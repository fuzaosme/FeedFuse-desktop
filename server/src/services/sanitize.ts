import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'iframe', 'img', 'ins', 'kbd', 'li', 'mark', 'ol',
  'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'section', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u',
  'ul', 'video', 'audio', 'track',
];

/**
 * 正文净化：保留阅读需要的结构，去掉脚本、事件属性和内联样式污染，
 * iframe 只放行主流视频站，避免变成任意内容的加载器。
 */
export function sanitizeContentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
      video: ['src', 'poster', 'controls', 'width', 'height', 'preload'],
      audio: ['src', 'controls', 'preload'],
      source: ['src', 'srcset', 'type', 'media'],
      iframe: ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'title'],
      '*': ['id', 'class', 'lang', 'dir'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'], iframe: ['https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
      }),
      iframe: (tagName, attribs) => {
        const src = attribs.src ?? '';
        const allowed =
          /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.bilibili\.com|vimeo\.com)\//i.test(
            src,
          );
        if (!allowed) return { tagName: 'span', attribs: {} };
        return { tagName, attribs };
      },
      script: (tagName) => ({ tagName: 'span', attribs: {} }),
      style: (tagName) => ({ tagName: 'span', attribs: {} }),
    },
    exclusiveFilter: (frame) =>
      ['script', 'style', 'noscript'].includes(frame.tag) ||
      (frame.tag === 'span' && !frame.text.trim()),
  });
}

/** 兜底把富文本压成一段纯文本摘要，用于列表和 AI 输入。 */
export function buildSummaryText(html: string, max = 220): string {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
