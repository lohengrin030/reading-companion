import { Router } from 'express';
import { getProvider } from '../providers/index.js';

const router = Router();

router.post('/translate', async (req, res) => {
  try {
    const { text, field, glossary } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: '缺少 text' });
    }

    const provider = getProvider();
    const messages = [
      { role: 'system', content: buildTranslatePrompt(field, glossary) },
      { role: 'user', content: text },
    ];

    const translation = await provider.chat({ messages, temperature: 0.3 });
    res.json({ translation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '翻译失败：' + err.message });
  }
});

function buildTranslatePrompt(field, glossary) {
  const parts = [
    '你是一名专业文献翻译助手，请把用户发来的内容翻译成中文。要求：',
    '1) 专业术语翻译准确，必要时保留英文原词并用括号注释；',
    '2) 文中的任何形式的公式（LaTeX 如 $...$ / $$...$$、纯文本如 A=π.r²、Unicode 数学符号等）必须原样保留，严禁把纯文本公式改写成 LaTeX 或其它格式；',
    '3) 语句通顺，符合中文阅读习惯。',
  ];
  if (field) {
    const fields = Array.isArray(field) ? field : [field];
    parts.push(
      `本文所属领域：${fields.join('、')}。请先根据待翻译内容判断它属于上述哪个领域（或交叉领域）下的哪个子领域/具体主题，` +
        `再按该子领域的术语习惯翻译；无法判断时按主领域通用译法。`
    );
  }
  if (Array.isArray(glossary) && glossary.length > 0) {
    const lines = glossary
      .map((t) => `  - ${t.source} → ${t.target}（${t.tag}）`)
      .join('\n');
    parts.push(
      `以下术语必须严格按指定译法翻译，不得自行改动：\n${lines}`
    );
  }
  return parts.join('\n');
}

export default router;
