import { Hono, type Context } from 'hono';
import type { ServerConfig } from '../config';
import { ValidationError } from '../http/envelope';
import { ok } from '../http/envelope';
import {
  createFeed,
  deleteFeed,
  getFeed,
  listFeeds,
  normalizeFeedUrl,
  updateFeed,
  type FeedItem,
  type UpdateFeedInput,
} from '../domain/feeds';
import { buildImageProxyUrl } from '../services/imageProxy';
import { fetchFeedXml, parseFeedXml } from '../services/rss';
import { refreshFeed, getRefreshProgress, startRefreshAllFeeds } from '../services/ingest';

function present(feed: FeedItem, cfg: ServerConfig): FeedItem {
  return {
    ...feed,
    iconUrl: feed.iconUrl ? buildImageProxyUrl(cfg, feed.iconUrl) : null,
  };
}

export function feedsRoutes(cfg: ServerConfig) {
  const app = new Hono();

  app.get('/', (c) => ok(c, listFeeds().map((feed) => present(feed, cfg))));

  app.post('/validate', async (c) => {
    const body = await readJson(c.req.raw);
    const url = normalizeFeedUrl(body.url);

    const fetched = await fetchFeedXml(url, {
      userAgent: cfg.userAgent,
      timeoutMs: cfg.requestTimeoutMs,
    });
    if (fetched.error) throw new ValidationError(fetched.error, { url: 'unreachable' });

    const parsed = await parseFeedXml(fetched.xml ?? '', fetched.finalUrl);
    return ok(c, {
      url,
      title: parsed.title,
      siteUrl: parsed.siteUrl,
      iconUrl: parsed.iconUrl,
      itemCount: parsed.items.length,
      samples: parsed.items.slice(0, 3).map((item) => item.title),
    });
  });

  app.get('/refresh/status', (c) => ok(c, getRefreshProgress()));

  app.post('/refresh', (c) => {
    const progress = startRefreshAllFeeds(cfg);
    return ok(c, progress);
  });

  app.post('/', async (c) => {
    const body = await readJson(c);
    const feed = createFeed({
      url: String(body.url ?? ''),
      title: typeof body.title === 'string' ? body.title : undefined,
      categoryId: typeof body.categoryId === 'string' ? body.categoryId : null,
      fetchIntervalMinutes:
        typeof body.fetchIntervalMinutes === 'number' ? body.fetchIntervalMinutes : undefined,
      fullTextOnOpenEnabled: toBool(body.fullTextOnOpenEnabled),
      fullTextOnFetchEnabled: toBool(body.fullTextOnFetchEnabled),
      aiSummaryOnOpenEnabled: toBool(body.aiSummaryOnOpenEnabled),
      titleTranslateEnabled: toBool(body.titleTranslateEnabled),
      bodyTranslateEnabled: toBool(body.bodyTranslateEnabled),
    });

    // 新建后立即抓一次，用户不用等下一个调度周期就能看到文章。
    // 订阅此时已落库，首次抓取失败只作为结果里的 error 返回：否则整个请求 500，
    // 用户重试反而会撞上 409「已存在」。
    let result: { inserted: number; error: string | null };
    try {
      result = await refreshFeed(feed.id, cfg, { force: true });
    } catch (err) {
      result = { inserted: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const created = getFeed(feed.id) ?? feed;
    return ok(c, {
      feed: present(created, cfg),
      inserted: result.inserted,
      error: result.error,
    });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c);
    const patch: UpdateFeedInput = {};

    if (typeof body.title === 'string') patch.title = body.title;
    if (body.categoryId === null || typeof body.categoryId === 'string') patch.categoryId = body.categoryId;
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.fetchIntervalMinutes === 'number') patch.fetchIntervalMinutes = body.fetchIntervalMinutes;
    if (typeof body.fullTextOnOpenEnabled === 'boolean') patch.fullTextOnOpenEnabled = body.fullTextOnOpenEnabled;
    if (typeof body.fullTextOnFetchEnabled === 'boolean') patch.fullTextOnFetchEnabled = body.fullTextOnFetchEnabled;
    if (typeof body.aiSummaryOnOpenEnabled === 'boolean') patch.aiSummaryOnOpenEnabled = body.aiSummaryOnOpenEnabled;
    if (typeof body.titleTranslateEnabled === 'boolean') patch.titleTranslateEnabled = body.titleTranslateEnabled;
    if (typeof body.bodyTranslateEnabled === 'boolean') patch.bodyTranslateEnabled = body.bodyTranslateEnabled;
    if (body.articleListDisplayMode === 'card' || body.articleListDisplayMode === 'list') {
      patch.articleListDisplayMode = body.articleListDisplayMode;
    }

    return ok(c, present(updateFeed(id, patch), cfg));
  });

  app.delete('/:id', (c) => {
    deleteFeed(c.req.param('id'));
    return ok(c, { deleted: true });
  });

  app.post('/:id/refresh', async (c) => {
    const result = await refreshFeed(c.req.param('id'), cfg, { force: true });
    return ok(c, result);
  });

  return app;
}

function toBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export async function readJson(input: Context | Request): Promise<Record<string, unknown>> {
  try {
    const parsed = input instanceof Request ? await input.json() : await input.req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return {};
}
