import { AppError } from '../http/envelope';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerConfig } from '../config';
import { NotFoundError, ValidationError, ok } from '../http/envelope';
import type { ArticleListItem } from '../domain/articles';
import {
  countArticlesByFilterStatus,
  getActiveSummarySession,
  getArticleContent,
  getArticleDetail,
  getCounts,
  listArticles,
  markAllRead,
  saveFulltext,
  saveSummary,
  searchArticles,
  setArticleState,
  startSummarySession,
  updateSummaryDraft,
  finishSummarySession,
  type ArticleDetail,
} from '../domain/articles';
import { resolveAiRuntime } from '../domain/settings';
import { buildImageProxyUrl, rewriteImagesToProxy } from '../services/imageProxy';
import { extractFulltext } from '../services/fulltext';
import {
  getFilterProgress,
  reapplyArticleFilters,
  startReapplyFilters,
} from '../services/filters';
import { contentFingerprint } from '../services/filters/text';
import { buildSummarySource, streamArticleSummary, streamBodyTranslation, translateArticleTitle } from '../services/translate';
import { writeLog } from '../domain/logs';
import { readJson } from './feeds';

/** 列表缩略图同样走本地代理：源站开防盗链时列表才不会整片裂图。 */
export function presentListItem(item: ArticleListItem, cfg: ServerConfig): ArticleListItem {
  return {
    ...item,
    previewImage: item.previewImage ? buildImageProxyUrl(cfg, item.previewImage) : null,
  };
}

export function presentArticle(article: ArticleDetail, cfg: ServerConfig): ArticleDetail {
  return {
    ...article,
    contentHtml: rewriteImagesToProxy(article.contentHtml, cfg, article.link),
    contentFullHtml: article.contentFullHtml
      ? rewriteImagesToProxy(article.contentFullHtml, cfg, article.link)
      : null,
    aiTranslationBilingualHtml: article.aiTranslationBilingualHtml
      ? rewriteImagesToProxy(article.aiTranslationBilingualHtml, cfg, article.link)
      : null,
    aiTranslationZhHtml: article.aiTranslationZhHtml
      ? rewriteImagesToProxy(article.aiTranslationZhHtml, cfg, article.link)
      : null,
    previewImage: article.previewImage ? buildImageProxyUrl(cfg, article.previewImage) : null,
  };
}

/** 回溯重判超过这个量级就转后台，同步返回会让前端等到超时。 */
const ASYNC_REAPPLY_THRESHOLD = 5000;

/** 与 buildWhere 支持的视图保持一致；新增视图时这里也要跟着改。 */
function isKnownView(view: string): boolean {
  return (
    view === 'all' ||
    view === 'unread' ||
    view === 'starred' ||
    /^feed:\d+$/.test(view) ||
    /^category:\d+$/.test(view)
  );
}

