/**
 * 英语精读与查词的文本工具。
 *
 * 与 Web 端 `web/src/lib/englishLearning.ts` 保持同一套归一化/切词规则：
 * 词典的键、查词候选、生词本去重都依赖它，两边不一致就会出现
 * 「页面上能查到、服务端说未收录」这种难以解释的差异。
 */

/** 精读链路发送给模型的语境上限。 */
export const ENGLISH_LEARNING_MAX_CONTEXT_CHARS = 1500;
/** 精读链路单次最多发送的句子数。 */
export const ENGLISH_LEARNING_MAX_SENTENCES = 8;
/** 每句发送上限（字符）。 */
export const ENGLISH_LEARNING_MAX_SENTENCE_CHARS = 500;
/** 选区文本发送上限（字符）。 */
export const ENGLISH_LEARNING_MAX_SELECTED_CHARS = 1000;
/** 精读链路单次允许的最大选区文本长度。 */
export const ENGLISH_LEARNING_MAX_TEXT_LENGTH = 20_000;
/** 讲解输出 token 上限。 */
export const ENGLISH_LEARNING_MAX_OUTPUT_TOKENS = 600;
/** 单词详细解释输出 token 上限。 */
export const WORD_DETAIL_MAX_OUTPUT_TOKENS = 500;

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
