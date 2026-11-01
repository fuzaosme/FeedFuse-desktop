/**
 * 生词本展示层的共用常量与纯函数。
 *
 * 上限与 `server/src/domain/vocabulary.ts` 的 MAX_VOCABULARY_SENTENCES 必须一致：
 * 服务端负责裁剪，前端只负责把「还剩几句」显示出来，两边对不上会误导用户。
 */

/** 单个词条最多保留几条例句，超出丢最早的一条。 */
export const MAX_VOCABULARY_SENTENCES = 5;

/**
 * 表格里只放核心释义。
 *
 * 词典释义常常是多行（词性 + 多条），整段塞进单元格会把行撑得忽高忽低；
 * 保留第一行并去掉行首编号，扫读时一眼就能对上号。
 */
export function coreDefinition(definition: string): string {
  const first = definition
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  return first.replace(/^(?:\d+\s*[.、)]|[①-⑳]|[-*•·])\s*/, '').trim();
}
