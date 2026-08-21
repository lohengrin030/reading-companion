import { Router } from 'express';
import { getProvider } from '../providers/index.js';

const router = Router();

// 并发 worker 数。与 parse-toc 一致的策略：批次间互不依赖，并发可大幅缩短总耗时。
const CONCURRENCY = 4;

// 自动提取术语并标注领域。书太长时前端传 pages 数组，后端分批调用 AI，合并去重后返回。
// 每个术语包含：term（术语）、translation（中文译名）、definitions（释义列表，含领域）、pages（出现页）。
router.post('/extract-terms', async (req, res) => {
  try {
    const { pages, field } = req.body || {};
    const pageList = Array.isArray(pages) ? pages : [];

    const batches = buildBatches(pageList);
    if (batches.length === 0) {
      return res.json({ terms: [] });
    }

    // SSE 流式返回：先发总批数，每完成一批发进度，最后发结果
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ type: 'total', total: batches.length });

    const provider = getProvider();
    // 并发解析：每个 worker 从队列领批次，完成一个发一次进度
    const queue = batches.map((_, i) => i);
    const results = new Array(batches.length).fill(null);
    let completed = 0;
    let failed = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const i = queue.shift();
        const batch = batches[i];
        let terms = [];
        try {
          const raw = await provider.chat({
            messages: [
              { role: 'system', content: '你只输出 JSON，不输出任何解释或多余文字。' },
              { role: 'user', content: buildExtractPrompt(batch.text, field) },
            ],
            temperature: 0.2,
            maxTokens: 4096,
          });
          terms = parseTerms(raw).map((t) => ({ ...t, pages: batch.pages }));
        } catch (err) {
          console.error(`术语批次 ${i + 1} 调用失败:`, err.message);
          failed++;
        }
        if (terms.length === 0) failed++;
        results[i] = terms; // 按批次序号存放，保证去重稳定
        completed++;
        send({ type: 'progress', done: completed, total: batches.length });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
    );

    if (failed === batches.length) {
      send({ type: 'error', message: '术语提取失败：所有批次调用均出错，请稍后重试。' });
      res.end();
      return;
    }
    const collected = results.flat();
    send({ type: 'done', terms: locatePages(mergeTerms(collected), pageList) });
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: '术语提取失败：' + err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

// 把页面文本切成约 4000 字符一批，并记录每批对应的页码（用于术语出现位置）。
function buildBatches(pageList) {
  const limit = 4000;
  const batches = [];
  let current = { text: '', pages: [] };
  for (const p of pageList) {
    const text = (p.text || '').trim();
    if (!text) continue;
    if (current.text.length > 0 && current.text.length + text.length > limit) {
      batches.push(current);
      current = { text: '', pages: [] };
    }
    current.text += (current.text ? '\n' : '') + text;
    if (!current.pages.includes(p.page)) current.pages.push(p.page);
  }
  if (current.text.trim()) batches.push(current);
  return batches;
}

function buildExtractPrompt(text, field) {
  const lines = [
    '请从下面这段专业文献中提取重要的专业术语（名词、概念、专有名词）。',
    '对每个术语给出：术语原文、中文译名（外文术语给标准中文译名，中文术语则同原文）、简短中文释义、所属领域/子领域。',
    '只提取真正有专业含义的术语，普通常用词不要列。',
  ];
  if (field) {
    const fields = Array.isArray(field) ? field : [field];
    lines.push(`当前书所属领域（可能交叉）：${fields.join('、')}，请优先按此领域标注。`);
  }
  lines.push(
    `文本：\n"""\n${text}\n"""`,
    '',
    '严格按如下 JSON 格式返回（terms 为空数组表示没有术语）：',
    '{"terms":[{"term":"field","translation":"场","definition":"场","domain":"电磁学"}]}'
  );
  return lines.join('\n');
}

// 稳健解析 AI 返回的 terms
function parseTerms(raw) {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj.terms)) return obj.terms;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (Array.isArray(obj.terms)) return obj.terms;
      } catch {}
    }
  }
  return [];
}

// 合并去重：同术语合并释义（不同领域并列）、累加出现页、保留中文译名。
function mergeTerms(terms) {
  const map = new Map();
  for (const t of terms) {
    if (!t || !t.term) continue;
    const key = String(t.term).trim().toLowerCase();
    const term = String(t.term).trim();
    const domain = (t.domain || '').trim();
    const definition = (t.definition || '').trim();
    const translation = (t.translation || '').trim();
    const pages = Array.isArray(t.pages) ? t.pages : [];

    if (!map.has(key)) {
      map.set(key, {
        term,
        translation,
        definitions: [{ domain, definition }],
        pages: [...pages],
      });
    } else {
      const existing = map.get(key);
      const dup = existing.definitions.some(
        (d) => d.domain === domain && d.definition === definition
      );
      if (!dup) existing.definitions.push({ domain, definition });
      for (const pg of pages) {
        if (!existing.pages.includes(pg)) existing.pages.push(pg);
      }
      if (!existing.translation && translation) existing.translation = translation;
    }
  }
  // 出现页排序
  return Array.from(map.values()).map((t) => ({
    ...t,
    pages: t.pages.sort((a, b) => a - b),
  }));
}

// 精确定位每个术语出现的页：在原文里做不区分大小写的子串搜索。
// 找到就用精确结果覆盖批级页码；找不到（词形变化等）保留批级结果。
function locatePages(terms, pageList) {
  for (const t of terms) {
    const needle = t.term.toLowerCase();
    const found = [];
    for (const p of pageList) {
      const text = (p.text || '').toLowerCase();
      if (needle && text.includes(needle)) found.push(p.page);
    }
    if (found.length > 0) t.pages = found.sort((a, b) => a - b);
  }
  return terms;
}

export default router;
