/**
 * 文件型词典（MDX / StarDict）的统一描述。
 *
 * 设计取舍：这两类格式本身就是「词头索引 + 随机访问的数据块」，
 * 把释义整本搬进 SQLite 会让磁盘膨胀 3～4 倍、导入多花几十秒。
 * 所以它们走 `storage: 'file'`——原文件（副本）留在应用数据目录里，
 * SQLite 只存词头与 record 范围，查词时按需回原文件取那一段。
 */

export type DictionaryFormat = 'inline' | 'mdx' | 'stardict';

/** sqlite：释义就在库里；file：释义回原文件读。 */
export type DictionaryStorage = 'sqlite' | 'file';

/** 释义的渲染方式。mdx 的释义是 HTML，StarDict 多数是纯文本。 */
export type EntryContentType = 'text' | 'html';

export interface ParsedEntry {
  term: string;
  /** file 模式下留空，靠 recordStart/recordEnd 回原文件取。 */
  definition: string;
  phonetic: string | null;
  recordStart: number | null;
  recordEnd: number | null;
}

/**
 * 解析结果的惰性视图：几十万词条的词典不把整本读进内存再插库，
 * 而是边解析边分批写，峰值内存只跟单批大小有关。
 */
export interface DictionarySource {
  format: DictionaryFormat;
  storage: DictionaryStorage;
  contentType: EntryContentType;
  /** 主文件绝对路径（.mdx 或 .ifo）。 */
  sourceFile: string;
  /** 附属资源文件（.mdd），没有则为 null。 */
  resourceFile: string | null;
  meta: Record<string, unknown>;
  /** 词头总数（含被跳过的条目），用于进度与界面展示。 */
  totalKeys: number;
  /**
   * 逐条产出可入库的词条。
   * 调用方必须容忍解析中途抛错：单条解压失败不应该让整本词典导入失败。
   */
  iterate(): Generator<ParsedEntry>;
  /** 释放底层文件句柄（MDX 会一直握着 fd）。 */
  close?(): void;
}
