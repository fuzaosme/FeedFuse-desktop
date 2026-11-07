import { englishWordSpans, normalizeVocabularyTerm, vocabularyLookupWord } from '../../lib/englishLearning';
import type { LearningSelection } from './selection';

/** 选区在某段文本中的片段：text 为选中文字，context/start/end 用来补全被截断的单词。 */
export interface SelectionPiece {
  text: string;
  context: string;
  start: number;
  end: number;
}

/**
 * 常见功能词。它们同样可能是学习目标，不能仅凭名单跳过用户选中的词。
 */
export const GLUE_WORDS: ReadonlySet<string> = new Set([
  // 冠词与限定词
  'a', 'an', 'the',
  // 介词
  'about', 'above', 'across', 'after', 'against', 'along', 'alongside', 'amid', 'among',
  'amongst', 'around', 'as', 'at', 'atop', 'before', 'behind', 'below', 'beneath', 'beside',
  'besides', 'between', 'beyond', 'by', 'despite', 'down', 'during', 'except', 'for', 'from',
  'in', 'inside', 'into', 'like', 'near', 'of', 'off', 'on', 'onto', 'opposite', 'out',
  'outside', 'over', 'past', 'per', 'round', 'since', 'through', 'throughout', 'till', 'to',
  'toward', 'towards', 'under', 'underneath', 'unlike', 'until', 'unto', 'up', 'upon', 'via',
  'with', 'within', 'without',
  // 连词
  'although', 'and', 'because', 'either', 'however', 'if', 'lest', 'neither', 'nor', 'or',
  'provided', 'so', 'than', 'that', 'though', 'unless', 'when', 'whenever', 'where', 'whereas',
  'wherever', 'whether', 'while', 'yet',
  // 代词与指示词
  'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'yourselves', 'he',
  'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'we', 'us',
  'our', 'ours', 'ourselves', 'they', 'them', 'their', 'theirs', 'themselves', 'this', 'these',
  'those', 'who', 'whom', 'whose', 'which', 'what', 'whatever', 'whichever', 'whoever', 'one',
  'ones', 'someone', 'something', 'anyone', 'anything', 'everyone', 'everything', 'nobody',
  'nothing', 'each', 'both', 'some', 'any', 'all', 'another', 'other', 'others', 'such', 'none',
  'no', 'every', 'few', 'many', 'much', 'more', 'most', 'less', 'least', 'several', 'enough',
  'own', 'same',
  // 助动词与情态动词
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'ought',
  // 常见功能副词
  'not', 'there', 'here', 'too', 'also', 'just', 'only', 'even', 'still', 'ever', 'never',
  'always', 'often', 'sometimes', 'usually', 'rather', 'quite', 'very', 'now', 'then', 'thus',
  'hence', 'therefore', 'perhaps', 'maybe', 'again', 'once', 'twice',
]);

export function isGlueWord(word: string): boolean {
  const normalized = normalizeVocabularyTerm(word);
  return normalized.length > 0 && GLUE_WORDS.has(normalized);
}

/** 一次选区只产生一张卡片：主查询词 + 未收录时左右各补一个词形成的候选。 */
export interface LookupPlan {
  /** 补全整词后的主查询表达；为空表示不适合查词，直接交给 AI。 */
  term: string;
  /** 主表达未收录时，分别拼上左右相邻实词形成的候选，按左→右顺序。 */
  expandedTerms: string[];
}

function coveredWords(piece: SelectionPiece) {
  return englishWordSpans(piece.context).filter((word) => word.start < piece.end && word.end > piece.start);
}

function fullySelected(piece: SelectionPiece, span: { start: number; end: number }): boolean {
  return piece.start <= span.start && span.end <= piece.end;
}

function significantWords(piece: SelectionPiece) {
  const covered = coveredWords(piece);
  if (covered.length <= 1) return covered;
  const significant = covered.filter((span) => {
    if (fullySelected(piece, span)) return true;
    // 胶水词只有被完整选中时才作为查询目标；撑到边上的介词/冠词直接忽略。
    if (isGlueWord(span.word)) return false;
    const overlap = piece.context.slice(Math.max(piece.start, span.start), Math.min(piece.end, span.end));
    return (overlap.match(/[A-Za-z]/g)?.length ?? 0) >= 2;
  });
  // 两边都只划到一个字母时没有可靠主目标，不擅自丢掉其中一个。
  return significant.length ? significant : covered;
}

/** 词与词之间只允许空白（连字符词在 englishWordSpans 里本身就是一整词）。 */
function wordsAreContiguous(context: string, words: readonly { end: number; start: number }[]): boolean {
  return words.slice(1).every((span, index) => /^\s+$/.test(context.slice(words[index].end, span.start)));
}

