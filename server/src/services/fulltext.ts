import { networkFetch, readLimitedBody } from './network';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import iconv from 'iconv-lite';
import type { ServerConfig } from '../config';
import { sanitizeContentHtml } from './sanitize';
import { absolutize } from './imageProxy';

export interface FulltextResult {
  html: string;
  title: string | null;
  excerpt: string | null;
  siteName: string | null;
  wordCount: number;
}

function decode(buffer: Buffer, contentType: string | null): string {
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase() ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(buffer.subarray(0, 4096).toString('latin1'))?.[1]?.toLowerCase() ??
    'utf-8';
  if (charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8');
  try {
    return iconv.decode(buffer, charset);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * 正文抓取：Readability 负责找到主体内容块，之后统一净化并把图片转成绝对地址。
 * 抓不到或结果明显过短时返回 null，让调用方保留原始 RSS 正文。
 */
export async function extractFulltext(
  url: string,
  cfg: ServerConfig,
): Promise<FulltextResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let html: string;
  let finalUrl = url;
  try {
    const response = await networkFetch(url, {
      headers: {
        'user-agent': cfg.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`源站返回 HTTP ${response.status}`);
    }
    const type = response.headers.get('content-type');
    if (type && !/html|xml|text\/plain/i.test(type)) {
      await response.body?.cancel();
      throw new Error('原文链接返回的不是网页');
    }
    finalUrl = response.url || url;
    html = decode(await readLimitedBody(response, 8 * 1024 * 1024), response.headers.get('content-type'));
  } catch (err) {
    const message = controller.signal.aborted ? '请求超时，请检查网络和代理' :
      err instanceof Error ? err.message : String(err);
    throw new Error(`正文抓取失败：${message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {
    /* 页面里的脚本错误与正文无关，静默忽略 */
  });

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: finalUrl, virtualConsole, runScripts: undefined });
  } catch {
    return null;
  }

  try {
    const document = dom.window.document;
    // 在 Readability 丢弃 data-* 属性前恢复懒加载图片，并按最终页面/base 地址解析相对链接。
    for (const image of document.querySelectorAll('img')) {
      const lazySrc = image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-lazy-src');
      if (lazySrc) image.setAttribute('src', lazySrc);
      const lazySrcset = image.getAttribute('data-srcset');
      if (lazySrcset) image.setAttribute('srcset', lazySrcset);
    }
    for (const element of document.querySelectorAll('[href], [src], [poster]')) {
      for (const attr of ['href', 'src', 'poster']) {
        const raw = element.getAttribute(attr);
        if (!raw) continue;
        try { element.setAttribute(attr, new URL(raw, document.baseURI).href); } catch { /* 保留给净化器处理 */ }
      }
    }
    // 先清掉明显与正文无关的容器，Readability 的判定会更稳。
    for (const selector of ['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'form']) {
      document.querySelectorAll(selector).forEach((node) => node.remove());
    }

    const article = new Readability(document, { charThreshold: 200 }).parse();
    if (!article?.content) return null;

    const textLength = article.textContent?.replace(/\s+/g, ' ').trim().length ?? 0;
    if (textLength < 140) return null;

    const absoluteHtml = article.content.replace(
      /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi,
      (match, prefix, src, suffix) => {
        const absolute = absolutize(String(src), finalUrl);
        return absolute ? `${prefix}${absolute}${suffix}` : match;
      },
    );

    const sanitized = sanitizeContentHtml(absoluteHtml);
    return {
      // 只做绝对化，不做代理改写：数据库里保存原始图片地址，
      // 代理链接只在这一份 HTML 出站时（presentArticle）生成。否则下一次
      // present 会把 `/api/image?u=…` 再包一层，图片全部 502。
      html: sanitized,
      title: article.title?.trim() || null,
      excerpt: article.excerpt?.trim() || null,
      siteName: article.siteName?.trim() || null,
      wordCount: textLength,
    };
  } catch {
    return null;
  } finally {
    dom.window.close();
  }
}
