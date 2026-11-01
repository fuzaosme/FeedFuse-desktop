export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** 去掉 HTML 标签，压平空白，用于摘要和 AI 输入。 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 从 HTML 中抓第一个可用图片，作为列表缩略图。 */
export function firstImageUrl(html: string | null | undefined, baseUrl?: string | null): string | null {
  if (!html) return null;
  const match = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"'>]+)["']/i);
  if (!match?.[1]) return null;
  return resolveUrl(match[1], baseUrl);
}

export function resolveUrl(href: string, baseUrl?: string | null): string | null {
  const raw = href.trim();
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl ?? undefined).toString();
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 极简并发池：本地抓取时限制同时打开的连接数，避免一次刷新打满网络。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
