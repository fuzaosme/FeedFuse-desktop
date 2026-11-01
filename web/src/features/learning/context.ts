import type { LearningSelection } from './selection';

/** 传给 AI 的段落上下文上限：整篇正文太长，只保留选区所在的文本块。 */
export const SELECTION_CONTEXT_MAX_LENGTH = 4000;

/**
 * 把选区所在的原文段落整理成一段上下文。
 *
 * `pieces[].context` 是选区所在文本块的完整文本（通常是段落），跨块选择时会有多段；
 * 这里按出现顺序去重并限制长度，避免把整篇文章塞进提示词。
 */
export function buildSelectionContext(selection: LearningSelection): string {
  const blocks: string[] = [];
  for (const piece of selection.pieces) {
    const block = piece.context.replace(/\s+/g, ' ').trim();
    if (block && !blocks.includes(block)) blocks.push(block);
  }
  const joined = blocks.join('\n');
  if (joined.length <= SELECTION_CONTEXT_MAX_LENGTH) return joined;

  const clipped = joined.slice(0, SELECTION_CONTEXT_MAX_LENGTH);
  const boundary = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
  );
  // 截断点太靠前时不再回退，否则会丢掉大半上下文。
  return (boundary > SELECTION_CONTEXT_MAX_LENGTH * 0.6
    ? clipped.slice(0, boundary + 1)
    : clipped).trim();
}
