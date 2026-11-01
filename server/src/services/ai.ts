import { networkFetch } from './network';
import type { AiRuntimeConfig } from '../domain/settings';
import { writeLog } from '../domain/logs';
import { errorMessage } from '../lib/utils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 有些兼容网关不支持 stream，允许调用方显式退回一次性返回。 */
  timeoutMs?: number;
  /** 429 / 5xx 的最大重试次数，默认 2；批量场景不想等可以传 0。 */
  retries?: number;
}

export class AiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

const DEFAULT_RETRIES = 2;
/** 指数退避：第 1 次重试等 1s，第 2 次等 3s；上游给了 retry-after 就用它。 */
const RETRY_BACKOFF_MS = [1_000, 3_000];
/** retry-after 上限：等太久不如直接把错误抛给用户。 */
const MAX_RETRY_AFTER_MS = 10_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** retry-after 既可能是秒数，也可能是 HTTP 日期，统一折算成毫秒并封顶。 */
function readRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1_000));
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
  return null;
}

/** 可被 AbortSignal 打断的等待：用户取消时立刻放弃，不再发下一次请求。 */
function waitBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiError('请求已取消'));
    };
    if (signal?.aborted) {
      reject(new AiError('请求已取消'));
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildBody(cfg: AiRuntimeConfig, messages: ChatMessage[], stream: boolean, options: ChatOptions) {
  return {
    model: cfg.model,
    messages,
    stream,
    temperature: options.temperature ?? 0.3,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
  };
}

/**
 * 一次已经发出去、但 body 还没读完的请求。
 *
 * 超时定时器与外部取消监听必须活到 body 读完为止——只在 `fetch` 返回响应头时清理，
 * 上游「先回 200 再挂起」就能让 SSE 永远不结束、`response.text()` 永不超时，
 * 摘要会话卡在 running，AI 过滤队列的并发槽也永远不释放。
 */
interface ChatFetch {
  response: Response;
  /** 读完 body 后必须调用；可重复调用。 */
  dispose: () => void;
  /** 是否由内部超时触发中断（区别于用户主动取消）。 */
  timedOut: () => boolean;
}

/** 单次请求：只负责发出去并校验状态码，不关心重试。 */
async function requestChat(
  cfg: AiRuntimeConfig,
  messages: ChatMessage[],
  stream: boolean,
  options: ChatOptions,
): Promise<ChatFetch> {
  const url = `${cfg.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  };

  try {
    const response = await networkFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(buildBody(cfg, messages, stream, options)),
      signal: controller.signal,
    });
    return { response, dispose, timedOut: () => timedOut };
  } catch (err) {
    dispose();
    if (options.signal?.aborted) throw new AiError('请求已取消');
    if (timedOut) throw new AiError('AI 服务响应超时，请检查网络或服务地址');
    throw new AiError(`无法连接 AI 服务：${errorMessage(err)}`);
  }
}

/**
 * 发请求并处理失败：只对 429 / 5xx 做轻量重试。
 * 超时与网络错误不重试——它们通常要等满 timeout，再乘几倍只会让界面更久没有反馈。
 */
async function callChat(
  cfg: AiRuntimeConfig,
  messages: ChatMessage[],
  stream: boolean,
  options: ChatOptions,
): Promise<ChatFetch> {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw new AiError('请求已取消');

    const chat = await requestChat(cfg, messages, stream, options);
    if (chat.response.ok) return chat;

    const status = chat.response.status;
    const retryAfter = readRetryAfterMs(chat.response);
    // 先把错误体读出来再释放资源：读 body 同样受超时保护。
    const detail = extractErrorMessage(await chat.response.text().catch(() => '')) || chat.response.statusText;
    chat.dispose();

    if (!isRetryableStatus(status) || attempt >= retries) {
      throw new AiError(describeStatus(status, detail), status);
    }

    const delay = retryAfter ?? RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
    writeLog({
      level: 'warning',
      category: 'external_api',
      message: 'AI 服务临时不可用，正在重试',
      source: 'services/ai',
      details: describeStatus(status, detail),
      context: { status, attempt: attempt + 1, maxRetries: retries, delayMs: delay, model: cfg.model },
    });
    await waitBeforeRetry(delay, options.signal);
  }
}

/** 读 body 阶段的异常统一翻译成人话，避免把 AbortError 直接抛给用户。 */
function readFailure(chat: ChatFetch, err: unknown, options: ChatOptions): AiError {
  if (options.signal?.aborted) return new AiError('请求已取消');
  if (chat.timedOut()) return new AiError('AI 服务响应超时，请检查网络或服务地址');
  if (err instanceof AiError) return err;
  const message = errorMessage(err);
  if (/abort/i.test(message) || /terminated/i.test(message)) {
    return new AiError('AI 服务提前断开了连接，请稍后重试');
  }
  return new AiError(`读取 AI 响应失败：${message}`);
}

function describeStatus(status: number, detail: string): string {
  const suffix = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) return `API Key 无效或无权限${suffix}`;
  if (status === 404) return `接口地址不存在，请检查 Base URL 是否包含 /v1${suffix}`;
  if (status === 429) return `请求过于频繁或额度不足${suffix}`;
  if (status >= 500) return `AI 服务异常（${status}）${suffix}`;
  return `AI 请求失败（${status}）${suffix}`;
}

function extractErrorMessage(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
      return parsed.error.message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // 非 JSON 错误体，直接截断原文
  }
  return text.slice(0, 300);
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: unknown; reasoning_content?: unknown };
    message?: { content?: unknown };
    finish_reason?: unknown;
  }>;
}

function extractDelta(chunk: StreamChunk): string {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta?.content;
  if (typeof delta === 'string') return delta;
  const messageContent = choice?.message?.content;
  return typeof messageContent === 'string' ? messageContent : '';
}

/** 逐 token 产出模型输出；reasoning_content 属于思维链，必须丢弃。 */
export async function* chatStream(
  cfg: AiRuntimeConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const chat = await callChat(cfg, messages, true, options);
  const { response } = chat;

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('event-stream') || !response.body) {
      // 网关忽略了 stream=true，退回一次性解析。
      const text = await response.text();
      yield parseNonStreamBody(text) ?? text;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 网关用 CRLF 分帧（规范允许）时，只找 '\n\n' 会一个事件都切不出来。
      // 这样做是安全的：跨 chunk 被切断的 '\r' 会在下一次拼上 '\n' 后再被替换。
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const delta of parseSseEvent(rawEvent)) yield delta;
      }
    }

    // 上游收尾不规范（最后一帧没有空行结尾）时，缓冲区里还留着完整数据，不能丢。
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      for (const delta of parseSseEvent(tail)) yield delta;
    }
  } catch (err) {
    throw readFailure(chat, err, options);
  } finally {
    chat.dispose();
  }
}

/** 解析一个 SSE 事件块：按规范把多行 data 拼起来，忽略注释与心跳。 */
function parseSseEvent(rawEvent: string): string[] {
  const dataLines: string[] = [];
  for (const line of rawEvent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    dataLines.push(data);
  }
  if (dataLines.length === 0) return [];

  const payload = dataLines.join('\n');
  try {
    const parsed = JSON.parse(payload) as StreamChunk;
    const delta = extractDelta(parsed);
    return delta ? [delta] : [];
  } catch {
    // 不是 JSON 的 data（少数网关直接吐纯文本）就原样当增量返回。
    return /^[[{]/.test(payload) ? [] : [payload];
  }
}

function parseNonStreamBody(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as StreamChunk;
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content ?? choice?.delta?.content;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

export async function chatComplete(
  cfg: AiRuntimeConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const chat = await callChat(cfg, messages, false, options);
  try {
    const text = await chat.response.text();
    const parsed = parseNonStreamBody(text);
    if (parsed === null) throw new AiError('AI 返回了无法解析的内容');
    return parsed;
  } catch (err) {
    throw readFailure(chat, err, options);
  } finally {
    chat.dispose();
  }
}

/** 把模型输出里可能出现的 ```json 围栏剥掉，再取第一个 JSON 值。 */
export function extractJson<T>(text: string): T | null {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
