import { networkFetch, readLimitedBody } from './network';
import Parser from 'rss-parser';
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
import { sanitizeContentHtml } from './sanitize';
import { buildSummaryText } from './sanitize';
import { firstImageUrl, htmlToText, resolveUrl, truncate, toIso } from '../lib/utils';

export interface ParsedItem {
  dedupeKey: string;
  title: string;
  link: string | null;
  author: string | null;
  publishedAt: string | null;
  contentHtml: string;
  summary: string;
  previewImage: string | null;
  sourceLanguage: string | null;
  /** 条目自带的音视频类型（enclosure / media:content），判定播客订阅用。 */
  mediaType: MediaType | null;
}

export type MediaType = 'audio' | 'video';

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  iconUrl: string | null;
  description: string | null;
  items: ParsedItem[];
}

const parser = new Parser({
  timeout: 20_000,
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['dc:creator', 'dcCreator'],
      ['itunes:image', 'itunesImage'],
    ],
  },
});

function detectCharset(contentType: string | null, buffer: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromXml = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  if (fromXml) return fromXml.toLowerCase();
  // 少数源站直接吐 UTF-16（带 BOM），不认 BOM 会整篇乱码。
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

function stripBom(text: string): string {
  // BOM 留在开头会让 XML 解析器把根节点识别错，顺手去掉。
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeBody(buffer: Buffer, contentType: string | null): string {
  const charset = detectCharset(contentType, buffer);
  if (charset === 'utf-8' || charset === 'utf8') return stripBom(buffer.toString('utf8'));
  try {
    return stripBom(iconv.decode(buffer, charset));
  } catch {
    return stripBom(buffer.toString('utf8'));
  }
}

export interface FetchFeedResult {
  status: number;
  notModified: boolean;
  xml: string | null;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  error: string | null;
}

/** 源站偶发抖动很常见，给一次 500ms 后的重试就够；再多会把一次刷新拖成几十秒。 */
const FETCH_RETRY_DELAY_MS = 500;

interface FetchAttempt {
  result: FetchFeedResult;
  /** 只有网络错误/超时/5xx 值得重试；429 是限流，立刻重试只会更糟。 */
  retryable: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptFetch(
  url: string,
  options: { etag?: string | null; lastModified?: string | null; userAgent: string; timeoutMs: number },
): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (options.etag) headers['if-none-match'] = options.etag;
  if (options.lastModified) headers['if-modified-since'] = options.lastModified;

  try {
    const response = await networkFetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    if (response.status === 304) {
      return {
        retryable: false,
        result: {
          status: 304,
          notModified: true,
          xml: null,
          etag: options.etag ?? null,
          lastModified: options.lastModified ?? null,
          finalUrl: url,
          error: null,
        },
      };
    }

    if (!response.ok) {
      // 非 2xx 的 body 没用，及时释放以免连接挂着不回收。
      void response.body?.cancel().catch(() => undefined);
      return {
        retryable: response.status >= 500,
        result: {
          status: response.status,
          notModified: false,
          xml: null,
          etag: null,
          lastModified: null,
          finalUrl: response.url || url,
          error: describeHttpStatus(response.status),
        },
      };
    }

    const buffer = await readLimitedBody(response, 8 * 1024 * 1024);
    return {
      retryable: false,
      result: {
        status: response.status,
        notModified: false,
        xml: decodeBody(buffer, response.headers.get('content-type')),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        finalUrl: response.url || url,
        error: null,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      retryable: true,
      result: {
        status: 0,
        notModified: false,
        xml: null,
        etag: null,
        lastModified: null,
        finalUrl: url,
        error: /abort|timeout/i.test(reason) ? '请求超时，请检查订阅地址或网络' : `无法访问订阅地址：${reason}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFeedXml(
  url: string,
  options: { etag?: string | null; lastModified?: string | null; userAgent: string; timeoutMs: number },
): Promise<FetchFeedResult> {
  const first = await attemptFetch(url, options);
  if (!first.retryable) return first.result;

  await delay(FETCH_RETRY_DELAY_MS);
  const second = await attemptFetch(url, options);
  return second.result;
}

function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) return `源站拒绝了访问（HTTP ${status}），可能需要登录或已被反爬拦截`;
  if (status === 404) return '订阅地址不存在（HTTP 404）';
  // 429 不在自动重试范围内，文案就不能再承诺「稍后会自动重试」。
  if (status === 429) return '源站限流（HTTP 429），请稍后手动刷新或调大该订阅的抓取间隔';
  if (status >= 500) return `源站异常（HTTP ${status}）`;
  return `订阅地址返回 HTTP ${status}`;
}

function extractMediaImage(item: Record<string, unknown>, baseUrl: string | null): string | null {
  const media = item.mediaContent as Array<{ $?: { url?: string; medium?: string } }> | undefined;
  if (Array.isArray(media)) {
    for (const entry of media) {
      const url = entry?.$?.url;
      if (url) return resolveUrl(url, baseUrl);
    }
  }
  const thumbs = item.mediaThumbnail as Array<{ $?: { url?: string } }> | undefined;
  if (Array.isArray(thumbs)) {
    for (const entry of thumbs) {
      const url = entry?.$?.url;
      if (url) return resolveUrl(url, baseUrl);
    }
  }
  const itunes = item.itunesImage as { $?: { href?: string } } | undefined;
  if (itunes?.$?.href) return resolveUrl(itunes.$.href, baseUrl);
  return null;
}

const MEDIA_EXTENSION: Record<string, MediaType> = {
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  wav: 'audio',
  flac: 'audio',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
};

function mediaTypeFromMime(value: unknown): MediaType | null {
  if (typeof value !== 'string') return null;
  const mime = value.trim().toLowerCase();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

function mediaTypeFromUrl(url: string | null | undefined): MediaType | null {
  if (!url) return null;
  const ext = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  return ext ? MEDIA_EXTENSION[ext] ?? null : null;
}

/**
 * 从 enclosure / media:content 里认出音视频。
 * 不少播客源只给 MIME，另一些只给文件后缀，两个都看一遍。
 */
function detectMediaType(item: Record<string, unknown>): { type: MediaType | null; url: string | null } {
  const enclosure = item.enclosure as { url?: string; type?: string } | undefined;
  if (enclosure) {
    const type = mediaTypeFromMime(enclosure.type) ?? mediaTypeFromUrl(enclosure.url);
    if (type) return { type, url: enclosure.url ?? null };
  }

  const media = item.mediaContent as Array<{ $?: { url?: string; type?: string; medium?: string } }> | undefined;
  if (Array.isArray(media)) {
    for (const entry of media) {
      const type =
        mediaTypeFromMime(entry?.$?.type) ??
        mediaTypeFromMime(entry?.$?.medium) ??
        mediaTypeFromUrl(entry?.$?.url);
      if (type) return { type, url: entry?.$?.url ?? null };
    }
  }

  return { type: null, url: null };
}

/**
 * 播客条目如果正文里没有播放器，就把 enclosure 补一个进去。
 * 这样「这条是音视频」这件事能随 content_html 落库，订阅列表判定播客才有据可依，
 * 用户也能直接在阅读器里播放。
 */
function ensureMediaPlayer(
  html: string,
  mediaType: MediaType | null,
  mediaUrl: string | null,
  baseUrl: string,
): string {
  if (!mediaType || !mediaUrl) return html;
  if (/<(audio|video)\b/i.test(html)) return html;

  const src = resolveUrl(mediaUrl, baseUrl);
  if (!src) return html;
  const player =
    mediaType === 'audio'
      ? `<audio controls preload="none" src="${src}"></audio>`
      : `<video controls preload="none" src="${src}"></video>`;
  return player + html;
}

/** 只在繁体/简体里出现的常用字，用来粗判简繁：数量差得足够多才下结论。 */
const TRADITIONAL_MARKERS = /[們個這說時為國會對發學經產與當還進種樣點無臺灣]/g;
const SIMPLIFIED_MARKERS = /[们个这说时为国会对发学经产与当还进种样点无台湾]/g;

/**
 * 语种判定只服务一个目的：决定「要不要送去翻译成中文」。
 *
 * 所以顺序很关键——假名、谚文必须先于汉字判断：日文长文里汉字同样很多，
 * 先判汉字就会把日文当成中文原文，翻译入口直接被挡掉（韩文同理，虽然汉字少）。
 */
function detectLanguage(html: string, title: string): string | null {
  const sample = `${title} ${htmlToText(html).slice(0, 400)}`;

  const kana = (sample.match(/[\u3040-\u30ff]/g) ?? []).length;
  if (kana > 12) return 'ja';
  const hangul = (sample.match(/[\uac00-\ud7af]/g) ?? []).length;
  if (hangul > 12) return 'ko';

  const cjk = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjk > 12) {
    // 繁体源要标成 zh-Hant 才能在翻译链路里走「繁转简」；判错的代价只是多一次
    // 无意义的调用，所以门槛设得保守一些（繁体标记显著多于简体标记才算）。
    const traditional = (sample.match(TRADITIONAL_MARKERS) ?? []).length;
    const simplified = (sample.match(SIMPLIFIED_MARKERS) ?? []).length;
    return traditional > 6 && traditional > simplified * 2 ? 'zh-Hant' : 'zh';
  }

  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (latin > 40) return 'en';
  return null;
}

function buildDedupeKey(item: { link: string | null; title: string; publishedAt: string | null; guid?: string }): string {
  const basis = item.guid || item.link || `${item.title}|${item.publishedAt ?? ''}`;
  return createHash('sha1').update(basis).digest('hex');
}

/** 解析 RSS/Atom：统一产出正文 HTML、摘要、封面图与去重键。 */
export async function parseFeedXml(xml: string, feedUrl: string): Promise<ParsedFeed> {
  let parsed: unknown;
  try {
    parsed = await parser.parseString(xml);
  } catch {
    // 结构不规范（缺 channel、命名空间混乱等）时退回正则提取，保证还能入库。
    parsed = parseWithFallbackSync(xml);
  }

  const feed = parsed as unknown as {
    title?: string;
    link?: string;
    description?: string;
    image?: { url?: string };
    itunesImage?: { $?: { href?: string } };
    items?: Array<Record<string, unknown> & {
      title?: string;
      link?: string;
      guid?: string;
      isoDate?: string;
      pubDate?: string;
      creator?: string;
      author?: string;
      content?: string;
      contentSnippet?: string;
      contentEncoded?: string;
      summary?: string;
      dcCreator?: string;
    }>;
  };

  const siteUrl = feed.link ? resolveUrl(feed.link, feedUrl) : null;
  const iconUrl =
    resolveUrl(feed.image?.url ?? '', feedUrl) ??
    resolveUrl(feed.itunesImage?.$?.href ?? '', feedUrl) ??
    null;

  const items: ParsedItem[] = [];
  for (const item of feed.items ?? []) {
    const link = item.link ? resolveUrl(item.link, feedUrl) : null;
    const rawHtml =
      (item.contentEncoded as string | undefined) ??
      (item.content as string | undefined) ??
      (item.summary as string | undefined) ??
      (item.contentSnippet as string | undefined) ??
      '';
    if (!rawHtml && !item.title) continue;

    const media = detectMediaType(item);
    // 播放器先插再净化：走一遍 sanitize 的标签/协议白名单，避免直接信任源站给的地址。
    const contentHtml = sanitizeContentHtml(
      ensureMediaPlayer(rawHtml, media.type, media.url, link ?? feedUrl),
    );
    const publishedAt = toIso(item.isoDate ?? item.pubDate);
    const title = truncate(htmlToText(item.title ?? '(无标题)'), 300);
    const previewImage =
      firstImageUrl(contentHtml, link ?? feedUrl) ?? extractMediaImage(item, link ?? feedUrl);

    items.push({
      dedupeKey: buildDedupeKey({ link, title, publishedAt, guid: item.guid }),
      title,
      link,
      author: (item.dcCreator as string | undefined) ?? item.creator ?? item.author ?? null,
      publishedAt,
      contentHtml,
      summary: buildSummaryText(contentHtml),
      previewImage,
      sourceLanguage: detectLanguage(contentHtml, title),
      mediaType: media.type,
    });
  }

  return {
    title: feed.title?.trim() || new URL(feedUrl).hostname,
    siteUrl,
    iconUrl,
    description: feed.description ?? null,
    items,
  };
}

/** rss-parser 的 parseString 是回调式 API，这里用同步 XML 提取兜底。 */
function parseWithFallbackSync(xml: string): unknown {
  const items: Array<Record<string, unknown>> = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];

  const pick = (block: string, tag: string): string | null => {
    const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(block);
    if (cdata?.[1]) return cdata[1].trim();
    const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return plain?.[1]?.trim() ?? null;
  };

  for (const block of itemBlocks) {
    const linkHref = /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ?? null;
    // 兜底路径也要认出 enclosure，否则播客源在解析失败时会被当成普通订阅。
    const enclosureTag = /<enclosure\b[^>]*>/i.exec(block)?.[0] ?? '';
    items.push({
      title: pick(block, 'title') ?? undefined,
      link: pick(block, 'link') ?? linkHref ?? undefined,
      guid: pick(block, 'guid') ?? pick(block, 'id') ?? undefined,
      pubDate: pick(block, 'pubDate') ?? pick(block, 'published') ?? pick(block, 'updated') ?? undefined,
      content: pick(block, 'content:encoded') ?? pick(block, 'content') ?? pick(block, 'description') ?? undefined,
      creator: pick(block, 'dc:creator') ?? pick(block, 'author') ?? undefined,
      enclosure: enclosureTag
        ? {
            url: /\burl=["']([^"']+)["']/i.exec(enclosureTag)?.[1],
            type: /\btype=["']([^"']+)["']/i.exec(enclosureTag)?.[1],
          }
        : undefined,
    });
  }

  return {
    title: pick(xml, 'title') ?? undefined,
    link: pick(xml, 'link') ?? undefined,
    description: pick(xml, 'description') ?? undefined,
    items,
  };
}
