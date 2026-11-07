import { getDb } from '../db/sqlite';
import { nowIso } from '../lib/utils';
import { NotFoundError, ValidationError } from '../http/envelope';
import { dictionaryLookupCandidates, normalizeVocabularyTerm } from '../lib/englishLearning';
import { getActiveConfig } from '../config';
import {
  BUILTIN_SOURCES,
  isBuiltinDictionaryId,
  type BuiltinDictionaryEntry,
  type BuiltinSource,
} from './builtinDictionary';
import { getSettings, setDictionaryEnabledSetting } from './settings';
import { acceptsPos, lemmaCandidates, phraseVariants, type PartOfSpeech } from '../lib/morphology';
import { detectFormat, groupDictionaryFiles, UnsupportedFileError, type DictionaryFileSet } from './dict/files';
import { parseMdx } from './dict/mdict';
import { parseStarDict } from './dict/stardict';
import { prepareDefinition } from './dict/content';
import { closeDictionaryReader, getDictionaryReader } from './dict/readers';
import {
  absoluteFromRoot,
  copyIntoDictionary,
  createDictionaryDir,
  fileSize,
  relativeToRoot,
  removeDictionaryDir,
} from './dict/storage';
import type {
  DictionaryFormat,
  DictionarySource,
  DictionaryStorage,
  EntryContentType,
} from './dict/types';

export interface DictionarySummary {
  id: string;
  name: string;
  entryCount: number;
  enabled: boolean;
  createdAt: string;
  /** 内置词典由代码与资源文件提供，不能停用或删除。 */
  builtin?: boolean;
  description?: string;
  format?: DictionaryFormat;
  storage?: DictionaryStorage;
  contentType?: EntryContentType;
  /** 原文件占用（文件型词典才有的数字，用于「这本占了多少磁盘」）。 */
  sizeBytes?: number | null;
}

export interface DictionaryEntry {
  term: string;
  definition: string;
  phonetic: string | null;
  dictionaryName: string;
  /** html 时前端要用富文本渲染，text 时按换行分段渲染。 */
  contentType: EntryContentType;
}

export interface DictionaryLookupResult {
  term: string;
  entries: DictionaryEntry[];
}

interface DictionaryRow {
  id: number;
  name: string;
  entry_count: number;
  enabled: number;
  created_at: string;
  format: string;
  storage: string;
  content_type: string;
  source_dir: string | null;
  source_file: string | null;
  resource_file: string | null;
  meta_json: string | null;
  size_bytes: number | null;
}

function mapDictionary(row: DictionaryRow): DictionarySummary {  return {
    id: String(row.id),
    name: row.name,
    entryCount: row.entry_count,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    format: row.format as DictionaryFormat,
    storage: row.storage as DictionaryStorage,
    contentType: row.content_type as EntryContentType,
    sizeBytes: row.size_bytes,
  };
}

function dictionaryDescription(row: DictionaryRow): string {
  const meta = parseMeta(row.meta_json);
  const parts: string[] = [];
  const label =
    row.format === 'mdx' ? 'MDict' : row.format === 'stardict' ? 'StarDict' : '词表';
  parts.push(label);
  if (meta.title && typeof meta.title === 'string') parts.push(meta.title);
  if (meta.hasResources === true) parts.push('含图片资源');
  if (typeof meta.parsedWordCount === 'number') parts.push(`索引词头 ${meta.parsedWordCount}`);
  parts.push(row.storage === 'file' ? '释义按需读取' : '释义已入库');
  return parts.join(' · ');
}

