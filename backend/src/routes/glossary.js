import { Router } from 'express';
import multer from 'multer';
import { parseGlossary } from '../services/glossary.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post('/glossary', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件' });
    }
    const terms = parseGlossary(req.file.buffer);
    res.json({ count: terms.length, terms });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '术语库解析失败：' + err.message });
  }
});

export default router;
