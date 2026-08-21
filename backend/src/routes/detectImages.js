import { Router } from 'express';
import multer from 'multer';
import { detectPageImages } from '../services/pdf.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 检测每页嵌入图片数量和位置
router.post('/detect-images', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const { pages } = req.body;
    const pageNumbers = pages ? JSON.parse(pages) : undefined;
    const result = await detectPageImages(req.file.buffer, pageNumbers);
    res.json({ pages: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '图片检测失败：' + err.message });
  }
});

export default router;
