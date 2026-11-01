import type { ServerConfig } from '../config';
import { getSettings } from '../domain/settings';
import { writeLog } from '../domain/logs';
import {
  getFeed,
  getFeedFetchState,
  listFeeds,
  listDueFeeds,
  markFetchResult,
  setFeedIconUrl,
  updateFeedSiteUrl,
  updateFeed,
} from '../domain/feeds';
import { getArticleContent, pruneFeedArticles, saveFulltext, upsertArticle } from '../domain/articles';
import { fetchFeedXml, parseFeedXml } from './rss';
import { mapLimit, nowIso } from '../lib/utils';
import { extractFulltext } from './fulltext';
import { enqueueAiFilter, evaluateOnIngest } from './filters';
import { contentFingerprint } from './filters/text';

export interface FeedRefreshResult {
  feedId: string;
  title: string;
  inserted: number;
  notModified: boolean;
  error: string | null;
}

export interface RefreshProgress {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  inserted: number;
  current: string | null;
  failures: Array<{ feedId: string; title: string; error: string }>;
}

const idleProgress: RefreshProgress = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  inserted: 0,
  current: null,
  failures: [],
};

let progress: RefreshProgress = { ...idleProgress };

export function getRefreshProgress(): RefreshProgress {
  return progress;
}

export async function refreshFeed(
  feedId: string,
  cfg: ServerConfig,
  options: { force?: boolean } = {},
): Promise<FeedRefreshResult> {
  const feed = getFeed(feedId);
  if (!feed) return { feedId, title: '', inserted: 0, notModified: false, error: '订阅不存在' };
  if (!feed.enabled && !options.force) {
    return { feedId, title: feed.title, inserted: 0, notModified: false, error: null };
  }

  const state = getFeedFetchState(feedId);
  const settings = getSettings();

  const fetched = await fetchFeedXml(feed.url, {
    etag: state?.etag ?? null,
    lastModified: state?.lastModified ?? null,
    userAgent: cfg.userAgent,
    timeoutMs: cfg.requestTimeoutMs,
  });

  if (fetched.error) {
    markFetchResult(feedId, { status: fetched.status || null, error: fetched.error });
    writeLog({
      level: 'warning',
      category: 'feed',
      message: '订阅抓取失败',
      source: 'services/ingest',
      details: fetched.error,
      context: { feedId, title: feed.title, url: feed.url, status: fetched.status },
    });
    return { feedId, title: feed.title, inserted: 0, notModified: false, error: fetched.error };
  }

  if (fetched.notModified) {
    markFetchResult(feedId, { status: 304, error: null });
    return { feedId, title: feed.title, inserted: 0, notModified: true, error: null };
  }

  let parsed;
  try {
    parsed = await parseFeedXml(fetched.xml ?? '', fetched.finalUrl);
  } catch (err) {
    const error = `订阅内容解析失败：${err instanceof Error ? err.message : String(err)}`;
    markFetchResult(feedId, { status: fetched.status, error });
    writeLog({ level: 'warning', category: 'feed', message: error, source: 'services/ingest', context: { feedId } });
    return { feedId, title: feed.title, inserted: 0, notModified: false, error };
  }

  let inserted = 0;
  const freshIds: string[] = [];
  // 只有同步判定没被过滤掉的文章才值得再问一次模型。
  const aiCandidates: string[] = [];
  for (const item of parsed.items.slice(0, 200)) {
    const evaluation = evaluateOnIngest({
      feedId,
      title: item.title,
      link: item.link,
      summary: item.summary,
      contentHtml: item.contentHtml,
      // 入库时还没有全文，先按 feed 里的正文算指纹，抓全文后再重判会得到更准的结论。
      contentFullHtml: null,
    });

    const result = upsertArticle({
      feedId,
      dedupeKey: item.dedupeKey,
      title: item.title,
      link: item.link,
      author: item.author,
      publishedAt: item.publishedAt,
      contentHtml: item.contentHtml,
      summary: item.summary,
      previewImage: item.previewImage,
      sourceLanguage: item.sourceLanguage,
      isFiltered: evaluation.isFiltered,
      filteredBy: evaluation.filteredBy,
      filterReason: evaluation.filterReason,
      filterStatus: evaluation.filterStatus,
      urlNormalized: evaluation.urlNormalized,
      titleNormalized: evaluation.titleNormalized,
      contentFingerprint: evaluation.contentFingerprint,
    });
    if (result.inserted) {
      inserted += 1;
      freshIds.push(result.id);
      if (!evaluation.isFiltered) aiCandidates.push(result.id);
    }
  }

  if (
    aiCandidates.length > 0 &&
    settings.rss.articleFilter.ai.enabled &&
    settings.rss.articleFilter.ai.prompt.trim()
  ) {
    // 不 await：抓取链路不能被模型调用拖住，队列在后台按并发 3 慢慢跑。
    enqueueAiFilter(aiCandidates);
  }

  // 首次抓取时补全标题、站点地址与图标；后续不覆盖用户可能改过的名称。
  const patch: Parameters<typeof updateFeed>[1] = {};
  if (!feed.title || feed.title === new URL(feed.url).hostname) {
    patch.title = parsed.title;
  }
  if (!feed.iconUrl && parsed.iconUrl) {
    setFeedIconUrl(feedId, parsed.iconUrl);
  }
  if (!feed.siteUrl && parsed.siteUrl) {
    updateFeedSiteUrl(feedId, parsed.siteUrl);
  }

  markFetchResult(feedId, {
    status: fetched.status,
    error: null,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
  });

  if (Object.keys(patch).length > 0) updateFeed(feedId, patch);

  const pruned = pruneFeedArticles(feedId, settings.rss.maxStoredArticlesPerFeed);
  if (pruned > 0) {
    writeLog({
      level: 'info',
      category: 'feed',
      message: '按留存上限清理旧文章',
      source: 'services/ingest',
      context: { feedId, pruned, keep: settings.rss.maxStoredArticlesPerFeed },
    });
  }

  if (feed.fullTextOnFetchEnabled && freshIds.length > 0) {
    // 只对最新的少量文章预抓全文，避免首次订阅就把网络和 CPU 打满。
    void preloadFulltext(freshIds.slice(0, 3), cfg);
  }

  return { feedId, title: feed.title, inserted, notModified: false, error: null };
}

