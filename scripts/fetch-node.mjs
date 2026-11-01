#!/usr/bin/env node
// 为 Tauri 的 bundle.externalBin 准备 node 可执行文件。
//
// 产出：src-tauri/binaries/node-<target-triple>（例如 node-aarch64-apple-darwin）
// Tauri 找不到带 triple 后缀的同名文件就不肯打包，所以文件名不能省。
//
// 用法：
//   node scripts/fetch-node.mjs                 # 下载默认版本
//   FEEDFUSE_NODE_VERSION=v22.22.2 node scripts/fetch-node.mjs
//   FEEDFUSE_NODE_TARGET=x86_64-apple-darwin node scripts/fetch-node.mjs   # 交叉准备
//
// 幂等：目标文件已存在且可执行时直接跳过（带 --force 可强制重下）。

import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BIN_DIR = join(REPO_ROOT, 'src-tauri', 'binaries');
const DEFAULT_VERSION = 'v22.22.2';
const FORCE = process.argv.includes('--force');

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function log(message) {
  console.log(message);
}

/** 从 rustc 推断 host triple；拿不到就按平台/架构硬映射。 */
function detectTargetTriple() {
  const fromEnv = process.env.FEEDFUSE_NODE_TARGET?.trim();
  if (fromEnv) return fromEnv;

  const candidates = ['rustc', join(process.env.HOME ?? '', '.cargo', 'bin', 'rustc')];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['-vV'], { encoding: 'utf8' });
      const host = out.match(/^host:\s*(\S+)$/m)?.[1];
      if (host) return host;
    } catch {
      // 换下一个候选
    }
  }

  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  if (!arch) fail(`无法识别的 CPU 架构: ${process.arch}`);
  const table = {
    darwin: `${arch}-apple-darwin`,
    linux: `${arch}-unknown-linux-gnu`,
    win32: `${arch}-pc-windows-msvc`,
  };
  const triple = table[process.platform];
  if (!triple) fail(`无法识别的平台: ${process.platform}`);
  log(`! 未能执行 rustc，按平台推断 target triple: ${triple}`);
  return triple;
}

/** Tauri externalBin 的平台标识 → nodejs.org 的产物名/归档格式。 */
function distForTriple(triple) {
  const isArm = triple.startsWith('aarch64');
  const isX64 = triple.startsWith('x86_64');
  if (triple.includes('apple-darwin')) {
    return { name: isArm ? 'darwin-arm64' : 'darwin-x64', ext: 'tar.gz', entry: 'bin/node' };
  }
  if (triple.includes('linux')) {
    return { name: isArm ? 'linux-arm64' : 'linux-x64', ext: 'tar.gz', entry: 'bin/node' };
  }
  if (triple.includes('windows')) {
    return {
      name: isArm ? 'win-arm64' : isX64 ? 'win-x64' : 'win-x86',
      ext: 'zip',
      entry: 'node.exe',
    };
  }
  fail(`暂不支持的 target triple: ${triple}`);
}

async function download(url, dest) {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      await downloadOnce(url, dest);
      return;
    } catch (err) {
      if (existsSync(dest)) {
        try {
          unlinkSync(dest);
        } catch {
          /* ignore */
        }
      }
      if (i === attempts) throw err;
      log(`  下载失败（第 ${i} 次）：${err.message}，2 秒后重试…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function downloadOnce(url, dest) {
  log(`  下载 ${url}`);
  // Node 自带 fetch 会自动使用 HTTPS_PROXY / HTTP_PROXY（若为支持的环境）。
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastTick = 0;
  const started = Date.now();

  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastTick < 200) return;
    lastTick = now;
    const mb = (received / 1048576).toFixed(1);
    const speed = (received / 1048576 / ((now - started) / 1000 || 1)).toFixed(1);
    if (total > 0) {
      const pct = ((received / total) * 100).toFixed(1).padStart(5);
      process.stdout.write(`\r  进度 ${pct}%  ${mb}/${(total / 1048576).toFixed(1)} MB  ${speed} MB/s`);
    } else {
      process.stdout.write(`\r  进度 ${mb} MB  ${speed} MB/s`);
    }
  });

  await pipeline(source, createWriteStream(dest));
  process.stdout.write('\r');
  log(`  已下载 ${(statSync(dest).size / 1048576).toFixed(1)} MB`);
}

function extract(archive, workDir) {
  log('  解压中…');
  // macOS / Linux 自带 tar；Windows 10+ 的 bsdtar 也能处理 zip。
  try {
    execFileSync('tar', ['-xf', archive, '-C', workDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    fail(
      `解压失败（${archive}）：${detail}`,
      '若系统缺少 tar，请手动解压后把 bin/node 放到 src-tauri/binaries/node-<triple>',
    );
  }
}

async function main() {
  const triple = detectTargetTriple();
  const dist = distForTriple(triple);
  const version = (process.env.FEEDFUSE_NODE_VERSION?.trim() || DEFAULT_VERSION).replace(/^v?/, 'v');
  const nodeName = `node-${version}-${dist.name}`;
  const archiveName = `${nodeName}.${dist.ext}`;
  const url = `https://nodejs.org/dist/${version}/${archiveName}`;

  const target = join(BIN_DIR, `node-${triple}`);

  log(`FeedFuse · fetch node`);
  log(`  target triple : ${triple}`);
  log(`  node version  : ${version}`);
  log(`  目标文件      : ${target}`);

  if (existsSync(target) && !FORCE) {
    const mode = statSync(target).mode & 0o777;
    if (mode & 0o111) {
      log('✓ 已存在且可执行，跳过下载（--force 可强制重下）');
      return;
    }
    log('! 目标文件存在但缺少执行位，补上即可');
    // 只需补执行位即可，避免重复下载。
    chmodSync(target, 0o755);
    log('✓ 已补上执行权限');
    return;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'feedfuse-node-'));
  const archive = join(workDir, archiveName);
  try {
    await download(url, archive);
    extract(archive, workDir);

    const extractedDir = join(workDir, nodeName);
    if (!existsSync(extractedDir)) {
      const entries = readdirSync(workDir).filter((name) => name.startsWith('node-'));
      fail(
        `解压结果不符合预期，找不到目录 ${nodeName}`,
        entries.length ? `实际内容: ${entries.join(', ')}` : '归档疑似为空',
      );
    }

    const binSrc = join(extractedDir, dist.entry);
    if (!existsSync(binSrc)) {
      fail(`归档里没有 ${dist.entry}（${binSrc}）`, '请确认 nodejs.org 的产物结构是否变动');
    }

    // 先写临时文件再 rename，避免中断留下半个可执行文件。
    const tmpTarget = `${target}.tmp`;
    copyFileSync(binSrc, tmpTarget);
    chmodSync(tmpTarget, 0o755);
    renameSync(tmpTarget, target);

    const size = statSync(target).size;
    log(`✓ 已写入 ${target} (${(size / 1048576).toFixed(1)} MB, 755)`);

    // 交叉目标不能直接执行，只有 host 匹配时才做一次版本自检。
    const hostTriple = (() => {
      try {
        return execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host:\s*(\S+)$/m)?.[1];
      } catch {
        return undefined;
      }
    })();
    if (!hostTriple || hostTriple === triple) {
      const out = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
      log(`✓ 自检通过: ${out}`);
    } else {
      log(`! 交叉准备（host=${hostTriple}），跳过可执行自检`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err.message, '如果网络需要代理，请设置 HTTPS_PROXY 后重试。');
});
