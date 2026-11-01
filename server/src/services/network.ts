import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvHttpProxyAgent } from 'undici';

const execFileAsync = promisify(execFile);
export interface ProxyConfig { httpProxy: string; httpsProxy: string; noProxy: string }

/** Finder 启动的应用没有 shell 环境变量，需要主动读取 macOS 系统代理。 */
export function parseSystemProxy(output: string): ProxyConfig {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(output)?.[1]?.trim();
  const proxy = (prefix: string) => {
    const host = value(`${prefix}Proxy`);
    const port = Number(value(`${prefix}Port`));
    if (value(`${prefix}Enable`) !== '1' || !host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  };
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/m.exec(output)?.[1] ?? '';
  const noProxy = [...exceptions.matchAll(/^\s*\d+\s*:\s*(\S+)/gm)]
    .map((match) => match[1]).filter((host) => host !== '<local>' && !host.includes('/')).join(',');
  return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS'), noProxy };
}

export function resolveProxyConfig(env: NodeJS.ProcessEnv, system: ProxyConfig): ProxyConfig {
  const http = env.http_proxy ?? env.HTTP_PROXY;
  const https = env.https_proxy ?? env.HTTPS_PROXY;
  // 显式环境配置作为一整套配置优先，避免 HTTPS-only 配置意外混入系统 HTTP 代理。
  const explicit = http !== undefined || https !== undefined;
  return {
    httpProxy: explicit ? (http ?? '') : system.httpProxy,
    httpsProxy: explicit ? (https ?? http ?? '') : system.httpsProxy,
    noProxy: (env.no_proxy ?? env.NO_PROXY ?? system.noProxy).trim() === '*' ? '*' :
      ['localhost', '127.0.0.1', '[::1]', env.no_proxy ?? env.NO_PROXY ?? system.noProxy].filter(Boolean).join(','),
  };
}

let cached: { key: string; agent: EnvHttpProxyAgent } | undefined;
let system: ProxyConfig = { httpProxy: '', httpsProxy: '', noProxy: '' };
let checkedAt = 0;
let checking: Promise<void> | undefined;
async function dispatcher() {
  if (process.platform === 'darwin' && Date.now() - checkedAt > 30_000) {
    checking ??= execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 64 * 1024 })
      .then(({ stdout }) => { system = parseSystemProxy(stdout); })
      .catch(() => { /* 系统查询失败时保留上一份配置 */ })
      .finally(() => { checkedAt = Date.now(); checking = undefined; });
    await checking;
  }
  const config = resolveProxyConfig(process.env, system);
  const key = JSON.stringify(config);
  if (cached?.key !== key) {
    const agent = new EnvHttpProxyAgent(config);
    const previous = cached;
    cached = { key, agent };
    // close 等待在途请求完成，不中断正文下载或 AI 流。
    void previous?.agent.close().catch(() => undefined);
  }
  return cached!.agent;
}

/** 所有外部请求共用代理策略；30 秒内跟随系统代理切换，回环始终直连。 */
export async function networkFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const agent = await dispatcher();
  return fetch(input, { ...init, dispatcher: agent } as RequestInit);
}

/** 按实际解压后的字节数限流，不能只信 Content-Length。 */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) throw new Error('响应内容过大，已停止下载');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
