import type { ApiEnvelope } from './types';

declare global {
  interface Window {
    __FEEDFUSE__?: { token?: string; version?: string; apiBase?: string };
    __TAURI_INTERNALS__?: unknown;
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(message: string, code: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

function runtimeToken(): string {
  return window.__FEEDFUSE__?.token ?? '';
}

function baseUrl(): string {
  return window.__FEEDFUSE__?.apiBase ?? '';
}

function authHeaders(): Record<string, string> {
  const token = runtimeToken();
  return token ? { 'x-feedfuse-token': token } : {};
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** 需要原样返回（比如 OPML 文件下载）时置为 true。 */
  raw?: boolean;
  /**
   * 覆盖默认超时。抓全文、校验订阅、首次抓取这类要等远端的接口必须放宽，
   * 否则前端会先超时，把一个其实会成功的请求掐掉。
   */
  timeoutMs?: number;
}

/**
 * 默认请求超时。sidecar 假死（端口还在但不再响应）时，没有超时的 fetch 会一直挂着，
 * 启动流程就永远停不住，用户只能看到无限转圈的启动页。
 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface ComposedSignal {
  signal: AbortSignal;
  /** 是否是「等超时了」而不是调用方主动取消——只有前者才该报超时错误。 */
  timedOut: () => boolean;
  dispose: () => void;
}

/** 把调用方给的 signal 和超时 signal 合成一个；优先用 AbortSignal.any，老引擎退回手动控制器。 */
function composeSignal(signal: AbortSignal | undefined, timeoutMs = DEFAULT_TIMEOUT_MS): ComposedSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return { signal: timeout, timedOut: () => timeout.aborted, dispose: () => {} };
  }

  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anySignal === 'function') {
    return { signal: anySignal([signal, timeout]), timedOut: () => timeout.aborted, dispose: () => {} };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  const onTimeout = () => controller.abort(timeout.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  if (timeout.aborted) controller.abort(timeout.reason);
  else timeout.addEventListener('abort', onTimeout, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timeout.aborted,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
      timeout.removeEventListener('abort', onTimeout);
    },
  };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, raw, timeoutMs } = options;
  const composed = composeSignal(signal, timeoutMs);

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      signal: composed.signal,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...authHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (raw) {
      if (!response.ok) throw new ApiError('请求失败', 'request_failed', response.status);
      return (await response.text()) as unknown as T;
    }

    let payload: ApiEnvelope<T> | null = null;
    try {
      payload = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new ApiError(
        response.status === 401 ? '本地访问令牌无效，请重启应用' : '服务返回了无法解析的数据',
        'invalid_response',
        response.status,
      );
    }

    if (!response.ok || !payload.ok) {
      throw new ApiError(
        payload.error?.message ?? '请求失败',
        payload.error?.code ?? 'request_failed',
        response.status,
        payload.error?.fields,
      );
    }

    return payload.data as T;
  } catch (err) {
    // 超时中止同样表现为 AbortError，必须先按超时判定，否则会和「用户主动取消」混在一起。
    if (composed.timedOut()) throw new ApiError('本地服务无响应，请重启应用', 'timeout', 0);
    throw err;
  } finally {
    composed.dispose();
  }
}

export interface SseHandlers {
  onEvent: (event: string, data: unknown) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

/** 手动解析 SSE：需要同时处理 event 名与增量 data，用原生 fetch 最可控。 */
export async function streamRequest(
  path: string,
  body: unknown,
  handlers: SseHandlers,
  method: 'POST' | 'GET' = 'POST',
): Promise<void> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    signal: handlers.signal,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      accept: 'text/event-stream',
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // 保留默认文案
    }
    throw new ApiError(message, 'stream_failed', response.status);
  }

  // 200 但返回 HTML：多半是 sidecar 已经挂了，请求被 SPA 兜底接走。
  // 不在这里拦住，读流只会拿到一坨 HTML，界面表现为「摘要一直不出现」。
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    throw new ApiError('本地服务返回了非流式响应，请重启应用', 'stream_content_type', response.status);
  }

  if (!response.body) throw new ApiError('流式响应不可用', 'stream_unsupported', 500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** 分派一个事件块；handler 自己抛错时交给 onError，别让一条坏事件掐断整条流。 */
  const dispatch = (rawEvent: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;

    const raw = dataLines.join('\n');
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 保留原始字符串
    }
    try {
      handlers.onEvent(eventName, parsed);
    } catch (err) {
      if (handlers.onError) handlers.onError(err as Error);
      else throw err;
    }
  };

  /** CRLF 也要能切事件；末尾孤立的 \r 可能是被切断的 \r\n，先留着等下一片数据。 */
  const append = (chunk: string) => {
    buffer += chunk;
    const tail = buffer.endsWith('\r') ? '\r' : '';
    const head = tail ? buffer.slice(0, -1) : buffer;
    buffer = head.replace(/\r\n?/g, '\n') + tail;
  };

  /** 把缓冲区里所有完整事件块取出来执行，剩半个的留在 buffer 里等下一片。 */
  const drain = () => {
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      dispatch(rawEvent);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
      drain();
    }
    // 流结束时最后一段通常没有空行收尾，flush 掉，否则 done 事件会被静默丢弃。
    append(decoder.decode());
    buffer = (buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
    drain();
    if (buffer.trim()) dispatch(buffer);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    if (handlers.onError) {
      handlers.onError(err as Error);
      return;
    }
    throw err;
  }
}

export function downloadBlob(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 上传单个文件（词典的 .mdx / .mdd / .idx 等）。
 *
 * 用 XHR 而不是 fetch：fetch 没有上传进度，几十上百兆的词典传起来用户会以为卡死。
 * 请求体直接给 File 对象，浏览器流式读取，不会把整本词典先读成 JS 字符串。
 */
export function uploadFile(
  path: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl()}${path}`);
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.setRequestHeader('content-type', 'application/octet-stream');

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      });
    }

    xhr.addEventListener('load', () => {
      let payload: ApiEnvelope<unknown> | null = null;
      try {
        payload = JSON.parse(xhr.responseText) as ApiEnvelope<unknown>;
      } catch {
        reject(new ApiError('上传失败：服务返回了无法解析的数据', 'invalid_response', xhr.status));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload.ok) {
        resolve();
        return;
      }
      reject(
        new ApiError(
          payload.error?.message ?? '上传失败',
          payload.error?.code ?? 'upload_failed',
          xhr.status,
        ),
      );
    });
    xhr.addEventListener('error', () => reject(new ApiError('上传失败：本地服务无响应', 'network', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('上传已取消', 'aborted', 0)));
    xhr.send(file);
  });
}
