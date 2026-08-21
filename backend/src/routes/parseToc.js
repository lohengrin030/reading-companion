import { Router } from 'express';
import { getProvider } from '../providers/index.js';

const router = Router();

// 单批送入 AI 的文字量上限。目录页数多、条目几百个时，
// 一次性要求 AI 输出全部 JSON 会超过模型输出 token 上限（约 2 万字符即被截断），
// 截断的 JSON 解析失败 → 前端表现为「未识别到目录」，因此按字符量分批解析再合并。
const BATCH_CHARS = 10000;

// 批次并发数。批次之间互不依赖，并发调用把总耗时从「批次和」缩短到「批次和 ÷ 并发数」。
const CONCURRENCY = 4;

// AI 从前几页的 OCR 文字里解析目录（章节标题 + 页码），作为无内置书签的兜底。
// SSE 流式返回：先发总批数，每完成一批发进度，最后发合并去重后的结果。
router.post('/parse-toc', async (req, res) => {
  try {
    const { pages } = req.body || {};
    const pageList = (Array.isArray(pages) ? pages : []).filter((p) => p.text && p.text.trim());

    const batches = buildBatches(pageList);
    if (batches.length === 0) {
      return res.json({ outline: [] });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ type: 'total', total: batches.length });

    const provider = getProvider();
    // 并发解析：每个 worker 从队列领批次，完成一个发一次进度（进度按完成数计，与批次顺序无关）
    const queue = batches.map((_, i) => i);
    const results = new Array(batches.length).fill(null);
    let completed = 0;
    let failed = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const i = queue.shift();
        const text = batches[i].map((p) => `【PDF第${p.page}页】\n${p.text}`).join('\n\n');
        const messages = [
          { role: 'system', content: '你只输出 JSON，不输出任何解释或多余文字。' },
          { role: 'user', content: buildTocPrompt(text) },
        ];

        // AI 偶发返回格式异常、误判为空或调用出错（含瞬时限流），失败/空结果时重试一次
        let outline = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const raw = await provider.chat({ messages, temperature: 0.1, maxTokens: 8192 });
            outline = parseOutline(raw);
          } catch (err) {
            console.error(`目录批次 ${i + 1} 第 ${attempt + 1} 次调用失败:`, err.message);
            outline = [];
          }
          if (outline.length > 0) break;
        }
        if (outline.length === 0) failed++;
        results[i] = outline; // 按批次序号存放，保证目录顺序
        completed++;
        send({ type: 'progress', done: completed, total: batches.length });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
    );

    if (failed === batches.length) {
      send({ type: 'error', message: '目录解析失败：AI 调用反复出错，请稍后重试。' });
      res.end();
      return;
    }
    send({ type: 'done', outline: dedupeOutline(results.flat()) });
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: '目录解析失败：' + err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

// 按字符量分批，尽量不拆散单页
function buildBatches(pageList) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const p of pageList) {
    if (current.length > 0 && chars + p.text.length > BATCH_CHARS) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildTocPrompt(text) {
  return [
    '下面是一本书的目录页 OCR 识别文字（目录页通常有多行「章节标题 …… 页码」）。',
    '请从这些文字里找出所有目录条目（章节标题 + 对应页码）。',
    '',
    '要求：',
    '1) 只提取目录条目，忽略正文、页眉、页脚、版权信息（页眉多为重复出现的文档编号，如 NWC TP 6575）；',
    '2) page 填目录行末尾的原始页码：可能是纯数字（如 12），也可能是「章-页」格式（如 4-20、5-116）。一律原样作为字符串返回，不要改写、不要拆分；',
    '3) title 必须逐字取自目录原文（章节编号、罗马数字等原样保留，如 "Chapter I" 不要写成 "Chapter 1"），不要改写或补全；',
    '4) 保持章节的层级顺序，但扁平返回即可（不需要嵌套）；',
    '5) 如果标题是外文（如英文），额外给出 title_zh（标准中文译名）；中文标题则 title_zh 与 title 相同；',
    '6) 严格按如下 JSON 格式返回（outline 为空数组表示没找到目录）：',
    '{"outline":[{"title":"Chapter I Introduction","title_zh":"第一章 绪论","page":"1-1"}]}',
    '',
    `OCR 文字：\n"""\n${text}\n"""`,
  ].join('\n');
}

function parseOutline(raw) {
  if (!raw) return [];
  const tries = [];
  // 1. 直接解析
  tries.push(raw.trim());
  // 2. 提取 ```json ... ``` 代码块
  const cb = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) tries.push(cb[1].trim());
  // 3. 提取第一个 { 到最后一个 }（覆盖最外层 JSON 对象）
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) tries.push(m[0]);

  for (const t of tries) {
    try {
      const obj = JSON.parse(t);
      if (Array.isArray(obj.outline)) return obj.outline;
    } catch {}
  }
  return [];
}

// 分批解析可能产生重复条目（跨批边界），按 标题+页码 去重
function dedupeOutline(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.title) continue;
    const key = `${String(it.title).trim()}|${String(it.page ?? '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export default router;
