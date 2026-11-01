import { getDb } from '../db/sqlite';
import { asBool, nowIso } from '../lib/utils';
import { ConflictError, NotFoundError, ValidationError } from '../http/envelope';
import { writeLog } from './logs';

export type ArticleListDisplayMode = 'card' | 'list';

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  iconUrl: string | null;
  enabled: boolean;
  categoryId: string | null;
  categoryName: string | null;
  fetchIntervalMinutes: number;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: string | null;
  lastFetchStatus: number | null;
  lastFetchError: string | null;
  fullTextOnOpenEnabled: boolean;
  fullTextOnFetchEnabled: boolean;
  aiSummaryOnOpenEnabled: boolean;
  titleTranslateEnabled: boolean;
  bodyTranslateEnabled: boolean;
  articleListDisplayMode: ArticleListDisplayMode;
  unreadCount: number;
  articleCount: number;
  isPodcast: boolean;
  createdAt: string;
}

interface FeedRow {
  id: number;
  title: string;
  url: string;
  site_url: string | null;
  icon_url: string | null;
  enabled: number;
  category_id: number | null;
  category_name: string | null;
  fetch_interval_minutes: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: string | null;
  last_fetch_status: number | null;
  last_fetch_error: string | null;
  full_text_on_open_enabled: number;
  full_text_on_fetch_enabled: number;
  ai_summary_on_open_enabled: number;
  title_translate_enabled: number;
  body_translate_enabled: number;
  article_list_display_mode: string;
  unread_count: number;
  article_count: number;
  total_count: number;
  podcast_count: number;
  created_at: string;
}

const FEED_SELECT = `
  select
    f.id, f.title, f.url, f.site_url, f.icon_url, f.enabled, f.category_id,
    c.name as category_name,
    f.fetch_interval_minutes, f.etag, f.last_modified, f.last_fetched_at,
    f.last_fetch_status, f.last_fetch_error,
    f.full_text_on_open_enabled, f.full_text_on_fetch_enabled,
    f.ai_summary_on_open_enabled, f.title_translate_enabled, f.body_translate_enabled,
    f.article_list_display_mode, f.created_at,
    (select count(*) from articles a
      where a.feed_id = f.id and a.is_read = 0 and a.is_filtered = 0) as unread_count,
    -- 与 unread_count 口径一致：被过滤掉的文章既不在列表里，也不该算进侧边栏的「N 篇」。
    (select count(*) from articles a
      where a.feed_id = f.id and a.is_filtered = 0) as article_count,
    -- 判断播客时仍按全部文章算分母，保持 isPodcast 的既有语义不变。
    (select count(*) from articles a where a.feed_id = f.id) as total_count,
    -- 只扫 content_html：content_full_html 多半更晚才抓回来，多两次 LIKE 全表扫描很贵。
    (select count(*) from articles a
      where a.feed_id = f.id
        and (a.content_html like '%<audio%' or a.content_html like '%<video%')) as podcast_count
  from feeds f
  left join categories c on c.id = f.category_id
`;

function mapFeed(row: FeedRow): FeedItem {
  return {
    id: String(row.id),
    title: row.title,
    url: row.url,
    siteUrl: row.site_url,
    iconUrl: row.icon_url,
    enabled: asBool(row.enabled),
    categoryId: row.category_id === null ? null : String(row.category_id),
    categoryName: row.category_name,
    fetchIntervalMinutes: row.fetch_interval_minutes,
    etag: row.etag,
    lastModified: row.last_modified,
    lastFetchedAt: row.last_fetched_at,
    lastFetchStatus: row.last_fetch_status,
    lastFetchError: row.last_fetch_error,
    fullTextOnOpenEnabled: asBool(row.full_text_on_open_enabled),
    fullTextOnFetchEnabled: asBool(row.full_text_on_fetch_enabled),
    aiSummaryOnOpenEnabled: asBool(row.ai_summary_on_open_enabled),
    titleTranslateEnabled: asBool(row.title_translate_enabled),
    bodyTranslateEnabled: asBool(row.body_translate_enabled),
    articleListDisplayMode: row.article_list_display_mode === 'list' ? 'list' : 'card',
    unreadCount: row.unread_count,
    articleCount: row.article_count,
    // 过半文章带音视频播放器才算播客订阅；普通博客偶尔嵌一个视频不该被当成播客，
    // 否则会连带关掉它的全文抓取与翻译。
    isPodcast: row.total_count > 0 && row.podcast_count > 0 && row.podcast_count * 2 >= row.total_count,
    createdAt: row.created_at,
  };
}

export function listFeeds(): FeedItem[] {
  return getDb()
    .all<FeedRow>(`${FEED_SELECT} order by c.position asc, f.created_at asc, f.id asc`)
    .map(mapFeed);
}

export function getFeed(id: string): FeedItem | null {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return null;
  const row = getDb().get<FeedRow>(`${FEED_SELECT} where f.id = ?`, numeric);
  return row ? mapFeed(row) : null;
}

