import katex from 'katex';
import 'katex/dist/katex.min.css';

// 用 KaTeX 渲染一段 LaTeX，点击可触发提问。
export default function Formula({ latex, display = false, onClick }) {
  const html = katex.renderToString(latex, {
    displayMode: display,
    throwOnError: false,
  });

  return (
    <span
      className={'formula' + (display ? ' formula-block' : '')}
      onClick={onClick}
      title="点击提问"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
