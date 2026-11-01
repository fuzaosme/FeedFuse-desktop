/**
 * 取「被点中的生词所在的那一句」。
 *
 * 用途只有两个：生词浮层里展示上下文、以及「加入例句」时把这一句存进生词本。
 * 句子边界交给 Intl.Segmenter（和划词链路同一套），这里只负责把点击位置换算成
 * 文本块内的偏移——不能直接对整块文本做 indexOf，同一个词在段落里可能出现多次。
 */
import { sentenceSpans } from './selection';

/** 句子所在的最小文本块：再往上是 section/div 会把多段并成一句。 */
const BLOCK_SELECTOR =
  'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dd,dt,pre,div,section,article';

/** 单句上限，和服务端 VocabularySentence 的限制保持一致。 */
export const MAX_SENTENCE_CHARS = 600;

export function sentenceAroundElement(element: Element): string {
  const block = element.closest(BLOCK_SELECTOR) ?? element.parentElement;
  if (!block) return '';

  // 从块起点量到点击位置的字符数，得到这段文字里的绝对偏移。
  let offset = 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(element, 0);
    offset = range.toString().length;
  } catch {
    offset = 0;
  }

  const raw = block.textContent ?? '';
  if (!raw.trim()) return '';
  const spans = sentenceSpans(raw);
  const hit =
    spans.find((span) => offset >= span.start && offset <= span.end) ??
    spans.find((span) => offset < span.end) ??
    spans[spans.length - 1];
  const sentence = (hit?.text ?? raw).replace(/\s+/g, ' ').trim();
  return sentence.slice(0, MAX_SENTENCE_CHARS);
}
