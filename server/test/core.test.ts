import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerConfig } from '../src/config';
import { decodeCursor, encodeCursor } from '../src/domain/articles';
import {
  absolutize,
  buildImageProxyUrl,
  rewriteImagesToProxy,
  verifyImageProxySignature,
} from '../src/services/imageProxy';

const cfg: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  token: 'test-token',
  dataDir: '/tmp/feedfuse-test',
  dbPath: '/tmp/feedfuse-test/feedfuse.db',
  staticDir: null,
  userAgent: 'FeedFuse/test',
  requestTimeoutMs: 15000,
  imageProxySecret: 'unit-test-secret',
};

describe('分页游标', () => {
  it('编码后能原样解回，且带非法输入时返回 null 而不是抛错', () => {
    const cursor = encodeCursor({ publishedAt: '2026-10-30T10:00:00.000Z', id: '42' });
    assert.deepEqual(decodeCursor(cursor), { p: '2026-10-30T10:00:00.000Z', i: '42' });

    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(''), null);
    assert.equal(decodeCursor('not-base64-json'), null);
    // 结构不对（缺字段）也要当无效处理，否则 SQL 会拿到 undefined 参数。
    assert.equal(decodeCursor(Buffer.from('{"p":"x"}').toString('base64url')), null);
  });
});

describe('图片代理', () => {
  it('生成的 URL 能被自己的签名校验通过', () => {
    const url = 'https://cdn.example.com/a.png?w=100';
    const proxied = buildImageProxyUrl(cfg, url);
    const parsed = new URL(proxied, 'http://127.0.0.1');
    const signature = parsed.searchParams.get('s') ?? '';
    const source = parsed.searchParams.get('u') ?? '';

    assert.equal(source, url);
    assert.ok(verifyImageProxySignature(cfg, source, signature));
  });

  it('签名不对或换个密钥都必须失败', () => {
    const url = 'https://cdn.example.com/a.png';
    const signature = new URL(buildImageProxyUrl(cfg, url), 'http://127.0.0.1').searchParams.get('s')!;

    assert.equal(verifyImageProxySignature(cfg, url, 'deadbeefdeadbeef'), false);
    assert.equal(verifyImageProxySignature({ ...cfg, imageProxySecret: 'other' }, url, signature), false);
  });

  it('正文图片改写成代理地址，data URI 与相对路径不动', () => {
    const html = '<p><img src="https://cdn.example.com/b.jpg"><img src="data:image/png;base64,AAA"></p>';
    const rewritten = rewriteImagesToProxy(html, cfg, 'https://site.example.com/post');

    assert.match(rewritten, /\/api\/image\?u=https%3A%2F%2Fcdn\.example\.com%2Fb\.jpg/);
    assert.match(rewritten, /data:image\/png;base64,AAA/);
  });

  it('相对地址按文章地址补全，无法解析时返回 null', () => {
    assert.equal(absolutize('/img/x.png', 'https://site.example.com/post/1'), 'https://site.example.com/img/x.png');
    assert.equal(absolutize('//cdn.example.com/x.png', 'https://site.example.com/post'), 'https://cdn.example.com/x.png');
    assert.equal(absolutize('', 'https://site.example.com'), null);
  });
});
