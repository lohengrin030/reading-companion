import { useRef, useState } from 'react';

// 在原图上叠加透明层，鼠标拖拽画框。松开后把框选区域（相对图片的坐标）回调给父级。
export default function BoxSelect({ imgSrc, onRegion }) {
  const wrapRef = useRef(null);
  const [rect, setRect] = useState(null); // { x, y, width, height } 显示坐标
  const startRef = useRef(null);

  const getPos = (e) => {
    const bounds = wrapRef.current.getBoundingClientRect();
    return {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
  };

  const onMouseDown = (e) => {
    e.preventDefault();
    const p = getPos(e);
    startRef.current = p;
    setRect({ x: p.x, y: p.y, width: 0, height: 0 });
  };

  const onMouseMove = (e) => {
    if (!startRef.current) return;
    const s = startRef.current;
    const p = getPos(e);
    setRect({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      width: Math.abs(p.x - s.x),
      height: Math.abs(p.y - s.y),
    });
  };

  const onMouseUp = () => {
    if (!startRef.current || !rect) {
      startRef.current = null;
      return;
    }
    const s = startRef.current;
    startRef.current = null;
    if (rect.width > 6 && rect.height > 6) {
      onRegion(rect, { width: s.width, height: s.height });
    }
    setRect(null);
  };

  return (
    <div
      ref={wrapRef}
      className="box-select"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <img src={imgSrc} alt="原书页面" draggable={false} />
      {rect && (
        <div
          className="box-rect"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
      <div className="box-hint">按住鼠标拖拽，框选要翻译的区域</div>
    </div>
  );
}
