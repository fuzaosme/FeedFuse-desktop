import { getDb } from '../db/sqlite';
import { asBool, nowIso } from '../lib/utils';
import { NotFoundError, ValidationError } from '../http/envelope';

/**
 * pending / error 只出现在 AI 语义过滤的异步链路里：
 * pending 表示已入队未出结果，error 表示判定失败（此时 is_filtered 仍为 0，文章照常可见）。
 */
export type FilterStatus = 'passed' | 'filtered' | 'pending' | 'error';

export interface ArticleListItem {
  id: string;
  feedId: string;
  feedTitle: string;
  title: string;
  titleZh: string | null;
  summary: string | null;
  previewImage: string | null;
  author: string | null;
  publishedAt: string;
  link: string | null;
  isRead: boolean;
  isStarred: boolean;
  isFiltered: boolean;
  /** keyword / ai / duplicate_url / duplicate_title / duplicate_similar；给前端解释「为什么被过滤」。 */
  filterReason: string | null;
  filterStatus: FilterStatus;
  hasFulltext: boolean;
  hasAiSummary: boolean;
  hasTranslation: boolean;
}

export interface ArticleDetail extends ArticleListItem {
  titleOriginal: string | null;
  contentHtml: string;
  contentFullHtml: string | null;
  sourceLanguage: string | null;
  aiSummary: string | null;
  aiTranslationZhHtml: string | null;
  aiTranslationBilingualHtml: string | null;
  siteUrl: string | null;
  feedUrl: string;
}

export interface AiSummarySession {
  id: string;
  /** queued：请求已受理但模型还没开始吐字，前端可以据此显示「排队中」。 */
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  draftText: string;
  finalText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

interface ArticleRow {
  id: number;
  feed_id: number;
  feed_title: string;
  title: string;
  title_original: string | null;
  title_zh: string | null;
  summary: string | null;
  preview_image_url: string | null;
  author: string | null;
  published_at: string;
  link: string | null;
  is_read: number;
  is_starred: number;
  is_filtered: number;
  filter_reason: string | null;
  filter_status: string | null;
  content_html: string | null;
  content_full_html: string | null;
  source_language: string | null;
  ai_summary: string | null;
  ai_translation_zh_html: string | null;
  ai_translation_bilingual_html: string | null;
  site_url: string | null;
  feed_url: string;
}

const ARTICLE_SELECT = `
  select a.id, a.feed_id, f.title as feed_title, a.title, a.title_original, a.title_zh,
         a.summary, a.preview_image_url, a.author, a.published_at, a.link,
         a.is_read, a.is_starred, a.is_filtered, a.filter_reason, a.filter_status,
         a.content_html, a.content_full_html,
         a.source_language, a.ai_summary, a.ai_translation_zh_html, a.ai_translation_bilingual_html,
         f.site_url, f.url as feed_url
  from articles a
  join feeds f on f.id = a.feed_id
`;

/**
 * 老库里的 is_filtered=1 是在 filter_status 这列存在之前写的，迁移只能给默认值 'passed'。
 * 读出来时按 is_filtered 兜底，避免前端把「已过滤」的文章显示成「通过」。
 */
function readFilterStatus(raw: string | null, isFiltered: boolean): FilterStatus {
  if (raw === 'passed' || raw === 'filtered' || raw === 'pending' || raw === 'error') return raw;
  return isFiltered ? 'filtered' : 'passed';
}

function mapListItem(row: ArticleRow): ArticleListItem {
  return {
    id: String(row.id),
    feedId: String(row.feed_id),
    feedTitle: row.feed_title,
    title: row.title,
    titleZh: row.title_zh,
    summary: row.summary,
    previewImage: row.preview_image_url,
    author: row.author,
    publishedAt: row.published_at,
    link: row.link,
    isRead: asBool(row.is_read),
    isStarred: asBool(row.is_starred),
    isFiltered: asBool(row.is_filtered),
    filterReason: row.filter_reason,
    filterStatus: readFilterStatus(row.filter_status, asBool(row.is_filtered)),
    hasFulltext: Boolean(row.content_full_html),
    hasAiSummary: Boolean(row.ai_summary),
    hasTranslation: Boolean(row.ai_translation_bilingual_html || row.ai_translation_zh_html),
  };
}

function mapDetail(row: ArticleRow): ArticleDetail {
  return {
    ...mapListItem(row),
    titleOriginal: row.title_original,
    contentHtml: row.content_html ?? '',
    contentFullHtml: row.content_full_html,
    sourceLanguage: row.source_language,
    aiSummary: row.ai_summary,
    aiTranslationZhHtml: row.ai_translation_zh_html,
    aiTranslationBilingualHtml: row.ai_translation_bilingual_html,
    siteUrl: row.site_url,
    feedUrl: row.feed_url,
  };
}

export interface ArticleQuery {
  view: string;
  limit?: number;
  cursor?: string | null;
  unreadOnly?: boolean;
  includeFiltered?: boolean;
}

interface CursorPayload {
  p: string;
  i: string;
}

export function encodeCursor(article: { publishedAt: string; id: string }): string {
  const payload: CursorPayload = { p: article.publishedAt, i: article.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (typeof parsed.p !== 'string' || typeof parsed.i !== 'string') return null;
    return { p: parsed.p, i: parsed.i };
  } catch {
    return null;
  }
}

function buildWhere(query: ArticleQuery): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const view = query.view || 'all';

