import { Router } from 'express';
import multer from 'multer';
import { extractText, extractOutline } from '../services/pdf.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 最大 50MB
});

router.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件' });
    }

    const pages = await extractText(req.file.buffer);
    const outline = await extractOutline(req.file.buffer);
    const text = pages.map((p) => p.text).join('\n\n');
    // 标记没有文字层的扫描页，前端会针对这些页提供 OCR 按钮
    const scannedPages = pages.filter((p) => !p.text.trim()).map((p) => p.page);

    res.json({
      filename: req.file.originalname,
      pageCount: pages.length,
      scannedPages,
      pages,
      text,
      outline,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF 解析失败：' + err.message });
  }
});

export default router;