export function findFeedByUrl(url: string): FeedItem | null {
  const row = getDb().get<FeedRow>(`${FEED_SELECT} where f.url = ?`, url);
  return row ? mapFeed(row) : null;
}

export interface FeedSecretRow {
  id: number;
  etag: string | null;
  lastModified: string | null;
  fetchIntervalMinutes: number;
  enabled: number;
}

export function getFeedFetchState(id: string): FeedSecretRow | null {
  const row = getDb().get<{
    id: number;
    etag: string | null;
    last_modified: string | null;
    fetch_interval_minutes: number;
    enabled: number;
  }>('select id, etag, last_modified, fetch_interval_minutes, enabled from feeds where id = ?', Number(id));
  if (!row) return null;
  return {
    id: row.id,
    etag: row.etag,
    lastModified: row.last_modified,
    fetchIntervalMinutes: row.fetch_interval_minutes,
    enabled: row.enabled,
  };
}

export interface CreateFeedInput {
  url: string;
  title?: string;
  siteUrl?: string | null;
  iconUrl?: string | null;
  categoryId?: string | null;
  fetchIntervalMinutes?: number;
  fullTextOnOpenEnabled?: boolean;
  fullTextOnFetchEnabled?: boolean;
  aiSummaryOnOpenEnabled?: boolean;
  titleTranslateEnabled?: boolean;
  bodyTranslateEnabled?: boolean;
}

export function normalizeFeedUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ValidationError('订阅地址不能为空', { url: 'required' });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ValidationError('订阅地址格式不正确', { url: 'invalid' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('仅支持 http/https 订阅地址', { url: 'unsupported_protocol' });
  }
  parsed.hash = '';
  return parsed.toString();
}

