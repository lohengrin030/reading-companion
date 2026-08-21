// 百度 OCR 服务封装。
// 通用文字识别（高精度版）接口：https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic
// 数学公式识别接口：https://aip.baidubce.com/rest/2.0/ocr/v1/formula
const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const ACCURATE_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic';
const FORMULA_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/formula';

let cachedToken = null;
let tokenExpireAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpireAt) {
    return cachedToken;
  }
  const apiKey = process.env.BAIDU_OCR_API_KEY;
  const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error('缺少百度 OCR 密钥，请在 backend/.env 配置 BAIDU_OCR_API_KEY 和 BAIDU_OCR_SECRET_KEY');
  }

  const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    throw new Error(`获取百度 access_token 失败 (${res.status})`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`百度返回错误：${data.error_description || data.error}`);
  }

  cachedToken = data.access_token;
  tokenExpireAt = Date.now() + (data.expires_in - 60) * 1000; // 提前 1 分钟过期
  return cachedToken;
}

// 识别图片中的文字，返回纯文本（多行用换行分隔）。
export async function accurateBasic(imageBase64) {
  const token = await getAccessToken();
  const body = new URLSearchParams({ image: imageBase64 });

  const res = await fetch(`${ACCURATE_URL}?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`百度 OCR 请求失败 (${res.status})`);
  }
  const data = await res.json();
  if (data.error_code) {
    throw new Error(`百度 OCR 错误 (${data.error_code})：${data.error_msg}`);
  }

  return (data.words_result || []).map((w) => w.words).join('\n');
}

// 识别图片中的数学公式，返回 LaTeX 字符串列表。
export async function formula(imageBase64) {
  const token = await getAccessToken();
  // 百度公式识别：formula_detect 开启可检测多个公式区域
  const body = new URLSearchParams({ image: imageBase64, recognize_granularity: 'big', formula_detect: 'true' });

  const res = await fetch(`${FORMULA_URL}?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`百度公式识别请求失败 (${res.status})`);
  }
  const data = await res.json();
  if (data.error_code) {
    throw new Error(`百度公式识别错误 (${data.error_code})：${data.error_msg}`);
  }

  return (data.words_result || []).map((w) => w.words).filter(Boolean);
}
