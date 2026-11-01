import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractFulltext } from '../src/services/fulltext';
import { loadConfig } from '../src/config';

async function withPage(handler: (path: string, res: ServerResponse) => void, run: (base: string) => Promise<void>) {
  const server = createServer((req, res) => handler(req.url!, res));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

test('重定向后的正文恢复懒加载图片，相对链接解析，脚本净化', async () => {
  await withPage((path, res) => {
    if (path === '/start') { res.writeHead(302, { location: '/posts/article' }); res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>测试文章</title></head><body><article><h1>测试文章</h1><p>${'这是一篇有足够长度的测试文章，用于验证正文能够在跳转之后正常提取。'.repeat(20)}</p><p><a href="../about">作者资料</a></p><img data-src="./photo.jpg" alt="正文配图"><script>alert(1)</script></article></body></html>`);
  }, async base => {
    const result = await extractFulltext(`${base}/start`, loadConfig());
    assert.ok(result);
    assert.ok(result.html.includes(`${base}/posts/photo.jpg`));
    assert.ok(result.html.includes(`${base}/about`));
    assert.ok(!result.html.includes('<script'));
    assert.ok(!result.html.includes('/api/image?'));
  });
});

test('HTTP 拒绝、正文读取超时与非网页响应保留可区分的原因', async () => {
  await withPage((path, res) => {
    if (path === '/denied') { res.writeHead(403); res.end(); }
    else if (path === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('pdf'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.flushHeaders(); }
  }, async base => {
    const cfg = { ...loadConfig(), requestTimeoutMs: 100 };
    await assert.rejects(extractFulltext(`${base}/denied`, cfg), /HTTP 403/);
    await assert.rejects(extractFulltext(`${base}/pdf`, cfg), /不是网页/);
    await assert.rejects(extractFulltext(`${base}/hang`, cfg), /超时/);
  });
});
