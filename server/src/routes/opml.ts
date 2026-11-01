import { Hono } from 'hono';
import { ValidationError, ok } from '../http/envelope';
import { exportOpml, importOpml } from '../services/opml';
import { startRefreshAllFeeds } from '../services/ingest';
import type { ServerConfig } from '../config';

export function opmlRoutes(cfg: ServerConfig) {
  const app = new Hono();

  app.get('/export', (c) => {
    const xml = exportOpml();
    c.header('content-type', 'application/xml; charset=utf-8');
    c.header('content-disposition', `attachment; filename="feedfuse-subscriptions.opml"`);
    return c.body(xml);
  });

  app.post('/import', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let xml = '';

    if (contentType.includes('application/json')) {
      const body = (await c.req.json().catch(() => ({}))) as { xml?: unknown };
      xml = typeof body.xml === 'string' ? body.xml : '';
    } else if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (file && typeof file !== 'string') {
        xml = await file.text();
      } else {
        xml = String(form.get('xml') ?? '');
      }
    } else {
      xml = await c.req.text();
    }

    if (!xml.trim()) throw new ValidationError('没有收到 OPML 内容', { file: 'required' });

    const result = importOpml(xml);
    // 导入完成后后台刷新，前端可以轮询 /api/feeds/refresh/status 看进度。
    if (result.imported > 0) startRefreshAllFeeds(cfg);

    return ok(c, result);
  });

  return app;
}