function parseMeta(metaJson: string | null): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed: unknown = JSON.parse(metaJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 内置词典的启用状态存在设置里（它们不在 dictionaries 表里）。
 * 默认全开：存的是「停用了哪些」，所以升级新增的词典不会被历史设置意外关掉。
 */
function activeBuiltinSources(disabled: ReadonlySet<string>): BuiltinSource[] {
  return BUILTIN_SOURCES.filter((source) => !disabled.has(source.id));
}

function builtinSummaries(): DictionarySummary[] {
  const disabled = new Set(getSettings().dictionaries.disabledIds);
  return BUILTIN_SOURCES.map((source) => {
    const enabled = !disabled.has(source.id);
    try {
      return {
        id: source.id,
        name: source.name,
        entryCount: source.entryCount(),
        enabled,
        createdAt: '',
        builtin: true,
        description: source.description,
        format: 'inline' as const,
        storage: 'sqlite' as const,
        contentType: 'text' as const,
      };
    } catch {
      // 文件缺失不该让整个设置页打不开：降级成一条可见的说明，查词继续走其它词典。
      return {
        id: source.id,
        name: source.name,
        entryCount: 0,
        enabled,
        createdAt: '',
        builtin: true,
        description: '词典文件缺失，请重新构建（见 server/assets/README.md）。',
        format: 'inline' as const,
        storage: 'sqlite' as const,
        contentType: 'text' as const,
      };
    }
  });
}

export function listDictionaries(): DictionarySummary[] {
  return [
    ...builtinSummaries(),
    ...getDb()
      .all<DictionaryRow>(
        `select id, name, entry_count, enabled, created_at, format, storage, content_type,
                source_dir, source_file, resource_file, meta_json, size_bytes
         from dictionaries order by created_at asc, id asc`,
      )
      .map((row) => ({ ...mapDictionary(row), description: dictionaryDescription(row) })),
  ];
}

export interface RawDictionaryEntry {
  term: string;
  definition: string;
  phonetic?: string | null;
}

export interface ImportDictionaryInput {
  name: string;
  entries: RawDictionaryEntry[];
  format?: DictionaryFormat;
}

/**
 * 词典导入：一次性写入 + 建索引，单用户本地词典通常几千到几万条，
 * 走事务批量插入比逐条 upsert 快一个数量级。
 */
export function importDictionary(input: ImportDictionaryInput): DictionarySummary {
  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('词典名称不能为空', { name: 'required' });
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new ValidationError('词典内容为空', { entries: 'required' });
  }

  const db = getDb();
  const existing = db.get<{ id: number; enabled: number }>(
    'select id, enabled from dictionaries where name = ?',
    name,
  );
  // 重新导入沿用旧的启用状态，别把用户关掉的词典又悄悄打开。
  const previousEnabled = existing?.enabled ?? 1;

  const now = nowIso();
  let inserted = 0;

  db.tx(() => {
    // 删除与重建必须在同一事务里：中途失败时旧词典要能原样保留。
    if (existing) {
      db.run('delete from dictionary_entries where dictionary_id = ?', existing.id);
      db.run('delete from dictionaries where id = ?', existing.id);
    }

    const result = db.run(
      `insert into dictionaries (name, entry_count, enabled, created_at, format, storage, content_type)
       values (?, 0, ?, ?, ?, 'sqlite', 'text')`,
      name,
      previousEnabled,
      now,
      input.format ?? 'inline',
    );
    const dictionaryId = result.lastInsertRowid;

    for (const entry of input.entries) {
      const term = (entry.term ?? '').trim();
      const definition = (entry.definition ?? '').trim();
      if (!term || !definition) continue;
      // 与查词候选共用同一套归一化：带连字符、所有格、全角字符的词条才能被查到。
      const normalized = normalizeVocabularyTerm(term);
      if (!normalized) continue;
      const written = db.run(
        `insert or ignore into dictionary_entries (dictionary_id, term, normalized_term, definition, phonetic)
         values (?, ?, ?, ?, ?)`,
        dictionaryId,
        term,
        normalized,
        definition,
        entry.phonetic ?? null,
      );
      inserted += written.changes;
    }

    db.run('update dictionaries set entry_count = ? where id = ?', inserted, dictionaryId);
  });

  return {
    id: String(
      getDb().get<{ id: number }>('select id from dictionaries where name = ?', name)?.id ?? 0,
    ),
    name,
    entryCount: inserted,
    enabled: previousEnabled === 1,
    createdAt: now,
    format: input.format ?? 'inline',
    storage: 'sqlite',
    contentType: 'text',
  };
}