  if (view === 'unread') {
    parts.push('a.is_read = 0');
  } else if (view === 'starred') {
    parts.push('a.is_starred = 1');
  } else if (view.startsWith('feed:')) {
    parts.push('a.feed_id = ?');
    params.push(Number(view.slice(5)));
  } else if (view.startsWith('category:')) {
    parts.push('f.category_id = ?');
    params.push(Number(view.slice(9)));
  }

  if (query.unreadOnly) parts.push('a.is_read = 0');
  // 「显示已过滤」只在单源视图有意义：聚合视图混进被规则挡掉的文章，
  // 会让「全部/未读」的语义变得不可解释，所以这里直接忽略该参数。
  if (!query.includeFiltered || !view.startsWith('feed:')) parts.push('a.is_filtered = 0');

  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', params };
}

export interface ArticlePage {
  items: ArticleListItem[];
  nextCursor: string | null;
  totalCount: number;
}

const MAX_LIMIT = 200;

/**
 * 分页参数一律走这里：`Number('abc')` 是 NaN，直接传给 sqlite 会变成
 * `datatype mismatch` 的 500，而手改 URL 或前端拼错就能触发。
 */
function normalizeLimit(raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

export function listArticles(query: ArticleQuery): ArticlePage {
  const limit = normalizeLimit(query.limit, 50);
  const { sql, params } = buildWhere(query);
  const cursor = decodeCursor(query.cursor);

  const cursorSql = cursor
    ? `${sql ? 'and' : 'where'} (a.published_at < ? or (a.published_at = ? and a.id < ?))`
    : '';
  const cursorParams = cursor ? [cursor.p, cursor.p, Number(cursor.i)] : [];

  const rows = getDb().all<ArticleRow>(
    `${ARTICLE_SELECT} ${sql} ${cursorSql}
     order by a.published_at desc, a.id desc
     limit ?`,
    ...params,
    ...cursorParams,
    limit + 1,
  );

  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];

  const totalCount =
    getDb().get<{ total: number }>(
      `select count(*) as total from articles a join feeds f on f.id = a.feed_id ${sql}`,
      ...params,
    )?.total ?? 0;

  return {
    items: visible.map(mapListItem),
    nextCursor: hasMore && last ? encodeCursor({ publishedAt: last.published_at, id: String(last.id) }) : null,
    totalCount,
  };
}

export interface ArticleCounts {
  all: number;
  unread: number;
  starred: number;
  /** 「已过滤 N 篇」用的数量，只有打开「显示已过滤」时前端才需要它。 */
  filtered: number;
}

export function getCounts(): ArticleCounts {
  const db = getDb();
  const row = db.get<{
    all_count: number;
    unread_count: number;
    starred_count: number;
    filtered_count: number;
  }>(
    `select
       (select count(*) from articles where is_filtered = 0) as all_count,
       (select count(*) from articles where is_filtered = 0 and is_read = 0) as unread_count,
       (select count(*) from articles where is_filtered = 0 and is_starred = 1) as starred_count,
       (select count(*) from articles where is_filtered = 1) as filtered_count`,
  );
  return {
    all: row?.all_count ?? 0,
    unread: row?.unread_count ?? 0,
    starred: row?.starred_count ?? 0,
    filtered: row?.filtered_count ?? 0,
  };
}

