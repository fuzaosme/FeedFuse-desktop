import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PartOfSpeech } from '../lib/morphology';

/**
 * 三本随应用分发的只读词典，都不进 SQLite，各自可以在设置里单独停用：
 *
 *   中英核心词库  assets/en-zh.json        29,005 条   中文释义 + 音标（ECDICT 筛选版，随上游移植）
 *   WordNet 英文释义  assets/builtin/…      154,542 条  英英释义 + 例句 + IPA（Open English WordNet 2025）
 *   词组词典      assets/phrases.json      8,440 条    常用短语，中英对照 + 例句
 *
 * 三本是**独立数据源**，不互相合并存储：查词时由 dictionaries.ts 按启用状态取命中并合成一条释义。
 * 这样停用 WordNet 只剩中文、停用中英词库只剩英英，用户能自己选。
 *
 * 加载策略：
 *   - WordNet 按首字母分片（37 个文件），一次查词只解析命中的那一片，最多同时留 8 片。
 *     合成单文件是 22MB：启动就要 parse 一遍并常驻两百兆堆，桌面端不该这么花内存。
 *   - 另外两本体量小（1.6MB / 2.7MB），首次查到才整体读入。
 */

export interface BuiltinDictionaryEntry {
  term: string;
  meanings: string[];
  phonetic: string | null;
  /** 粗粒度词性（n / v / a / r 的组合）。词形推导靠它判断该不该按动词变形；词组为空串。 */
  pos: string;
}

export interface BuiltinSource {
  id: string;
  name: string;
  description: string;
  /** 词条数。文件缺失时返回 0 而不是抛错。 */
  entryCount(): number;
  /** 按已归一化的小写词头查。 */
  lookup(term: string): BuiltinDictionaryEntry | null;
  /** 词组词典只对多词表达命中；单词查词永远跳过它。 */
  phrasesOnly?: boolean;
}

/* ----------------------------- 资源定位 ----------------------------- */

const here = dirname(fileURLToPath(import.meta.url));
// dev：src/domain → ../../assets；打包后：dist → ./
const ASSET_ROOTS = [here, join(here, '..', 'assets'), join(here, '..', '..', 'assets')];