/* --------------------------- 文件型词典导入 --------------------------- */

/**
 * 从本地文件导入 MDX / StarDict 词典。
 *
 * 一次可以传多组（用户框选了两个词典的全部文件），每组单独成为一本词典。
 * 解析失败的组不会影响其它组：错误按组收集后一起抛，让用户知道哪一本没进来。
 */
export function importDictionaryFiles(paths: string[]): DictionarySummary[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ValidationError('没有选择任何词典文件', { files: 'required' });
  }
  const groups = groupDictionaryFiles(paths);
  const imported: DictionarySummary[] = [];
  const failures: string[] = [];

  for (const group of groups) {
    try {
      imported.push(importDictionaryGroup(group));
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      failures.push(`${group.baseName}：${message}`);
    }
  }

  if (imported.length === 0) {
    throw new UnsupportedFileError(failures.length > 0 ? failures.join('；') : '没有可导入的词典');
  }
  if (failures.length > 0) {
    // 部分成功：把失败原因挂在最后一本上带出去，前端弹提示但不回滚已成功的。
    imported[imported.length - 1] = {
      ...imported[imported.length - 1],
      description: `${imported[imported.length - 1].description ?? ''}（另有 ${failures.length} 组失败：${failures.join('；')}）`,
    };
  }
  return imported;
}

function importDictionaryGroup(group: DictionaryFileSet): DictionarySummary {
  const format = detectFormat(group);
  const files = [group.mdx, group.mdd, group.ifo, group.idx, group.dict, group.dz, group.syn].filter(
    (path): path is string => Boolean(path),
  );

  const dir = createDictionaryDir();
  let source: DictionarySource | null = null;

  try {
    const copies = copyIntoDictionary(dir, files);
    const copy = (path: string | null): string | null => (path ? copies.get(path) ?? null : null);

    source =
      format === 'mdx'
        ? parseMdx({ mdx: copy(group.mdx) as string, mdd: copy(group.mdd) })
        : parseStarDict({
            ifo: copy(group.ifo) as string,
            // .dict 优先于 .dict.dz：有未压缩版本时读起来更快，也不用在查询期整本解压。
            idx: copy(group.idx),
            dict: copy(group.dict),
            dz: copy(group.dict) ? null : copy(group.dz),
            syn: copy(group.syn),
          });

    const name = resolveDictionaryName(source, group.baseName);
    const sizeBytes = [...copies.values()].reduce((total, path) => total + fileSize(path), 0);
    return persistFileDictionary({ source, name, dir, sizeBytes });
  } catch (err) {
    source?.close?.();
    removeDictionaryDir(dir);
    throw err;
  }
}

function resolveDictionaryName(source: DictionarySource, fallback: string): string {
  const title = source.meta.title ?? source.meta.bookname;
  if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 80);
  return fallback.replace(/[\\/]/g, ' ').trim().slice(0, 80) || '导入词典';
}