export interface FilterStatusCounts {
  total: number;
  passed: number;
  filtered: number;
  pending: number;
  error: number;
}

/** 分段统计：前端用它展示「已过滤 N 篇」，路由用它判断回溯要同步跑还是异步跑。 */
export function countArticlesByFilterStatus(): FilterStatusCounts {
  const row = getDb().get<{
    total: number;
    passed: number;
    filtered: number;
    pending: number;
    error: number;
  }>(
    `select
       count(*) as total,
       sum(case when is_filtered = 0 then 1 else 0 end) as passed,
       sum(case when is_filtered = 1 then 1 else 0 end) as filtered,
       sum(case when filter_status = 'pending' then 1 else 0 end) as pending,
       sum(case when filter_status = 'error' then 1 else 0 end) as error
     from articles`,
  );
  return {
    total: row?.total ?? 0,
    passed: row?.passed ?? 0,
    filtered: row?.filtered ?? 0,
    pending: row?.pending ?? 0,
    error: row?.error ?? 0,
  };
}

export function getArticleDetail(id: string): ArticleDetail | null {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return null;
  const row = getDb().get<ArticleRow>(`${ARTICLE_SELECT} where a.id = ?`, numeric);
  return row ? mapDetail(row) : null;
}

export function setArticleState(id: string, patch: { isRead?: boolean; isStarred?: boolean }): ArticleDetail {
  const numeric = Number(id);
  const current = getArticleDetail(id);
  if (!current) throw new NotFoundError('文章不存在');

  const sets: string[] = [];
  const params: unknown[] = [];
  const now = nowIso();

  if (patch.isRead !== undefined) {
    sets.push('is_read = ?', 'read_at = ?');
    params.push(patch.isRead, patch.isRead ? now : null);
  }
  if (patch.isStarred !== undefined) {
    sets.push('is_starred = ?', 'starred_at = ?');
    params.push(patch.isStarred, patch.isStarred ? now : null);
  }
  if (sets.length === 0) throw new ValidationError('至少需要一个更新字段', { body: 'empty' });

  getDb().run(`update articles set ${sets.join(', ')} where id = ?`, ...params, numeric);
  return { ...current, ...(patch.isRead !== undefined ? { isRead: patch.isRead } : {}), ...(patch.isStarred !== undefined ? { isStarred: patch.isStarred } : {}) };
}

export function markAllRead(view: string): number {
  const { sql, params } = buildWhere({ view, includeFiltered: false });
  const now = nowIso();
  const where = sql ? `${sql} and a.is_read = 0` : 'where a.is_read = 0';
  const result = getDb().run(
    `update articles set is_read = 1, read_at = ?
     where id in (select a.id from articles a join feeds f on f.id = a.feed_id ${where})`,
    now,
    ...params,
  );
  return result.changes;
}

export interface SearchQuery {
  q: string;
  limit?: number;
}

export function searchArticles(query: SearchQuery): ArticleListItem[] {
  const term = query.q.trim();
  if (!term) return [];
  const rawLimit = query.limit ?? 40;
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 40));
  const db = getDb();

  const ftsQuery = term
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(' ');

  try {
    const rows = db.all<ArticleRow>(
      `${ARTICLE_SELECT}
       where a.id in (select rowid from articles_fts where articles_fts match ?) and a.is_filtered = 0
       order by a.published_at desc, a.id desc limit ?`,
      ftsQuery,
      limit,
    );
    if (rows.length > 0) return rows.map(mapListItem);
  } catch {
    // FTS 语法异常时退回 LIKE，保证搜索永远有结果可用
  }

  const like = `%${term.replace(/[%_]/g, '')}%`;
  return db
    .all<ArticleRow>(
      `${ARTICLE_SELECT}
       where a.is_filtered = 0 and (a.title like ? or a.summary like ?)
       order by a.published_at desc, a.id desc limit ?`,
      like,
      like,
      limit,
    )
    .map(mapListItem);
}

