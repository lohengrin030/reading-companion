import { Router } from 'express';
import { accurateBasic, formula } from '../services/baiduOcr.js';

const router = Router();

// 接收前端传来的页面图片（base64），调用百度 OCR 返回文字。
router.post('/ocr', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ error: '缺少 image' });
    }
    const text = await accurateBasic(image);
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'OCR 失败：' + err.message });
  }
});

// 接收图片，调用百度数学公式识别，返回 LaTeX 列表。
router.post('/ocr-formula', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ error: '缺少 image' });
    }
    const formulas = await formula(image);
    res.json({ formulas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '公式识别失败：' + err.message });
  }
});

export default router;
