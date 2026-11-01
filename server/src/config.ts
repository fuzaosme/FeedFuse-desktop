import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const APP_NAME = 'FeedFuse';
export const APP_VERSION = '0.6.0';

export function defaultDataDir(): string {
  const app = 'FeedFuse';
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', app);
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), app);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'feedfuse');
  }
}

export interface ServerConfig {
  /** 监听端口；0 表示由系统分配，再通过握手行回传给 Tauri。 */
  port: number;
  host: string;
  /** 本地 API 访问令牌：阻止同机其他进程/网页随意调用本机接口。 */
  token: string;
  dataDir: string;
  dbPath: string;
  /** 前端静态资源目录（web/dist）；缺省时说明是纯 API 模式。 */
  staticDir: string | null;
  userAgent: string;
  requestTimeoutMs: number;
  imageProxySecret: string;
}

export function loadConfig(): ServerConfig {
  const dataDir = process.env.FEEDFUSE_DATA_DIR?.trim() || defaultDataDir();
  const port = Number.parseInt(process.env.FEEDFUSE_PORT ?? '0', 10);
  const staticDir = process.env.FEEDFUSE_STATIC_DIR?.trim() || null;

  return {
    port: Number.isFinite(port) ? port : 0,
    host: '127.0.0.1',
    token: process.env.FEEDFUSE_TOKEN?.trim() || randomUUID(),
    dataDir,
    dbPath: process.env.FEEDFUSE_DB_PATH?.trim() || join(dataDir, 'feedfuse.db'),
    staticDir,
    userAgent: process.env.FEEDFUSE_USER_AGENT?.trim() || `FeedFuse/${APP_VERSION} (+desktop)`,
    requestTimeoutMs: Number.parseInt(process.env.FEEDFUSE_REQUEST_TIMEOUT_MS ?? '15000', 10),
    imageProxySecret: process.env.FEEDFUSE_IMAGE_SECRET?.trim() || randomUUID(),
  };
}

/**
 * 全局配置单例。
 *
 * 大多数领域模块（订阅、文章、媒体）都由路由把 cfg 传进来，不需要单例；
 * 但词典的「查词」是纯领域调用，还要在构造资源 URL 时拿到本地访问令牌，
 * 传一遍 cfg 会污染所有调用点，所以在这里留一个只读入口。
 */
let activeConfig: ServerConfig | null = null;

export function setActiveConfig(cfg: ServerConfig): void {
  activeConfig = cfg;
}

export function getActiveConfig(): ServerConfig | null {
  return activeConfig;
}
