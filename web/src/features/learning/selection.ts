import { countEnglishWords, englishWordSpans } from '../../lib/englishLearning';
import type { SelectionPiece } from './lookupTerms';

// 正文里被标记的生词也是 role="button"（为了键盘可达），但它属于正文文字，
// 划词时必须照常参与，否则「选中一段里含生词的长句」会整段失效。
const VOCABULARY_WORD = '[role="button"]:not(.ff-vocabulary-word)';
const EXCLUDED_PARTS = [
  '.ff-translation', '[data-translation]', '[data-ff-translation]', 'pre', 'code',
  'button', 'input', 'textarea', 'select', '[contenteditable]',
  VOCABULARY_WORD, 'script', 'style', '[hidden]', '[aria-hidden="true"]',
];
const EXCLUDED = EXCLUDED_PARTS.join(',');
const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,div,section,article';
// 内联链接可查词；代码仅作为完整原句的上下文。
const CONTEXT_EXCLUDED = [
  '.ff-translation', '[data-translation]', '[data-ff-translation]', 'pre', 'button', 'input', 'textarea',
  'select', '[contenteditable]', VOCABULARY_WORD, 'script', 'style',
  '[hidden]', '[aria-hidden="true"]',
].join(',');

export interface LearningSelection {
  selectedText: string;
  wordCount: number;
  sentences: string[];
  rect: { left: number; right: number; top: number; bottom: number };
  /** 选区在文本块内的位置，用于把被截断的单词补全成整词。 */
  pieces: SelectionPiece[];
}

type TextSpan = { node: Text; start: number; selectable: boolean };
type TextBlock = { element: Element; text: string; spans: TextSpan[] };
type SentenceSegmenter = { segment(text: string): Iterable<{ segment: string; index: number }> };

function parentElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function textBlocks(root: HTMLElement, excluded: string): TextBlock[] {
  const result: TextBlock[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const parent = parentElement(current);
    if (!parent || parent.closest(CONTEXT_EXCLUDED)) continue;
    const element = parent.closest(BLOCKS) ?? root;
    if (!root.contains(element)) continue;
    if (!(current instanceof Text) && !(current instanceof HTMLBRElement)) continue;
    let block = result[result.length - 1];
    if (!block || block.element !== element) {
      block = { element, text: '', spans: [] };
      result.push(block);
    }
    if (current instanceof Text) {
      block.spans.push({ node: current, start: block.text.length, selectable: !parent.closest(excluded) });
      block.text += current.data;
    } else {
      block.text += '\n';
    }
  }
  return result;
}

type SentenceSpan = { text: string; start: number; end: number };

/** 句子切分：优先 Intl.Segmenter，老环境整体当一句。生词浮层也复用它。 */
export function sentenceSpans(text: string): SentenceSpan[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale: string, options: { granularity: 'sentence' }) => SentenceSegmenter;
  }).Segmenter;
  if (Segmenter) {
    try {
      return [...new Segmenter('en', { granularity: 'sentence' }).segment(text)]
        .map((part) => ({ text: part.segment.trim(), start: part.index, end: part.index + part.segment.length }));
    } catch { /* 旧环境使用同一套保守的段落回退。 */ }
  }
  return text.trim() ? [{ text: text.trim(), start: 0, end: text.length }] : [];
}

/**
 * 完整主句旁边只擦到最多两个词时裁去那段越界；完整选中的短句始终保留。
 * 对所有文本块一起判断，因此换行和换段不会改变容错规则。
 */
function trimSentenceEdges(pieces: SelectionPiece[]): { pieces: SelectionPiece[]; sentences: string[] } {
  const overlaps = pieces.flatMap((piece, pieceIndex) => sentenceSpans(piece.context).flatMap((sentence) => {
    const start = Math.max(piece.start, sentence.start);
    const end = Math.min(piece.end, sentence.end);
    const words = englishWordSpans(piece.context.slice(sentence.start, sentence.end));
    const selectedWords = words.filter((word) =>
      sentence.start + word.start < end && sentence.start + word.end > start,
    );
    if (end <= start || !selectedWords.length) return [];
    const complete = start <= sentence.start + words[0].start &&
      end >= sentence.start + words[words.length - 1].end;
    return [{ pieceIndex, sentence, start, end, count: selectedWords.length, complete }];
  }));
  const anchors = overlaps.filter((overlap) => overlap.complete);
  const isFringe = (overlap: typeof overlaps[number]) => !overlap.complete && overlap.count <= 2 &&
    anchors.some((anchor) => anchor.count > overlap.count);
  let first = 0;
  let last = overlaps.length - 1;
  // 每一侧最多裁去一条相邻句，不能循环吞掉用户选中的多句话。
  if (first < last && isFringe(overlaps[first])) first += 1;
  if (first < last && isFringe(overlaps[last])) last -= 1;
  const retained = overlaps.slice(first, last + 1);
  const corrected = pieces.flatMap((piece, pieceIndex) => {
    const matching = retained.filter((overlap) => overlap.pieceIndex === pieceIndex);
    if (!matching.length) return [];
    const start = matching[0].start;
    const end = matching[matching.length - 1].end;
    return [{ ...piece, start, end, text: piece.context.slice(start, end) }];
  });
  return { pieces: corrected, sentences: retained.map((overlap) => overlap.sentence.text) };
}

export function readLearningSelection(root: HTMLElement): LearningSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  if (parentElement(range.startContainer)?.closest(EXCLUDED) ||
      parentElement(range.endContainer)?.closest(EXCLUDED)) return null;

  const pieces: SelectionPiece[] = [];
  for (const block of textBlocks(root, EXCLUDED)) {
    let start = Infinity;
    let end = -1;
    for (const span of block.spans) {
      if (!range.intersectsNode(span.node)) continue;
      const from = range.startContainer === span.node ? range.startOffset : 0;
      const to = range.endContainer === span.node ? range.endOffset : span.node.length;
      if (to <= from) continue;
      if (!span.selectable && span.node.data.slice(from, to).trim()) return null;
      start = Math.min(start, span.start + from);
      end = Math.max(end, span.start + to);
    }
    if (end <= start || !block.text.slice(start, end).trim()) continue;
    pieces.push({ text: block.text.slice(start, end), context: block.text, start, end });
  }
  const corrected = trimSentenceEdges(pieces);
  const sentences = corrected.sentences;
  const selectedText = corrected.pieces.map((piece) => piece.text).join('\n').trim();
  const wordCount = countEnglishWords(selectedText);
  if (!wordCount || !sentences.length) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    selectedText, wordCount, sentences, pieces: corrected.pieces,
    rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
  };
}
