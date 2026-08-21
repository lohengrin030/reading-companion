import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// 提取 PDF 每页文字，按原书行位置分行分段。返回 [{ page, text }]
export async function extractText(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = rebuildLayout(content.items);
    pages.push({ page: i, text });
    page.cleanup();
  }

  await doc.destroy();
  return pages;
}

// 提取 PDF 内置书签（目录大纲），解析成 [{ title, page, items }]。无书签返回空数组。
export async function extractOutline(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  let outline = [];
  try {
    const raw = await doc.getOutline();
    outline = raw ? await resolveOutline(doc, raw) : [];
  } catch {
    outline = [];
  }

  await doc.destroy();
  return outline;
}

async function resolveOutline(doc, items) {
  const result = [];
  for (const item of items || []) {
    let page = null;
    try {
      if (item.dest) {
        const dest =
          typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest) && dest[0]) {
          const idx = await doc.getPageIndex(dest[0]);
          page = idx + 1; // 转成 1-based
        }
      }
    } catch {
      page = null;
    }
    result.push({
      title: item.title || '',
      page,
      items: item.items ? await resolveOutline(doc, item.items) : [],
    });
  }
  return result;
}

// 检测 PDF 每页是否包含嵌入图片（用于前端显示"识别图片"入口）。
// 返回 [{ page, imageCount, images: [{ name, width, height, x, y, w, h }] }]
export async function detectPageImages(buffer, pageNumbers) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  const pages = [];
  const targetPages = pageNumbers && pageNumbers.length
    ? pageNumbers
    : Array.from({ length: doc.numPages }, (_, i) => i + 1);

  for (const pageNum of targetPages) {
    if (pageNum < 1 || pageNum > doc.numPages) continue;
    const page = await doc.getPage(pageNum);
    const { imageCount, images } = await detectImagesFromPage(page);
    pages.push({ page: pageNum, imageCount, images });
    page.cleanup();
  }

  await doc.destroy();
  return pages;
}

async function detectImagesFromPage(page) {
  const result = [];
  try {
    const imageList = await page.getImageList();
    if (!imageList || imageList.length === 0) return { imageCount: 0, images: [] };

    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;
    const pageArea = pageWidth * pageHeight;

    for (let i = 0; i < imageList.length; i++) {
      const imgObj = imageList[i];
      try {
        const { width: imgW, height: imgH } = await imgObj.getImageData();
        const imgArea = imgW * imgH;

        // 过滤掉接近整页大小的图片（扫描件本身就是全页图）
        // 只保留文档中的插图、流程图等内容图片
        const areaRatio = imgArea / pageArea;
        if (areaRatio > 0.7) continue; // 超过页面面积 70% 视为扫描件本身

        // 过滤太小的图片（可能是图标、logo）
        if (imgW < 30 && imgH < 30) continue;

        // 估算图片位置（best-effort）
        const estX = (i % 2) * pageWidth * 0.5 + pageWidth * 0.1;
        const estY = Math.floor(i / 2) * pageHeight * 0.3 + pageHeight * 0.1;
        const estW = Math.min(imgW, pageWidth * 0.4);
        const estH = Math.min(imgH, pageHeight * 0.25);

        result.push({
          name: imgObj.name || `image_${i}`,
          width: imgW,
          height: imgH,
          x: Math.round(estX),
          y: Math.round(estY),
          w: Math.round(estW),
          h: Math.round(estH),
        });
      } catch {}
    }
  } catch {}
  return { imageCount: result.length, images: result };
}
// PDF 坐标系原点在左下角，transform[5] 越大越靠上。
function rebuildLayout(items) {
  // 1. 过滤空块，收集 (y, x, 文本, 高度)
  const tokens = [];
  for (const it of items) {
    const str = it.str;
    if (!str) continue;
    tokens.push({
      x: it.transform[4],
      y: it.transform[5],
      height: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10,
      str,
    });
  }
  if (tokens.length === 0) return '';

  // 2. 按 y 聚类成行（同一行内的块 y 相近）
  tokens.sort((a, b) => b.y - a.y || a.x - b.x);
  const avgHeight =
    tokens.reduce((s, t) => s + t.height, 0) / tokens.length || 10;
  const yTol = Math.max(avgHeight * 0.5, 2);

  const lines = [];
  let cur = { y: tokens[0].y, items: [tokens[0]] };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (Math.abs(t.y - cur.y) <= yTol) {
      cur.items.push(t);
      // 更新行的平均 y，防止累积漂移
      cur.y = cur.items.reduce((s, it) => s + it.y, 0) / cur.items.length;
    } else {
      lines.push(cur);
      cur = { y: t.y, items: [t] };
    }
  }
  lines.push(cur);

  // 3. 每行按 x 排序后拼接；行间垂直距离大则分段（空行）
  const lineObjs = lines
    .map((l) => {
      const text = l.items
        .sort((a, b) => a.x - b.x)
        .map((t) => t.str)
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim();
      const height = Math.max(...l.items.map((t) => t.height));
      return { y: l.y, height, text };
    })
    .filter((l) => l.text);

  let out = '';
  for (let i = 0; i < lineObjs.length; i++) {
    const l = lineObjs[i];
    if (i === 0) {
      out += l.text;
      continue;
    }
    const prev = lineObjs[i - 1];
    const gap = prev.y - l.y; // 上一行比当前行高出的垂直距离
    const paraGap = Math.max(prev.height, l.height) * 1.6;
    out += gap > paraGap ? '\n\n' + l.text : '\n' + l.text;
  }
  return out;
}
