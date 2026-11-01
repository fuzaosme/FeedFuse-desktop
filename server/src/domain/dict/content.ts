import sanitizeHtml from 'sanitize-html';
import type { EntryContentType } from './types';

/**
 * 把词典里的原始释义整理成可以直接交给前端的形态。
 *
 * MDX 的释义是一整块带外部样式的 HTML：`<link rel=stylesheet href="ODE.css">` 指向
 * 同目录（实际在 .mdd 里）的样式表，`<img src="pr.png">` 指向 .mdd 里的图片。
 * 这些相对路径在 WebView 里既加载不到、也不该加载，所以：
 *   - 丢掉 link/style/script，样式统一由应用控制；
 *   - 把 img 的相对 src 改写成我们自己的资源接口；
 *   - 其余标签过一遍白名单，避免词典自带的奇怪标签把排版搞坏。
 */

const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'small', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

/**
 * @param resourceUrl 把词典内的资源键（如 `pr.png` / `p/abacus.png`）转成可访问的 URL
 */
export function prepareDefinition(
  raw: string,
  contentType: EntryContentType,
  resourceUrl: (key: string) => string,
): string {
  // MDX 的 record 用 \r\n\u0000 收尾，NUL 在 HTML 里是非法字符，先整体清掉。
  const cleaned = raw.replace(/\u0000/g, '').trim();
  if (contentType === 'text') return cleaned;

  const withoutStyles = cleaned
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');

  return sanitizeHtml(withoutStyles, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title'],
      div: ['class', 'style'],
      span: ['class', 'style'],
      td: ['colspan', 'rowspan', 'style'],
      th: ['colspan', 'rowspan', 'style'],
      table: ['style', 'border'],
      img: ['src', 'alt', 'width', 'height'],
      p: ['class', 'style'],
    },
    // 词典里的内联样式只用来做字号/对齐，色值交给主题，避免出现白底黑字或荧光色块。
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^(none|underline|line-through)$/],
        'vertical-align': [/^(top|middle|bottom|baseline)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'data'],
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        if (!src) return { tagName, attribs: {} };
        // 外链图片保持原样；相对路径按词典内部资源处理。
        if (/^(https?:|data:)/i.test(src)) return { tagName, attribs };
        return { tagName, attribs: { ...attribs, src: resourceUrl(src.replace(/^\.?\//, '')) } };
      },
      a: (tagName, attribs) => {
        const href = attribs.href ?? '';
        // `entry://word` 是 MDict 的内部跳转协议，WebView 里点了没反应，去掉更干净。
        if (/^entry:\/\//i.test(href)) {
          const { href: _ignored, ...rest } = attribs;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
    },
  }).trim();
}
