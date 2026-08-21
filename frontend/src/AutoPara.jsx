import { useEffect, useRef, useState } from 'react';
import { normalizeTranslation, splitMath } from './math.js';
import { isChineseText } from './text.js';
import { translateText } from './api.js';
import Formula from './Formula.jsx';

// LRU 缓存：基于 Map 的插入序特性实现。get 时重排为最近使用，set 超限时淘汰最旧条目。
// 默认容量 2000 条，覆盖大多数书籍（约 200 页 × 每页 10 段），防止长时间使用内存溢出。
class LRUCache {
  constructor(max = 2000) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  has(key) {
    return this.map.has(key);
  }
  get size() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
}

// 跨组件共享的翻译缓存：key=原文，value=译文。同一段不重复调接口。
const translationCache = new LRUCache(2000);
// 正在翻译中的段落，避免同一小段并发重复请求
const inflight = new Set();

// 渲染一段文字（含公式）。点击公式回调可选。
function ParaContent({ text, onFormulaClick }) {
  return (
    <>
      {splitMath(text).map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.content}</span>
        ) : (
          <Formula
            key={i}
            latex={seg.content}
            display={seg.type === 'display'}
            onClick={onFormulaClick ? (e) => onFormulaClick(seg.content, e) : undefined}
          />
        )
      )}
    </>
  );
}

// 滚动进视口后自动翻译某段。translation/loading 通过 onDone 通知父级（对照模式用）。
function useAutoTranslate(text, field, glossary, wrapRef, enabled) {
  const [translation, setTranslation] = useState(() => translationCache.get(text) || '');
  const [loading, setLoading] = useState(false);

  // text 变化（切换 PDF / 翻页导致组件复用）时重置译文：命中缓存则用缓存，否则清空待翻译
  useEffect(() => {
    setTranslation(translationCache.get(text) || '');
    setLoading(false);
  }, [text]);

  useEffect(() => {
    if (!enabled || translation) return;
    if (isChineseText(text)) return; // 中文文献跳过翻译
    const el = wrapRef.current;
    if (!el) return;
    let cancelled = false;

    const run = async () => {
      const hit = translationCache.get(text);
      if (hit) {
        if (!cancelled) setTranslation(hit);
        return;
      }
      if (inflight.has(text)) return;
      inflight.add(text);
      if (!cancelled) setLoading(true);
      try {
        const res = await translateText({ text, field, glossary });
        const cleaned = normalizeTranslation(res.translation);
        translationCache.set(text, cleaned);
        if (!cancelled) setTranslation(cleaned);
      } catch (e) {
        console.warn('整段翻译失败：', e.message);
      } finally {
        inflight.delete(text);
        if (!cancelled) setLoading(false);
      }
    };

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            run();
            io.disconnect();
          }
        },
        { rootMargin: '200px' }
      );
      io.observe(el);
      return () => {
        cancelled = true;
        io.disconnect();
      };
    }
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled, translation]);

  return { translation, loading };
}

// 整段翻译模式：原文在上，译文在下。
export function AutoPara({ text, field, glossary, onFormulaClick }) {
  const wrapRef = useRef(null);
  const { translation, loading } = useAutoTranslate(text, field, glossary, wrapRef, true);

  return (
    <div ref={wrapRef} className="auto-para">
      <p className="page-text">
        <ParaContent text={text} onFormulaClick={onFormulaClick} />
      </p>
      {loading && <div className="auto-translation loading">翻译中…</div>}
      {translation && (
        <div className="auto-translation">
          <ParaContent text={translation} />
        </div>
      )}
    </div>
  );
}

// 中英对照模式：每段一行，左原文右译文。
export function BilingualPara({ text, field, glossary, onFormulaClick }) {
  const wrapRef = useRef(null);
  const { translation, loading } = useAutoTranslate(text, field, glossary, wrapRef, true);

  return (
    <div ref={wrapRef} className="bi-row">
      <div className="bi-cell bi-source">
        <ParaContent text={text} onFormulaClick={onFormulaClick} />
      </div>
      <div className="bi-cell bi-target">
        {loading && <span className="bi-loading">翻译中…</span>}
        {translation && <ParaContent text={translation} />}
      </div>
    </div>
  );
}
