import { getDb } from '../db/sqlite';
import { nowIso } from '../lib/utils';
import { NotFoundError, ValidationError } from '../http/envelope';
import { dictionaryLookupCandidates, normalizeVocabularyTerm } from '../lib/englishLearning';
import { getActiveConfig } from '../config';
import {
  BUILTIN_DICTIONARY_DESCRIPTION,
  BUILTIN_DICTIONARY_ID,
  BUILTIN_DICTIONARY_NAME,
  builtinDictionaryEntryCount,
  lookupBuiltinDictionary,
} from './builtinDictionary';
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

function mapDictionary(row: DictionaryRow): DictionarySummary {
  return {
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

/** 内置词典始终排在最前：它是默认可用、且无需用户维护的那一本。 */
function builtinSummary(): DictionarySummary {
  try {
    return {
      id: BUILTIN_DICTIONARY_ID,
      name: BUILTIN_DICTIONARY_NAME,
      entryCount: builtinDictionaryEntryCount(),
      enabled: true,
      createdAt: '',
      builtin: true,
      description: BUILTIN_DICTIONARY_DESCRIPTION,
      format: 'inline',
      storage: 'sqlite',
      contentType: 'text',
    };
  } catch {
    // 文件缺失不该让整个设置页打不开：降级成一条可见的说明，查词继续走用户词典。
    return {
      id: BUILTIN_DICTIONARY_ID,
      name: BUILTIN_DICTIONARY_NAME,
      entryCount: 0,
      enabled: true,
      createdAt: '',
      builtin: true,
      description: '内置词典文件缺失，请重新构建或部署 server/assets/en-zh.json。',
      format: 'inline',
      storage: 'sqlite',
      contentType: 'text',
    };
  }
}

export function listDictionaries(): DictionarySummary[] {
  return [
    builtinSummary(),
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
  if (id === BUILTIN_DICTIONARY_ID) throw new ValidationError('内置核心词库是默认词典，不能删除');
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
  if (id === BUILTIN_DICTIONARY_ID) throw new ValidationError('内置核心词库是默认词典，不能停用');
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
 * 查词顺序与原版一致：
 * 1. 用户导入/安装的词典（精确命中，按导入先后排序）；
 * 2. 内置核心词库（随应用分发的那份 en-zh.json）；
 * 3. 用户词典的前缀/FTS 模糊兜底，保证输入变形也能查到。
 *
 * 内置词典排在用户词典之后，是因为用户导入的词典往往更专业、更有针对性。
 * 文件型词典的释义要回原文件读，读失败（文件被挪走）时继续尝试下一个候选，
 * 不能因为一本词典坏了就让整个查词失败。
 */
export function lookupWord(rawTerm: string): DictionaryLookupResult {
  const term = (rawTerm ?? '').trim();
  if (!term) throw new ValidationError('查询词不能为空', { term: 'required' });

  const normalized = normalizeVocabularyTerm(term);
  if (!normalized) throw new ValidationError('查询词不能为空', { term: 'required' });
  const candidates = dictionaryLookupCandidates(normalized);
  const db = getDb();

  if (candidates.length > 0) {
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

    // 按候选顺序取最高优先级的一行：同一个词在多个词典里出现时，先导入的胜出。
    const byTerm = new Map<string, LookupRow[]>();
    for (const row of stored) {
      const list = byTerm.get(row.normalized_term);
      if (list) list.push(row);
      else byTerm.set(row.normalized_term, [row]);
    }
    for (const candidate of candidates) {
      for (const row of byTerm.get(candidate) ?? []) {
        const definition = resolveRowContent(row);
        if (definition) return { term, entries: [mapEntry(row, definition)] };
      }
    }
  }

  for (const candidate of candidates) {
    let builtin;
    try {
      builtin = lookupBuiltinDictionary(candidate);
    } catch {
      break;
    }
    if (builtin) {
      return {
        term,
        entries: [
          {
            term: builtin.term,
            definition: builtin.meanings.join('\n'),
            phonetic: builtin.phonetic ?? null,
            dictionaryName: BUILTIN_DICTIONARY_NAME,
            contentType: 'text',
          },
        ],
      };
    }
  }

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
  return { term, entries };
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
