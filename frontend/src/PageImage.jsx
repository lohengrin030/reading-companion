import { useEffect, useRef, useState } from 'react';
import { renderPageToDataUrl } from './pdfRender.js';
import BoxSelect from './BoxSelect.jsx';

// 在页面顶部展示 PDF 原书页面图（懒加载：滚到视口附近才开始渲染）。
// boxSelect=true 时允许在原图上拖拽画框（框选区域翻译）。
export default function PageImage({ file, pageNumber, boxSelect, onBoxRegion }) {
  const wrapRef = useRef(null);
  const [img, setImg] = useState(null); // { dataUrl, width, height }
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let cancelled = false;

    const load = async () => {
      try {
        const result = await renderPageToDataUrl(file, pageNumber);
        if (!cancelled) setImg(result);
      } catch (e) {
        if (!cancelled) setFailed(true);
      }
    };

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            load();
            io.disconnect();
          }
        },
        { rootMargin: '300px' }
      );
      io.observe(el);
      return () => {
        cancelled = true;
        io.disconnect();
      };
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [file, pageNumber]);

  // 框选完成：把框内区域从原图裁下来（按显示比例换算回原图坐标）
  const handleRegion = (displayRect, displaySize) => {
    if (!img || !onBoxRegion) return;
    const scaleX = img.width / displaySize.width;
    const scaleY = img.height / displaySize.height;
    const sx = Math.round(displayRect.x * scaleX);
    const sy = Math.round(displayRect.y * scaleY);
    const sw = Math.round(displayRect.width * scaleX);
    const sh = Math.round(displayRect.height * scaleY);
    if (sw < 4 || sh < 4) return;

    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      onBoxRegion(base64);
    };
    image.src = img.dataUrl;
  };

  return (
    <div ref={wrapRef} className="page-image">
      {img ? (
        boxSelect ? (
          <BoxSelect imgSrc={img.dataUrl} onRegion={handleRegion} />
        ) : (
          <img src={img.dataUrl} alt={`第 ${pageNumber} 页原文`} />
        )
      ) : failed ? (
        <div className="page-image-loading">原图渲染失败，已显示下方文字</div>
      ) : (
        <div className="page-image-loading">正在渲染第 {pageNumber} 页原图…</div>
      )}
    </div>
  );
}
