import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// 把 PDF 文件的某一页渲染成 PNG。
async function renderPageToPng(file, pageNumber, scale) {
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  const dataUrl = canvas.toDataURL('image/png');
  await doc.destroy();
  return { dataUrl, width: canvas.width, height: canvas.height };
}

// 渲染页面为图片，返回 { dataUrl, width, height }，用于界面展示原文。
export async function renderPageToDataUrl(file, pageNumber, scale = 1.5) {
  return renderPageToPng(file, pageNumber, scale);
}

// 渲染页面为 base64（不含 data URI 前缀），用于发送给后端 OCR。
export async function renderPageToBase64(file, pageNumber, scale = 2) {
  const { dataUrl } = await renderPageToPng(file, pageNumber, scale);
  return dataUrl.split(',')[1];
}
