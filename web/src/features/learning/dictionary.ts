import { fetchDictionaries, lookupWord } from '../../api/endpoints';
import {
  dictionaryLookupCandidates,
  normalizeVocabularyTerm,
} from '../../lib/englishLearning';

export interface DictionaryEntry {
  meanings: string[];
  phonetic?: string;
  /** html 表示 meanings 里是一条已清洗的 HTML；text 表示按行拆好的纯文本释义。 */
  contentType?: 'text' | 'html';
}

export type DictionaryResult =
  | { status: 'found'; entry: DictionaryEntry; dictionaryId: string }
  | { status: 'not_found' }
  | { status: 'error' };

/** 单次查词超时：本地 sidecar 正常时是毫秒级，超过这个时间就该让用户看到「失败可重试」。 */
export const DICTIONARY_LOOKUP_TIMEOUT_MS = 1_200;

/** 归一化缓存：划词/连续查词会反复归一化同一字符串。 */
const NORMALIZE_CACHE_LIMIT = 2000;
const normalizeCache = new Map<string, string>();

/** 热点查询 LRU：只缓存稳定结果（found / not_found），error 随网络波动不缓存。 */
const RESULT_CACHE_LIMIT = 500;
const resultCache = new Map<string, { result: DictionaryResult; expiresAt: number }>();

/** 同词并发请求合并：多个词卡并行查同一个词只打一次接口。 */
const inflightLookups = new Map<string, Promise<DictionaryResult>>();

function cachedNormalize(term: string): string {
  const cached = normalizeCache.get(term);
  if (cached !== undefined) return cached;
  const normalized = normalizeVocabularyTerm(term);
  if (normalizeCache.size >= NORMALIZE_CACHE_LIMIT) {
    const oldest = normalizeCache.keys().next();
    if (!oldest.done) normalizeCache.delete(oldest.value);
  }
  normalizeCache.set(term, normalized);
  return normalized;
}

function getCachedResult(normalized: string): DictionaryResult | null {
  const cached = resultCache.get(normalized);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    resultCache.delete(normalized);
    return null;
  }
  // LRU：命中即移到末尾，下次淘汰最久未用。
  resultCache.delete(normalized);
  resultCache.set(normalized, cached);
  return cached.result;
}

function setCachedResult(normalized: string, result: DictionaryResult): void {
  if (result.status !== 'found' && result.status !== 'not_found') return;
  if (resultCache.has(normalized)) resultCache.delete(normalized);
  else if (resultCache.size >= RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next();
    if (!oldest.done) resultCache.delete(oldest.value);
  }
  resultCache.set(normalized, {
    result, expiresAt: Date.now() + (result.status === 'found' ? 5 * 60_000 : 30_000),
  });
}

/** 保留完整表达的等价写法，不把前缀单词当作词组命中。 */
export const buildPhraseFallbackCandidates = dictionaryLookupCandidates;

/** 单测/调试用：清空缓存。 */
export function clearDictionaryCaches(): void {
  normalizeCache.clear();
  resultCache.clear();
  inflightLookups.clear();
}

function toResult(entries: Array<{ term: string; definition: string; phonetic: string | null; dictionaryName: string; contentType?: 'text' | 'html' }>): DictionaryResult {
  const first = entries[0];
  if (!first) return { status: 'not_found' };

  // HTML 释义（MDict / 部分 StarDict）不能按换行拆：拆开就是一堆半截标签。
  if (first.contentType === 'html') {
    const html = first.definition.trim();
    if (!html) return { status: 'not_found' };
    return {
      status: 'found',
      dictionaryId: first.dictionaryName,
      entry: { meanings: [html], phonetic: first.phonetic ?? undefined, contentType: 'html' },
    };
  }

  const meanings = first.definition
    .split(/\r?\n/)
    .map((meaning) => meaning.trim())
    .filter(Boolean);
  if (meanings.length === 0) return { status: 'not_found' };
  return {
    status: 'found',
    dictionaryId: first.dictionaryName,
    entry: { meanings, phonetic: first.phonetic ?? undefined, contentType: 'text' },
  };
}

/**
 * 查词：服务端已合并「用户导入词典（优先）→ 内置核心词库 → 用户词典模糊兜底」，
 * 前端只负责缓存、并发合并与超时，不再重复请求多个候选。
 */
export async function lookupDictionary(term: string): Promise<DictionaryResult> {
  const normalized = cachedNormalize(term);
  if (!normalized) return { status: 'not_found' };
  const cached = getCachedResult(normalized);
  if (cached) return cached;
  const inflight = inflightLookups.get(normalized);
  if (inflight) return inflight;

  let current: Promise<DictionaryResult> | null = null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DICTIONARY_LOOKUP_TIMEOUT_MS);
  const task = (async (): Promise<DictionaryResult> => {
    try {
      const response = await lookupWord(term, controller.signal);
      const result = toResult(response.entries);
      setCachedResult(normalized, result);
      return result;
    } catch {
      // 本地服务无响应 / 超时统一报失败，让卡片给出重试入口。
      return { status: 'error' };
    } finally {
      window.clearTimeout(timer);
      if (inflightLookups.get(normalized) === current) inflightLookups.delete(normalized);
    }
  })();
  current = task;
  inflightLookups.set(normalized, task);
  return task;
}

let warmed = false;

/** 提前载入服务端词典列表：让内置核心词典在首次划词前完成预热。 */
export function warmLearningDictionaries(): void {
  if (warmed) return;
  warmed = true;
  void fetchDictionaries().catch(() => undefined);
}
