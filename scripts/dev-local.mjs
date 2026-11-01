#!/usr/bin/env node
/**
 * 本地开发一键启动：sidecar（tsx watch，固定 9559）+ Vite（5173）。
 *
 * Vite 的 /api 代理指向 127.0.0.1:9559，令牌统一用 dev-local-token；
 * sidecar 侧开了 FEEDFUSE_ALLOW_ANON=1，所以浏览器直接访问也能调通。
 *
 * 只依赖 node:child_process，Ctrl-C 会把两个子进程一起收掉。
 *
 * 用法：node scripts/dev-local.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = 9559;
const WEB_PORT = 5173;
const TOKEN = 'dev-local-token';
const DATA_DIR = join(ROOT, '.dev-data');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const children = [];
let shuttingDown = false;

function tag(name, color) {
  return (line) => `\x1b[${color}m[${name}]\x1b[0m ${line}`;
}

const serverTag = tag('server', '36');
const webTag = tag('web', '35');

function pipeLines(stream, format, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) console.log(format(line));
      if (onLine) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) console.log(format(buffer));
  });
}

function start(name, format, args, env, onLine) {
  const child = spawn(PNPM, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 下自成一个进程组，方便一次把 pnpm/tsx/node 整棵子树收掉。
    detached: process.platform !== 'win32',
  });
  pipeLines(child.stdout, format, onLine);
  pipeLines(child.stderr, format, onLine);

  child.on('error', (err) => {
    console.error(format(`启动失败：${err.message}`));
    shutdown(1, `${name} 启动失败`);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(format(`进程退出（code=${code ?? 'null'} signal=${signal ?? 'none'}）`));
    shutdown(code ?? 1, `${name} 退出`);
  });

  children.push(child);
  return child;
}

function killTree(child, signal = 'SIGINT') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已经退出就忽略
    }
  }
}

function shutdown(code = 0, reason = '') {
  if (shuttingDown) return;
  shuttingDown = true;

  if (reason) console.log(`\n\x1b[33m▸ ${reason}，正在关闭…\x1b[0m`);
  for (const child of children) killTree(child, 'SIGINT');

  // 给 tsx/vite 一点时间收尾，超时就强杀，避免占着 9559/5173 不放。
  const timer = setTimeout(() => {
    for (const child of children) killTree(child, 'SIGKILL');
    process.exit(code);
  }, 3_000);
  timer.unref();

  Promise.all(
    children.map(
      (child) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null) resolveExit();
          else child.once('exit', () => resolveExit());
        }),
    ),
  ).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}

/**
 * 探测端口是否被占用。
 * 必须同时试 IPv4 与 IPv6：macOS 上 `localhost` 常解析到 ::1，
 * 只 bind 127.0.0.1 探测会漏掉正在监听 ::1 的进程（Vite 默认就是这种）。
 */
function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function checkPort(port) {
  const [v4, v6] = await Promise.all([tryConnect('127.0.0.1', port), tryConnect('::1', port)]);
  if (!v4 && !v6) return { busy: false };

  const found = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pid = (found.stdout ?? '')
    .split('\n')
    .slice(1)
    .map((row) => row.trim().split(/\s+/)[1])
    .find(Boolean);
  return { busy: true, pid };
}

process.on('SIGINT', () => shutdown(0, '收到 Ctrl-C'));
process.on('SIGTERM', () => shutdown(0, '收到 SIGTERM'));

/* ------------------------------ 启动 ------------------------------ */

if (!existsSync(join(ROOT, 'node_modules'))) {
  console.error('\x1b[31m✗ 未找到 node_modules，请先执行 `pnpm install`\x1b[0m');
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });

/* --------------------------- 端口预检 --------------------------- */

const serverPort = await checkPort(SERVER_PORT);
if (serverPort.busy) {
  console.error(`\x1b[31m✗ 端口 ${SERVER_PORT} 已被占用\x1b[0m${serverPort.pid ? `（PID ${serverPort.pid}）` : ''}`);
  console.error(`  sidecar 端口不能顺延：Vite 的 /api 代理写死指向 ${SERVER_PORT}。`);
  console.error(`  先释放端口再重试：  kill ${serverPort.pid ?? '<PID>'}    # 或用 lsof -nP -iTCP:${SERVER_PORT} -sTCP:LISTEN 查`);
  process.exit(1);
}

const webPort = await checkPort(WEB_PORT);
if (webPort.busy) {
  console.log(
    `\x1b[33m▸ 端口 ${WEB_PORT} 已被占用${webPort.pid ? `（PID ${webPort.pid}）` : ''}，前端将自动顺延到下一个可用端口\x1b[0m`,
  );
}

const sharedEnv = {
  ...process.env,
  FEEDFUSE_TOKEN: TOKEN,
  FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
};

console.log('\n\x1b[1mFeedFuse 本地开发\x1b[0m');
console.log(`  sidecar  \x1b[36mhttp://127.0.0.1:${SERVER_PORT}\x1b[0m  （FEEDFUSE_ALLOW_ANON=1，数据目录 .dev-data/）`);
console.log(`  前端     \x1b[35mhttp://localhost:${WEB_PORT}\x1b[0m  （/api 代理到 sidecar；Vite 绑的是 localhost，用 127.0.0.1 打不开）`);
console.log('  Ctrl-C 同时退出两边\n');

start(
  'server',
  serverTag,
  ['--filter', '@feedfuse/server', 'dev'],
  {
    ...sharedEnv,
    FEEDFUSE_PORT: String(SERVER_PORT),
    FEEDFUSE_ALLOW_ANON: '1',
    FEEDFUSE_DATA_DIR: DATA_DIR,
    // 开发时前端由 Vite 提供，sidecar 只当纯 API 用。
    FEEDFUSE_STATIC_DIR: '',
  },
  (line) => {
    if (line.includes('[feedfuse-ready]')) {
      console.log(`\x1b[32m▸ 后端已就绪：http://127.0.0.1:${SERVER_PORT}\x1b[0m`);
    }
  },
);

start('web', webTag, ['--filter', '@feedfuse/web', 'dev'], sharedEnv, (line) => {
  // Vite 顺延端口后真实地址只出现在这行输出里，抓出来高亮一下，避免照着旧提示点。
  // 注意：这行在彩色输出里被 ANSI 转义切成多段（"Local" 和 ":" 之间就有 reset），先剥掉再匹配。
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const match = /Local:\s+(http:\/\/\S+)/.exec(plain);
  if (match) {
    console.log(`\x1b[32m▸ 前端已就绪：${match[1]}\x1b[0m`);
  }
});
