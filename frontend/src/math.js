// 把一段文本按公式分隔符拆成「文本 / 行内公式 / 块级公式」片段。
// 支持 $...$、$$...$$、\(...\)（行内）和 \[...\]（块级）。
export function splitMath(text) {
  const parts = [];
  const regex = /(\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g;
  let last = 0;
  let m;
  while ((m = regex.exec(text))) {
    if (m.index > last) {
      parts.push({ type: 'text', content: text.slice(last, m.index) });
    }
    const raw = m[0];
    if (raw.startsWith('$$') && raw.endsWith('$$')) {
      parts.push({ type: 'display', content: raw.slice(2, -2) });
    } else if (raw.startsWith('\\[') && raw.endsWith('\\]')) {
      parts.push({ type: 'display', content: raw.slice(2, -2) });
    } else if (raw.startsWith('\\(') && raw.endsWith('\\)')) {
      parts.push({ type: 'inline', content: raw.slice(2, -2) });
    } else {
      parts.push({ type: 'inline', content: raw.slice(1, -1) });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) {
    parts.push({ type: 'text', content: text.slice(last) });
  }
  return parts;
}

// 清理 AI 返回的翻译结果中的 LaTeX 包裹：
// - \(...\)  ->  纯文本
// - \[...\]  ->  纯文本
// - $...$    ->  保留（用户显式使用的格式）
// - $$...$$  ->  保留
export function normalizeTranslation(text) {
  if (!text) return text;
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, '$1')
    .replace(/\\\(([\s\S]+?)\\\)/g, '$1');
}

// 把一页文本按空行拆成段落，过滤空段。
export function splitParagraphs(text) {
  return text
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
