/**
 * 英语精读与查词的基础文本工具。
 *
 * 和服务端 `server/src/lib/englishLearning.ts` 使用同一套正则与归一化规则：
 * 词典键、查词候选、生词去重都依赖它，两边不一致就会出现
 * 「页面上能查到、服务端说未收录」的差异。
 */

/** 精读链路单次请求超时。 */
export const ENGLISH_LEARNING_TIMEOUT_MS = 30_000;
/** 快速阅读策略更新后，不复用热更新前的旧讲解。 */
export const ENGLISH_LEARNING_CACHE_VERSION = 2;
export const ENGLISH_LEARNING_MAX_TEXT_LENGTH = 20_000;

/** 选区文本发送上限（字符）。 */
export const ENGLISH_LEARNING_MAX_SELECTED_CHARS = 1000;
/** 精读链路单次最多发送的句子数。 */
export const ENGLISH_LEARNING_MAX_SENTENCES = 8;
/** 每句发送上限（字符）。 */
export const ENGLISH_LEARNING_MAX_SENTENCE_CHARS = 500;
/** 精读链路发送给模型的语境上限。 */
export const ENGLISH_LEARNING_MAX_CONTEXT_CHARS = 1500;

export function truncateForPrompt(text: string, maxChars: number): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}…（已截断）`;
}

export function truncateLearningContext(context: string | undefined): string {
  if (!context) return '';
  return truncateForPrompt(context, ENGLISH_LEARNING_MAX_CONTEXT_CHARS);
}

export function englishWordSpans(text: string): { word: string; start: number; end: number }[] {
  return [...text.matchAll(/[A-Za-z]+(?:['’‘\u2010\u2011-][A-Za-z]+)*/g)].map((match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function countEnglishWords(text: string): number {
  return englishWordSpans(text).length;
}

const S_CONTRACTIONS = new Set([
  "it's", "he's", "she's", "that's", "there's", "here's", "what's", "who's",
  "where's", "when's", "why's", "how's", "let's",
]);

/** 查词时去掉名词所有格；常见 's 缩写仍保留，避免把 it's 查成 it。 */
export function vocabularyLookupWord(word: string): string {
  const normalized = word.replace(/[’‘]/g, "'").toLowerCase();
  return S_CONTRACTIONS.has(normalized) ? word : word.replace(/['’‘]s$/i, '');
}

/** 候选必须保留整个表达，不能把只命中前半段伪装成词组命中。 */
export function dictionaryLookupCandidates(normalized: string): string[] {
  if (!normalized) return [];
  const candidates = [normalized];
  if (englishWordSpans(normalized).length === 1) candidates.push(vocabularyLookupWord(normalized));
  if (/[ -]/.test(normalized)) {
    candidates.push(normalized.includes('-') ? normalized.replace(/-/g, ' ') : normalized.replace(/ /g, '-'));
  }
  return [...new Set(candidates)];
}

export function cleanVocabularyTerm(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
}

export function normalizeVocabularyTerm(text: string): string {
  return cleanVocabularyTerm(text)
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/[\u2010-\u2014]/g, '-')
    .toLowerCase();
}