function assetPath(...parts: string[]): string | null {
  for (const root of ASSET_ROOTS) {
    const candidate = join(root, ...parts);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface RawEntry {
  phonetic?: string;
  pos?: string;
  meanings?: unknown;
}

/** ECDICT 的释义行自带词性前缀（"n." / "vt." / "ad."），没有独立字段时从这里捡。 */
const LINE_POS: Record<string, PartOfSpeech> = {
  n: 'n', v: 'v', vt: 'v', vi: 'v', a: 'a', adj: 'a', s: 'a', ad: 'r', adv: 'r', r: 'r',
};

function posFromLines(lines: readonly string[]): string {
  const found = new Set<string>();
  for (const line of lines) {
    const match = /^\s*\[?([a-z]{1,3})[.\]]/.exec(line);
    const pos = match ? LINE_POS[match[1]] : undefined;
    if (pos) found.add(pos);
  }
  return [...found].sort().join('');
}

function toEntry(term: string, raw: RawEntry | undefined, derivePos: boolean): BuiltinDictionaryEntry | null {
  const meanings = Array.isArray(raw?.meanings)
    ? raw.meanings.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : [];
  if (!meanings.length) return null;
  const pos = typeof raw?.pos === 'string' && raw.pos ? raw.pos : derivePos ? posFromLines(meanings) : '';
  return {
    term,
    meanings,
    phonetic: typeof raw?.phonetic === 'string' && raw.phonetic.trim() ? raw.phonetic : null,
    pos,
  };
}

/* ---------------------------- 中英核心词库 ---------------------------- */

const ZH_CORE_ID = 'builtin-zh-core';
let zhCoreCache: Map<string, BuiltinDictionaryEntry> | null = null;

function loadZhCore(): Map<string, BuiltinDictionaryEntry> {
  if (zhCoreCache) return zhCoreCache;
  const entries = new Map<string, BuiltinDictionaryEntry>();
  const path = assetPath('en-zh.json');
  if (path) {
    // 旧文件就是 { 词头: { meanings, phonetic } }，没有外层包装。
    for (const [term, raw] of Object.entries(readJson<Record<string, RawEntry>>(path))) {
      const entry = toEntry(term, raw, true);
      if (entry) entries.set(term, entry);
    }
  }
  zhCoreCache = entries;
  return entries;
}

/* --------------------------- WordNet 分片 --------------------------- */

interface CoreIndex {
  count: number;
  shards: Record<string, number>;
}

let indexCache: CoreIndex | null = null;

function wordnetIndex(): CoreIndex {
  if (indexCache) return indexCache;
  const path = assetPath('builtin', 'index.json');
  if (!path) throw new Error('内置词库索引缺失：server/assets/builtin/index.json');
  const parsed = readJson<Partial<CoreIndex>>(path);
  indexCache = {
    count: typeof parsed.count === 'number' ? parsed.count : 0,
    shards: parsed.shards && typeof parsed.shards === 'object' ? parsed.shards : {},
  };
  return indexCache;
}

/** 分片名：a-z 与数字各自一片，其余（符号、非拉丁）统一进 _。 */
function shardKey(term: string): string {
  const first = term[0] ?? '';
  return /^[a-z0-9]$/.test(first) ? first : '_';
}

/** 同时最多保留 8 片：一篇文章里的词基本落在几个首字母内，再多也没必要占着。 */
const MAX_LOADED_SHARDS = 8;
const shardCache = new Map<string, Map<string, BuiltinDictionaryEntry>>();

function loadShard(bucket: string): Map<string, BuiltinDictionaryEntry> {
  const cached = shardCache.get(bucket);
  if (cached) {
    shardCache.delete(bucket);
    shardCache.set(bucket, cached);
    return cached;
  }
  const entries = new Map<string, BuiltinDictionaryEntry>();
  const path = assetPath('builtin', `${bucket}.json`);
  if (path) {
    for (const [term, raw] of Object.entries(readJson<Record<string, RawEntry>>(path))) {
      const entry = toEntry(term, raw, false);
      if (entry) entries.set(term, entry);
    }
  }
  shardCache.set(bucket, entries);
  while (shardCache.size > MAX_LOADED_SHARDS) {
    const oldest = shardCache.keys().next().value;
    if (oldest === undefined) break;
    shardCache.delete(oldest);
  }
  return entries;
}

/* ----------------------------- 词组词典 ----------------------------- */

let phraseCache: Map<string, BuiltinDictionaryEntry> | null = null;

/** 与 `web/src/features/learning/lookupTerms.ts` 一致：超过 4 个词直接交给 AI，不再查词典。 */
export const MAX_PHRASE_WORDS = 4;

function loadPhrases(): Map<string, BuiltinDictionaryEntry> {
  if (phraseCache) return phraseCache;
  const entries = new Map<string, BuiltinDictionaryEntry>();
  const path = assetPath('phrases.json');
  if (path) {
    const parsed = readJson<{ entries?: Record<string, RawEntry> }>(path);
    for (const [term, raw] of Object.entries(parsed.entries ?? {})) {
      const entry = toEntry(term, raw, false);
      if (entry) entries.set(term, entry);
    }
  }
  phraseCache = entries;
  return entries;
}

function wordCount(term: string): number {
  return term.split(' ').filter(Boolean).length;
}

/* ------------------------------ 三本词典 ------------------------------ */

export const ZH_CORE_DICTIONARY_ID = ZH_CORE_ID;
export const ZH_CORE_DICTIONARY_NAME = '中英核心词库';
export const ZH_CORE_DICTIONARY_DESCRIPTION =
  '考试大纲与高频词的**中文释义**（约 2.9 万条，94% 带音标），ECDICT 筛选版。';

export const WORDNET_DICTIONARY_ID = 'builtin-wordnet';
export const WORDNET_DICTIONARY_NAME = 'WordNet 英文释义';
export const WORDNET_DICTIONARY_DESCRIPTION =
  'Open English WordNet 2025：约 15.4 万词条的英英释义、例句与 IPA（约 21% 有音标）。';

export const PHRASE_DICTIONARY_ID = 'builtin-phrases';
export const PHRASE_DICTIONARY_NAME = '词组词典';
export const PHRASE_DICTIONARY_DESCRIPTION =
  '8000+ 常用英语短语与动词搭配，中英对照并附例句。只对 2～6 个词的表达生效。';

/** 展示与优先级顺序：中文在前（用户看的是母语），英英补充，词组只在多词表达时命中。 */
export const BUILTIN_SOURCES: readonly BuiltinSource[] = [
  {
    id: ZH_CORE_DICTIONARY_ID,
    name: ZH_CORE_DICTIONARY_NAME,
    description: ZH_CORE_DICTIONARY_DESCRIPTION,
    entryCount: () => loadZhCore().size,
    lookup: (term) => loadZhCore().get(term) ?? null,
  },
  {
    id: WORDNET_DICTIONARY_ID,
    name: WORDNET_DICTIONARY_NAME,
    description: WORDNET_DICTIONARY_DESCRIPTION,
    entryCount: () => wordnetIndex().count,
    lookup: (term) => (term ? loadShard(shardKey(term)).get(term) ?? null : null),
  },
  {
    id: PHRASE_DICTIONARY_ID,
    name: PHRASE_DICTIONARY_NAME,
    description: PHRASE_DICTIONARY_DESCRIPTION,
    entryCount: () => loadPhrases().size,
    lookup: (term) => {
      const words = wordCount(term);
      if (words < 2 || words > MAX_PHRASE_WORDS) return null;
      return loadPhrases().get(term) ?? null;
    },
    phrasesOnly: true,
  },
];

export function findBuiltinSource(id: string): BuiltinSource | null {
  return BUILTIN_SOURCES.find((source) => source.id === id) ?? null;
}

export function isBuiltinDictionaryId(id: string): boolean {
  return BUILTIN_SOURCES.some((source) => source.id === id);
}

/**
 * 把三本词典整体载入成一张表。
 * 只为测试与诊断保留：正常查词按需分片，不做全量载入。
 */
export function loadBuiltinDictionary(): Map<string, BuiltinDictionaryEntry> {
  const merged = new Map<string, BuiltinDictionaryEntry>(loadPhrases());
  for (const [term, entry] of loadZhCore()) merged.set(term, entry);
  for (const bucket of Object.keys(wordnetIndex().shards)) {
    for (const [term, entry] of loadShard(bucket)) merged.set(term, entry);
  }
  return merged;
}

/** 测试用：丢掉缓存，模拟冷启动。 */
export function clearBuiltinCaches(): void {
  shardCache.clear();
  zhCoreCache = null;
  phraseCache = null;
  indexCache = null;
}
