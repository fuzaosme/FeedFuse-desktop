import { Hono } from 'hono';
import type { ServerConfig } from '../config';
import { streamSSE } from 'hono/streaming';
import { ValidationError, ok } from '../http/envelope';
import { listArticles, getCounts } from '../domain/articles';
import { listCategories } from '../domain/categories';
import { listFeeds } from '../domain/feeds';
import { getRefreshProgress } from '../services/ingest';
import { buildImageProxyUrl } from '../services/imageProxy';
import { streamSentenceExplanation, streamWordDetail } from '../services/translate';
import { readJson } from './feeds';
import { presentListItem } from './articles';

export function snapshotRoutes(cfg: ServerConfig) {
  const app = new Hono();

  /** 首屏与切视图统一走一个快照接口，避免前端拼接多次请求。 */
  app.get('/snapshot', (c) => {
    const url = new URL(c.req.url);
    const view = url.searchParams.get('view') ?? 'all';

    const page = listArticles({
      view,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      cursor: url.searchParams.get('cursor'),
      unreadOnly: url.searchParams.get('unreadOnly') === 'true',
      includeFiltered: url.searchParams.get('includeFiltered') === 'true',
    });

    return ok(c, {
      categories: listCategories(),
      feeds: listFeeds().map((feed) => ({
        ...feed,
        iconUrl: feed.iconUrl ? buildImageProxyUrl(cfg, feed.iconUrl) : null,
      })),
      articles: { ...page, items: page.items.map((item) => presentListItem(item, cfg)) },
      counts: getCounts(),
      refresh: getRefreshProgress(),
    });
  });

  return app;
}

export function englishRoutes() {
  const app = new Hono();

  /** 英文讲解：SSE 流式返回，前端边出边收。 */
  app.post('/explain', (c) => {
    return streamSSE(c, async (stream) => {
      const body = await readJson(c);
      const articleId = typeof body.articleId === 'string' ? body.articleId : '';
      const context = typeof body.context === 'string' ? body.context : undefined;
      const sentences = readSentences(body.sentences);
      // 兼容旧客户端：只传 sentence 时把它当成唯一完整句子。
      const legacy = typeof body.sentence === 'string' ? body.sentence.trim() : '';
      const selectedText =
        typeof body.selectedText === 'string' && body.selectedText.trim()
          ? body.selectedText.trim()
          : legacy || sentences.join('\n');

      if (!selectedText) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: '没有选中内容' }) });
        return;
      }

      try {
        for await (const delta of streamSentenceExplanation({
          articleId,
          selectedText,
          sentences: sentences.length ? sentences : [selectedText],
          context,
          signal: c.req.raw.signal,
        })) {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: delta }) });
        }
        await stream.writeSSE({ event: 'done', data: '{}' });
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
        });
      }
    });
  });

  /** 单词「详细解释」：与句子讲解分开，固定使用内置提示词。 */
  app.post('/word-detail', (c) => {
    return streamSSE(c, async (stream) => {
      const body = await readJson(c);
      const articleId = typeof body.articleId === 'string' ? body.articleId : '';
      const context = typeof body.context === 'string' ? body.context : undefined;
      const term = typeof body.term === 'string' ? body.term.trim() : '';
      const sentences = readSentences(body.sentences);
      const selectedText =
        typeof body.selectedText === 'string' && body.selectedText.trim()
          ? body.selectedText.trim()
          : sentences.join('\n') || term;

      if (!term) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: '缺少要解释的单词' }) });
        return;
      }

      try {
        for await (const delta of streamWordDetail({
          articleId,
          term,
          selectedText,
          sentences: sentences.length ? sentences : [selectedText],
          context,
          signal: c.req.raw.signal,
        })) {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: delta }) });
        }
        await stream.writeSSE({ event: 'done', data: '{}' });
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
        });
      }
    });
  });

  return app;
}

/** 句子列表：去空、去重、限量，避免把超长选区整段塞给模型。 */
function readSentences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= 100) break;
  }
  return result;
}