function persistFileDictionary(input: {
  source: DictionarySource;
  name: string;
  dir: string;
  sizeBytes: number;
}): DictionarySummary {
  const { source, name, dir, sizeBytes } = input;
  const db = getDb();
  const existing = db.get<{ id: number; enabled: number }>(
    'select id, enabled from dictionaries where name = ?',
    name,
  );
  const previousEnabled = existing?.enabled ?? 1;
  const now = nowIso();
  let dictionaryId = 0;
  let inserted = 0;

  try {
    db.tx(() => {
      if (existing) {
        db.run('delete from dictionary_entries where dictionary_id = ?', existing.id);
        db.run('delete from dictionaries where id = ?', existing.id);
      }
      const result = db.run(
        `insert into dictionaries
           (name, entry_count, enabled, created_at, format, storage, content_type,
            source_dir, source_file, resource_file, meta_json, size_bytes)
         values (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name,
        previousEnabled,
        now,
        source.format,
        source.storage,
        source.contentType,
        relativeToRoot(dir),
        source.sourceFile ? relativeToRoot(source.sourceFile) : null,
        source.resourceFile ? relativeToRoot(source.resourceFile) : null,
        JSON.stringify(relativizeMeta(source)),
        sizeBytes,
      );
      dictionaryId = result.lastInsertRowid;

      for (const entry of source.iterate()) {
        const term = entry.term.trim();
        if (!term) continue;
        const normalized = normalizeVocabularyTerm(term);
        if (!normalized) continue;
        const written = db.run(
          `insert or ignore into dictionary_entries
             (dictionary_id, term, normalized_term, definition, phonetic, record_start, record_end)
           values (?, ?, ?, ?, ?, ?, ?)`,
          dictionaryId,
          term,
          normalized,
          entry.definition,
          entry.phonetic,
          entry.recordStart,
          entry.recordEnd,
        );
        inserted += written.changes;
      }

      db.run('update dictionaries set entry_count = ? where id = ?', inserted, dictionaryId);
    });
  } finally {
    source.close?.();
  }

  const row = db.get<DictionaryRow>(
    `select id, name, entry_count, enabled, created_at, format, storage, content_type,
            source_dir, source_file, resource_file, meta_json, size_bytes
     from dictionaries where id = ?`,
    dictionaryId,
  );
  if (!row) throw new NotFoundError('词典写入后读取失败');
  return { ...mapDictionary(row), description: dictionaryDescription(row) };
}

/** meta 里可能带绝对路径（数据文件的副本位置），入库前统一换成相对路径。 */
function relativizeMeta(source: DictionarySource): Record<string, unknown> {
  const meta = { ...source.meta };
  const dataFile = meta.dataFile;
  if (typeof dataFile === 'string') {
    try {
      meta.dataFile = relativeToRoot(dataFile);
    } catch {
      meta.dataFile = null;
    }
  }
  return meta;
}

export function deleteDictionary(id: string): void {
  if (isBuiltinDictionaryId(id)) throw new ValidationError('内置词典随应用分发，不能删除（可以停用）');
  const numeric = Number(id);
  const row = getDb().get<{ id: number; source_dir: string | null }>(
    'select id, source_dir from dictionaries where id = ?',
    numeric,
  );
  if (!row) throw new NotFoundError('词典不存在');

  closeDictionaryReader(numeric);
  getDb().run('delete from dictionary_entries where dictionary_id = ?', numeric);
  getDb().run('delete from dictionaries where id = ?', numeric);
  // 先删库再删文件：文件删失败最多留一份孤儿目录，反过来会留下点不开的词典。
  if (row.source_dir) {
    try {
      removeDictionaryDir(absoluteFromRoot(row.source_dir));
    } catch {
      // 存储未初始化（测试场景）时忽略。
    }
  }
}

export function setDictionaryEnabled(id: string, enabled: boolean): DictionarySummary {
  if (isBuiltinDictionaryId(id)) {
    setDictionaryEnabledSetting(id, enabled);
    const summary = builtinSummaries().find((item) => item.id === id);
    if (!summary) throw new NotFoundError('词典不存在');
    return summary;
  }
  const numeric = Number(id);
  const db = getDb();
  const updated = db.run('update dictionaries set enabled = ? where id = ?', enabled, numeric);
  if (updated.changes === 0) throw new NotFoundError('词典不存在');
  // 停用后立刻放掉文件句柄，别让一本不用的词典继续占着几十兆内存。
  if (!enabled) closeDictionaryReader(numeric);
  const row = db.get<DictionaryRow>(
    `select id, name, entry_count, enabled, created_at, format, storage, content_type,
            source_dir, source_file, resource_file, meta_json, size_bytes
     from dictionaries where id = ?`,
    numeric,
  );
  if (!row) throw new NotFoundError('词典不存在');
  return mapDictionary(row);
}

/* ------------------------------- 查词 ------------------------------- */

interface LookupRow {
  term: string;
  definition: string;
  phonetic: string | null;
  name: string;
  normalized_term: string;
  dict_id: number;
  storage: string;
  content_type: string;
  format: string;
  source_file: string | null;
  resource_file: string | null;
  meta_json: string | null;
  record_start: number | null;
  record_end: number | null;
}

/**
 * 文件内资源的对外地址。
 * `<img>` 带不上自定义请求头，所以令牌只能走查询参数——本地单用户场景下
 * 这份 token 本来就只存在前端内存里，放在 URL 上不会多暴露任何东西。
 */
export function dictionaryResourceUrl(dictionaryId: number, key: string): string {
  const token = getActiveConfig()?.token;
  const search = new URLSearchParams({ key });
  if (token) search.set('token', token);
  return `/api/dictionaries/${dictionaryId}/resource?${search.toString()}`;
}

function resolveRowContent(row: LookupRow): string | null {
  if (row.storage !== 'file') {
    const text = row.definition?.trim();
    return text ? row.definition : null;
  }
  if (row.record_start === null || row.record_end === null) return null;

  let sourceFile: string | null = null;
  try {
    sourceFile = row.source_file ? absoluteFromRoot(row.source_file) : null;
  } catch {
    return null;
  }
  const reader = getDictionaryReader({
    id: row.dict_id,
    format: row.format as DictionaryFormat,
    sourceFile,
    resourceFile: row.resource_file ? safeAbsolute(row.resource_file) : null,
    metaJson: row.meta_json,
  });
  if (!reader) return null;

  const raw = reader.readDefinition(row.record_start, row.record_end);
  if (!raw) return null;
  return prepareDefinition(raw, row.content_type as EntryContentType, (key) =>
    dictionaryResourceUrl(row.dict_id, key),
  );
}

function safeAbsolute(stored: string): string | null {
  try {
    return absoluteFromRoot(stored);
  } catch {
    return null;
  }
}

function mapEntry(row: LookupRow, definition: string): DictionaryEntry {
  return {
    term: row.term,
    definition,
    phonetic: row.phonetic,
    dictionaryName: row.name,
    contentType: (row.content_type as EntryContentType) ?? 'text',
  };
}

/**
 * 查词顺序：
 *   1. 用户导入/安装的词典（精确命中，按导入先后）；
 *   2. 启用中的内置词典（中英核心词库 / WordNet / 词组词典），同一词头命中多本时合成一条释义；
 *   3. 词形还原后的 1～2 步（studied → study，looked forward to → look forward to）；
 *   4. 用户词典的前缀 / FTS 模糊兜底。
 *
 * 内置词典是否参与由设置决定（`dictionaries.disabledIds`），每次查词只读一次设置。
 * 三本都停用也不会报错：查不到就是查不到。
 * 第 3 步的规则见 lib/morphology.ts：候选必须带词性、且真的在词典里存在，
 * 否则 `us` 会被解释成 `use`。
 */
export function lookupWord(rawTerm: string): DictionaryLookupResult {
  const term = (rawTerm ?? '').trim();
  if (!term) throw new ValidationError('查询词不能为空', { term: 'required' });

  const normalized = normalizeVocabularyTerm(term);
  if (!normalized) throw new ValidationError('查询词不能为空', { term: 'required' });

  const candidates = dictionaryLookupCandidates(normalized);
  const sources = activeBuiltinSources(new Set(getSettings().dictionaries.disabledIds));
  const direct = findExact(candidates, sources);

  if (!normalized.includes(' ')) {
    const lemma = resolveLemma(candidates, sources);
    if (lemma) {
      const base = findExact([lemma.lemma], sources);
      // 变形词自己也可能是词条（studied 是形容词、tired 是形容词、running 是名词）。
      // 两个都有时不能只给一个：选 studied 的人多半要 study，但 studied 的形容词义也是真的。
      if (base) return { term, entries: [mergeInflection(direct, base, lemma)] };
    }
    if (direct) return { term, entries: [direct] };
  } else {
    if (direct) return { term, entries: [direct] };
    // 词组只还原一个词：looked forward to → look forward to。
    for (const variant of phraseVariants(normalized)) {
      const hit = findExact([variant], sources);
      if (hit) return { term, entries: [hit] };
    }
  }

  return { term, entries: fuzzyEntries(normalized) };
}

/** 精确查词：用户词典优先；没命中才由内置词典合成。 */
function findExact(candidates: string[], sources: readonly BuiltinSource[]): DictionaryEntry | null {
  if (!candidates.length) return null;
  const stored = findUserDictionaryRows(candidates);
  if (stored) return stored;
  for (const candidate of candidates) {
    const merged = mergeBuiltinHits(candidate, sources);
    if (merged) return merged;
  }
  return null;
}

function safeLookup<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    // 内置资源缺失（打包漏文件）不能把整次查词变成 500，降级成「这本没查到」。
    return null;
  }
}

/**
 * 内置词典命中合成。
 *
 * 三本是独立数据源，但用户看到的是**一张卡片**：中文释义在前，英英释义与例句跟在后面，
 * 音标优先用 WordNet 的 IPA（中英词库那份是 ASCII 近似标音）。
 * 只用一本时 dictionaryName 就是那本的名字；多本命中时用「 · 」连起来，卡片上能看到来源。
 */
function mergeBuiltinHits(term: string, sources: readonly BuiltinSource[]): DictionaryEntry | null {
  const hits: Array<{ source: BuiltinSource; entry: BuiltinDictionaryEntry }> = [];
  for (const source of sources) {
    const entry = safeLookup(() => source.lookup(term));
    if (entry) hits.push({ source, entry });
  }
  if (!hits.length) return null;
  // 词组词典命中时它的释义必须排最前：百度式的一条短语中文释义比 WordNet 的动词拆分更直接，
  // 而且 WordNet 一条多词词条能占满 10 行，不排前面就会被行数上限切掉。
  hits.sort((a, b) => linePriority(a.source) - linePriority(b.source));

  const lines: string[] = [];
  for (const hit of hits) {
    for (const line of hit.entry.meanings) if (!lines.includes(line)) lines.push(line);
  }
  const phonetic =
    hits.find((hit) => hit.source.id === 'builtin-wordnet' && hit.entry.phonetic)?.entry.phonetic ??
    hits.find((hit) => hit.entry.phonetic)?.entry.phonetic ??
    null;

  return {
    term: hits[0].entry.term,
    // 释义行数兜底：WordNet 单词最多 10 行 + 中文 6 行，再多卡片就成滚动了。
    definition: lines.slice(0, 12).join('\n'),
    phonetic,
    dictionaryName: hits.map((hit) => hit.source.name).join(' · '),
    contentType: 'text',
  };
}

/** 用户词典精确命中：同一个词在多本词典里出现时，先导入的胜出。 */
function findUserDictionaryRows(candidates: string[]): DictionaryEntry | null {
  const db = getDb();
  const placeholders = candidates.map(() => '?').join(', ');
  const stored = db.all<LookupRow>(
    `select e.term, e.definition, e.phonetic, d.name, e.normalized_term,
            d.id as dict_id, d.storage, d.content_type, d.format,
            d.source_file, d.resource_file, d.meta_json,
            e.record_start, e.record_end
     from dictionary_entries e
     join dictionaries d on d.id = e.dictionary_id
     where d.enabled = 1 and e.normalized_term in (${placeholders})
     order by d.created_at asc, d.id asc, e.id asc`,
    ...candidates,
  );

  const byTerm = new Map<string, LookupRow[]>();
  for (const row of stored) {
    const list = byTerm.get(row.normalized_term);
    if (list) list.push(row);
    else byTerm.set(row.normalized_term, [row]);
  }
  for (const candidate of candidates) {
    for (const row of byTerm.get(candidate) ?? []) {
      const definition = resolveRowContent(row);
      if (definition) return mapEntry(row, definition);
    }
  }
  return null;
}

/**
 * 词典里这个词头有哪些词性。
 * 内置词典里存了词性（WordNet 显式、中英词库从释义前缀推导）；用户导入的词表没有词性，
 * 返回空串表示「未知」，此时 acceptsPos 一律放行——猜错一个用户自己的词，
 * 比什么都查不到更容易被发现。
 */
function lexiconPos(term: string, sources: readonly BuiltinSource[]): { pos: string } | null {
  let found = false;
  let pos = '';
  for (const source of sources) {
    const entry = safeLookup(() => source.lookup(term));
    if (!entry) continue;
    found = true;
    if (entry.pos) {
      pos = entry.pos;
      break;
    }
  }
  if (found) return { pos };
  const row = getDb().get<{ id: number }>(
    `select e.id
     from dictionary_entries e
     join dictionaries d on d.id = e.dictionary_id
     where d.enabled = 1 and e.normalized_term = ?
     limit 1`,
    term,
  );
  return row ? { pos: '' } : null;
}

interface ResolvedLemma {
  lemma: string;
  /** 命中的变形类型，用来给用户一句「这个词是 study 的过去式」。 */
  label: string;
}

/** 变形类型 → 给用户看的中文说法。一条规则可能同时是两种形态（-ed 既是过去式也是过去分词）。 */
const RULE_LABEL: Record<string, string> = {
  possessive: '所有格',
  'irregular-verb': '不规则变形',
  'irregular-plural': '不规则复数',
  'irregular-degree': '比较级/最高级',
  'plural-es-is': '复数',
  'plural-ies': '复数/第三人称单数',
  'plural-es': '复数/第三人称单数',
  'plural-es-s': '复数/第三人称单数',
  'plural-s': '复数/第三人称单数',
  'past-ied': '过去式/过去分词',
  'past-double': '过去式/过去分词',
  'past-ed': '过去式/过去分词',
  'past-e': '过去式/过去分词',
  'past-ck': '过去式/过去分词',
  'ing-ie': '现在分词',
  'ing-y': '现在分词',
  'ing-double': '现在分词',
  ing: '现在分词',
  'ing-e': '现在分词',
  'est-iest': '最高级',
  'er-ier': '比较级',
  'est-double': '最高级',
  'er-double': '比较级',
  est: '最高级',
  er: '比较级',
  'est-e': '最高级',
  'er-e': '比较级',
};

/**
 * 把候选形态还原成词典里真实存在的词头，按可信度取第一个。
 *
 * 这里不做「先查再说」——先验证词性、再验证存在性，两个都过才收。
 * 单复数与过去式在拼写上会撞车（`used` 可能是 `use` 的过去式，`uses` 可能是 `use` 的三单），
 * 但两者都指向同一个词头，所以不需要消歧；真正需要消的歧靠 score 顺序与词性过滤解决。
 */
function resolveLemma(
  candidates: string[],
  sources: readonly BuiltinSource[],
): ResolvedLemma | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const item of lemmaCandidates(candidate)) {
      if (seen.has(item.lemma)) continue;
      seen.add(item.lemma);
      const known = lexiconPos(item.lemma, sources);
      if (!known) continue;
      if (!acceptsPos(known.pos, item.pos as ReadonlySet<PartOfSpeech>)) continue;
      return { lemma: item.lemma, label: RULE_LABEL[item.rule] ?? '变形' };
    }
  }
  return null;
}

/**
 * 把「选中形态」与「还原后的词头」合成一条释义。
 *
 * 形如：
 *   adj. produced or marked by conscious design
 *   （studied 是 study 的过去式/过去分词）
 *   n. 学习, 研究, 学科
 * 顺序是「选中的词自己的释义 → 一句说明 → 词头的释义」，因为用户查的毕竟是选中那个词。
 */
function mergeInflection(
  surface: DictionaryEntry | null,
  base: DictionaryEntry,
  lemma: ResolvedLemma,
): DictionaryEntry {
  // 选中的形态自己不是词条 → 只有一个词头可给，不必加任何说明。
  if (!surface) return base;
  // 用户自己导入的词条说了算：不往里面掺内置词库的释义，免得自定义词表被稀释。
  if (!isBuiltinName(surface.dictionaryName)) return surface;
  const lines = surface.definition.split('\n');
  lines.push(`（${surface.term} 是 ${base.term} 的${lemma.label}）`);
  for (const line of base.definition.split('\n')) {
    if (!lines.includes(line)) lines.push(line);
  }
  return {
    ...surface,
    definition: lines.slice(0, 12).join('\n'),
  };
}

/** 合成释义时的行序：词组（最贴合该表达）→ 中英 → 英英。 */
function linePriority(source: BuiltinSource): number {
  if (source.id === 'builtin-phrases') return 0;
  if (source.id === 'builtin-zh-core') return 1;
  return 2;
}

function isBuiltinName(name: string): boolean {
  return BUILTIN_SOURCES.some((source) => name.includes(source.name));
}

/** 前缀/FTS 模糊兜底：整词没收录时的最后一招。 */
function fuzzyEntries(normalized: string): DictionaryEntry[] {
  const db = getDb();
  let fuzzy: LookupRow[] = [];
  try {
    fuzzy = db.all<LookupRow>(
      `select e.term, e.definition, e.phonetic, d.name, e.normalized_term,
              d.id as dict_id, d.storage, d.content_type, d.format,
              d.source_file, d.resource_file, d.meta_json,
              e.record_start, e.record_end
       from dictionary_entries e
       join dictionaries d on d.id = e.dictionary_id
       where d.enabled = 1 and e.id in (
         select rowid from dictionary_entries_fts where dictionary_entries_fts match ?
       )
       limit 12`,
      `"${normalized.replace(/"/g, '""')}"*`,
    );
  } catch {
    fuzzy = db.all<LookupRow>(
      `select e.term, e.definition, e.phonetic, d.name, e.normalized_term,
              d.id as dict_id, d.storage, d.content_type, d.format,
              d.source_file, d.resource_file, d.meta_json,
              e.record_start, e.record_end
       from dictionary_entries e
       join dictionaries d on d.id = e.dictionary_id
       where d.enabled = 1 and e.normalized_term like ?
       limit 12`,
      `${normalized}%`,
    );
  }

  const entries: DictionaryEntry[] = [];
  for (const row of fuzzy) {
    const definition = resolveRowContent(row);
    if (definition) entries.push(mapEntry(row, definition));
  }
  return entries;
}

