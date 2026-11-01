import { Hono } from 'hono';
import { dirname } from 'node:path';
import type { ServerConfig } from '../config';
import { ValidationError, ok } from '../http/envelope';
import { openExternalUrl } from '../services/opener';
import { readJson } from './feeds';

/**
 * 系统能力：这些事 WebView 自己做不到（没有 shell / opener 插件），
 * 只能由 sidecar 在 Node 侧代劳。
 */
export function systemRoutes(cfg: ServerConfig) {
  const app = new Hono();

  app.get('/info', (c) =>
    ok(c, {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      // 便携模式（FEEDFUSE_DATA_DIR / FEEDFUSE_DB_PATH）下两者可能不同，
      // 兜一层 dirname，保证「关于」页显示的一定是库文件真实所在目录。
      dataDir: cfg.dataDir || dirname(cfg.dbPath),
    }),
  );

  /**
   * 打开外链。正文链接与「原文」按钮都走这里，
   * 因为 Tauri WebView 没有 opener 插件，target="_blank" 点了没反应。
   */
  app.post('/open-url', async (c) => {
    const body = await readJson(c);
    const url = body.url;
    if (typeof url !== 'string') throw new ValidationError('缺少 url 参数', { url: 'required' });

    await openExternalUrl(url);
    // 命中去重时同样返回 opened:true：调用方只关心「点了能打开」，重复点击不该报错。
    return ok(c, { opened: true });
  });

  return app;
}
