import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { loadConfig, setActiveConfig, APP_VERSION } from './config';
import { openDb } from './db/sqlite';
import { createApp } from './http/app';
import { failStaleSummarySessions, clearPendingFilterStatus } from './domain/articles';
import { writeLog } from './domain/logs';
import { BUILTIN_SOURCES } from './domain/builtinDictionary';
import { configureDictionaryStorage } from './domain/dict/storage';
import { closeAllDictionaryReaders } from './domain/dict/readers';
import { startScheduler, stopScheduler } from './services/scheduler';

const READY_PREFIX = '[feedfuse-ready]';

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(APP_VERSION);
    return;
  }

  const cfg = loadConfig();
  setActiveConfig(cfg);
  // 文件型词典（MDX / StarDict）的原文件副本统一放在数据目录下，便于整体备份与删除。
  configureDictionaryStorage(join(cfg.dataDir, 'dictionaries'));
  openDb(cfg.dbPath);
  // 上次进程留下的「进行中」状态都要收尾：摘要会话标失败，过滤任务放回可见。
  // 两者都是内存任务的残影，不清理就会在界面上变成永远转不完的圈。
  failStaleSummarySessions();
  // 内置词典是查词主路径。WordNet 按首字母分片，这里只读一次索引核对文件是否齐全，
  // 真正解析发生在第一次查到该首字母的时候。
  try {
    const detail = BUILTIN_SOURCES.map((source) => `${source.name} ${source.entryCount()} 条`).join(' · ');
    console.log(`[feedfuse] 内置词典就绪：${detail}`);
  } catch (err) {
    console.error('[feedfuse] 内置核心词库载入失败（查词将只使用导入词典）', err);
  }
  const pendingFilters = clearPendingFilterStatus();
  if (pendingFilters > 0) {
    console.log(`[feedfuse] 清理残留的过滤任务：${pendingFilters} 篇`);
  }

  const app = createApp(cfg);

  const server = serve(
    {
      fetch: app.fetch,
      hostname: cfg.host,
      port: cfg.port,
    },
    (info: AddressInfo) => {
      const baseUrl = `http://${cfg.host}:${info.port}`;
      // Tauri 通过这一行拿到真实端口与令牌，然后加载同源地址。
      console.log(
        `${READY_PREFIX} ${JSON.stringify({
          port: info.port,
          token: cfg.token,
          baseUrl,
          dbPath: cfg.dbPath,
          version: APP_VERSION,
        })}`,
      );
      writeLog({
        level: 'info',
        category: 'settings',
        message: '本地服务已启动',
        source: 'main',
        context: { port: info.port, dbPath: cfg.dbPath, version: APP_VERSION },
      });
      startScheduler(cfg);
    },
  );

  const shutdown = (signal: string) => {
    console.log(`[feedfuse] shutting down (${signal})`);
    stopScheduler();
    // 释放词典打开的文件句柄，Windows 上不关会拦住卸载/覆盖。
    closeAllDictionaryReaders();
    server.close(() => process.exit(0));
    // 兜底：5 秒内没退干净就强退，避免残留进程占端口。
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[feedfuse] uncaught exception', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[feedfuse] unhandled rejection', reason);
  });
}

main().catch((err) => {
  console.error('[feedfuse] failed to start', err);
  process.exit(1);
});
