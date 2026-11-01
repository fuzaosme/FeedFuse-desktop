import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVocabularyTerm } from '../lib/englishLearning';

/**
 * 内置核心词库：约 2.9 万条考试大纲与高频词，随应用分发，不依赖网络与用户导入。
 * 源文件与筛选规则见 `server/assets/README.md`（由原版 public/dictionaries/en-zh.json 移植）。
 */
export const BUILTIN_DICTIONARY_ID = 'builtin-ecdict-core';
export const BUILTIN_DICTIONARY_NAME = '内置核心词库';
export const BUILTIN_DICTIONARY_DESCRIPTION =
  '考试大纲词汇与高频词（约 2.9 万条），随应用内置，无需下载即可查词。';

export interface BuiltinDictionaryEntry {
  term: string;
  meanings: string[];
  phonetic?: string;
}

let cache: Map<string, BuiltinDictionaryEntry> | null = null;

function readDictionaryFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev：src/domain → ../../assets；打包后：dist → ./en-zh.json。
  const candidates = [
    join(here, 'en-zh.json'),
    join(here, '..', 'assets', 'en-zh.json'),
    join(here, '..', '..', 'assets', 'en-zh.json'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error(`内置词典文件缺失（已尝试：${candidates.join('、')}）`);
}

/**
 * 只读一次。JSON.parse 2.8MB 约几十毫秒，启动时调用一次预热，
 * 之后每次查词都是 Map 的 O(1)。
 */
export function loadBuiltinDictionary(): Map<string, BuiltinDictionaryEntry> {
  if (cache) return cache;
  const parsed: unknown = JSON.parse(readDictionaryFile());
  if (!parsed || typeof parsed !== 'object') throw new Error('内置词典格式无效');
  const entries = new Map<string, BuiltinDictionaryEntry>();
  for (const [rawTerm, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as { meanings?: unknown; phonetic?: unknown };
    if (!Array.isArray(record.meanings)) continue;
    const meanings = record.meanings.filter(
      (meaning): meaning is string => typeof meaning === 'string' && meaning.trim().length > 0,
    );
    if (meanings.length === 0) continue;
    const term = normalizeVocabularyTerm(rawTerm);
    if (!term || entries.has(term)) continue;
    entries.set(term, {
      term,
      meanings,
      phonetic: typeof record.phonetic === 'string' ? record.phonetic : undefined,
    });
  }
  cache = entries;
  return entries;
}

export function builtinDictionaryEntryCount(): number {
  return loadBuiltinDictionary().size;
}

/** 按已归一化的候选词查内置词典；不做模糊匹配，避免把前缀词当成整词命中。 */
export function lookupBuiltinDictionary(normalized: string): BuiltinDictionaryEntry | null {
  if (!normalized) return null;
  return loadBuiltinDictionary().get(normalized) ?? null;
}