async function preloadFulltext(articleIds: string[], cfg: ServerConfig): Promise<void> {
  for (const id of articleIds) {
    try {
      const article = getArticleContent(id);
      if (!article?.link || article.contentFullHtml) continue;
      const extracted = await extractFulltext(article.link, cfg);
      // 全文比 RSS 摘要长得多，顺手把指纹换成基于全文算的，跨订阅查重才有区分度。
      if (extracted) saveFulltext(id, extracted.html, contentFingerprint(extracted.html));
    } catch {
      // 预抓失败不影响订阅刷新
    }
  }
}

export async function refreshFeeds(
  feedIds: string[],
  cfg: ServerConfig,
  options: { force?: boolean } = {},
): Promise<RefreshProgress> {
  if (progress.running) return progress;

  progress = {
    running: true,
    startedAt: nowIso(),
    finishedAt: null,
    total: feedIds.length,
    done: 0,
    inserted: 0,
    current: null,
    failures: [],
  };

  const targets = feedIds
    .map((id) => getFeed(id))
    .filter((feed): feed is NonNullable<typeof feed> => Boolean(feed));

  await mapLimit(targets, 4, async (feed) => {
    progress.current = feed.title;
    try {
      const result = await refreshFeed(feed.id, cfg, options);
      progress.inserted += result.inserted;
      if (result.error) {
        progress.failures.push({ feedId: feed.id, title: feed.title, error: result.error });
      }
    } catch (err) {
      progress.failures.push({
        feedId: feed.id,
        title: feed.title,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      progress.done += 1;
    }
  });

  progress.running = false;
  progress.current = null;
  progress.finishedAt = nowIso();
  writeLog({
    level: progress.failures.length > 0 ? 'warning' : 'info',
    category: 'feed',
    message: `批量刷新完成：${progress.inserted} 篇新文章`,
    source: 'services/ingest',
    context: {
      total: progress.total,
      failures: progress.failures.slice(0, 10),
    },
  });
  return progress;
}

export function startRefreshAllFeeds(cfg: ServerConfig): RefreshProgress {
  if (progress.running) return progress;
  const all = listFeeds()
    .filter((feed) => feed.enabled)
    .map((feed) => feed.id);
  void refreshFeeds(all, cfg, { force: true });
  return progress;
}
