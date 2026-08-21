import { Router } from 'express';
import { getProvider } from '../providers/index.js';

const router = Router();

// 检测选中文本里在当前领域下有歧义、需要区分的术语，返回候选含义。
// 前端拿到后弹出候选让用户选择，选定后作为"术语偏好"再传给 /chat 讲解。
router.post('/disambiguate', async (req, res) => {
  try {
    const { text, field } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: '缺少 text' });
    }

    const provider = getProvider();
    const prompt = buildDisambiguatePrompt(text, field);
    const raw = await provider.chat({
      messages: [
        { role: 'system', content: '你只输出 JSON，不输出任何解释或多余文字。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
    });

    const terms = parseTerms(raw);
    res.json({ terms });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '歧义检测失败：' + err.message });
  }
});

function buildDisambiguatePrompt(text, field) {
  const lines = [
    '请分析用户选中的这段文本，判断其中是否有「在同一领域内存在多种含义、容易误解」的关键术语。',
  ];
  if (field) {
    const fields = Array.isArray(field) ? field : [field];
    lines.push(`当前领域（可能是交叉领域）：${fields.join('、')}`);
  }
  lines.push(
    `待分析文本：\n"""\n${text}\n"""`,
    '',
    '要求：',
    '1) 只列出确实有歧义、且会影响理解的术语，普通术语不要列；',
    '2) 每个术语给出 2~4 个在当前领域内可能的不同含义候选（用简洁中文）；',
    '3) 严格按如下 JSON 格式返回（terms 为空数组表示无歧义）：',
    '{"terms":[{"term":"field","candidates":["标量场","矢量场","电磁场"]}]}'
  );
  return lines.join('\n');
}

// 从 AI 返回里稳健地提取 terms（容错 markdown 代码块等）
function parseTerms(raw) {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj.terms)) return obj.terms;
  } catch {
    // 尝试提取第一个 {...} 块
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

export default router;
