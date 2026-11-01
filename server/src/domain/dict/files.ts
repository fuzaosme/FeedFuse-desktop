import { basename, extname } from 'node:path';

/**
 * 用户实际下载到的词典都是一组文件，而不是单个文件：
 *   MDict   : xxx.mdx + xxx.mdd（图片/样式/音频）
 *   StarDict: xxx.ifo + xxx.idx + xxx.dict(.dz) [+ xxx.syn]
 * 所以导入的第一步是「把一次选中的文件按词典分组」，再按组识别格式。
 */

export interface DictionaryFileSet {
  /** 分组用的基名（去掉扩展名），仅用于提示文案与目录命名。 */
  baseName: string;
  mdx: string | null;
  mdd: string | null;
  ifo: string | null;
  idx: string | null;
  /** 未压缩的 .dict；有它就不必解 .dz。 */
  dict: string | null;
  /** .dict.dz */
  dz: string | null;
  syn: string | null;
}

function emptySet(baseName: string): DictionaryFileSet {
  return {
    baseName,
    mdx: null,
    mdd: null,
    ifo: null,
    idx: null,
    dict: null,
    dz: null,
    syn: null,
  };
}

/** `xxx.dict.dz` 的真实扩展名要连看两级，extname 只会给出 `.dz`。 */
function describe(path: string): { kind: keyof Omit<DictionaryFileSet, 'baseName'> | null; base: string } {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (lower.endsWith('.dict.dz')) return { kind: 'dz', base: name.slice(0, -'.dict.dz'.length) };
  if (lower.endsWith('.idx.gz')) return { kind: 'idx', base: name.slice(0, -'.idx.gz'.length) };
  const ext = extname(lower);
  const base = name.slice(0, name.length - ext.length);
  switch (ext) {
    case '.mdx':
      return { kind: 'mdx', base };
    case '.mdd':
      return { kind: 'mdd', base };
    case '.ifo':
      return { kind: 'ifo', base };
    case '.idx':
      return { kind: 'idx', base };
    case '.dict':
      return { kind: 'dict', base };
    case '.syn':
      return { kind: 'syn', base };
    default:
      return { kind: null, base };
  }
}

/**
 * 把一批文件按基名分组。
 *
 * 「同基名」优先；MDD 找不到同名 MDX 时（网上下的词典经常被改过名字）
 * 只要全局只有一个 mdx 和一个 mdd，就按唯一的那个配对——这是用户的真实预期。
 */
export function groupDictionaryFiles(paths: string[]): DictionaryFileSet[] {
  const byBase = new Map<string, DictionaryFileSet>();
  const unknown: string[] = [];

  for (const path of paths) {
    const { kind, base } = describe(path);
    if (!kind) {
      unknown.push(path);
      continue;
    }
    const key = base.toLowerCase();
    const set = byBase.get(key) ?? emptySet(base);
    set[kind] = path;
    byBase.set(key, set);
  }

  const groups = [...byBase.values()];
  const mdds = groups.filter((group) => group.mdd);
  const mddsWithoutMdx = mdds.filter((group) => !group.mdx);

  // 名字对不上的一对 mdx/mdd：各只有一个时才敢配对，多个就是猜了。
  if (mddsWithoutMdx.length === 1) {
    const orphanMdd = mddsWithoutMdx[0];
    const mdxGroups = groups.filter((group) => group.mdx);
    if (mdxGroups.length === 1 && orphanMdd.baseName !== mdxGroups[0].baseName) {
      mdxGroups[0].mdd = orphanMdd.mdd;
      groups.splice(groups.indexOf(orphanMdd), 1);
    }
  }

  // 只带 .mdd 的组没有意义（资源离开 mdx 没法单独用）。
  const usable = groups.filter((group) => group.mdx || group.ifo);

  if (usable.length === 0) {
    const hint = unknown.length > 0 ? `（收到 ${unknown.length} 个无法识别的文件）` : '';
    throw new UnsupportedFileError(
      `没有找到可导入的词典文件${hint}。MDict 需要 .mdx（可另配同名 .mdd）；StarDict 需要 .ifo + .idx + .dict 或 .dict.dz。`,
    );
  }
  return usable;
}

/** 面向用户的格式错误：路由层会把它转成 400，而不是当成服务端故障。 */
export class UnsupportedFileError extends Error {
  readonly code = 'unsupported_dictionary_file';
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

/** 一组文件属于哪种格式。调用前 groupDictionaryFiles 已保证至少有一个主文件。 */
export function detectFormat(group: DictionaryFileSet): 'mdx' | 'stardict' {
  if (group.mdx) return 'mdx';
  if (group.ifo) return 'stardict';
  throw new UnsupportedFileError('词典文件不完整：缺少 .mdx 或 .ifo 主文件');
}