export interface UpsertArticleInput {
  feedId: string;
  dedupeKey: string;
  title: string;
  link: string | null;
  author: string | null;
  publishedAt: string | null;
  contentHtml: string | null;
  summary: string | null;
  previewImage: string | null;
  sourceLanguage: string | null;
  isFiltered?: boolean;
  filteredBy?: string[];
  filterReason?: string | null;
  filterStatus?: FilterStatus;
  urlNormalized?: string | null;
  titleNormalized?: string | null;
  contentFingerprint?: string | null;
}

export function upsertArticle(input: UpsertArticleInput): { id: string; inserted: boolean } {
  const db = getDb();
  const now = nowIso();
  const feedId = Number(input.feedId);
  const existing = db.get<{ id: number }>(
    'select id from articles where feed_id = ? and dedupe_key = ?',
    feedId,
    input.dedupeKey,
  );

  if (existing) {
    // 已存在的文章只补全缺失字段，绝不覆盖用户已经产生的阅读状态与 AI 结果。
    db.run(
      `update articles set
         content_html = coalesce(nullif(content_html, ''), ?),
         summary = coalesce(nullif(summary, ''), ?),
         preview_image_url = coalesce(preview_image_url, ?),
         author = coalesce(author, ?),
         published_at = coalesce(published_at, ?)
       where id = ?`,
      input.contentHtml,
      input.summary,
      input.previewImage,
      input.author,
      input.publishedAt ?? now,
      existing.id,
    );
    return { id: String(existing.id), inserted: false };
  }

  const isFiltered = input.isFiltered ?? false;
  const result = db.run(
    `insert into articles (
       feed_id, dedupe_key, title, link, author, published_at, content_html, summary,
       preview_image_url, source_language, fetched_at, is_filtered, filtered_by,
       filter_reason, filter_status, url_normalized, title_normalized, content_fingerprint
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    feedId,
    input.dedupeKey,
    input.title,
    input.link,
    input.author,
    input.publishedAt ?? now,
    input.contentHtml,
    input.summary,
    input.previewImage,
    input.sourceLanguage,
    now,
    isFiltered,
    input.filteredBy?.length ? JSON.stringify(input.filteredBy) : null,
    input.filterReason ?? null,
    input.filterStatus ?? (isFiltered ? 'filtered' : 'passed'),
    input.urlNormalized ?? null,
    input.titleNormalized ?? null,
    input.contentFingerprint ?? null,
  );

  return { id: String(result.lastInsertRowid), inserted: true };
}

/**
 * 写入抓取到的全文。
 *
 * 全文比 RSS 摘要长得多，指纹也就更有区分度，所以调用方会把重算后的
 * `contentFingerprint` 一起传进来；不传则只更新正文（保持老行为）。
 */
export function saveFulltext(id: string, html: string, fingerprint?: string | null): void {
  if (fingerprint === undefined) {
    getDb().run('update articles set content_full_html = ? where id = ?', html, Number(id));
    return;
  }
  getDb().run(
    `update articles
     set content_full_html = ?, content_fingerprint = coalesce(?, content_fingerprint)
     where id = ?`,
    html,
    fingerprint,
    Number(id),
  );
}

/* ------------------------------ 过滤与去重 ------------------------------ */

export interface DuplicateCandidateQuery {
  /** 审核中的文章自身 id；入库前还没有 id，传 null/undefined 表示不与任何行互斥。 */
  id?: string | null;
  urlNormalized: string | null;
  titleNormalized: string | null;
  /**
   * 指纹的 LSH 分带（64 位切成 4 段各 16 位）。
   *
   * 只比「前 16 位相同」这种单带前缀召回率太低：相似度 0.85 的两篇大约差 9 个 bit，
   * 随机分布下第一条带恰好干净的概率只有 ~6%。四带里任一带干净就算候选，
   * 召回能提到 ~25%（相似度 0.95 时到 ~86%），代价只是多三个 substr 比较。
   */
  fingerprintBands: string[] | null;
  fingerprintLimit?: number;
}

export interface DuplicateCandidates {
  urlMatchId: string | null;
  titleMatchId: string | null;
  fingerprintMatches: Array<{ id: string; fingerprint: string }>;
}

const FINGERPRINT_QUERY_LIMIT = 200;

/**
 * 查重候选查询：只在 domain 里写 SQL，判定逻辑（阈值、长度门槛）留给 services/filters。
 * 统一加 `id < ?` 条件，保证永远跟更早入库的文章比，重复的那条留最早的一份。
 */
export function findDuplicateCandidate(query: DuplicateCandidateQuery): DuplicateCandidates {
  const db = getDb();
  const selfId = query.id !== null && query.id !== undefined ? Number(query.id) : null;
  const selfClause = selfId !== null && Number.isInteger(selfId) ? 'and id < ?' : '';
  const selfParams: unknown[] = selfClause ? [selfId] : [];

  let urlMatchId: string | null = null;
  if (query.urlNormalized) {
    const row = db.get<{ id: number }>(
      `select id from articles where url_normalized = ? ${selfClause} order by id asc limit 1`,
      query.urlNormalized,
      ...selfParams,
    );
    if (row) urlMatchId = String(row.id);
  }

  let titleMatchId: string | null = null;
  if (query.titleNormalized) {
    const row = db.get<{ id: number }>(
      `select id from articles where title_normalized = ? ${selfClause} order by id asc limit 1`,
      query.titleNormalized,
      ...selfParams,
    );
    if (row) titleMatchId = String(row.id);
  }

  let fingerprintMatches: Array<{ id: string; fingerprint: string }> = [];
  if (query.fingerprintBands && query.fingerprintBands.length > 0) {
    // 任一带相等即为候选；4 段 hex 各占 4 个字符，用 substr 比较而不是 like，避免大小写与转义问题。
    const bandClauses = query.fingerprintBands
      .map((_, index) => `substr(content_fingerprint, ${index * 4 + 1}, 4) = ?`)
      .join(' or ');
    const rows = db.all<{ id: number; content_fingerprint: string }>(
      `select id, content_fingerprint from articles
       where content_fingerprint is not null
         and (${bandClauses}) ${selfClause}
       order by id desc limit ?`,
      ...query.fingerprintBands,
      ...selfParams,
      Math.min(FINGERPRINT_QUERY_LIMIT, Math.max(1, query.fingerprintLimit ?? FINGERPRINT_QUERY_LIMIT)),
    );
    fingerprintMatches = rows.map((row) => ({ id: String(row.id), fingerprint: row.content_fingerprint }));
  }

  return { urlMatchId, titleMatchId, fingerprintMatches };
}

export interface ArticleFilterPatch {
  isFiltered: boolean;
  reason: string | null;
  status: FilterStatus;
  /** 关键词命中列表；非关键词原因传空数组即可。 */
  filteredBy?: string[] | null;
  /** 老库这两列还是 null，回溯时顺手补上，否则跨订阅比较永远匹配不到它。 */
  urlNormalized?: string | null;
  titleNormalized?: string | null;
  contentFingerprint?: string | null;
}

export function setArticleFilter(id: string, patch: ArticleFilterPatch): void {
  const sets = ['is_filtered = ?', 'filter_reason = ?', 'filter_status = ?'];
  const params: unknown[] = [patch.isFiltered, patch.reason, patch.status];

  if (patch.filteredBy !== undefined) {
    sets.push('filtered_by = ?');
    params.push(patch.filteredBy?.length ? JSON.stringify(patch.filteredBy) : null);
  }
  if (patch.urlNormalized !== undefined) {
    sets.push('url_normalized = ?');
    params.push(patch.urlNormalized);
  }
  if (patch.titleNormalized !== undefined) {
    sets.push('title_normalized = ?');
    params.push(patch.titleNormalized);
  }
  if (patch.contentFingerprint !== undefined) {
    sets.push('content_fingerprint = ?');
    params.push(patch.contentFingerprint);
  }

  getDb().run(`update articles set ${sets.join(', ')} where id = ?`, ...params, Number(id));
}

/**
 * 关掉 AI 语义过滤时，把被它判掉的文章放回可见。
 *
 * 这些文章的 `is_filtered = 1` 是模型判的，不是用户规则判的；用户关掉开关后
 * 它们在聚合视图里继续消失，看起来就是「文章不见了」，而唯一的恢复路径
 * 是再花几千次模型调用重判一遍 —— 完全没有必要。
 */
export function clearAiFilteredArticles(): number {
  const result = getDb().run(
    `update articles set is_filtered = 0, filter_reason = null, filter_status = 'passed'
     where filter_reason = 'ai'`,
  );
  return result.changes;
}

/**
 * 启动时把上次残留的 `pending` 放回可见。
 *
 * AI 语义过滤队列只在内存里，进程一退这些任务就没人接管了；不清理的话这些文章
 * 会永远停在「判定中」，前端画一个永远不会结束的转圈。
 */
export function clearPendingFilterStatus(): number {
  const result = getDb().run(
    "update articles set filter_status = 'passed' where filter_status = 'pending'",
  );
  return result.changes;
}

export interface ArticleFilterCandidate {
  id: string;
  feedId: string;
  title: string;
  link: string | null;
  summary: string | null;
  contentHtml: string | null;
  contentFullHtml: string | null;
  urlNormalized: string | null;
  titleNormalized: string | null;
  contentFingerprint: string | null;
  isFiltered: boolean;
  filterReason: string | null;
  filterStatus: FilterStatus;
}

interface FilterCandidateRow {
  id: number;
  feed_id: number;
  title: string;
  link: string | null;
  summary: string | null;
  content_html: string | null;
  content_full_html: string | null;
  url_normalized: string | null;
  title_normalized: string | null;
  content_fingerprint: string | null;
  is_filtered: number;
  filter_reason: string | null;
  filter_status: string | null;
}

/** 回溯重判用：id 游标分批拉取，一次全读进内存会把老库的大正文全抬起来。 */
export function listArticleFilterCandidates(
  options: { afterId?: string | null; limit?: number } = {},
): ArticleFilterCandidate[] {
  const limit = Math.min(1000, Math.max(1, options.limit ?? 500));
  const afterId = options.afterId ? Number(options.afterId) : 0;
  const rows = getDb().all<FilterCandidateRow>(
    `select id, feed_id, title, link, summary, content_html, content_full_html,
            url_normalized, title_normalized, content_fingerprint,
            is_filtered, filter_reason, filter_status
     from articles
     where id > ?
     order by id asc
     limit ?`,
    Number.isFinite(afterId) ? afterId : 0,
    limit,
  );

  return rows.map((row) => ({
    id: String(row.id),
    feedId: String(row.feed_id),
    title: row.title,
    link: row.link,
    summary: row.summary,
    contentHtml: row.content_html,
    contentFullHtml: row.content_full_html,
    urlNormalized: row.url_normalized,
    titleNormalized: row.title_normalized,
    contentFingerprint: row.content_fingerprint,
    isFiltered: asBool(row.is_filtered),
    filterReason: row.filter_reason,
    filterStatus: readFilterStatus(row.filter_status, asBool(row.is_filtered)),
  }));
}

export function saveSummary(id: string, summary: string, model: string): void {
  getDb().run(
    'update articles set ai_summary = ?, ai_summary_model = ?, ai_summarized_at = ? where id = ?',
    summary,
    model,
    nowIso(),
    Number(id),
  );
}

export function saveTitleTranslation(id: string, titleZh: string): void {
  getDb().run('update articles set title_zh = ?, title_original = coalesce(title_original, title) where id = ?', titleZh, Number(id));
}

export function saveBodyTranslation(
  id: string,
  translation: { zhHtml: string | null; bilingualHtml: string | null },
): void {
  getDb().run(
    `update articles set
       ai_translation_zh_html = coalesce(?, ai_translation_zh_html),
       ai_translation_bilingual_html = coalesce(?, ai_translation_bilingual_html)
     where id = ?`,
    translation.zhHtml,
    translation.bilingualHtml,
    Number(id),
  );
}

export function pruneFeedArticles(feedId: string, keep: number): number {
  const db = getDb();
  // 星标文章不参与裁剪：用户主动收藏的内容一旦被高频源挤出窗口就再也找不回来，
  // 而这类数据的价值远高于「每源只留 N 篇」的存储约束。
  const result = db.run(
    `delete from articles where feed_id = ? and is_starred = 0 and id not in (
       select id from articles where feed_id = ? order by published_at desc, id desc limit ?
     )`,
    Number(feedId),
    Number(feedId),
    keep,
  );
  return result.changes;
}

export function pruneAllFeeds(keep: number): number {
  const feeds = getDb().all<{ id: number }>('select id from feeds');
  return feeds.reduce((sum, feed) => sum + pruneFeedArticles(String(feed.id), keep), 0);
}

export interface StoredArticleContent {
  id: string;
  title: string;
  link: string | null;
  contentHtml: string | null;
  contentFullHtml: string | null;
  summary: string | null;
  aiSummary: string | null;
  sourceLanguage: string | null;
  feedId: string;
  /** AI 语义过滤入队前要确认这篇文章不是已经被关键词/查重判掉了。 */
  isFiltered: boolean;
  filterReason: string | null;
  filterStatus: FilterStatus;
}

export function getArticleContent(id: string): StoredArticleContent | null {
  const row = getDb().get<{
    id: number;
    title: string;
    link: string | null;
    content_html: string | null;
    content_full_html: string | null;
    summary: string | null;
    ai_summary: string | null;
    source_language: string | null;
    feed_id: number;
    is_filtered: number;
    filter_reason: string | null;
    filter_status: string | null;
  }>(
    `select id, title, link, content_html, content_full_html, summary, ai_summary,
            source_language, feed_id, is_filtered, filter_reason, filter_status
     from articles where id = ?`,
    Number(id),
  );
  if (!row) return null;
  return {
    id: String(row.id),
    title: row.title,
    link: row.link,
    contentHtml: row.content_html,
    contentFullHtml: row.content_full_html,
    summary: row.summary,
    aiSummary: row.ai_summary,
    sourceLanguage: row.source_language,
    feedId: String(row.feed_id),
    isFiltered: asBool(row.is_filtered),
    filterReason: row.filter_reason,
    filterStatus: readFilterStatus(row.filter_status, asBool(row.is_filtered)),
  };
}

/* ------------------------------ AI 摘要会话 ------------------------------ */

interface SessionRow {
  id: number;
  article_id: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  draft_text: string;
  final_text: string | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
}

export function startSummarySession(articleId: string): string {
  const db = getDb();
  const now = nowIso();
  // 同一篇文章只允许有一条 running 会话：连点两次「生成摘要」会开出两条流，
  // 后结束的那条覆盖前者，另一条则永远停在 running（只能等下次启动被标记中断）。
  db.run(
    `update article_ai_summary_sessions
     set status = 'failed', error_code = 'superseded', error_message = '已被新的生成请求取代',
         updated_at = ?, finished_at = ?
     where article_id = ? and status in ('queued', 'running')`,
    now,
    now,
    Number(articleId),
  );

  const result = db.run(
    `insert into article_ai_summary_sessions (article_id, status, draft_text, created_at, updated_at)
     values (?, 'running', '', ?, ?)`,
    Number(articleId),
    now,
    now,
  );
  return String(result.lastInsertRowid);
}

export function updateSummaryDraft(sessionId: string, draft: string): void {
  getDb().run(
    'update article_ai_summary_sessions set draft_text = ?, updated_at = ? where id = ?',
    draft,
    nowIso(),
    Number(sessionId),
  );
}

export function finishSummarySession(
  sessionId: string,
  result: { status: 'succeeded' | 'failed'; text?: string; errorCode?: string; errorMessage?: string },
): void {
  const now = nowIso();
  getDb().run(
    `update article_ai_summary_sessions
     set status = ?, final_text = coalesce(?, final_text), draft_text = coalesce(?, draft_text),
         error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
     where id = ?`,
    result.status,
    result.text ?? null,
    result.text ?? null,
    result.errorCode ?? null,
    result.errorMessage ?? null,
    now,
    now,
    Number(sessionId),
  );
}

export function getActiveSummarySession(articleId: string): AiSummarySession | null {
  const row = getDb().get<SessionRow>(
    `select * from article_ai_summary_sessions
     where article_id = ?
     order by case when status = 'running' then 0 else 1 end, updated_at desc
     limit 1`,
    Number(articleId),
  );
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status,
    draftText: row.draft_text,
    finalText: row.final_text,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

/** 进程重启后残留的 running 会话不可能再被推进，统一标记为中断。 */
export function failStaleSummarySessions(): void {
  getDb().run(
    `update article_ai_summary_sessions
     set status = 'failed', error_code = 'interrupted', error_message = '应用退出导致摘要中断',
         updated_at = ?, finished_at = ?
     where status = 'running'`,
    nowIso(),
    nowIso(),
  );
}
