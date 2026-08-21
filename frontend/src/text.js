// 判断文本是否以中文为主。中文文献不需要翻译，前端据此跳过翻译。
export function isChineseText(text) {
  if (!text) return false;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    if (ch >= '\u4e00' && ch <= '\u9fff') cjk++;
  }
  return total > 0 && cjk / total >= 0.3;
}
