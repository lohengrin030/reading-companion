// DeepSeek 适配器（OpenAI 兼容协议）
// 以后要换成别的模型，照着这个文件新建一个 provider 即可，业务代码不用改。
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

export async function chat({ messages, temperature = 0.7, maxTokens }) {
  if (!API_KEY) {
    throw new Error('缺少 DEEPSEEK_API_KEY，请在 backend/.env 中配置');
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      // 不传时用模型默认上限（deepseek-chat 默认 4K），大输出任务需显式调高
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek API 请求失败 (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
