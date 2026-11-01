import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkFetch, parseSystemProxy, resolveProxyConfig, readLimitedBody } from '../src/services/network';

const system = { httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', noProxy: '*.local' };

test('macOS 系统代理：启用状态、端口、IPv6 与例外列表', () => {
  assert.deepEqual(parseSystemProxy(`
 HTTPEnable : 1
 HTTPProxy : 127.0.0.1
 HTTPPort : 7897
 HTTPSEnable : 1
 HTTPSProxy : ::1
 HTTPSPort : 7898
 ExceptionsList : <array> {
  0 : *.local
  1 : 192.168.0.0/16
  2 : <local>
 }
`), { httpProxy: system.httpProxy, httpsProxy: 'http://[::1]:7898', noProxy: '*.local' });
  assert.equal(parseSystemProxy('HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 7897').httpProxy, '');
});

test('环境代理优先、大小写优先级、显式禁用、NO_PROXY 通配符', () => {
  assert.equal(resolveProxyConfig({}, system).httpsProxy, system.httpsProxy);
  const resolved = resolveProxyConfig({ http_proxy: 'http://lower:80', HTTP_PROXY: 'http://upper:80' }, system);
  assert.equal(resolved.httpProxy, 'http://lower:80');
  assert.equal(resolved.httpsProxy, resolved.httpProxy);
  assert.match(resolved.noProxy, /127\.0\.0\.1/);
  assert.equal(resolveProxyConfig({ HTTP_PROXY: '' }, system).httpsProxy, '');
  assert.equal(resolveProxyConfig({ NO_PROXY: '*' }, system).noProxy, '*');
});

test('真实 fetch 经 CONNECT 代理；回环请求即使未设 NO_PROXY 也直连', async () => {
  let connects = 0;
  const proxy = createServer();
  proxy.on('connect', (_req, socket) => {
    connects++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied');
    });
  });
  const local = createServer((_req, res) => res.end('direct'));
  await Promise.all([new Promise<void>(r => proxy.listen(0, '127.0.0.1', r)), new Promise<void>(r => local.listen(0, '127.0.0.1', r))]);
  const keys = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    assert.equal(await (await networkFetch('http://unresolvable.invalid/article')).text(), 'proxied');
    assert.equal(await (await networkFetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}`)).text(), 'direct');
    assert.equal(connects, 1);
    process.env.NO_PROXY = '*';
    await assert.rejects(networkFetch('http://unresolvable.invalid/article'));
    assert.equal(connects, 1);
  } finally {
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    proxy.closeAllConnections(); local.closeAllConnections();
    await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => local.close(() => r()))]);
  }
});

test('无 Content-Length 的超大响应也会及时取消读取', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readLimitedBody(response, 10), /过大/);
  assert.equal(cancelled, true);
});
