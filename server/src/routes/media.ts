import { networkFetch, readLimitedBody } from '../services/network';
import { Hono } from 'hono';
import type { ServerConfig } from '../config';
import { ValidationError } from '../http/envelope';
import { verifyImageProxySignature } from '../services/imageProxy';

const MAX_BYTES = 12 * 1024 * 1024;

export function mediaRoutes(cfg: ServerConfig) {
  const app = new Hono();

  /**
   * 图片代理：正文图片统一走这里，既能绕开 Referer 防盗链，
   * 也让 WebView 不必直接请求任意第三方域名。
   */
  app.get('/image', async (c) => {
    const url = new URL(c.req.url);
    const source = url.searchParams.get('u') ?? '';
    const signature = url.searchParams.get('s') ?? '';

    if (!source || !signature) throw new ValidationError('缺少图片参数', { u: 'required' });
    if (!verifyImageProxySignature(cfg, source, signature)) {
      throw new ValidationError('图片签名无效', { s: 'invalid' });
    }

    let target: URL;
    try {
      target = new URL(source);
    } catch {
      throw new ValidationError('图片地址非法', { u: 'invalid' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new ValidationError('仅支持 http/https 图片', { u: 'unsupported_protocol' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    try {
      const response = await networkFetch(target, {
        headers: {
          'user-agent': cfg.userAgent,
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          referer: `${target.protocol}//${target.host}/`,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return c.body(null, 502);
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      if (!contentType.startsWith('image/')) {
        await response.body.cancel();
        return c.body(null, 415);
      }

      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_BYTES) {
        await response.body.cancel();
        return c.body(null, 413);
      }

      const buffer = await readLimitedBody(response, MAX_BYTES);
      if (buffer.byteLength > MAX_BYTES) return c.body(null, 413);

      return c.body(new Uint8Array(buffer), 200, {
        'content-type': contentType,
        'cache-control': 'public, max-age=86400',
        'content-length': String(buffer.byteLength),
      });
    } catch {
      return c.body(null, 502);
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}
