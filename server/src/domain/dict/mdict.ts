import { MDX } from 'js-mdict';
import { UnsupportedFileError } from './files';
import type { DictionarySource, EntryContentType, ParsedEntry } from './types';

/**
 * MDict（.mdx/.mdd）解析。
 *
 * 用 js-mdict（AGPL-3.0，与本项目同许可）而不是自己啃格式：
 * 它已经处理好加密头、lzo1x、UTF-16 词典、record 块切分这些边界情况。
 *
 * 实测（ODE 3/e，24.3 万词头 / 9.5MB）：
 *   打开并解出全部词头 ≈ 157ms，堆内存 ≈ 56MB
 *   逐条取释义 ≈ 1.3 万条/秒
 * 所以导入期做「逐条 fetch」是可接受的，换来的是能准确跳过空词条，
 * 否则空释义条目会以「无内容」的形式盖住内置词库的同名词条。
 */

interface MdxKeyItem {
  keyText: string;
  recordStartOffset: number;
  recordEndOffset: number;
  keyBlockIdx: number;
}

interface RecordRange {
  start: number;
  end: number;
}

/** `@@@LINK=target` 是 MDict 的重定向词条（大小写变体、复数形式常用这种写法）。 */
const LINK_PATTERN = /^@@@LINK=(.+)$/;

/**
 * MDX 的 record 以 `\r\n\u0000` 收尾，`trim()` 不会去掉 NUL，
 * 不做这一步的话 `^@@@LINK=...$` 永远匹配不上，重定向词条会原样显示成一行 `@@@LINK=xxx`。
 */
function stripRecordTail(value: string): string {
  return value.replace(/[\u0000\u0001]+$/g, '').trim();
}

function linkTarget(definition: string): string | null {
  const match = LINK_PATTERN.exec(stripRecordTail(definition));
  return match ? match[1].trim() : null;
}

/**
 * 词条优先级：正常词头 > 后缀/括注词头。
 * 同一本词典里 `-ability` 和 `ability` 归一化后都变成 `ability`，
 * 而 MDX 按字典序排列，`-` 打头的会排在前面——不排序的话 `ability` 会被
 * `-ability`（后缀释义）顶掉，用户查常用词反而看到一条「后缀」解释。
 */
function keyPriority(key: string): number {
  return /^[A-Za-z0-9]/.test(key) ? 0 : 1;
}

function contentTypeOf(header: Record<string, unknown>): EntryContentType {
  const format = typeof header.Format === 'string' ? header.Format.toLowerCase() : '';
  // 绝大多数 MDX 都是 Format="Html"；Text 类型按纯文本处理，避免把正文当标签渲染。
  return format === 'text' ? 'text' : 'html';
}

/**
 * 词头清洗：只做「不影响检索」的修剪。
 * 大小写与连字符交给统一的 normalizeVocabularyTerm，这里改了就两边对不上。
 */
function cleanKey(raw: string): string {
  return raw.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseMdx(files: { mdx: string; mdd: string | null }): DictionarySource {
  let mdx: MDX;
  try {
    mdx = new MDX(files.mdx);
  } catch (err) {
    throw new UnsupportedFileError(
      `.mdx 无法解析：${err instanceof Error ? err.message : '文件可能损坏或版本不受支持'}`,
    );
  }

  const header = (mdx.header ?? {}) as Record<string, unknown>;
  const items = (mdx.keywordList ?? []) as MdxKeyItem[];
  if (items.length === 0) {
    throw new UnsupportedFileError('.mdx 里没有任何词头，文件可能已损坏');
  }

  // 词头 → 条目。重复词头保留先出现的：与「同一词典内先导入者胜出」的既有规则一致。
  const byKey = new Map<string, MdxKeyItem>();
  for (const item of items) {
    const key = cleanKey(item.keyText ?? '');
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }

  /** 只缓存重定向链，不缓存普通词条：link 通常只占 1% 上下，不会撑爆内存。 */
  const linkCache = new Map<string, RecordRange | null>();

  const fetchDefinition = (item: MdxKeyItem): string | null => {
    try {
      return mdx.fetch(item).definition ?? null;
    } catch {
      // 单条 record 解压失败在真实词典里并不罕见（块损坏/文件被截断），跳过即可。
      return null;
    }
  };

  const resolveLink = (target: string, depth: number): RecordRange | null => {
    if (depth > 4) return null;
    if (linkCache.has(target)) return linkCache.get(target) ?? null;
    const item = byKey.get(target);
    if (!item) {
      linkCache.set(target, null);
      return null;
    }
    const definition = fetchDefinition(item);
    if (!definition || !definition.trim()) {
      linkCache.set(target, null);
      return null;
    }
    const next = linkTarget(definition);
    const range = next
      ? resolveLink(next, depth + 1)
      : { start: item.recordStartOffset, end: item.recordEndOffset };
    linkCache.set(target, range);
    return range;
  };

  const engineVersion =
    typeof header.GeneratedByEngineVersion === 'string' ? header.GeneratedByEngineVersion : null;
  const encrypted = typeof header.Encrypted === 'string' ? header.Encrypted : '0';

  return {
    format: 'mdx',
    storage: 'file',
    contentType: contentTypeOf(header),
    sourceFile: files.mdx,
    resourceFile: files.mdd,
    meta: {
      title: typeof header.Title === 'string' ? header.Title : null,
      description: typeof header.Description === 'string' ? header.Description : null,
      encoding: typeof header.Encoding === 'string' ? header.Encoding : null,
      engineVersion,
      encrypted,
      hasResources: Boolean(files.mdd),
      entryCount: byKey.size,
    },
    totalKeys: byKey.size,
    *iterate(): Generator<ParsedEntry> {
      // 稳定排序：先按「是不是正常词头」，同一档内保持词典原序。
      const ordered = [...byKey.entries()]
        .map(([key, item], index) => ({ key, item, index }))
        .sort((a, b) => keyPriority(a.key) - keyPriority(b.key) || a.index - b.index);

      for (const { key: term, item } of ordered) {
        const definition = fetchDefinition(item);
        if (!definition || !stripRecordTail(definition)) continue;

        const target = linkTarget(definition);
        const range = target
          ? resolveLink(target, 1)
          : { start: item.recordStartOffset, end: item.recordEndOffset };
        // 重定向目标缺失时整条丢掉：留着只会让用户点开看到一个裸的 @@@LINK= 串。
        if (!range || range.end <= range.start) continue;

        yield {
          term,
          definition: '',
          phonetic: null,
          recordStart: range.start,
          recordEnd: range.end,
        };
      }
    },
    close(): void {
      const scanner = (mdx as unknown as { scanner?: { close?: () => void } }).scanner;
      scanner?.close?.();
    },
  };
}
