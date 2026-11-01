import { MDX, MDD } from 'js-mdict';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { DictionaryFormat } from './types';

/**
 * 查询期的释义读取器。
 *
 * 文件型词典在库里只有「词头 + 偏移」，真正的释义要回原文件取。
 * 这里做两件事：
 *   1. 按格式提供 readDefinition（MDX 解 record 块，StarDict 切 .dict）；
 *   2. 给打开的文件句柄加一层 LRU + 空闲回收，避免词典装了一堆就一直占着内存。
 *
 * 为什么必须回收：MDX 打开时会解出全部词头（ODE 24 万词头约 56MB 堆内存），
 * 装两三本大词典又不回收，桌面端的常驻内存会很难看。
 */

export interface DictionaryReader {
  readDefinition(recordStart: number, recordEnd: number): string | null;
  /** MDD / StarDict 里附带的图片、样式、音频。 */
  readResource?(key: string): Buffer | null;
  close(): void;
}

export interface ReaderSpec {
  id: number;
  format: DictionaryFormat;
  sourceFile: string | null;
  resourceFile: string | null;
  metaJson: string | null;
}

/* ------------------------------ MDX / MDD ------------------------------ */

class MdxReader implements DictionaryReader {
  #mdx: MDX;
  #mdd: MDD | null = null;

  constructor(sourceFile: string, resourceFile: string | null) {
    this.#mdx = new MDX(sourceFile);
    if (resourceFile) {
      try {
        this.#mdd = new MDD(resourceFile);
      } catch {
        // .mdd 损坏不该让整本词典不可用：还能查释义，只是图片显示不出来。
        this.#mdd = null;
      }
    }
  }

  readDefinition(recordStart: number, recordEnd: number): string | null {
    try {
      const item = {
        keyText: '',
        recordStartOffset: recordStart,
        recordEndOffset: recordEnd,
        keyBlockIdx: 0,
      };
      return this.#mdx.fetch(item).definition ?? null;
    } catch {
      return null;
    }
  }

