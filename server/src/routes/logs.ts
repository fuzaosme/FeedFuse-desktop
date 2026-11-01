import { Hono } from 'hono';
import { ok } from '../http/envelope';
import { clearLogs, listLogs, type LogLevel } from '../domain/logs';

export function logsRoutes() {
  const app = new Hono();

  app.get('/', (c) => {
    const url = new URL(c.req.url);
    const rawLevel = url.searchParams.get('level');
    const level: LogLevel | 'all' =
      rawLevel === 'info' || rawLevel === 'warning' || rawLevel === 'error' ? rawLevel : 'all';
    return ok(
      c,
      listLogs({
        page: Number(url.searchParams.get('page') ?? 1),
        pageSize: Number(url.searchParams.get('pageSize') ?? 50),
        level,
      }),
    );
  });

  app.delete('/', (c) => {
    clearLogs();
    return ok(c, { cleared: true });
  });

  return app;
}
