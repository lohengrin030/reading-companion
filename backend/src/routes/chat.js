import { Router } from 'express';
import { getProvider } from '../providers/index.js';

const router = Router();

// 会话历史由前端持久化（localStorage），请求时带上 history 字段，后端无状态处理。
// 这样刷新页面/重启后端后对话上下文仍然保留，方便对同一本书持续追问。
router.post('/chat', async (req, res) => {
  try {
    const { sessionId, message, context, history } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: '缺少 message' });
    }

    const provider = getProvider();
    // 使用前端传来的历史，或为空数组
    const prevHistory = Array.isArray(history) ? history : [];

    const messages = [
      { role: 'system', content: buildSystemPrompt(context) },
      ...prevHistory,
      { role: 'user', content: message },
    ];

    const answer = await provider.chat({ messages });

    // 构建新的历史（截断到最近 20 条，防止 token 超限）
    const nextHistory = [
      ...prevHistory,
      { role: 'user', content: message },
      { role: 'assistant', content: answer },
    ];
    if (nextHistory.length > 20) nextHistory.splice(0, nextHistory.length - 20);

    res.json({ answer, history: nextHistory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI 调用失败：' + err.message });
  }
});

function buildSystemPrompt(context = {}) {
  const parts = ['你是一位耐心的专业书伴读助手，用通俗易懂的中文解释，必要时举例说明。'];
  if (context.isFormula) {
    const latex = context.latex || context.selectedText || '';
    parts.push(
      `用户询问的是一段 LaTeX 公式：\n"""\n${latex}\n"""\n` +
        `请分点讲解：1) 这个公式的整体含义；2) 每个符号、每一项分别是什么、起什么作用；3) 如果该公式有推导过程，请分步骤给出并解释每一步的物理/数学意义。`
    );
  } else if (context.selectedText) {
    parts.push(`用户选中的原文：\n"""\n${context.selectedText}\n"""`);
  }
  if (context.field) {
    const fields = Array.isArray(context.field) ? context.field : [context.field];
    parts.push(
      `本书所属领域：${fields.join('、')}。` +
        `请先根据用户选中的内容，判断它属于上述哪个领域（或交叉领域）下的哪个子领域/具体主题，` +
        `再按该子领域的术语习惯解释；无法判断子领域时，按主领域通用含义解释。`
    );
  }
  if (Array.isArray(context.termPreferences) && context.termPreferences.length > 0) {
    const prefs = context.termPreferences
      .map((p) => `  - ${p.term}：此处指「${p.meaning}」`)
      .join('\n');
    parts.push(`以下术语在此处的确切含义已由用户确认，请严格按此含义解释：\n${prefs}`);
  }
  return parts.join('\n');
}

export default router;
