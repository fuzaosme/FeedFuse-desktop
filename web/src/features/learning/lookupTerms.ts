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

/** 整体查询失败后，按原文顺序查询的词；功能词不再被直接过滤。 */
export interface LookupPlan {
  terms: string[];
  fallbackTerms: string[];
}

function coveredWords(piece: SelectionPiece) {
  return englishWordSpans(piece.context).filter((word) => word.start < piece.end && word.end > piece.start);
}

function significantWords(piece: SelectionPiece) {
  const covered = coveredWords(piece);
  if (covered.length <= 1) return covered;
  const significant = covered.filter((span) => {
    if (piece.start <= span.start && span.end <= piece.end) return true;
    const overlap = piece.context.slice(Math.max(piece.start, span.start), Math.min(piece.end, span.end));
    return (overlap.match(/[A-Za-z]/g)?.length ?? 0) >= 2;
  });
  // 两边都只划到一个字母时没有可靠主目标，不擅自丢掉其中一个。
  return significant.length ? significant : covered;
}

/** 先尝试补全后的整个词组；未命中才应用最多一个字母的边缘容错。 */
export function resolveLookupPlan(pieces: readonly SelectionPiece[]): LookupPlan {
  const words = pieces.flatMap((piece) => significantWords(piece));
  const fallback = [...new Set(words.map((span) => vocabularyLookupWord(span.word)))];
  if (pieces.length !== 1) return { terms: fallback, fallbackTerms: [] };
  const piece = pieces[0];
  const covered = coveredWords(piece);
  if (!covered.length) return { terms: [], fallbackTerms: [] };
  if (covered.length === 1) return { terms: fallback, fallbackTerms: [] };

  // 不能把逗号、句号两侧的词拼成不存在的词组。
  const contiguous = covered.slice(1).every((span, index) =>
    /^\s+$/.test(piece.context.slice(covered[index].end, span.start)),
  );
  if (!contiguous) return { terms: fallback, fallbackTerms: [] };
  const phrase = piece.context.slice(covered[0].start, covered[covered.length - 1].end).replace(/\s+/g, ' ');
  return { terms: [phrase], fallbackTerms: fallback };
}

/**
 * 完整句子优先讲解；短表达先查词组。4～6 词的表达只有整体未收录才讲解，
 * 字数按有效选词计算，擦到第四个词的一个字母不会突然切成句子。
 */
export function resolveSelectionMode(selection: LearningSelection): 'word' | 'sentence' | 'phrase-or-sentence' {
  const words = selection.pieces.flatMap(significantWords);
  if (!words.length) return 'word';
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
  if (words.length < 4) return 'word';
  // 长表达直接讲解，避免对大段文本做无意义的词典查询。
  return words.length <= 6 ? 'phrase-or-sentence' : 'sentence';
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
