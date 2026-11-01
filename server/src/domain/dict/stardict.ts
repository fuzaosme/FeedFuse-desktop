import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { UnsupportedFileError } from './files';
import type { DictionarySource, EntryContentType, ParsedEntry } from './types';

/**
 * StarDict 结构（https://github.com/huzheng001/stardict-3 的 doc/StarDictFileFormat）：
 *   .ifo  纯文本元信息（wordcount / idxfilesize / sametypesequence / idxoffsetbits）
 *   .idx  词头 + 数据块偏移，按词头排序，随机访问靠它
 *   .dict 数据块；.dict.dz 是 dictzip（gzip 变体），整体解压后偏移仍是对解压流而言
 *   .syn  同义词 → .idx 里的词条序号
 *
 * 这里只解析词头与偏移，释义留给查询期按需读取——和 MDX 保持同一套「文件后备」策略。
 */

export interface StarDictIfo {
  version?: string;
  bookname?: string;
  wordcount?: string;
  idxfilesize?: string;
  idxoffsetbits?: string;
  sametypesequence?: string;
  description?: string;
  author?: string;
  email?: string;
  website?: string;
  date?: string;
  dicttype?: string;
}

export function parseIfo(text: string): StarDictIfo {
  const info: StarDictIfo = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!value) continue;
    info[key as keyof StarDictIfo] = value;
  }
  return info;
}

/** `.idx` 可能被单独 gzip 过（.idx.gz），两种都要能读。 */
export function readIdxBuffer(path: string): Buffer {
  const raw = readFileSync(path);
  if (path.toLowerCase().endsWith('.gz')) return gunzipSync(raw);
  return raw;
}

interface IdxEntry {
  word: string;
  offset: number;
  size: number;
}

/**
 * 逐条解析 .idx。
 * 单条格式：[词头 UTF-8][0x00][offset BE 4/8 字节][size BE 4 字节]
 * 遇到截断的尾巴直接停下——比抛错更接近用户在别的软件里看到的效果。
 */
export function* iterateIdx(buffer: Buffer, offsetBits: 32 | 64): Generator<IdxEntry> {
  const offsetBytes = offsetBits === 64 ? 8 : 4;
  let cursor = 0;

  while (cursor < buffer.length) {
    const terminator = buffer.indexOf(0, cursor);
    if (terminator < 0) return;
    const word = buffer.subarray(cursor, terminator).toString('utf8');
    const offsetStart = terminator + 1;
    const sizeStart = offsetStart + offsetBytes;
    if (sizeStart + 4 > buffer.length) return;

    const offset =
      offsetBits === 64
        ? Number(buffer.readBigUInt64BE(offsetStart))
        : buffer.readUInt32BE(offsetStart);
    const size = buffer.readUInt32BE(sizeStart);
    cursor = sizeStart + 4;

    if (!word) continue;
    yield { word, offset, size };
  }
}

/**
 * .syn：[同义词 UTF-8][0x00][idx 词条序号 BE 4 字节]。
 * 同义词没有自己的数据块，指向主词条的 offset/size。
 */
export function* iterateSyn(buffer: Buffer, entries: IdxEntry[]): Generator<IdxEntry> {
  let cursor = 0;
  while (cursor < buffer.length) {
    const terminator = buffer.indexOf(0, cursor);
    if (terminator < 0) return;
    const word = buffer.subarray(cursor, terminator).toString('utf8');
    const indexStart = terminator + 1;
    if (indexStart + 4 > buffer.length) return;
    const index = buffer.readUInt32BE(indexStart);
    cursor = indexStart + 4;
    const target = entries[index];
    if (!word || !target) continue;
    yield { word, offset: target.offset, size: target.size };
  }
}

function contentTypeOf(sequence: string): EntryContentType {
  // h = HTML，g = Pango markup，两者都含标签，按 HTML 渲染最接近原貌。
  return /[hg]/.test(sequence) ? 'html' : 'text';
}

export function parseStarDict(files: {
  ifo: string;
  idx: string | null;
  dict: string | null;
  dz: string | null;
  syn: string | null;
}): DictionarySource {
  if (!files.idx) {
    throw new UnsupportedFileError('StarDict 词典缺少 .idx 索引文件，无法定位词条');
  }
  if (!files.dict && !files.dz) {
    throw new UnsupportedFileError('StarDict 词典缺少 .dict 或 .dict.dz 数据文件，只有索引没法查词');
  }

  const info = parseIfo(readFileSync(files.ifo, 'utf8'));
  const idxBuffer = readIdxBuffer(files.idx);
  const offsetBits: 32 | 64 = info.idxoffsetbits === '64' ? 64 : 32;
  const sequence = info.sametypesequence ?? '';

  // 先物化成数组：.syn 要靠序号回指，而且下一步要报「实际词条数」。
  const entries = [...iterateIdx(idxBuffer, offsetBits)];
  if (entries.length === 0) {
    throw new UnsupportedFileError('.idx 里没有解析出任何词条，文件可能损坏或选择了错误的 .idx');
  }

  const aliases = files.syn ? [...iterateSyn(readFileSync(files.syn), entries)] : [];

  return {
    format: 'stardict',
    storage: 'file',
    contentType: contentTypeOf(sequence),
    sourceFile: files.ifo,
    resourceFile: null,
    meta: {
      ...info,
      // 报实际解析出来的数量，而不是 .ifo 里声明的；两者不一致时用户能立刻发现。
      declaredWordCount: info.wordcount ? Number(info.wordcount) : null,
      parsedWordCount: entries.length,
      synonymCount: aliases.length,
      dataFile: files.dict ?? files.dz,
      compressed: Boolean(files.dz && !files.dict),
      offsetBits,
      sametypesequence: sequence,
    },
    totalKeys: entries.length + aliases.length,
    *iterate(): Generator<ParsedEntry> {
      for (const entry of [...entries, ...aliases]) {
        if (entry.size <= 0) continue;
        yield {
          term: entry.word,
          definition: '',
          phonetic: null,
          recordStart: entry.offset,
          recordEnd: entry.offset + entry.size,
        };
      }
    },
  };
}