/**
 * 主表达未收录时，用左右各一个相邻实词再拼一次词组。
 * 相邻词是胶水词时跳过：`a resilient`、`resilient and` 这类组合不值得查。
 */
function expansionTerms(piece: SelectionPiece, start: number, end: number, term: string): string[] {
  const words = englishWordSpans(piece.context);
  const result: string[] = [];
  const left = words.filter((word) => word.end <= start).at(-1);
  if (left && /^[\s-]*$/.test(piece.context.slice(left.end, start)) && !isGlueWord(left.word)) {
    result.push(`${left.word} ${term}`);
  }
  const right = words.find((word) => word.start >= end);
  if (right && /^[\s-]*$/.test(piece.context.slice(end, right.start)) && !isGlueWord(right.word)) {
    result.push(`${term} ${right.word}`);
  }
  return [...new Set(result)];
}

/** 先查补全后的完整表达；未收录时再用左右相邻词拼出的候选。 */
export function resolveLookupPlan(pieces: readonly SelectionPiece[]): LookupPlan {
  // 跨段/跨块的选区不是单个表达，交给 AI 比硬拆成一张词卡更合理。
  if (pieces.length !== 1) return { term: '', expandedTerms: [] };
  const piece = pieces[0];
  const words = significantWords(piece);
  if (!words.length) return { term: '', expandedTerms: [] };
  // 逗号、句号两侧的词不能拼成不存在的词组。
  if (words.length > 1 && !wordsAreContiguous(piece.context, words)) {
    return { term: '', expandedTerms: [] };
  }

  const term = words.length === 1
    ? vocabularyLookupWord(words[0].word)
    : piece.context.slice(words[0].start, words[words.length - 1].end).replace(/\s+/g, ' ');
  return {
    term,
    expandedTerms: expansionTerms(piece, words[0].start, words[words.length - 1].end, term),
  };
}

/**
 * 完整句子优先讲解；1～4 个有效词先查词/词组，超过 4 个词直接交给 AI。
 * 字数按有效选词计算，擦到第四个词的一个字母不会突然切成句子。
 */
export function resolveSelectionMode(selection: LearningSelection): 'word' | 'sentence' {
  const words = selection.pieces.flatMap(significantWords);
  if (!words.length) return 'word';
  // 单个词始终先查词典，哪怕它恰好是一个只有一词的句子。
  if (words.length === 1) return 'word';
  if (selection.pieces.length > 1 || selection.sentences.length > 1) return 'sentence';
  const piece = selection.pieces[0];
  const selectedStart = words[0].start;
  const selectedEnd = words[words.length - 1].end;
  const selected = piece.context.slice(selectedStart, selectedEnd).replace(/\s+/g, ' ').trim();
  const wholeSentence = selection.sentences.some((sentence) => {
    if (!/[.!?]["'’”）)\]]*$/.test(sentence.trim())) return false;
    const sentenceWords = englishWordSpans(sentence);
    if (!sentenceWords.length) return false;
    return sentence.slice(sentenceWords[0].start, sentenceWords[sentenceWords.length - 1].end)
      .replace(/\s+/g, ' ').trim() === selected;
  });
  if (wholeSentence) return 'sentence';
  // 2～4 个词先按整词组查询；超过 4 个词说明用户要的是句意，直接讲解。
  if (words.length > 4) return 'sentence';
  return wordsAreContiguous(piece.context, words) ? 'word' : 'sentence';
}

/** AI 接收补全后的有效选区，避免翻译半个单词或已忽略的擦边字母。 */
export function completeLearningSelection(selection: LearningSelection): LearningSelection {
  const pieces = selection.pieces.map((piece) => {
    const words = significantWords(piece);
    if (!words.length) return piece;
    const start = Math.min(piece.start, words[0].start);
    const end = Math.max(piece.end, words[words.length - 1].end);
    // 被忽略的首尾词不应随原选区一起送给 AI。
    const covered = coveredWords(piece);
    const correctedStart = covered[0].start === words[0].start ? start : words[0].start;
    const correctedEnd = covered[covered.length - 1].end === words[words.length - 1].end ? end : words[words.length - 1].end;
    return { ...piece, start: correctedStart, end: correctedEnd, text: piece.context.slice(correctedStart, correctedEnd) };
  });
  const selectedText = pieces.map((piece) => piece.text).join('\n').trim();
  return { ...selection, pieces, selectedText, wordCount: englishWordSpans(selectedText).length };
}