/* ---------------------------- 词典内资源 ---------------------------- */

const RESOURCE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  css: 'text/css',
  js: 'text/javascript',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

export interface DictionaryResource {
  data: Buffer;
  mime: string;
}

/** 读取 .mdd / StarDict 里附带的图片、样式、发音。 */
export function getDictionaryResource(id: string, key: string): DictionaryResource {
  const numeric = Number(id);
  const row = getDb().get<DictionaryRow>(
    `select id, name, entry_count, enabled, created_at, format, storage, content_type,
            source_dir, source_file, resource_file, meta_json, size_bytes
     from dictionaries where id = ?`,
    numeric,
  );
  if (!row) throw new NotFoundError('词典不存在');
  if (!row.resource_file) throw new NotFoundError('这本词典没有附带资源文件');

  const reader = getDictionaryReader({
    id: row.id,
    format: row.format as DictionaryFormat,
    sourceFile: row.source_file ? safeAbsolute(row.source_file) : null,
    resourceFile: safeAbsolute(row.resource_file),
    metaJson: row.meta_json,
  });
  if (!reader?.readResource) throw new NotFoundError('这本词典不支持资源读取');

  const data = reader.readResource(key);
  if (!data) throw new NotFoundError(`词典内找不到资源：${key}`);

  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '';
  return { data, mime: RESOURCE_MIME[ext] ?? 'application/octet-stream' };
}