  readResource(key: string): Buffer | null {
    if (!this.#mdd || !key) return null;
    try {
      // js-mdict 的 locate 会把 / 归一成 \ 并补前导反斜杠，返回 base64。
      const located = this.#mdd.locate(key);
      if (!located.definition) return null;
      return Buffer.from(located.definition, 'base64');
    } catch {
      return null;
    }
  }

  close(): void {
    for (const instance of [this.#mdx, this.#mdd]) {
      const scanner = (instance as unknown as { scanner?: { close?: () => void } } | null)?.scanner;
      scanner?.close?.();
    }
  }
}

/* ------------------------------- StarDict ------------------------------- */

/** StarDict 的字段类型：能当文本渲染的只有下面这些，P/W 是图片和音频。 */
const TEXT_FIELD_TYPES = new Set(['m', 'l', 'g', 't', 'x', 'y', 'k', 'h', 'n', 'X']);

/**
 * StarDict 数据块解码。
 * sametypesequence 存在时字段顺序由它给定、最后一个字段吃到块尾；
 * 不存在时每段自带 [type:1][size:4 BE] 头。
 */
export function decodeStarDictRecord(buffer: Buffer, sequence: string): string {
  const parts: string[] = [];

  if (!sequence) {
    let cursor = 0;
    while (cursor + 5 <= buffer.length) {
      const type = String.fromCharCode(buffer[cursor]);
      const size = buffer.readUInt32BE(cursor + 1);
      const start = cursor + 5;
      const end = start + size;
      if (end > buffer.length) break;
      if (TEXT_FIELD_TYPES.has(type)) parts.push(buffer.subarray(start, end).toString('utf8'));
      cursor = end;
    }
    return parts.join('\n').trim();
  }

  let cursor = 0;
  for (let index = 0; index < sequence.length; index += 1) {
    const type = sequence[index];
    const isLast = index === sequence.length - 1;
    let end: number;
    if (isLast) {
      end = buffer.length;
    } else {
      if (cursor + 4 > buffer.length) break;
      end = cursor + 4 + buffer.readUInt32BE(cursor);
      cursor += 4;
      if (end > buffer.length) break;
    }
    if (TEXT_FIELD_TYPES.has(type)) parts.push(buffer.subarray(cursor, end).toString('utf8'));
    cursor = end;
  }
  return parts.join('\n').trim();
}

class StarDictReader implements DictionaryReader {
  #fd: number | null = null;
  #buffer: Buffer | null = null;
  readonly #dataFile: string;
  readonly #sequence: string;
  readonly #compressed: boolean;

  constructor(dataFile: string, sequence: string, compressed: boolean) {
    this.#dataFile = dataFile;
    this.#sequence = sequence;
    this.#compressed = compressed;
    if (!compressed) this.#fd = openSync(dataFile, 'r');
  }

  /** .dict.dz 只能整体解压（dictzip 的随机访问表实现成本远高于直接解一份）。 */
  #ensureBuffer(): Buffer | null {
    if (this.#buffer) return this.#buffer;
    try {
      this.#buffer = this.#compressed
        ? gunzipSync(readFileSync(this.#dataFile))
        : null;
      return this.#buffer;
    } catch {
      return null;
    }
  }

  readDefinition(recordStart: number, recordEnd: number): string | null {
    const size = recordEnd - recordStart;
    if (size <= 0) return null;
    let slice: Buffer | null = null;

    if (this.#fd === null) {
      const buffer = this.#ensureBuffer();
      if (!buffer || recordEnd > buffer.length) return null;
      slice = buffer.subarray(recordStart, recordEnd);
    } else {
      try {
        if (recordEnd > statSync(this.#dataFile).size) return null;
        slice = Buffer.allocUnsafe(size);
        readSync(this.#fd, slice, 0, size, recordStart);
      } catch {
        return null;
      }
    }

    const text = decodeStarDictRecord(slice, this.#sequence);
    return text.length > 0 ? text : null;
  }

  close(): void {
    this.#buffer = null;
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {
        // 已经关掉就算了，回收路径不该再抛错。
      }
      this.#fd = null;
    }
  }
}

/* ------------------------------ 句柄缓存 ------------------------------ */

const MAX_OPEN_READERS = 2;
const IDLE_TIMEOUT_MS = 5 * 60_000;

interface CachedReader {
  reader: DictionaryReader;
  lastUsed: number;
}

const cache = new Map<number, CachedReader>();

function evictIdle(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      entry.reader.close();
      cache.delete(id);
    }
  }
  // 还是超了就从最久没用的开始关。
  while (cache.size > MAX_OPEN_READERS) {
    let oldestId: number | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of cache) {
      if (entry.lastUsed < oldestAt) {
        oldestAt = entry.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    cache.get(oldestId)?.reader.close();
    cache.delete(oldestId);
  }
}

function createReader(spec: ReaderSpec): DictionaryReader | null {
  if (!spec.sourceFile) return null;
  try {
    if (spec.format === 'mdx') return new MdxReader(spec.sourceFile, spec.resourceFile);
    if (spec.format === 'stardict') {
      const meta = parseMeta(spec.metaJson);
      const dataFile = typeof meta.dataFile === 'string' ? meta.dataFile : null;
      if (!dataFile) return null;
      const sequence = typeof meta.sametypesequence === 'string' ? meta.sametypesequence : '';
      return new StarDictReader(dataFile, sequence, meta.compressed === true);
    }
  } catch (err) {
    console.warn('[dict] 打开词典失败', spec.id, err);
  }
  return null;
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

export function getDictionaryReader(spec: ReaderSpec): DictionaryReader | null {
  evictIdle();
  const cached = cache.get(spec.id);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.reader;
  }
  const reader = createReader(spec);
  if (!reader) return null;
  cache.set(spec.id, { reader, lastUsed: Date.now() });
  evictIdle();
  return reader;
}

export function closeDictionaryReader(id: number): void {
  const cached = cache.get(id);
  if (!cached) return;
  cached.reader.close();
  cache.delete(id);
}

export function closeAllDictionaryReaders(): void {
  for (const entry of cache.values()) entry.reader.close();
  cache.clear();
}
