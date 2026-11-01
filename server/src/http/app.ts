import { Hono, type Handler } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from '../config';
import { APP_VERSION } from '../config';
import { AppError, UnauthorizedError, fail } from './envelope';
import { feedsRoutes } from '../routes/feeds';
import { categoriesRoutes } from '../routes/categories';
import { articlesRoutes } from '../routes/articles';
import { settingsRoutes } from '../routes/settings';
import { logsRoutes } from '../routes/logs';
import { opmlRoutes } from '../routes/opml';
import { dictionariesRoutes, vocabularyRoutes } from '../routes/library';
import { mediaRoutes } from '../routes/media';
import { systemRoutes } from '../routes/system';
import { englishRoutes, snapshotRoutes } from '../routes/snapshot';
import { getDb } from '../db/sqlite';
import { countTables } from './health';

export function createApp(cfg: ServerConfig): Hono {
  const app = new Hono();

  app.onError((err, c) => fail(c, err));

  // 回环绑定还不足以防 DNS rebinding：拒绝以外部域名访问含本地令牌的入口页。
  app.use('*', async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return c.text('仅允许本机访问', 403);
    return next();
  });

  // 开发模式下 Vite 跑在另一个端口，需要放行跨端口请求；生产是同源加载，不依赖 CORS。
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : null),
      allowHeaders: ['content-type', 'x-feedfuse-token'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    // 图片走签名校验（<img> 无法带自定义头），其余接口都要求本地令牌。
    if (c.req.path === '/api/image') return next();
    if (process.env.FEEDFUSE_ALLOW_ANON === '1') return next();

    const headerToken = c.req.header('x-feedfuse-token');
    const cookieToken = parseCookie(c.req.header('cookie') ?? '', 'ff_token');
    // 词典里的图片由 <img> 直接发起，带不上自定义请求头，只能把令牌放进查询参数。
    const queryToken = c.req.query('token');
    const token = headerToken ?? cookieToken ?? queryToken;
    if (token !== cfg.token) throw new UnauthorizedError();
    return next();
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      data: {
        version: APP_VERSION,
        uptimeMs: Math.round(process.uptime() * 1000),
        dbPath: cfg.dbPath,
        tables: countTables(),
        pid: process.pid,
      },
    }),
  );

  app.route('/api/feeds', feedsRoutes(cfg));
  app.route('/api/categories', categoriesRoutes());
  app.route('/api/articles', articlesRoutes(cfg));
  app.route('/api/settings', settingsRoutes());
  app.route('/api/logs', logsRoutes());
  app.route('/api/opml', opmlRoutes(cfg));
  app.route('/api/vocabulary', vocabularyRoutes());
  app.route('/api/dictionaries', dictionariesRoutes());
  app.route('/api', mediaRoutes(cfg));
  app.route('/api/english', englishRoutes());
  app.route('/api', snapshotRoutes(cfg));
  app.route('/api/system', systemRoutes(cfg));

  app.all('/api/*', (c) =>
    c.json({ ok: false, error: { code: 'not_found', message: `接口不存在: ${c.req.path}` } }, 404),
  );

  mountStatic(app, cfg);

  return app;
}

/**
 * 生产环境由 sidecar 同时提供前端静态文件，
 * 这样 WebView 与 API 同源，不用处理跨域、cookie 与相对路径问题。
 */
function mountStatic(app: Hono, cfg: ServerConfig): void {
  const root = cfg.staticDir;
  if (!root || !existsSync(root)) {
    app.get('/', (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>FeedFuse sidecar</title>
         <body style="font-family:system-ui;padding:40px">
         <h1>FeedFuse sidecar 已启动</h1>
         <p>当前为纯 API 模式（未找到前端构建产物）。</p>
         <p>健康检查：<a href="/api/health">/api/health</a></p>
         </body>`,
      ),
    );
    return;
  }

  const indexPath = join(root, 'index.html');

  const serveIndex: Handler = (c) => {
    if (!existsSync(indexPath)) return c.text('前端资源缺失', 500);
    const html = readFileSync(indexPath, 'utf8');
    c.header('Cache-Control', 'no-store');
    return c.html(injectRuntimeConfig(html, cfg));
  };

  // 入口页必须先于静态中间件注册：否则 serveStatic 会把 index.html 原样吐出去，
  // 里面就没有注入的本地令牌，前端所有 API 调用都会被 401 拦掉。
  app.get('/', serveIndex);
  app.get('/index.html', serveIndex);

  app.use(
    '/*',
    serveStatic({
      root,
      rewriteRequestPath: (path) => (path === '/' ? '/__no_such_index__' : path),
    }),
  );

  // SPA 兜底：非静态资源路径统一返回 index.html，并把本地令牌注入页面。
  app.get('*', serveIndex);
}

function injectRuntimeConfig(html: string, cfg: ServerConfig): string {
  const runtime = `<script>window.__FEEDFUSE__=${JSON.stringify({
    token: cfg.token,
    version: APP_VERSION,
    apiBase: '',
  })};</script>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${runtime}</head>`)
    : `${runtime}${html}`;
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export { AppError, getDb };
