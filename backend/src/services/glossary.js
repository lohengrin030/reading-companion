import xlsx from 'xlsx';

// 解析术语库 xlsx。列：source=原文 target=译文 tag=词性(per/loc/noun) case_sensitive=是否区分大小写
// 第 1 行英文表头，第 2 行中文说明，数据从第 3 行开始。
export function parseGlossary(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const terms = [];
  for (let i = 2; i < rows.length; i++) {
    const [source, target, tag, caseSensitive] = rows[i];
    if (!source || !target) continue;
    terms.push({
      source: String(source).trim(),
      target: String(target).trim(),
      tag: String(tag || 'noun').trim(),
      caseSensitive: String(caseSensitive).toUpperCase() === 'TRUE',
    });
  }
  return terms;
}
