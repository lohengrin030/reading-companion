import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import uploadRouter from './routes/upload.js';
import chatRouter from './routes/chat.js';
import translateRouter from './routes/translate.js';
import ocrRouter from './routes/ocr.js';
import glossaryRouter from './routes/glossary.js';
import disambiguateRouter from './routes/disambiguate.js';
import extractTermsRouter from './routes/extractTerms.js';
import parseTocRouter from './routes/parseToc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', uploadRouter);
app.use('/api', chatRouter);
app.use('/api', translateRouter);
app.use('/api', ocrRouter);
app.use('/api', glossaryRouter);
app.use('/api', disambiguateRouter);
app.use('/api', extractTermsRouter);
app.use('/api', parseTocRouter);

// 生产环境：后端托管前端构建产物，同源部署
const distPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(distPath, 'index.html'));
  }
});

app.listen(config.port, config.host, () => {
  console.log(`后端已启动: http://${config.host}:${config.port}`);
  if (config.isProd) console.log('（生产模式，托管前端静态文件）');
});
