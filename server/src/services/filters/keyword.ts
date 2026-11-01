import { htmlToText } from '../../lib/utils';

export interface KeywordInput {
  title: string;
  summary: string | null;
  contentHtml: string | null;
  contentFullHtml?: string | null;
}

/**
 * 关键词命中判定。
 *
 * 命中范围包含标题、摘要与正文：只看标题会漏掉「标题正常、正文是广告」的源，
 * 只看正文又会漏掉「正文被截断、关键词在标题里」的情况。
 * 有全文时用全文，因为它才是用户真正会看到的内容。
 */
export function matchKeywords(input: KeywordInput, keywords: string[]): string[] {
  if (keywords.length === 0) return [];

  const body = htmlToText(input.contentFullHtml || input.contentHtml || '');
  const summary = htmlToText(input.summary ?? '');
  const haystack = `${input.title}\n${summary}\n${body}`.toLowerCase();

  // 关键词按用户书写顺序返回，前端展示与 filtered_by 里存的顺序才是稳定的。
  return keywords.filter((keyword) => {
    const needle = keyword.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}
