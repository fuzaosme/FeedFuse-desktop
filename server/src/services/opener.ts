import { spawn } from 'node:child_process';
import { AppError, ValidationError } from '../http/envelope';
import { errorMessage } from '../lib/utils';

/** URL 长度上限：浏览器与系统命令行的现实阈值都在这个量级之上，超出基本是异常输入。 */
const MAX_URL_LENGTH = 2048;

/** 同一 URL 的去重窗口：双击 / 连点两下只应该弹出一个浏览器窗口。 */
const DEDUP_WINDOW_MS = 500;

/**
 * C0/C1 控制字符（含 \r \n \0）。
 * Windows 的 cmd 会把换行当成命令分隔，其它平台也可能被参数解析吃掉，
 * 与其逐平台做转义，不如直接拒绝。
 */
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

/** url → 最近一次打开的时间戳，只保留很短的时间窗，不会成为内存负担。 */
const recentOpen = new Map<string, number>();

/**
 * 用系统默认浏览器打开外链。
 *
 * 为什么不让 WebView 自己开：桌面版没有装 tauri-plugin-opener，
 * `target="_blank"` 在 WKWebView 里点了毫无反应；由 sidecar 代为调起系统命令，
 * 就不用为了一个功能去动 capability 和插件依赖。
 */
export async function openExternalUrl(rawUrl: string): Promise<void> {
  const url = normalizeExternalUrl(rawUrl);

  const now = Date.now();
  const last = recentOpen.get(url);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return;
  remember(url, now);

  const { command, args } = buildCommand(url);
  await spawnDetached(command, args);
}

/** 校验并归一化 URL：只放行 http/https，其余一律当作非法参数。 */
function normalizeExternalUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url) throw new ValidationError('缺少要打开的链接', { url: 'required' });
  if (url.length > MAX_URL_LENGTH) {
    throw new ValidationError(`链接过长（最多 ${MAX_URL_LENGTH} 个字符）`, { url: 'too_long' });
  }
  if (CONTROL_CHAR.test(url)) throw new ValidationError('链接包含非法字符', { url: 'invalid' });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('链接格式不正确', { url: 'invalid' });
  }
  // 只允许 web 协议：file:// 会打开本地文件，javascript:/data: 更是直接在别处执行脚本。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('只能打开 http 或 https 链接', { url: 'unsupported_protocol' });
  }

  // 返回归一化后的字符串，去重用的 key 也就统一了（大小写、默认端口等差异会被抹平）。
  return parsed.toString();
}

function buildCommand(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `start` 的第一个带引号参数是窗口标题，必须显式给空串，
      // 否则 URL 会被当成标题吞掉，浏览器窗口根本不会出现。
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    case 'linux':
      return { command: 'xdg-open', args: [url] };
    default:
      throw new AppError('open_failed', `当前系统（${process.platform}）暂不支持打开外部链接`, 500);
  }
}

/**
 * 用 spawn 而不是 exec：exec 会经过 shell，URL 里的 & | ; 会被当成命令分隔符，
 * 等于把用户可控字符串直接拼进命令行。spawn 传数组参数，不经过 shell。
 */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });

    child.once('error', (err) => {
      reject(new AppError('open_failed', `无法调起系统浏览器：${errorMessage(err)}`, 500));
    });
    child.once('spawn', () => {
      // 浏览器是长驻进程，不能等它退出；unref 让 sidecar 与之解绑，
      // 这样应用关闭时不会把已经打开的浏览器窗口一起带走。
      child.unref();
      resolve();
    });
  });
}

function remember(url: string, now: number): void {
  // 长时间运行的 sidecar 会累积很多 key，窗口过期后就顺手清掉。
  if (recentOpen.size >= 64) {
    for (const [key, ts] of recentOpen) {
      if (now - ts >= DEDUP_WINDOW_MS) recentOpen.delete(key);
    }
  }
  recentOpen.set(url, now);
}
