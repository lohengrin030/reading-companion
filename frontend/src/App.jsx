import { useEffect, useMemo, useRef, useState } from 'react';
import { askAI, disambiguate, extractTerms, ocrFormula, ocrImage, parseToc, translateText, uploadDocument, uploadGlossary } from './api.js';
import { splitMath, splitParagraphs } from './math.js';
import { isChineseText } from './text.js';
import Formula from './Formula.jsx';
import { AutoPara, BilingualPara } from './AutoPara.jsx';
import { renderPageToBase64 } from './pdfRender.js';
import PageImage from './PageImage.jsx';

// 常见领域待选项（工科生专业书）
const PRESET_FIELDS = [
  '数学', '物理', '化学', '力学', '电磁学', '电路与电子',
  '信号处理', '通信工程', '控制工程', '计算机科学',
  '机械工程', '材料科学', '流体力学', '热力学', '土木工程', '生物医学工程',
];

export default function App() {
  const [pages, setPages] = useState([]);
  const [filename, setFilename] = useState('');
  const [fields, setFields] = useState([]); // 领域标签，可多选（交叉学科）
  const [showFields, setShowFields] = useState(false);
  const [customField, setCustomField] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // selection: { kind: 'text'|'formula', text?, latex?, x, y }
  const [selection, setSelection] = useState(null);
  const [pendingContext, setPendingContext] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [chatHistory, setChatHistory] = useState([]); // 会话历史，持久化到 localStorage
  const [answer, setAnswer] = useState('');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [ocrLoading, setOcrLoading] = useState({});
  const [currentPage, setCurrentPage] = useState(null);
  const [jumpPage, setJumpPage] = useState('');
  const [bookmarks, setBookmarks] = useState([]);
  const [glossary, setGlossary] = useState([]); // 术语库 [{source,target,tag,caseSensitive}]
  const [glossaryName, setGlossaryName] = useState('');
  const [editingPage, setEditingPage] = useState(null); // 正在手动编辑的页码
  const [editText, setEditText] = useState('');
  const [showCache, setShowCache] = useState(false);
  // 翻译模式：off=手动划选 / para=整段翻译 / bilingual=中英对照
  const [transMode, setTransMode] = useState('off');
  // 术语表：自动提取的术语 + 领域 + 释义
  const [terms, setTerms] = useState([]);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsProgress, setTermsProgress] = useState(null); // { done, total } 提取进度
  const [showTerms, setShowTerms] = useState(false);
  // 目录大纲（PDF 内置书签）
  const [outline, setOutline] = useState([]);
  const [showOutline, setShowOutline] = useState(false);
  const [tocLoading, setTocLoading] = useState(false); // AI 解析目录中
  const [tocOffset, setTocOffset] = useState('0'); // 目录页码偏移量（校正书内页码与 PDF 页的差）
  // 目录页码范围（用户可指定，默认前 12 页）
  const [tocStart, setTocStart] = useState('1');
  const [tocEnd, setTocEnd] = useState('12');
  const [showTocConfig, setShowTocConfig] = useState(false);
  const [tocOcrProgress, setTocOcrProgress] = useState(null); // { done, total } OCR 进度
  const [tocAiProgress, setTocAiProgress] = useState(null); // { done, total } AI 分批解析进度
  // 当前 outline 是否来自 AI 解析（区别于 PDF 内置书签：内置书签页码就是 PDF 页码，无需偏移）
  const [outlineParsed, setOutlineParsed] = useState(false);
  // 手动修正的目录跳转页码：{ [标题]: PDF页码 }。定位失败/定位错误的条目可手动指定。
  const [tocFixes, setTocFixes] = useState({});
  // 正在修正的条目与输入框页码（定位模式：浮动条跟随，翻到目标页确认）
  const [fixingItem, setFixingItem] = useState(null);
  const [fixingPage, setFixingPage] = useState('');

  // 页面内搜索
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]); // [{page, index, length}]
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef(null);

  // 批注/笔记：{ [sessionId]: [{ id, text, page, note, color, createdAt }] }
  const [annotations, setAnnotations] = useState([]);
  const [newNoteText, setNewNoteText] = useState('');
  const [newNoteColor, setNewNoteColor] = useState('#ffec99');
  const [showAnnotations, setShowAnnotations] = useState(true);

  const textRef = useRef(null);
  const fileRef = useRef(null);
  const docFileRef = useRef(null);
  const glossaryRef = useRef(null);
  const tocRangeRef = useRef(null); // 本次 AI 解析目录的页码范围（标题搜索时排除目录页自身）

  // localStorage 键：按文件名区分文档
  const storageKey = filename ? `reader:${filename}` : null;

  // 会话历史持久化：会话历史按 sessionId 存在 localStorage，按文档隔离。
  const saveChatHistory = (sid, history) => {
    if (!sid || !storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.chatSessions = data.chatSessions || {};
      data.chatSessions[sid] = history;
      data.activeChatSession = sid;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  };

  const loadChatHistory = (sid) => {
    if (!sid || !storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      if (data.chatSessions && data.chatSessions[sid]) {
        return data.chatSessions[sid];
      }
    } catch {}
    return null;
  };

  const loadActiveSessionId = () => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      return data.activeChatSession || null;
    } catch {}
    return null;
  };

  // 滚动监听：当前最靠近视口顶部的页 = 当前阅读位置，写入 localStorage
  useEffect(() => {
    if (!storageKey) return;
    const onScroll = () => {
      const el = textRef.current;
      if (!el) return;
      const sections = el.querySelectorAll('.page[data-page]');
      let current = null;
      for (const s of sections) {
        if (s.getBoundingClientRect().top <= 120) current = s.dataset.page;
        else break;
      }
      if (current != null) {
        setCurrentPage(Number(current));
        try {
          const raw = localStorage.getItem(storageKey);
          const data = raw ? JSON.parse(raw) : {};
          data.page = Number(current);
          localStorage.setItem(storageKey, JSON.stringify(data));
        } catch {}
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [storageKey, pages]);

  // 上传成功后：恢复 OCR 缓存、书签、会话历史，并跳到上次阅读位置
  useEffect(() => {
    if (!storageKey || pages.length === 0) return;
    let target = null;
    let savedBookmarks = [];
    let ocrCache = {};
    let savedTocFixes = {};
    let savedOutline = null;
    let savedTocOffset = '0';
    let savedTocRange = null;
    let savedSid = null;
    let savedHistory = [];
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const data = JSON.parse(raw);
        target = data.page;
        savedBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
        ocrCache = data.ocrCache || {};
        savedTocFixes = data.tocFixes || {};
        savedOutline = Array.isArray(data.outline) ? data.outline : null;
        savedTocOffset = data.tocOffset != null ? String(data.tocOffset) : '0';
        savedTocRange = data.tocRange || null;
        // 恢复会话历史：先找活跃 sessionId，找不到取第一个
        if (data.activeChatSession && data.chatSessions && data.chatSessions[data.activeChatSession]) {
          savedSid = data.activeChatSession;
          savedHistory = data.chatSessions[data.activeChatSession];
        } else if (data.chatSessions) {
          const sids = Object.keys(data.chatSessions);
          if (sids.length > 0) {
            savedSid = sids[0];
            savedHistory = data.chatSessions[sids[0]];
          }
        }
      }
    } catch {}
    // 恢复之前 OCR 过的页面文字，避免重复调接口
    if (Object.keys(ocrCache).length > 0) {
      setPages((prev) =>
        prev.map((p) => (ocrCache[p.page] ? { ...p, text: ocrCache[p.page], ocr: true } : p))
      );
    }
    setBookmarks(savedBookmarks);
    setTocFixes(savedTocFixes);
    // 恢复会话历史
    setSessionId(savedSid);
    setChatHistory(savedHistory);
    // 恢复批注
    setAnnotations(loadAnnotations());
    // 恢复上次 AI 解析的目录（含偏移量与目录页范围），免重新调 AI 解析
    if (savedOutline && savedOutline.length > 0) {
      setOutline(savedOutline);
      setOutlineParsed(true);
      setTocOffset(savedTocOffset);
      tocRangeRef.current = savedTocRange;
    }
    if (target) {
      // 等页面渲染完成再滚动
      const t = setTimeout(() => {
        document.getElementById(`page-${target}`)?.scrollIntoView({ block: 'start' });
      }, 300);
      return () => clearTimeout(t);
    }
    // 仅在挂载/换文档时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, pages.length]);

  // 书签增删、持久化、跳转
  const persistBookmarks = (list) => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.bookmarks = list;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  };

  const addBookmark = () => {
    if (!currentPage) return;
    addBookmarkAt(currentPage);
  };

  const addBookmarkAt = (page) => {
    if (!page) return;
    setBookmarks((prev) => {
      if (prev.includes(page)) return prev;
      const next = [...prev, page].sort((a, b) => a - b);
      persistBookmarks(next);
      return next;
    });
  };

  const removeBookmark = (page) => {
    setBookmarks((prev) => {
      const next = prev.filter((p) => p !== page);
      persistBookmarks(next);
      return next;
    });
  };

  const jumpToPage = (page) => {
    document.getElementById(`page-${page}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 目录修正的持久化（与书签同一存储结构）
  const persistTocFixes = (fixes) => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.tocFixes = fixes;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  };

  // 持久化 AI 解析的目录（含页码偏移、目录页范围），下次打开同一本书免重新解析
  const persistOutline = (list, offsetVal, range) => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.outline = list;
      data.tocOffset = String(offsetVal);
      data.tocRange = range;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  };

  // 偏移量变化时同步到已保存的目录数据
  useEffect(() => {
    if (!storageKey || !outlineParsed || outline.length === 0) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.tocOffset = tocOffset;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocOffset]);

  // 开始修正某条目：关闭目录面板，进入定位模式（浮动条跟随当前页）
  const startFixTocItem = (item) => {
    setShowOutline(false);
    setFixingItem(item);
    setFixingPage(currentPage != null ? String(currentPage) : '');
    setError('');
  };

  // 确认修正：保存页码并跳转过去验证
  const confirmTocFix = () => {
    const n = parseInt(fixingPage, 10);
    if (!Number.isInteger(n) || n < 1 || n > pages.length) {
      setError(`页码应在 1~${pages.length} 之间`);
      return;
    }
    const next = { ...tocFixes, [fixingItem.title]: n };
    setTocFixes(next);
    persistTocFixes(next);
    setFixingItem(null);
    setError('');
    jumpToPage(n);
  };

  // 取消修正
  const cancelTocFix = () => {
    setFixingItem(null);
    setError('');
  };

  // 页码跳转：校验范围后跳转
  const handleJumpPage = () => {
    const n = parseInt(jumpPage, 10);
    if (!Number.isInteger(n) || n < 1 || n > pages.length) {
      setError(`页码应在 1~${pages.length} 之间`);
      return;
    }
    setError('');
    jumpToPage(n);
    setJumpPage('');
  };

  const resetAnswer = () => {
    setAnswer('');
    setQuestion('');
  };

  // ========== 页面内搜索 ==========
  const runSearch = (query) => {
    if (!query || pages.length === 0) {
      setSearchResults([]);
      setSearchIndex(0);
      return;
    }
    const q = query.toLowerCase();
    const results = [];
    for (const p of pages) {
      const text = (p.text || '').toLowerCase();
      if (!text) continue;
      let idx = text.indexOf(q);
      while (idx !== -1) {
        results.push({ page: p.page, index: idx, length: query.length });
        idx = text.indexOf(q, idx + q.length);
      }
    }
    setSearchResults(results);
    setSearchIndex(0);
    if (results.length > 0) jumpToPage(results[0].page);
  };

  const gotoSearchResult = (dir) => {
    if (searchResults.length === 0) return;
    let next = searchIndex + dir;
    if (next < 0) next = searchResults.length - 1;
    if (next >= searchResults.length) next = 0;
    setSearchIndex(next);
    jumpToPage(searchResults[next].page);
  };

  // ========== 批注持久化 ==========
  const saveAnnotations = (list) => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.annotations = list;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  };

  const loadAnnotations = () => {
    if (!storageKey) return [];
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      return Array.isArray(data.annotations) ? data.annotations : [];
    } catch {}
    return [];
  };

  const addAnnotation = (selectedText, page, note, color) => {
    const a = {
      id: 'ann-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      text: selectedText,
      page,
      note,
      color,
      createdAt: Date.now(),
    };
    const next = [...annotations, a];
    setAnnotations(next);
    saveAnnotations(next);
  };

  const removeAnnotation = (id) => {
    const next = annotations.filter((a) => a.id !== id);
    setAnnotations(next);
    saveAnnotations(next);
  };

  const updateAnnotationNote = (id, note) => {
    const next = annotations.map((a) => (a.id === id ? { ...a, note } : a));
    setAnnotations(next);
    saveAnnotations(next);
  };

  // ========== 术语表导出 ==========
  const exportTerms = (format) => {
    if (terms.length === 0) return;
    if (format === 'json') {
      const blob = new Blob([JSON.stringify(terms, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename || 'terms'}-术语表.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (format === 'csv') {
      const rows = [['术语', '中文译名', '释义', '领域', '出现页']];
      for (const t of terms) {
        const defs = (t.definitions || []).map((d) => `${d.domain}: ${d.definition}`).join(' | ');
        rows.push([
          t.term,
          t.translation || '',
          defs,
          (t.definitions || []).map((d) => d.domain).join(' | '),
          (t.pages || []).join(','),
        ]);
      }
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename || 'terms'}-术语表.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // ========== 阅读进度 ==========
  const readingProgress = useMemo(() => {
    if (pages.length === 0 || currentPage == null) return 0;
    return Math.round((currentPage / pages.length) * 100);
  }, [pages.length, currentPage]);

  // ========== 快捷键 ==========
  useEffect(() => {
    const onKey = (e) => {
      // Ctrl/Cmd+F 打开搜索
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      // Escape 关闭搜索
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSearch]);

  const handleUpload = async (file) => {
    setError('');
    setBusy(true);
    try {
      const data = await uploadDocument(file);
      docFileRef.current = file;
      // 重置上一本书留下的所有内容状态（阅读位置、目录、术语表、编辑中等）
      setPages(data.pages || []);
      setFilename(data.filename);
      setOutline(data.outline || []);
      setOutlineParsed(false);
      setTocFixes({});
      setFixingItem(null);
      setSessionId(null);
      setChatHistory([]);
      setSelection(null);
      setPendingContext(null);
      setOcrLoading({});
      resetAnswer();
      setTerms([]);
      setTermsLoading(false);
      setTermsProgress(null);
      setShowTerms(false);
      setShowOutline(false);
      setTocLoading(false);
      setTocOcrProgress(null);
      setTocAiProgress(null);
      setEditingPage(null);
      setEditText('');
      setBookmarks([]); // 新书书签由上传后的恢复逻辑写入
      setCurrentPage(null);
      setJumpPage('');
      setAnnotations([]); // 新书批注由上传后的恢复逻辑写入
      setShowSearch(false);
      setSearchResults([]);
      setSearchQuery('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  };

  // 上传术语库 xlsx
  const onGlossaryChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const data = await uploadGlossary(file);
      setGlossary(data.terms || []);
      setGlossaryName(file.name);
    } catch (err) {
      setError(err.message);
    }
  };

  const clearGlossary = () => {
    setGlossary([]);
    setGlossaryName('');
  };

  // 领域多选：点选预设领域或自定义添加
  const toggleField = (f) => {
    setFields((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  };
  const addCustomField = () => {
    const v = customField.trim();
    if (v && !fields.includes(v)) setFields((prev) => [...prev, v]);
    setCustomField('');
  };
  const removeField = (f) => setFields((prev) => prev.filter((x) => x !== f));

  const handleMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || !textRef.current || !sel.anchorNode) return;
    if (!textRef.current.contains(sel.anchorNode)) return;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // 用页面绝对坐标，弹窗用 absolute 定位，不随滚动漂移
    setSelection({
      kind: 'text',
      text,
      x: rect.left + window.scrollX,
      y: rect.bottom + window.scrollY,
      key: Date.now(),
    });
    setPendingContext({ isFormula: false, selectedText: text });
    resetAnswer();
  };

  const handleFormulaClick = (latex, e) => {
    e.stopPropagation();
    setSelection({
      kind: 'formula',
      latex,
      x: e.clientX + window.scrollX,
      y: e.clientY + window.scrollY,
      key: Date.now(),
    });
    setPendingContext({ isFormula: true, latex });
    resetAnswer();
  };

  // 点击术语：作为选中文本发起提问
  const handleTermClick = (term, e) => {
    e.stopPropagation();
    setSelection({
      kind: 'text',
      text: term,
      x: e.clientX + window.scrollX,
      y: e.clientY + window.scrollY,
      key: Date.now(),
    });
    setPendingContext({ isFormula: false, selectedText: term });
    resetAnswer();
  };

  // 自动提取术语并标注领域
  const handleExtractTerms = async () => {
    if (pages.length === 0) return;
    setTermsLoading(true);
    setTermsProgress(null);
    setError('');
    try {
      const res = await extractTerms({
        pages,
        field: fields,
        onProgress: (done, total) => setTermsProgress({ done, total }),
      });
      setTerms(res.terms || []);
      setShowTerms(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setTermsLoading(false);
      setTermsProgress(null);
    }
  };

  // 打开目录解析配置框（默认前 12 页，用户可指定页码范围）
  const openTocConfig = () => {
    if (pages.length === 0 || !docFileRef.current) return;
    setTocStart('1');
    setTocEnd(String(Math.min(12, pages.length)));
    setShowTocConfig(true);
  };

  // 按用户指定页码范围 OCR + AI 解析目录
  const doParseToc = async () => {
    setShowTocConfig(false);
    setTocLoading(true);
    setError('');
    try {
      let start = parseInt(tocStart, 10) || 1;
      let end = parseInt(tocEnd, 10) || Math.min(12, pages.length);
      start = Math.max(1, Math.min(start, pages.length));
      end = Math.max(start, Math.min(end, pages.length));

      const collected = [];
      const totalPages = end - start + 1;
      for (let i = start; i <= end; i++) {
        setTocOcrProgress({ done: i - start + 1, total: totalPages });
        const p = pages[i - 1];
        let text = p.text || '';
        if (!text.trim()) {
          // 扫描页：渲染为图片后 OCR
          const image = await renderPageToBase64(docFileRef.current, i, 2);
          const res = await ocrImage({ image });
          text = res.text || '';
        }
        if (text.trim()) collected.push({ page: i, text });
      }
      setTocOcrProgress(null); // OCR 完成，进入 AI 分批解析

      if (collected.length === 0) {
        setError('指定范围内没有可识别文字，请确认页码范围或文档是否扫描版。');
        return;
      }

      // 后端分批调 AI（目录太长时一次输出会被截断），SSE 回传进度
      const res = await parseToc({
        pages: collected,
        onProgress: (done, total) => setTocAiProgress({ done, total }),
      });
      // page 保留原始标签（可能是 "12" 或 "4-20" 这类「章-页」格式），跳转时再换算
      const toc = (res.outline || []).map((o) => ({ ...o, items: [] }));
      if (toc.length === 0) {
        setError('未在指定范围内识别到目录，请调整页码范围后重试。');
        return;
      }
      tocRangeRef.current = { start, end };
      setOutline(toc);
      setOutlineParsed(true);
      setShowOutline(true);
      persistOutline(toc, tocOffset, { start, end }); // 保存结果，下次打开免重新解析
    } catch (e) {
      setError(e.message);
    } finally {
      setTocLoading(false);
      setTocOcrProgress(null);
      setTocAiProgress(null);
    }
  };

  // 把全部页文字规范化后拼成一条长串，用于按标题定位章节所在 PDF 页。
  // 规范化会去掉所有非字母数字字符，兼容文字层/OCR 里常见的字符间多空格问题。
  const normTextIndex = useMemo(() => {
    let big = '';
    const marks = [];
    for (const p of pages) {
      const t = normForSearch(p.text || '');
      if (!t) continue;
      marks.push({ page: p.page, start: big.length });
      big += t + '\u0001'; // 页间分隔符，防止跨页误匹配
    }
    return { big, marks };
  }, [pages]);

  // 在全书文字里搜索标题，返回标题所在的 PDF 页码（跳过目录页自身）。找不到返回 null。
  // 结果按标题缓存（pages 变化时随 normTextIndex 一起失效），避免目录面板重渲染时反复全文搜索。
  const titlePageCacheRef = useRef({ index: null, cache: new Map() });
  const findPageByTitle = (title) => {
    if (titlePageCacheRef.current.index !== normTextIndex) {
      titlePageCacheRef.current = { index: normTextIndex, cache: new Map() };
    }
    const cache = titlePageCacheRef.current.cache;
    if (cache.has(title)) return cache.get(title);

    // 先按完整标题找；找不到再尝试去掉开头的章节编号（扫描件正文标题的识别常有出入）
    let result = locateNorm(normForSearch(title));
    if (result == null) {
      const stripped = stripSectionPrefix(String(title || ''));
      if (stripped) result = locateNorm(normForSearch(stripped));
    }
    cache.set(title, result);
    return result;
  };

  // 在规范化全文里搜索 key，返回所在 PDF 页码；命中目录页自身时跳过继续找
  const locateNorm = (key) => {
    if (key.length < 8) return null; // 太短容易误匹配
    const range = tocRangeRef.current;
    let from = 0;
    while (true) {
      const idx = normTextIndex.big.indexOf(key, from);
      if (idx < 0) return null;
      const mark = normTextIndex.marks.findLast((m) => m.start <= idx);
      const pg = mark ? mark.page : null;
      if (!range || pg == null || pg < range.start || pg > range.end) return pg;
      from = idx + 1; // 命中目录页自身，继续往后找
    }
  };

  // 目录条目 → 实际 PDF 页码：
  // 纯数字页码直接加偏移量；「章-页」格式（如 4-20）无法换算，退而搜索标题定位。
  const resolveTocPage = (item) => {
    const label = String(item.page ?? '').trim();
    if (/^\d+$/.test(label)) {
      return Number(label) + (parseInt(tocOffset, 10) || 0);
    }
    return findPageByTitle(item.title);
  };

  const runAsk = async (followUp, termPreferences) => {
    if (!pendingContext) return;
    setAsking(true);
    setError('');
    try {
      const sid =
        sessionId ||
        (crypto.randomUUID
          ? crypto.randomUUID()
          : 'sid-' + Math.random().toString(36).slice(2));

      const defaultMessage = pendingContext.isFormula
        ? '请讲解这个公式的含义、每个符号的作用和推导过程。'
        : `请解释下面这段话：\n${pendingContext.selectedText}`;

      // 读取该 session 已有的历史（可能是新建 session，也可能是恢复的）
      const existingHistory = chatHistory.length > 0
        ? chatHistory
        : (loadChatHistory(sid) || []);

      const res = await askAI({
        sessionId: sid,
        message: followUp || defaultMessage,
        context: { ...pendingContext, field: fields, termPreferences },
        history: existingHistory,
      });
      const nextHistory = Array.isArray(res.history) ? res.history : existingHistory;
      setSessionId(sid);
      setChatHistory(nextHistory);
      saveChatHistory(sid, nextHistory);
      setAnswer(res.answer);
    } catch (e) {
      setError(e.message);
    } finally {
      setAsking(false);
    }
  };

  const handleExplain = (termPreferences) => runAsk(null, termPreferences);

  const handleFollowUp = () => {
    if (!question.trim()) return;
    runAsk(question.trim());
  };

  // 把某页 OCR 文字写入缓存（新建/覆盖），下次打开直接恢复
  const saveOcrCache = (pageNumber, text) => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw ? JSON.parse(raw) : {};
      data.ocrCache = { ...(data.ocrCache || {}), [pageNumber]: text };
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {}
  };

  // 更新某页文字并同步缓存
  const applyPageText = (pageNumber, text) => {
    setPages((prev) =>
      prev.map((p) => (p.page === pageNumber ? { ...p, text, ocr: true } : p))
    );
    saveOcrCache(pageNumber, text);
  };

  // OCR 识别某页。scale 越大越清晰，重识别用 3
  const handleOcrPage = async (pageNumber, scale = 2) => {
    if (!docFileRef.current) return;
    setOcrLoading((s) => ({ ...s, [pageNumber]: true }));
    setError('');
    try {
      const image = await renderPageToBase64(docFileRef.current, pageNumber, scale);
      const res = await ocrImage({ image });
      applyPageText(pageNumber, res.text);
    } catch (e) {
      setError(e.message);
    } finally {
      setOcrLoading((s) => ({ ...s, [pageNumber]: false }));
    }
  };

  // 进入手动编辑
  const startEdit = (pageNumber, text) => {
    setEditingPage(pageNumber);
    setEditText(text);
  };

  // 保存手动编辑，写回缓存
  const saveEdit = () => {
    if (editingPage == null) return;
    applyPageText(editingPage, editText);
    setEditingPage(null);
    setEditText('');
  };

  const cancelEdit = () => {
    setEditingPage(null);
    setEditText('');
  };

  // 框选区域翻译：扫描页原图上拖框，框内先 OCR 再翻译
  const [boxMode, setBoxMode] = useState({}); // { [page]: true } 哪些页处于框选模式
  const [boxResult, setBoxResult] = useState({}); // { [page]: { ocr, translation, loading } }
  // 公式识别：{ [page]: { formulas: [latex], loading } }
  const [formulaResult, setFormulaResult] = useState({});

  const toggleBoxMode = (page) => {
    setBoxMode((s) => ({ ...s, [page]: !s[page] }));
    if (boxMode[page]) {
      // 退出框选清掉结果
      setBoxResult((s) => ({ ...s, [page]: null }));
    }
  };

  // 框选完成：裁剪出的区域图 -> OCR -> 翻译
  const handleBoxRegion = async (page, base64) => {
    setBoxResult((s) => ({ ...s, [page]: { ocr: '', translation: '', loading: true } }));
    setError('');
    try {
      const ocrRes = await ocrImage({ image: base64 });
      const ocrText = ocrRes.text || '';
      let translation = '';
      if (ocrText.trim() && !isChineseText(ocrText)) {
        const tr = await translateText({ text: ocrText, field: fields, glossary });
        translation = tr.translation;
      }
      setBoxResult((s) => ({ ...s, [page]: { ocr: ocrText, translation, loading: false } }));
    } catch (e) {
      setBoxResult((s) => ({ ...s, [page]: null }));
      setError('框选识别失败：' + e.message);
    }
  };

  // 公式识别：整页扫描图转 LaTeX 列表，可点击提问
  const handleFormulaOcr = async (pageNumber) => {
    if (!docFileRef.current) return;
    setFormulaResult((s) => ({ ...s, [pageNumber]: { formulas: [], loading: true } }));
    setError('');
    try {
      const image = await renderPageToBase64(docFileRef.current, pageNumber, 2);
      const res = await ocrFormula({ image });
      setFormulaResult((s) => ({
        ...s,
        [pageNumber]: { formulas: res.formulas || [], loading: false },
      }));
    } catch (e) {
      setFormulaResult((s) => ({ ...s, [pageNumber]: null }));
      setError('公式识别失败：' + e.message);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>专业书伴读</h1>
        <div className="controls">
          <div className="field-select">
            <button
              className={`field-toggle ${fields.length ? 'on' : ''}`}
              onClick={() => setShowFields((v) => !v)}
              title="选择本书领域（可多选，支持交叉学科）"
            >
              领域{fields.length ? `（${fields.length}）` : ''}
            </button>
            {showFields && (
              <div className="field-panel">
                <div className="field-presets">
                  {PRESET_FIELDS.map((f) => (
                    <button
                      key={f}
                      className={`field-chip ${fields.includes(f) ? 'on' : ''}`}
                      onClick={() => toggleField(f)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <div className="field-custom">
                  <input
                    type="text"
                    placeholder="自定义领域，回车添加"
                    value={customField}
                    onChange={(e) => setCustomField(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCustomField()}
                  />
                  <button onClick={addCustomField}>添加</button>
                </div>
                {fields.length > 0 && (
                  <div className="field-selected">
                    {fields.map((f) => (
                      <span key={f} className="field-selected-tag">
                        {f}
                        <button className="field-remove" onClick={() => removeField(f)}>×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <button onClick={() => glossaryRef.current?.click()}>
            {glossaryName ? `术语库：${glossaryName}（${glossary.length}条）` : '导入术语库'}
          </button>
          <input
            ref={glossaryRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={onGlossaryChange}
            hidden
          />
          {glossaryName && (
            <button className="glossary-clear" onClick={clearGlossary} title="清除术语库">
              ×
            </button>
          )}
          <button onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? '解析中…' : '导入 PDF'}
          </button>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={onFileChange} hidden />
          <div className="trans-modes">
            {[
              ['off', '划选'],
              ['para', '整段'],
              ['bilingual', '中英对照'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                className={`trans-mode-btn ${transMode === mode ? 'on' : ''}`}
                onClick={() => setTransMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="cache-btn"
            onClick={handleExtractTerms}
            disabled={termsLoading || pages.length === 0}
          >
            {termsLoading
              ? termsProgress
                ? `提取术语 ${termsProgress.done}/${termsProgress.total}`
                : '提取中…'
              : '提取术语'}
          </button>
          {outline.length > 0 ? (
            <button className="cache-btn" onClick={() => setShowOutline(true)}>目录</button>
          ) : (
            pages.length > 0 && (
              <button className="cache-btn" onClick={openTocConfig} disabled={tocLoading}>
                {tocLoading
                  ? tocOcrProgress
                    ? `识别目录 ${tocOcrProgress.done}/${tocOcrProgress.total}`
                    : tocAiProgress
                      ? `AI 解析 ${tocAiProgress.done}/${tocAiProgress.total}`
                      : 'AI 解析中…'
                  : '解析目录'}
              </button>
            )
          )}
          <button className="cache-btn" onClick={() => setShowCache(true)}>缓存管理</button>
          {annotations.length > 0 && (
            <button className="cache-btn" onClick={() => setShowAnnotations((v) => !v)}>
              📝 批注 ({annotations.length})
            </button>
          )}
        </div>
      </header>

      {showCache && <CacheManager onClose={() => setShowCache(false)} />}

      {showTocConfig && (
        <div className="cache-overlay" onClick={() => setShowTocConfig(false)}>
          <div className="cache-panel" onClick={(e) => e.stopPropagation()}>
            <div className="cache-head">
              <h2>解析目录</h2>
              <button className="cache-close" onClick={() => setShowTocConfig(false)}>×</button>
            </div>
            <div className="toc-config">
              <div className="toc-config-row">
                <span>目录页码范围：</span>
                <input
                  type="number"
                  min="1"
                  max={pages.length}
                  value={tocStart}
                  onChange={(e) => setTocStart(e.target.value)}
                  placeholder="起始页"
                />
                <span>~</span>
                <input
                  type="number"
                  min="1"
                  max={pages.length}
                  value={tocEnd}
                  onChange={(e) => setTocEnd(e.target.value)}
                  placeholder="结束页"
                />
                <span className="toc-config-hint">（共 {pages.length} 页）</span>
              </div>
              <div className="toc-config-tip">
                目录通常在书的前几页到二十几页。若扫描版目录页没有文字，会自动 OCR 后识别。
              </div>
              <div className="popup-actions">
                <button onClick={doParseToc} disabled={tocLoading}>
                  {tocLoading ? '解析中…' : '开始解析'}
                </button>
                <button className="ocr-edit-cancel" onClick={() => setShowTocConfig(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOutline && outline.length > 0 && (
        <div className="cache-overlay" onClick={() => setShowOutline(false)}>
          <div className="cache-panel" onClick={(e) => e.stopPropagation()}>
            <div className="cache-head">
              <h2>目录</h2>
              <button className="cache-close" onClick={() => setShowOutline(false)}>×</button>
            </div>
            <div className="toc-offset">
              <span>页码偏移：</span>
              <input
                type="number"
                value={tocOffset}
                onChange={(e) => setTocOffset(e.target.value)}
                placeholder="0"
              />
              <span className="toc-offset-hint">目录页码比 PDF 页少的差值（如目录第1页实际在第15页，填14）</span>
            </div>
            <div className="outline">
              <OutlineList
                items={outline}
                offset={parseInt(tocOffset, 10) || 0}
                resolvePage={outlineParsed ? resolveTocPage : undefined}
                fixes={tocFixes}
                onFix={outlineParsed ? startFixTocItem : undefined}
                onJump={(page) => {
                  jumpToPage(page);
                  setShowOutline(false);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {/* 定位模式：为某个目录条目手动指定跳转页码。翻到目标页（浮动条实时显示当前页）或直接输入页码。 */}
      {fixingItem && (
        <div className="toc-fix-bar">
          <div className="toc-fix-info">
            <div className="toc-fix-title" title={fixingItem.title}>
              正在定位：{fixingItem.title}
            </div>
            <div className="toc-fix-hint">
              翻到该章节实际所在页（当前第 {currentPage ?? '—'} 页），或直接输入页码后确认
            </div>
          </div>
          <input
            type="number"
            min="1"
            max={pages.length}
            value={fixingPage}
            onChange={(e) => setFixingPage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmTocFix()}
            placeholder="PDF 页码"
          />
          <button className="toc-fix-confirm" onClick={confirmTocFix}>确认</button>
          <button className="toc-fix-cancel" onClick={cancelTocFix}>取消</button>
        </div>
      )}

      {showTerms && (
        <div className="terms-panel">
          <div className="terms-head">
            <span>术语表（{terms.length} 个术语）</span>
            <div className="terms-actions">
              {terms.length > 0 && (
                <>
                  <button className="terms-export" onClick={() => exportTerms('json')} title="导出 JSON">导出 JSON</button>
                  <button className="terms-export" onClick={() => exportTerms('csv')} title="导出 CSV (Excel 可打开)">导出 CSV</button>
                </>
              )}
              <button className="terms-close" onClick={() => setShowTerms(false)}>收起</button>
            </div>
          </div>
          {terms.length === 0 ? (
            <div className="terms-empty">未提取到术语。</div>
          ) : (
            <div className="terms-list">
              {terms.map((t) => {
                // 当前领域优先：匹配当前选中领域的释义排前面
                const defs = [...(t.definitions || [])].sort((a, b) => {
                  const ai = fields.includes(a.domain) ? 0 : 1;
                  const bi = fields.includes(b.domain) ? 0 : 1;
                  return ai - bi;
                });
                return (
                  <div key={t.term} className="term-card">
                    <button className="term-name" onClick={(e) => handleTermClick(t.term, e)}>
                      {t.term}
                      {t.translation && t.translation !== t.term && (
                        <span className="term-trans">（{t.translation}）</span>
                      )}
                    </button>
                    <div className="term-defs">
                      {defs.map((d, i) => (
                        <div key={i} className="term-def">
                          {d.domain && <span className="term-domain">{d.domain}</span>}
                          <span className="term-def-text">{d.definition}</span>
                        </div>
                      ))}
                    </div>
                    {t.pages && t.pages.length > 0 && (
                      <div className="term-pages">出现：第 {t.pages.join('、')} 页</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {filename && (
        <div className="doc-bar">
          <div className="doc-name">当前文档：{filename}</div>
          <div className="bookmark-bar">
            {currentPage != null && <span className="current-page">第 {currentPage} 页 / 共 {pages.length} 页</span>}
            <div className="jump-control">
              <input
                type="number"
                min="1"
                max={pages.length}
                placeholder={`1~${pages.length}`}
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJumpPage()}
              />
              <button onClick={handleJumpPage}>跳转</button>
            </div>
            <button className="bookmark-add" onClick={addBookmark} disabled={currentPage == null}>
              + 书签
            </button>
            <button className="search-btn" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50); }} title="搜索 (Ctrl+F)">
              🔍 搜索
            </button>
            {bookmarks.length > 0 && (
              <div className="bookmarks">
                {bookmarks.map((p) => (
                  <span key={p} className="bookmark">
                    <button className="bookmark-jump" onClick={() => jumpToPage(p)}>
                      第 {p} 页
                    </button>
                    <button className="bookmark-del" onClick={() => removeBookmark(p)} title="删除书签">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <main className="content">
        <div className="text-area" ref={textRef} onMouseUp={handleMouseUp} onTouchEnd={handleMouseUp}>
          {pages.length === 0 ? (
            <div className="placeholder">
              点击右上角「导入 PDF」开始阅读。选中文字或点击公式即可提问。
            </div>
          ) : (
            pages.map((p) => (
              <section key={p.page} id={`page-${p.page}`} data-page={p.page} className="page">
                <div className="page-label">
                  <span>第 {p.page} 页</span>
                  {bookmarks.includes(p.page) ? (
                    <button
                      className="page-bookmark marked"
                      onClick={() => removeBookmark(p.page)}
                      title="点击移除书签"
                    >
                      ★ 已加书签
                    </button>
                  ) : (
                    <button
                      className="page-bookmark"
                      onClick={() => addBookmarkAt(p.page)}
                      title="给本页添加书签"
                    >
                      ☆ 添加书签
                    </button>
                  )}
                </div>
                {docFileRef.current && (
                  <PageImage
                    file={docFileRef.current}
                    pageNumber={p.page}
                    boxSelect={!p.text && boxMode[p.page]}
                    onBoxRegion={(base64) => handleBoxRegion(p.page, base64)}
                  />
                )}
                {p.text ? (
                  editingPage === p.page ? (
                    <div className="ocr-edit">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={Math.min(Math.max(editText.split('\n').length + 2, 6), 30)}
                      />
                      <div className="ocr-edit-actions">
                        <button onClick={saveEdit}>保存</button>
                        <button className="ocr-edit-cancel" onClick={cancelEdit}>取消</button>
                      </div>
                    </div>
                  ) : transMode !== 'off' ? (
                    // 自动翻译模式：整段 / 中英对照
                    splitParagraphs(p.text).map((para, i) =>
                      transMode === 'bilingual' ? (
                        <BilingualPara
                          key={i}
                          text={para}
                          field={fields}
                          glossary={glossary}
                          onFormulaClick={handleFormulaClick}
                        />
                      ) : (
                        <AutoPara
                          key={i}
                          text={para}
                          field={fields}
                          glossary={glossary}
                          onFormulaClick={handleFormulaClick}
                        />
                      )
                    )
                  ) : (
                    <>
                      <p className="page-text">
                        {splitMath(p.text).map((seg, i) =>
                          seg.type === 'text' ? (
                            <span key={i}>{seg.content}</span>
                          ) : (
                            <Formula
                              key={i}
                              latex={seg.content}
                              display={seg.type === 'display'}
                              onClick={(e) => handleFormulaClick(seg.content, e)}
                            />
                          )
                        )}
                      </p>
                      {p.ocr && (
                        <div className="ocr-actions">
                          <button
                            className="ocr-btn"
                            onClick={() => handleOcrPage(p.page, 3)}
                            disabled={ocrLoading[p.page]}
                            title="用更高清晰度重新识别，覆盖当前结果"
                          >
                            {ocrLoading[p.page] ? '识别中…' : '↻ 重新识别'}
                          </button>
                          <button
                            className="ocr-btn"
                            onClick={() => startEdit(p.page, p.text)}
                            title="手动修改识别文字"
                          >
                            ✎ 编辑
                          </button>
                        </div>
                      )}
                    </>
                  )
                ) : (
                  <div className="scan-page">
                    <span>（扫描版，无文字层）</span>
                    <button onClick={() => handleOcrPage(p.page)} disabled={ocrLoading[p.page]}>
                      {ocrLoading[p.page] ? '识别中…' : 'OCR 识别本页'}
                    </button>
                    <button
                      onClick={() => handleFormulaOcr(p.page)}
                      disabled={formulaResult[p.page]?.loading}
                      title="识别本页数学公式，转 LaTeX 可点击提问"
                    >
                      {formulaResult[p.page]?.loading ? '识别中…' : '公式识别'}
                    </button>
                    <button
                      className={`box-toggle ${boxMode[p.page] ? 'on' : ''}`}
                      onClick={() => toggleBoxMode(p.page)}
                      title="在上方原图上拖框，框内文字先 OCR 再翻译"
                    >
                      {boxMode[p.page] ? '退出框选' : '框选翻译'}
                    </button>
                  </div>
                )}
                {!p.text && formulaResult[p.page] && !formulaResult[p.page].loading && (
                  <div className="formula-result">
                    {formulaResult[p.page].formulas.length === 0 ? (
                      <div className="box-line">本页未识别到公式</div>
                    ) : (
                      <>
                        <div className="formula-result-title">识别到 {formulaResult[p.page].formulas.length} 个公式（点击可提问）：</div>
                        {formulaResult[p.page].formulas.map((latex, i) => (
                          <div key={i} className="formula-result-item">
                            <Formula
                              latex={latex}
                              display
                              onClick={(e) => handleFormulaClick(latex, e)}
                            />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
                {!p.text && boxMode[p.page] && boxResult[p.page] && (
                  <div className="box-result">
                    {boxResult[p.page].loading ? (
                      <div className="box-line">识别翻译中…</div>
                    ) : (
                      <>
                        {boxResult[p.page].ocr && (
                          <div className="box-line">
                            <span className="box-label">识别：</span>
                            {boxResult[p.page].ocr}
                          </div>
                        )}
                        {boxResult[p.page].translation && (
                          <div className="box-line">
                            <span className="box-label">译文：</span>
                            {boxResult[p.page].translation}
                          </div>
                        )}
                        {!boxResult[p.page].ocr && <div className="box-line">框内未识别到文字</div>}
                      </>
                    )}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </main>

      {selection && (
        <SelectionPopup
          key={selection.key}
          selection={selection}
          field={fields}
          glossary={glossary}
          asking={asking}
          onExplain={handleExplain}
          onClose={() => setSelection(null)}
          answer={answer}
          question={question}
          onQuestionChange={setQuestion}
          onFollowUp={handleFollowUp}
          onAddAnnotation={(text, page) => {
            addAnnotation(text, page, '', newNoteColor);
            setSelection(null);
          }}
          currentPage={currentPage}
        />
      )}

      {showSearch && (
        <div className="search-overlay">
          <div className="search-box">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索文字 (Ctrl+F)"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); runSearch(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') gotoSearchResult(e.shiftKey ? -1 : 1); }}
            />
            <span className="search-count">
              {searchResults.length > 0 ? `${searchIndex + 1} / ${searchResults.length}` : '0 结果'}
            </span>
            <button className="search-nav" onClick={() => gotoSearchResult(-1)} disabled={searchResults.length === 0}>↑</button>
            <button className="search-nav" onClick={() => gotoSearchResult(1)} disabled={searchResults.length === 0}>↓</button>
            <button className="search-close" onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]); }}>×</button>
          </div>
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.slice(0, 20).map((r, i) => {
                const pageText = (pages.find((p) => p.page === r.page)?.text || '').toLowerCase();
                const start = Math.max(0, r.index - 20);
                const end = Math.min(pageText.length, r.index + r.length + 40);
                const snippet = pageText.slice(start, end);
                return (
                  <div
                    key={i}
                    className={`search-result-item ${i === searchIndex ? 'on' : ''}`}
                    onClick={() => { setSearchIndex(i); jumpToPage(r.page); }}
                  >
                    <span className="search-result-page">第 {r.page} 页</span>
                    <span className="search-result-snippet">...{snippet}...</span>
                  </div>
                );
              })}
              {searchResults.length > 20 && (
                <div className="search-more">还有 {searchResults.length - 20} 条结果，请使用 ↑↓ 导航</div>
              )}
            </div>
          )}
        </div>
      )}

      {annotations.length > 0 && (
        <div className="annotations-panel">
          <div className="annotations-head">
            <span>我的批注（{annotations.length} 条）</span>
            <button className="annotations-toggle" onClick={() => setShowAnnotations((v) => !v)}>
              {showAnnotations ? '收起' : '展开'}
            </button>
          </div>
          {showAnnotations && (
            <div className="annotations-list">
              {annotations.map((a) => (
                <div key={a.id} className="annotation-item" style={{ borderLeftColor: a.color }}>
                  <div className="annotation-text" onClick={() => jumpToPage(a.page)} title="点击跳转到原文">
                    <span className="annotation-page">第 {a.page} 页</span>
                    <span className="annotation-quoted">"{a.text.length > 60 ? a.text.slice(0, 60) + '…' : a.text}"</span>
                  </div>
                  <div className="annotation-note-row">
                    <input
                      className="annotation-note"
                      placeholder="添加批注..."
                      value={a.note}
                      onChange={(e) => updateAnnotationNote(a.id, e.target.value)}
                    />
                    <input
                      type="color"
                      className="annotation-color"
                      value={a.color}
                      onChange={(e) => {
                        const next = annotations.map((x) => x.id === a.id ? { ...x, color: e.target.value } : x);
                        setAnnotations(next);
                        saveAnnotations(next);
                      }}
                      title="标记颜色"
                    />
                    <button className="annotation-del" onClick={() => removeAnnotation(a.id)} title="删除批注">×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {filename && pages.length > 0 && (
        <div className="progress-bar-fixed" title={`阅读进度 ${readingProgress}% (第 ${currentPage ?? 0} / ${pages.length} 页)`}>
          <div className="progress-fill" style={{ width: `${readingProgress}%` }} />
          <span className="progress-label">{readingProgress}%</span>
        </div>
      )}

      <BackToTop />
    </div>
  );
}

// 回到顶部浮动按钮，滚动一段距离后显示
function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;
  return (
    <button
      className="back-to-top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="回到顶部"
    >
      ↑ 顶部
    </button>
  );
}

// 缓存管理面板：列出所有存过的文档缓存，可单个清除或全部清空
function CacheManager({ onClose }) {
  const [items, setItems] = useState([]);

  const load = () => {
    const list = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('reader:')) continue;
      const raw = localStorage.getItem(key) || '';
      let ocrPages = 0;
      let chatSessions = 0;
      try {
        const data = JSON.parse(raw);
        ocrPages = data.ocrCache ? Object.keys(data.ocrCache).length : 0;
        if (data.chatSessions) {
          chatSessions = Object.keys(data.chatSessions).length;
        }
      } catch {}
      list.push({
        key,
        name: key.slice('reader:'.length),
        size: raw.length,
        ocrPages,
        chatSessions,
      });
    }
    list.sort((a, b) => b.size - a.size);
    setItems(list);
  };

  useEffect(load, []);

  const fmt = (n) =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

  const removeOne = (key) => {
    localStorage.removeItem(key);
    load();
  };

  const clearAll = () => {
    items.forEach((it) => localStorage.removeItem(it.key));
    load();
  };

  const total = items.reduce((s, it) => s + it.size, 0);

  return (
    <div className="cache-overlay" onClick={onClose}>
      <div className="cache-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cache-head">
          <h2>缓存管理</h2>
          <button className="cache-close" onClick={onClose}>×</button>
        </div>
        {items.length === 0 ? (
          <div className="cache-empty">暂无缓存。阅读过的文档会在这里显示。</div>
        ) : (
          <>
            <div className="cache-total">共 {items.length} 个文档，占用 {fmt(total)}</div>
            <ul className="cache-list">
              {items.map((it) => (
                <li key={it.key} className="cache-item">
                  <div className="cache-item-info">
                    <div className="cache-item-name">{it.name}</div>
                    <div className="cache-item-meta">
                      {fmt(it.size)}
                      {it.ocrPages > 0 ? ` · OCR ${it.ocrPages} 页` : ''}
                      {it.chatSessions > 0 ? ` · ${it.chatSessions} 个对话` : ''}
                    </div>
                  </div>
                  <button className="cache-del" onClick={() => removeOne(it.key)}>清除</button>
                </li>
              ))}
            </ul>
            <button className="cache-clear-all" onClick={clearAll}>全部清空</button>
          </>
        )}
      </div>
    </div>
  );
}

// 规范化文字用于搜索匹配：小写 + 只保留字母/数字/中文。
// 文字层或 OCR 常在字符间插入多余空格（如 "In trod u ction"），去空白后才能对上。
function normForSearch(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

// 去掉标题开头的章节编号（如 "4.5.1 Parachute…" → "Parachute…"、"Chapter I Intro…" → "Intro…"）。
// 完整标题在正文里搜不到时，用去掉编号的部分再搜一次。
function stripSectionPrefix(title) {
  let t = title.trim();
  let m = t.match(/^\d+(?:[.\-]\d+)*[.\s]+(.+)$/);
  if (m) t = m[1];
  m = t.match(/^(?:chapter|section|appendix|figure|table|图|表|第[一二三四五六七八九十\d]+[章节])\s*[.:：、]?\s*(?:[ivxlcdm]+|\d+(?:[.\-]\d+)*)\s+(.+)$/i);
  if (m) t = m[1];
  return t.trim();
}

// 递归渲染目录大纲。offset 用于校正目录页码与实际 PDF 页的偏差；
// resolvePage 用于 AI 解析的目录（页码可能是「章-页」格式，需换算成 PDF 页）；
// fixes 是手动修正的页码映射（优先级最高），onFix 点击 ✎ 进入定位模式。
function OutlineList({ items, onJump, offset = 0, resolvePage, fixes = {}, onFix }) {
  return (
    <ul className="outline-list">
      {items.map((item, i) => {
        const fixed = fixes[item.title];
        const targetPage =
          fixed ?? (resolvePage
            ? resolvePage(item)
            : item.page != null && /^\d+$/.test(String(item.page).trim())
              ? Number(item.page) + Number(offset)
              : null);
        const hasZh = item.title_zh && item.title_zh !== item.title;
        return (
          <li key={i} className="outline-item">
            <div className="outline-row">
              <button
                className="outline-title"
                onClick={() => targetPage != null && onJump(targetPage)}
                disabled={targetPage == null}
              >
                {item.title}
                {hasZh && <span className="outline-zh">（{item.title_zh}）</span>}
              </button>
              {item.page != null && (
                <span className={`outline-page${fixed ? ' outline-page-fixed' : ''}`}>
                  {fixed != null ? `第${fixed}页 ✓` : targetPage ?? String(item.page)}
                </span>
              )}
              {onFix && (
                <button
                  className="outline-fix"
                  onClick={() => onFix(item)}
                  title="手动修正跳转页码（翻到目标页确认）"
                >
                  ✎
                </button>
              )}
            </div>
            {item.items && item.items.length > 0 && (
              <OutlineList items={item.items} onJump={onJump} offset={offset} resolvePage={resolvePage} fixes={fixes} onFix={onFix} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// 选中后的弹出面板。文字选中会自动翻译；点「讲解」才调 AI 解释。
function SelectionPopup({
  selection,
  field,
  glossary,
  asking,
  onExplain,
  onClose,
  answer,
  question,
  onQuestionChange,
  onFollowUp,
  onAddAnnotation,
  currentPage,
}) {
  const [translation, setTranslation] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState('');
  // 歧义术语确认：待确认的术语列表 + 用户选中的含义
  const [pendingTerms, setPendingTerms] = useState(null); // [{ term, candidates }]
  const [chosen, setChosen] = useState({}); // { term: meaning }
  const [disamLoading, setDisamLoading] = useState(false);

  // 术语偏好：localStorage 存 { "领域:term": "含义" }。领域为多选时用「、」合并成 key。
  const PREFS_KEY = 'reader:termPrefs';
  const fieldKey = Array.isArray(field) ? field.join('、') : field || '';
  const loadPrefs = () => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  };
  const getPref = (term) => loadPrefs()[`${fieldKey}:${term}`] || null;
  const setPref = (term, meaning) => {
    const all = loadPrefs();
    all[`${fieldKey}:${term}`] = meaning;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(all));
    } catch {}
  };

  // 点击弹窗外部任意处关闭（桌面 mousedown + 移动端 touchstart）
  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [onClose]);

  // 文字选中即自动翻译（中文文献跳过）
  useEffect(() => {
    if (selection.kind !== 'text') return;
    if (isChineseText(selection.text)) return;
    let cancelled = false;
    setTranslating(true);
    translateText({ text: selection.text, field, glossary })
      .then((res) => {
        if (!cancelled) setTranslation(res.translation);
      })
      .catch((e) => {
        if (!cancelled) setTranslateError(e.message);
      })
      .finally(() => {
        if (!cancelled) setTranslating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection, field, glossary]);

  // 点「讲解」：先检测歧义术语，有歧义则弹出候选确认
  const handleExplainClick = async () => {
    if (selection.kind !== 'text') {
      onExplain([]);
      return;
    }
    setDisamLoading(true);
    try {
      const { terms } = await disambiguate({ text: selection.text, field });
      const prefs = [];
      const pending = [];
      for (const t of terms || []) {
        const meaning = getPref(t.term);
        if (meaning) prefs.push({ term: t.term, meaning });
        else pending.push(t);
      }
      if (pending.length > 0) {
        setPendingTerms(pending);
        setChosen({});
      } else {
        onExplain(prefs);
      }
    } catch {
      // 检测失败就正常讲解
      onExplain([]);
    } finally {
      setDisamLoading(false);
    }
  };

  // 选定某个术语的含义
  const chooseMeaning = (term, meaning) => {
    setPref(term, meaning);
    setChosen((c) => ({ ...c, [term]: meaning }));
  };

  // 全部选完，确认后带偏好讲解
  const confirmChoices = () => {
    const prefs = (pendingTerms || []).map((t) => ({
      term: t.term,
      meaning: chosen[t.term] || getPref(t.term),
    }));
    setPendingTerms(null);
    onExplain(prefs);
  };

  const rootRef = useRef(null);
  const isCjk = selection.kind === 'text' && isChineseText(selection.text);
  const allChosen = pendingTerms && pendingTerms.every((t) => chosen[t.term]);

  return (
    <div className="popup" ref={rootRef} style={{ left: selection.x, top: selection.y + 8 }}>
      {selection.kind === 'formula' ? (
        <div className="popup-formula">
          <Formula latex={selection.latex} display={false} />
        </div>
      ) : (
        <div className="popup-selected">
          {selection.text.slice(0, 60)}
          {selection.text.length > 60 ? '…' : ''}
        </div>
      )}

      {pendingTerms ? (
        <div className="disam">
          <div className="disam-title">发现歧义术语，请选择此处含义：</div>
          {pendingTerms.map((t) => (
            <div key={t.term} className="disam-term">
              <div className="disam-term-name">{t.term}</div>
              <div className="disam-candidates">
                {(t.candidates || []).map((c) => (
                  <button
                    key={c}
                    className={`disam-cand ${chosen[t.term] === c ? 'on' : ''}`}
                    onClick={() => chooseMeaning(t.term, c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="popup-actions">
            <button onClick={confirmChoices} disabled={!allChosen || asking}>
              {asking ? '回答中…' : '确定'}
            </button>
            <button onClick={() => setPendingTerms(null)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="popup-actions">
          <button onClick={handleExplainClick} disabled={asking || disamLoading}>
            {asking ? '回答中…' : disamLoading ? '检测歧义中…' : '讲解'}
          </button>
          <button
            className="popup-annotate"
            onClick={() => {
              if (selection.kind === 'text' && onAddAnnotation && currentPage != null) {
                onAddAnnotation(selection.text, currentPage);
              }
            }}
            title="添加批注"
          >
            📝 批注
          </button>
          <button onClick={onClose}>关闭</button>
        </div>
      )}

      {selection.kind === 'text' && !isCjk && (
        <div className="popup-answer">
          <div className="popup-answer-title">译文</div>
          {translateError ? (
            <div className="popup-answer-text popup-error">翻译失败：{translateError}</div>
          ) : (
            <div className="popup-answer-text">
              {translating ? '翻译中…' : translation}
            </div>
          )}
        </div>
      )}

      {answer && (
        <div className="popup-answer">
          <div className="popup-answer-head">
            <div className="popup-answer-title">AI 讲解</div>
            <button className="popup-new-chat" onClick={() => {
              setSessionId(null);
              setChatHistory([]);
              setAnswer('');
              setQuestion('');
            }} title="开启新对话">新对话</button>
          </div>
          <div className="popup-answer-text">{answer}</div>
          <div className="popup-follow">
            <input
              type="text"
              placeholder="继续追问，如：这个 ∂ 是什么意思？"
              value={question}
              onChange={(e) => onQuestionChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onFollowUp()}
            />
            <button onClick={onFollowUp} disabled={asking}>追问</button>
          </div>
        </div>
      )}
    </div>
  );
}
