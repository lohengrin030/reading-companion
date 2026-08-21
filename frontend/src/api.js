export async function uploadDocument(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/documents/upload', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '上传失败');
  }
  return res.json();
}

export async function askAI({ sessionId, message, context, history }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, context, history }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'AI 请求失败');
  }
  return res.json();
}

export async function disambiguate({ text, field }) {
  const res = await fetch('/api/disambiguate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, field }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '歧义检测失败');
  }
  return res.json();
}

// 读取后端 SSE 流（extract-terms / parse-toc 共用）：
// 解析 data: 行，progress 回调进度，done 返回结果对象，error 抛异常。
async function readSseStream(res, onProgress) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let error = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const data = JSON.parse(line.slice(5).trim());
        if (data.type === 'progress' && onProgress) onProgress(data.done, data.total);
        else if (data.type === 'done') result = data;
        else if (data.type === 'error') error = data.message;
      } catch {}
    }
  }

  if (error) throw new Error(error);
  return result;
}

export async function extractTerms({ pages, field, onProgress }) {
  const res = await fetch('/api/extract-terms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages, field }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '术语提取失败');
  }

  const contentType = res.headers.get('Content-Type') || '';
  if (!contentType.includes('text/event-stream')) {
    return res.json(); // 空结果等普通 JSON 响应
  }

  const data = await readSseStream(res, onProgress);
  return { terms: data?.terms || [] };
}

export async function parseToc({ pages, onProgress }) {
  const res = await fetch('/api/parse-toc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '目录解析失败');
  }

  const contentType = res.headers.get('Content-Type') || '';
  if (!contentType.includes('text/event-stream')) {
    return res.json(); // 空结果等普通 JSON 响应
  }

  const data = await readSseStream(res, onProgress);
  return { outline: data?.outline || [] };
}

export async function translateText({ text, field, glossary }) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, field, glossary }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '翻译失败');
  }
  return res.json();
}

export async function uploadGlossary(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/glossary', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '术语库上传失败');
  }
  return res.json();
}

export async function ocrImage({ image }) {
  const res = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'OCR 失败');
  }
  return res.json();
}

export async function ocrFormula({ image }) {
  const res = await fetch('/api/ocr-formula', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '公式识别失败');
  }
  return res.json();
}

export async function detectPageImages(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/detect-images', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '图片检测失败');
  }
  return res.json();
}
