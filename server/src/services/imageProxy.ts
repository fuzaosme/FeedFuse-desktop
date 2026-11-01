import { createHmac } from 'node:crypto';
import type { ServerConfig } from '../config';

function sign(secret: string, url: string): string {
  return createHmac('sha256', secret).update(url).digest('base64url').slice(0, 16);
}

export function buildImageProxyUrl(cfg: ServerConfig, sourceUrl: string): string {
  const signature = sign(cfg.imageProxySecret, sourceUrl);
  return `/api/image?u=${encodeURIComponent(sourceUrl)}&s=${signature}`;
}

export function verifyImageProxySignature(cfg: ServerConfig, sourceUrl: string, signature: string): boolean {
  const expected = sign(cfg.imageProxySecret, sourceUrl);
  return expected.length === signature.length && timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  let mismatch = a.length === b.length ? 0 : 1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/**
 * 把正文里的图片改走本地代理：
 * 一是绕开源站 Referer 防盗链，二是避免 WebView 直接暴露在外网请求里。
 *
 * 幂等：已经是 `/api/image?…` 的地址原样保留。老版本曾把代理链接写进过数据库，
 * 不判断就会再包一层（`u=http://源站/api/image?u=…`），图片全部 502。
 */
export function rewriteImagesToProxy(html: string, cfg: ServerConfig, pageUrl: string | null): string {
  if (!html) return html;
  const withSrc = html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi,
    (match, prefix, src, suffix) => {
      if (isLocalProxyUrl(String(src))) return match;
      const absolute = absolutize(String(src), pageUrl);
      if (!absolute) return match;
      if (absolute.startsWith('data:')) return match;
      return `${prefix}${buildImageProxyUrl(cfg, absolute)}${suffix}`;
    },
  );
  // srcset 必须一起改：浏览器优先用它，只改 src 等于没绕开第三方直连。
  return withSrc.replace(/(<img\b[^>]*?\bsrcset\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, value, suffix) => {
    const rewritten = rewriteSrcset(String(value), cfg, pageUrl);
    return rewritten === null ? match : `${prefix}${rewritten}${suffix}`;
  });
}

/** `srcset` 形如 `a.jpg 1x, b.jpg 2x`，逐个候选改写成代理地址。 */
function rewriteSrcset(value: string, cfg: ServerConfig, pageUrl: string | null): string | null {
  const candidates = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;

  const rewritten: string[] = [];
  for (const candidate of candidates) {
    const [url, ...descriptor] = candidate.split(/\s+/);
    if (!url) continue;
    if (isLocalProxyUrl(url)) {
      rewritten.push(candidate);
      continue;
    }
    const absolute = absolutize(url, pageUrl);
    if (!absolute) return null;
    rewritten.push(`${buildImageProxyUrl(cfg, absolute)}${descriptor.length ? ` ${descriptor.join(' ')}` : ''}`);
  }
  return rewritten.length > 0 ? rewritten.join(', ') : null;
}

function isLocalProxyUrl(src: string): boolean {
  return /^(https?:\/\/[^/]+)?\/api\/image\?/.test(src.trim());
}

export function absolutize(src: string, baseUrl: string | null): string | null {
  const raw = String(src).trim();
  if (!raw || raw.startsWith('data:')) return raw.startsWith('data:') ? raw : null;
  try {
    return new URL(raw, baseUrl ?? undefined).toString();
  } catch {
    return null;
  }
}
