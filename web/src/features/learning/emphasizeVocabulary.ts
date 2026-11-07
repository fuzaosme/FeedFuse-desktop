/**
 * 给正文里的生词加标记。
 *
 * 只处理文本节点：原 HTML 结构、链接、图片、行内样式全部保持原样，
 * 标记出来的 `<span data-vocabulary-word>` 自带词条写法，悬停/点击时据此回查生词本。
 * 词组可能被 `<b>`/`<a>` 切开，此时每个片段都指向同一个词条，点哪一段都能打开。
 */
import { createVocabularyMatcher, type VocabularyMatcher } from './vocabularyMatch';

const EXCLUDED = [
  '.ff-translation', '[data-translation]', '[data-ff-translation]', 'pre', 'code', 'kbd', 'samp',
  'button', 'input', 'textarea', 'select', '[contenteditable]', '[role="button"]',
  'script', 'style', 'noscript', 'svg', 'math', '[hidden]', '[aria-hidden="true"]',
].join(',');

const BLOCKS =
  'address,article,aside,blockquote,dd,div,dl,dt,figcaption,figure,footer,header,h1,h2,h3,h4,h5,h6,' +
  'li,main,nav,ol,p,section,table,tbody,td,tfoot,th,thead,tr,ul,hr';

type TextSpan = { node: Text; start: number; end: number };

/** 纯文本（标题、摘要）要先转义再交给 emphasise——标题里的 `<` 不能被当成标签。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param html    文章 HTML
 * @param terms   生词本的词条（也可以用已建好的 matcher，避免每帧重建索引）
 */
export function emphasizeVocabulary(html: string, terms: string[] | VocabularyMatcher): string {
  if (!html || typeof DOMParser !== 'function') return html;
  const matcher = Array.isArray(terms) ? createVocabularyMatcher(terms) : terms;
  if (!matcher.size) return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 支持重复处理（切翻译模式会重跑一遍）而不产生嵌套标记。
  for (const span of doc.querySelectorAll('span[data-vocabulary-word]')) {
    span.replaceWith(...span.childNodes);
  }

  let spans: TextSpan[] = [];
  let text = '';
  const flush = () => {
    if (!spans.length) {
      text = '';
      return;
    }
    const matches = matcher.scan(text);
    if (matches.length) {
      for (const span of spans) {
        const overlaps = matches.filter((match) => match.start < span.end && match.end > span.start);
        if (!overlaps.length) continue;
        const fragment = doc.createDocumentFragment();
        let offset = 0;
        for (const match of overlaps) {
          const from = Math.max(0, match.start - span.start);
          const to = Math.min(span.node.length, match.end - span.start);
          if (to <= offset) continue;
          if (from > offset) fragment.append(span.node.data.slice(offset, from));
          const mark = doc.createElement('span');
          mark.className = 'ff-vocabulary-word';
          mark.setAttribute('data-vocabulary-word', 'true');
          mark.setAttribute('data-vocabulary-term', match.term);
          mark.setAttribute('role', 'button');
          mark.setAttribute('tabindex', '0');
          // 悬停会直接展开释义浮层，不再用原生 title 提示，避免两个提示同时出现。
          mark.setAttribute('aria-label', `生词本：${match.term}`);
          mark.textContent = span.node.data.slice(from, to);
          fragment.append(mark);
          offset = to;
        }
        if (offset < span.node.length) fragment.append(span.node.data.slice(offset));
        span.node.replaceWith(fragment);
      }
    }
    spans = [];
    text = '';
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      if (!value) return;
      spans.push({ node: node as Text, start: text.length, end: text.length + value.length });
      text += value;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(EXCLUDED)) {
      flush();
      return;
    }
    const boundary = node.matches(BLOCKS) || node.tagName === 'BR';
    if (boundary) flush();
    for (const child of [...node.childNodes]) visit(child);
    if (boundary) flush();
  };

  visit(doc.body);
  flush();
  return doc.body.innerHTML;
}
