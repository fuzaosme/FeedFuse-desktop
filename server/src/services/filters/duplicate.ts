import { findDuplicateCandidate } from '../../domain/articles';
import { getSettings } from '../../domain/settings';
import { hammingSimilarity, fingerprintBands } from './text';

export type DuplicateReason = 'duplicate_url' | 'duplicate_title' | 'duplicate_similar';

export interface DuplicateInput {
  /** 入库前还没有 id，传 null：此时「不能和自己比」靠 id 大小天然成立。 */
  id: string | null;
  feedId: string;
  url: string | null;
  normalizedUrl: string | null;
  normalizedTitle: string;
  fingerprint: string | null;
}

export interface DuplicateHit {
  reason: DuplicateReason;
  duplicateOf: string;
}

/** 指纹候选集上限：同前缀的候选通常只有个位数，200 是给异常数据兜底，避免全表扫。 */
const FINGERPRINT_CANDIDATE_LIMIT = 200;

/**
 * 标题太短时撞车概率极高：「周报」「日报」这类标题会被判成互相重复，
 * 一旦误判就是整片文章被隐藏，代价远大于漏判，所以加长度门槛。
 */
const MIN_TITLE_LENGTH = 8;

/**
 * 跨订阅查重。
 *
 * 判定顺序按「可信度从高到低」：URL 相同几乎肯定是同一篇；标题相同但可能只是栏目名相同；
 * 内容指纹相似需要算相似度，最贵也最容易误判，放最后。
 * 只跟 id 更小的文章比，保证每次保留的都是最早入库的那条。
 */
export function findDuplicate(input: DuplicateInput): DuplicateHit | null {
  const { duplicate } = getSettings().rss.articleFilter;
  if (!duplicate.enabled) return null;

  const titleComparable = input.normalizedTitle.length >= MIN_TITLE_LENGTH;
  const bands = input.fingerprint ? fingerprintBands(input.fingerprint) : [];

  if (!input.normalizedUrl && !titleComparable && bands.length === 0) return null;

  const candidates = findDuplicateCandidate({
    id: input.id,
    urlNormalized: input.normalizedUrl,
    titleNormalized: titleComparable ? input.normalizedTitle : null,
    fingerprintBands: bands.length > 0 ? bands : null,
    fingerprintLimit: FINGERPRINT_CANDIDATE_LIMIT,
  });

  if (candidates.urlMatchId) {
    return { reason: 'duplicate_url', duplicateOf: candidates.urlMatchId };
  }
  if (candidates.titleMatchId) {
    return { reason: 'duplicate_title', duplicateOf: candidates.titleMatchId };
  }

  if (input.fingerprint) {
    let best: { id: string; similarity: number } | null = null;
    for (const candidate of candidates.fingerprintMatches) {
      const similarity = hammingSimilarity(input.fingerprint, candidate.fingerprint);
      if (similarity < duplicate.similarity) continue;
      if (!best || similarity > best.similarity) best = { id: candidate.id, similarity };
    }
    if (best) return { reason: 'duplicate_similar', duplicateOf: best.id };
  }

  return null;
}