export function createFeed(input: CreateFeedInput): FeedItem {
  const url = normalizeFeedUrl(input.url);
  if (findFeedByUrl(url)) throw new ConflictError('该订阅已存在', { url: 'duplicate' });

  const db = getDb();
  const now = nowIso();
  const title = (input.title?.trim() || new URL(url).hostname).slice(0, 200);
  const result = db.run(
    `insert into feeds (
       title, url, site_url, icon_url, enabled, category_id, fetch_interval_minutes,
       full_text_on_open_enabled, full_text_on_fetch_enabled, ai_summary_on_open_enabled,
       title_translate_enabled, body_translate_enabled, created_at, updated_at
     ) values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    title,
    url,
    input.siteUrl ?? null,
    input.iconUrl ?? null,
    input.categoryId ? Number(input.categoryId) : null,
    input.fetchIntervalMinutes ?? 30,
    input.fullTextOnOpenEnabled ?? false,
    input.fullTextOnFetchEnabled ?? false,
    input.aiSummaryOnOpenEnabled ?? false,
    input.titleTranslateEnabled ?? false,
    input.bodyTranslateEnabled ?? false,
    now,
    now,
  );

  writeLog({
    level: 'info',
    category: 'feed',
    message: '添加订阅',
    source: 'domain/feeds',
    context: { feedId: result.lastInsertRowid, url },
  });

  const created = getFeed(String(result.lastInsertRowid));
  if (!created) throw new Error('feed created but not readable');
  return created;
}

export interface UpdateFeedInput {
  title?: string;
  categoryId?: string | null;
  enabled?: boolean;
  fetchIntervalMinutes?: number;
  fullTextOnOpenEnabled?: boolean;
  fullTextOnFetchEnabled?: boolean;
  aiSummaryOnOpenEnabled?: boolean;
  titleTranslateEnabled?: boolean;
  bodyTranslateEnabled?: boolean;
  articleListDisplayMode?: ArticleListDisplayMode;
}

const UPDATABLE: Array<{ key: keyof UpdateFeedInput; column: string; kind: 'text' | 'bool' | 'int' }> = [
  { key: 'title', column: 'title', kind: 'text' },
  { key: 'categoryId', column: 'category_id', kind: 'int' },
  { key: 'enabled', column: 'enabled', kind: 'bool' },
  { key: 'fetchIntervalMinutes', column: 'fetch_interval_minutes', kind: 'int' },
  { key: 'fullTextOnOpenEnabled', column: 'full_text_on_open_enabled', kind: 'bool' },
  { key: 'fullTextOnFetchEnabled', column: 'full_text_on_fetch_enabled', kind: 'bool' },
  { key: 'aiSummaryOnOpenEnabled', column: 'ai_summary_on_open_enabled', kind: 'bool' },
  { key: 'titleTranslateEnabled', column: 'title_translate_enabled', kind: 'bool' },
  { key: 'bodyTranslateEnabled', column: 'body_translate_enabled', kind: 'bool' },
  { key: 'articleListDisplayMode', column: 'article_list_display_mode', kind: 'text' },
];

const MIN_FETCH_INTERVAL_MINUTES = 5;
const MAX_FETCH_INTERVAL_MINUTES = 10_080;

/** 分类 ID 只接受整数；非法值若直接 Number() 会得到 NaN，sqlite 层会把它静默写成 NULL。 */
function parseCategoryId(value: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new ValidationError('分类 ID 不合法', { categoryId: 'invalid' });
  }
  return Number(text);
}

/** 抓取间隔夹到 5 分钟 ~ 7 天；NaN / Infinity 直接拒绝，避免写进数据库变成 NULL。 */
function normalizeFetchInterval(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ValidationError('抓取间隔必须是数字', { fetchIntervalMinutes: 'invalid' });
  }
  return Math.min(MAX_FETCH_INTERVAL_MINUTES, Math.max(MIN_FETCH_INTERVAL_MINUTES, Math.round(numeric)));
}

export function updateFeed(id: string, patch: UpdateFeedInput): FeedItem {
  const current = getFeed(id);
  if (!current) throw new NotFoundError('订阅不存在');

  const nextCategoryId =
    patch.categoryId === undefined
      ? undefined
      : patch.categoryId === null
        ? null
        : parseCategoryId(patch.categoryId);
  const nextFetchInterval =
    patch.fetchIntervalMinutes === undefined ? undefined : normalizeFetchInterval(patch.fetchIntervalMinutes);

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of UPDATABLE) {
    const value = patch[field.key];
    if (value === undefined) continue;
    sets.push(`${field.column} = ?`);
    if (field.key === 'categoryId') params.push(nextCategoryId ?? null);
    else if (field.key === 'fetchIntervalMinutes') params.push(nextFetchInterval);
    else if (field.kind === 'bool') params.push(Boolean(value));
    else if (field.kind === 'int') params.push(Number(value));
    else params.push(String(value).trim());
  }

  if (sets.length === 0) return current;

  if (nextCategoryId !== undefined && nextCategoryId !== null) {
    const exists = getDb().get<{ id: number }>('select id from categories where id = ?', nextCategoryId);
    if (!exists) throw new ValidationError('分类不存在', { categoryId: 'not_found' });
  }

  getDb().run(
    `update feeds set ${sets.join(', ')}, updated_at = ? where id = ?`,
    ...params,
    nowIso(),
    Number(id),
  );
  const updated = getFeed(id);
  if (!updated) throw new NotFoundError('订阅不存在');
  return updated;
}

export function deleteFeed(id: string): void {
  const feed = getFeed(id);
  if (!feed) throw new NotFoundError('订阅不存在');
  getDb().run('delete from feeds where id = ?', Number(id));
  writeLog({
    level: 'info',
    category: 'feed',
    message: '删除订阅',
    source: 'domain/feeds',
    context: { title: feed.title, url: feed.url },
  });
}

export function markFetchResult(
  id: string,
  result: { status: number | null; error: string | null; etag?: string | null; lastModified?: string | null },
): void {
  getDb().run(
    `update feeds set last_fetched_at = ?, last_fetch_status = ?, last_fetch_error = ?,
       etag = coalesce(?, etag), last_modified = coalesce(?, last_modified), updated_at = ?
     where id = ?`,
    nowIso(),
    result.status,
    result.error,
    result.etag ?? null,
    result.lastModified ?? null,
    nowIso(),
    Number(id),
  );
}

export function setFeedIconUrl(id: string, iconUrl: string | null): void {
  getDb().run('update feeds set icon_url = ?, updated_at = ? where id = ?', iconUrl, nowIso(), Number(id));
}

export function updateFeedSiteUrl(id: string, siteUrl: string | null): void {
  getDb().run('update feeds set site_url = ?, updated_at = ? where id = ?', siteUrl, nowIso(), Number(id));
}

/** 找出到期的订阅：从未抓取、或距上次抓取已超过订阅间隔。 */
export function listDueFeeds(now = Date.now()): Array<{ id: string; title: string }> {
  const rows = getDb().all<{ id: number; title: string; last_fetched_at: string | null; fetch_interval_minutes: number }>(
    `select id, title, last_fetched_at, fetch_interval_minutes
     from feeds where enabled = 1 order by last_fetched_at is not null, last_fetched_at asc`,
  );
  return rows
    .filter((row) => {
      if (!row.last_fetched_at) return true;
      const last = Date.parse(row.last_fetched_at);
      if (!Number.isFinite(last)) return true;
      return now - last >= row.fetch_interval_minutes * 60_000;
    })
    .map((row) => ({ id: String(row.id), title: row.title }));
}

/**
 * 全局抓取间隔变更时，只同步「跟随全局」的订阅。
 *
 * 数据库里没有「是否自定义过间隔」的标记，用「当前值等于旧全局值」来判断：
 * 用户单独给某个源设过别的间隔，就不该被一次全局修改覆盖掉。
 */
export function syncFetchInterval(previousMinutes: number, nextMinutes: number): number {
  const result = getDb().run(
    'update feeds set fetch_interval_minutes = ?, updated_at = ? where fetch_interval_minutes = ?',
    nextMinutes,
    nowIso(),
    previousMinutes,
  );
  return result.changes;
}

