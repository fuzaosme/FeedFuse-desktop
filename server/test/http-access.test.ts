import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http/app';
import { loadConfig } from '../src/config';

test('入口页注入本地令牌但不缓存，外部 Host 不能读取入口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedfuse-http-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<html><head></head><body>Reader</body></html>');
    const app = createApp({ ...loadConfig(), token: 'local-secret', staticDir: dir });
    const local = await app.request('http://127.0.0.1:9559/');
    assert.equal(local.status, 200);
    assert.equal(local.headers.get('cache-control'), 'no-store');
    assert.match(await local.text(), /local-secret/);
    const external = await app.request('http://rebind.example/');
    assert.equal(external.status, 403);
    assert.doesNotMatch(await external.text(), /local-secret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('图片鉴权豁免只允许精确路径，图片密钥每次启动重新生成', async () => {
  const old = process.env.FEEDFUSE_ALLOW_ANON;
  delete process.env.FEEDFUSE_ALLOW_ANON;
  try {
    const app = createApp(loadConfig());
    assert.equal((await app.request('http://localhost/api/image-not-real')).status, 401);
    assert.equal((await app.request('http://localhost/api/image')).status, 400);
    assert.notEqual(loadConfig().imageProxySecret, loadConfig().imageProxySecret);
  } finally { if (old !== undefined) process.env.FEEDFUSE_ALLOW_ANON = old; }
});