export function articlesRoutes(cfg: ServerConfig) {
  const app = new Hono();

  app.get('/', (c) => {
    const url = new URL(c.req.url);
    const page = listArticles({
      view: url.searchParams.get('view') ?? 'all',
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      cursor: url.searchParams.get('cursor'),
      unreadOnly: url.searchParams.get('unreadOnly') === 'true',
      includeFiltered: url.searchParams.get('includeFiltered') === 'true',
    });
    return ok(c, {
      ...page,
      items: page.items.map((item) => presentListItem(item, cfg)),
      counts: getCounts(),
    });
  });

  app.get('/search', (c) => {
    const url = new URL(c.req.url);
    const q = url.searchParams.get('q') ?? '';
    const items = searchArticles({ q, limit: Number(url.searchParams.get('limit') ?? 40) });
    return ok(c, { items: items.map((item) => presentListItem(item, cfg)) });
  });

  app.post('/mark-all-read', async (c) => {
    const body = await readJson(c);
    const view = typeof body.view === 'string' ? body.view : 'all';
    // view 直接透传给 buildWhere，未知值不会加任何条件，等于「全库标记已读」。
    // 一个拼写错误就能把用户所有未读清空，所以在入口处白名单校验。
    if (!isKnownView(view)) throw new ValidationError('未知的视图', { view: 'invalid' });
    const updated = markAllRead(view);
    writeLog({
      level: 'info',
      category: 'article',
      message: '批量标记已读',
      source: 'routes/articles',
      context: { view, updated },
    });
    return ok(c, { updated, counts: getCounts() });
  });

  // 静态路径必须排在 /:id 之前，否则 "reapply-filters" 会被当成文章 id。
  app.post('/reapply-filters', async (c) => {
    // includeAi 决定要不要把每篇都送去模型重判：默认不开启，
    // 否则一次点击就是几千次真实调用。前端「立即重判」在 AI 过滤开启时会带上它。
    const body = await readJson(c);
    const options = { includeAi: body.includeAi === true };
    // 超过阈值就转后台跑：同步扫几千篇会让请求卡到浏览器超时。
    const total = countArticlesByFilterStatus().total;
    if (total > ASYNC_REAPPLY_THRESHOLD) {
      startReapplyFilters(options);
      return ok(c, { running: true });
    }
    const result = reapplyArticleFilters(options);
    writeLog({
      level: 'info',
      category: 'article',
      message: '按当前设置重判过滤规则',
      source: 'routes/articles',
      context: { ...result },
    });
    return ok(c, result);
  });

  app.get('/reapply-filters/status', (c) => ok(c, getFilterProgress()));

  app.get('/:id', (c) => {
    const article = getArticleDetail(c.req.param('id'));
    if (!article) throw new NotFoundError('文章不存在');
    return ok(c, {
      ...presentArticle(article, cfg),
      aiSummarySession: getActiveSummarySession(article.id),
    });
  });

  app.patch('/:id', async (c) => {
    const body = await readJson(c);
    const patch: { isRead?: boolean; isStarred?: boolean } = {};
    if (typeof body.isRead === 'boolean') patch.isRead = body.isRead;
    if (typeof body.isStarred === 'boolean') patch.isStarred = body.isStarred;
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('至少需要一个更新字段', { body: 'empty' });
    }
    const updated = setArticleState(c.req.param('id'), patch);
    return ok(c, { updated: true, counts: getCounts(), article: updated });
  });

  app.post('/:id/fulltext', async (c) => {
    const id = c.req.param('id');
    const article = getArticleContent(id);
    if (!article) throw new NotFoundError('文章不存在');
    if (!article.link) throw new ValidationError('这篇文章没有原文链接，无法抓取全文', { link: 'missing' });

    let extracted;
    try {
      extracted = await extractFulltext(article.link, cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : '正文抓取失败，请检查网络和代理';
      writeLog({ level: 'warning', category: 'article', message, source: 'routes/articles', context: { articleId: id } });
      throw new AppError('upstream_error', message, 502);
    }
    if (!extracted) {
      throw new ValidationError('未能提取到正文内容，可能被源站反爬拦截', { url: 'extract_failed' });
    }
    saveFulltext(id, extracted.html, contentFingerprint(extracted.html));
    writeLog({
      level: 'info',
      category: 'article',
      message: '抓取全文成功',
      source: 'routes/articles',
      context: { articleId: id, wordCount: extracted.wordCount },
    });

    return ok(c, {
      contentFullHtml: rewriteImagesToProxy(extracted.html, cfg, article.link),
      wordCount: extracted.wordCount,
      excerpt: extracted.excerpt,
      title: extracted.title,
    });
  });

  app.post('/:id/summary/stream', (c) => {
    const id = c.req.param('id');
    // 先同步校验输入，避免已经切到 SSE 才发现缺正文。
    buildSummarySource(id);

    return streamSSE(c, async (stream) => {
      const sessionId = startSummarySession(id);
      let text = '';
      let lastFlush = Date.now();

      try {
        for await (const delta of streamArticleSummary({ articleId: id, signal: c.req.raw.signal })) {
          text += delta;
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: delta }) });

          if (Date.now() - lastFlush > 800) {
            lastFlush = Date.now();
            updateSummaryDraft(sessionId, text);
          }
        }

        // 模型偶尔会返回空内容（上游把流提前断掉、网关返回空 choices）。这时绝不能落库：
        // 一条空摘要会覆盖掉用户已经生成好的那份，而且前端只会看到「成功但什么都没有」。
        const trimmed = text.trim();
        if (!trimmed) throw new Error('AI 返回了空内容，请稍后重试');

        // 模型名必须跟着摘要一起落库，否则前端无法显示这条摘要出自哪个模型。
        saveSummary(id, trimmed, resolveAiRuntime('summary').model);
        finishSummarySession(sessionId, { status: 'succeeded', text: trimmed });
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ text: trimmed }) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finishSummarySession(sessionId, { status: 'failed', errorCode: 'ai_error', errorMessage: message });
        writeLog({
          level: 'error',
          category: 'ai_summary',
          message: '生成摘要失败',
          source: 'routes/articles',
          details: message,
          context: { articleId: id },
        });
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) });
      }
    });
  });

  app.post('/:id/translation/title', async (c) => {
    const title = await translateArticleTitle(c.req.param('id'));
    return ok(c, { title });
  });

  app.post('/:id/translation/body/stream', (c) => {
    const id = c.req.param('id');
    const article = getArticleContent(id);
    if (!article) throw new NotFoundError('文章不存在');

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of streamBodyTranslation(id, c.req.raw.signal)) {
          if ('translated' in event) {
            await stream.writeSSE({
              event: 'progress',
              data: JSON.stringify({
                translated: event.translated.map((item) => ({ id: item.id, text: item.text })),
              }),
            });
            continue;
          }

          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              zhHtml: rewriteImagesToProxy(event.zhHtml, cfg, article.link),
              bilingualHtml: rewriteImagesToProxy(event.bilingualHtml, cfg, article.link),
              totalSegments: event.totalSegments,
              translatedSegments: event.translatedSegments,
            }),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeLog({
          level: 'error',
          category: 'ai_translate',
          message: '正文翻译失败',
          source: 'routes/articles',
          details: message,
          context: { articleId: id },
        });
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) });
      }
    });
  });

  return app;
}
