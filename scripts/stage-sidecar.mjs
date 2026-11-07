#!/usr/bin/env node
/**
 * 把 sidecar 运行时摊平到 src-tauri/resources，供 Tauri 的 bundle.resources 整体打包。
 *
 * 产物结构：
 *   src-tauri/resources/
 *     server/
 *       server.mjs          esbuild 产物（第三方依赖 external）
 *       schema.sql          启动时读取的建表脚本
 *       node_modules/       仅生产依赖，已解掉 pnpm 的符号链接
 *     web/
 *       index.html          Vite 产物，FEEDFUSE_STATIC_DIR 指向这里
 *       assets/...
 *
 * 幂等：每次都先清空 resources 再重新写入。
 * 用法：node scripts/stage-sidecar.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(ROOT, 'src-tauri', 'resources');
const SERVER_DIST = join(ROOT, 'server', 'dist');
const WEB_DIST = join(ROOT, 'web', 'dist');
const STAGE_TMP = join(ROOT, '.stage-tmp');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;

function fail(message) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m\n`);
  process.exit(1);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function dirSize(target) {
  let total = 0;
  let files = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    const stats = statSync(current);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(join(current, entry));
      continue;
    }
    total += stats.size;
    files += 1;
  }
  return { bytes: total, files };
}

function report(label, target) {
  if (!existsSync(target)) {
    console.log(`  ${label.padEnd(28)} ${yellow('缺失')}`);
    return 0;
  }
  const stats = statSync(target);
  if (stats.isDirectory()) {
    const { bytes, files } = dirSize(target);
    console.log(`  ${label.padEnd(28)} ${formatSize(bytes).padStart(9)}  ${dim(`${files} 个文件`)}`);
    return bytes;
  }
  console.log(`  ${label.padEnd(28)} ${formatSize(stats.size).padStart(9)}`);
  return stats.size;
}

/* ------------------------------ 1. 前置校验 ------------------------------ */

const serverEntry = join(SERVER_DIST, 'server.mjs');
const serverSchema = join(SERVER_DIST, 'schema.sql');
const serverDictionary = join(SERVER_DIST, 'builtin');
const serverPhrases = join(SERVER_DIST, 'phrases.json');
const serverZhCore = join(SERVER_DIST, 'en-zh.json');
const webEntry = join(WEB_DIST, 'index.html');

const missing = [
  [serverEntry, 'server/dist/server.mjs'],
  [serverSchema, 'server/dist/schema.sql'],
  [serverDictionary, 'server/dist/builtin/'],
  [serverPhrases, 'server/dist/phrases.json'],
  [serverZhCore, 'server/dist/en-zh.json'],
  [webEntry, 'web/dist/index.html'],
].filter(([path]) => !existsSync(path));

if (missing.length > 0) {
  console.error('\x1b[31m✗ 缺少构建产物：\x1b[0m');
  for (const [, name] of missing) console.error(`  - ${name}`);
  fail('请先在仓库根目录执行 `pnpm build`（或 `pnpm build:server && pnpm build:web`）再运行本脚本');
}

/* ---------------------------- 2. 清空目标目录 ---------------------------- */

console.log(`\n▸ 清空 ${dim(RESOURCES)}`);
rmSync(RESOURCES, { recursive: true, force: true });
mkdirSync(join(RESOURCES, 'server'), { recursive: true });
mkdirSync(join(RESOURCES, 'web'), { recursive: true });

/* --------------------------- 3. 服务端产物拷贝 --------------------------- */

cpSync(serverEntry, join(RESOURCES, 'server', 'server.mjs'));
cpSync(serverSchema, join(RESOURCES, 'server', 'schema.sql'));
cpSync(serverDictionary, join(RESOURCES, 'server', 'builtin'), { recursive: true });
cpSync(serverPhrases, join(RESOURCES, 'server', 'phrases.json'));
cpSync(serverZhCore, join(RESOURCES, 'server', 'en-zh.json'));
// 故意不带 .map：sourcemap 只在本地调试有用，随包分发纯属占体积。
console.log(`▸ 已写入 server.mjs / schema.sql / builtin/ / phrases.json / en-zh.json`);

/* ------------------------------ 4. 前端产物 ------------------------------ */

cpSync(WEB_DIST, join(RESOURCES, 'web'), { recursive: true, dereference: true });
console.log(`▸ 已写入 web/（Vite 产物）`);

/* ---------------------------- 5. 生产依赖 ---------------------------- */

/**
 * 优先让 pnpm 自己算生产依赖树（hoisted 布局，天然没有符号链接）。
 * 老版本 pnpm 没有 --legacy / node-linker 组合时，回退到手工按依赖图拷贝。
 */
function deployWithPnpm(nodeLinker) {
  const args = ['--filter', '@feedfuse/server', 'deploy', '--prod', '--legacy'];
  if (nodeLinker) args.push(`--config.node-linker=${nodeLinker}`);
  args.push(STAGE_TMP);

  const result = spawnSync(PNPM, args, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').slice(-6).join('\n');
    console.log(dim(`  pnpm deploy${nodeLinker ? ' (hoisted)' : ''} 失败：\n${detail}`));
    return false;
  }
  return existsSync(join(STAGE_TMP, 'node_modules'));
}

/** 手工兜底：从 server/node_modules 出发按 package.json 依赖图解析真实目录。 */
function collectFromWorkspace() {
  const sourceRoot = join(ROOT, 'server', 'node_modules');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));
  const wanted = Object.keys(pkg.dependencies ?? {});
  const resolved = new Map();

  const resolveDep = (fromDir, name) => {
    for (const base of [fromDir, sourceRoot]) {
      const candidate = join(base, name);
      if (existsSync(candidate)) {
        try {
          return realpathSync(candidate);
        } catch {
          // 继续尝试下一个位置
        }
      }
    }
    return null;
  };

  const queue = wanted.map((name) => ({ name, from: sourceRoot }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const real = resolveDep(from, name);
    if (!real) continue;
    if (resolved.has(name)) continue;

    resolved.set(name, real);
    const depPkgPath = join(real, 'package.json');
    if (!existsSync(depPkgPath)) continue;
    let depPkg;
    try {
      depPkg = JSON.parse(readFileSync(depPkgPath, 'utf8'));
    } catch {
      continue;
    }
    // pnpm 的依赖落在真实目录的同级 node_modules 里（.pnpm/<id>/node_modules/）。
    const siblingRoot = dirname(real);
    for (const child of Object.keys(depPkg.dependencies ?? {})) {
      queue.push({ name: child, from: siblingRoot });
    }
  }

  return resolved;
}

function stageNodeModules() {
  const target = join(RESOURCES, 'server', 'node_modules');
  mkdirSync(target, { recursive: true });

  rmSync(STAGE_TMP, { recursive: true, force: true });

  let deployed = deployWithPnpm('hoisted');
  if (!deployed) {
    rmSync(STAGE_TMP, { recursive: true, force: true });
    deployed = deployWithPnpm(null);
  }

  if (deployed) {
    // .bin 只是一堆 CLI 软链，sidecar 运行时用不到。
    cpSync(join(STAGE_TMP, 'node_modules'), target, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const name = basename(src);
        return name !== '.bin' && name !== '.modules.yaml' && name !== '.pnpm';
      },
    });
    rmSync(STAGE_TMP, { recursive: true, force: true });
    console.log(`  ${green('✓')} 依赖来源：pnpm deploy（hoisted）`);
    return;
  }

  console.log(yellow('  ! pnpm deploy 不可用，回退到手工解析 server/node_modules'));
  const packages = collectFromWorkspace();
  if (packages.size === 0) {
    fail('没能解析出任何生产依赖，请先执行 `pnpm install`');
  }
  for (const [name, realPath] of packages) {
    cpSync(realPath, join(target, name), { recursive: true, dereference: true });
  }
  console.log(`  ${green('✓')} 依赖来源：手工解析（${packages.size} 个包）`);
}

console.log(`▸ 收集生产依赖…`);
stageNodeModules();

/* ------------------------------ 6. 结果汇总 ------------------------------ */

const requiredDeps = Object.keys(
  JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8')).dependencies ?? {},
);
const unresolved = requiredDeps.filter(
  (name) => !existsSync(join(RESOURCES, 'server', 'node_modules', name)),
);
if (unresolved.length > 0) {
  fail(`生产依赖缺失：${unresolved.join(', ')}`);
}

console.log(`\n▸ 产物清单 ${dim(RESOURCES)}`);
const parts = [
  ['server/server.mjs', join(RESOURCES, 'server', 'server.mjs')],
  ['server/schema.sql', join(RESOURCES, 'server', 'schema.sql')],
  ['server/builtin/', join(RESOURCES, 'server', 'builtin')],
  ['server/phrases.json', join(RESOURCES, 'server', 'phrases.json')],
  ['server/en-zh.json', join(RESOURCES, 'server', 'en-zh.json')],
  ['server/node_modules/', join(RESOURCES, 'server', 'node_modules')],
  ['web/', join(RESOURCES, 'web')],
];
let total = 0;
for (const [label, path] of parts) total += report(label, path);

console.log(`  ${''.padEnd(28)} ${'─'.repeat(9)}`);
console.log(`  ${'合计'.padEnd(27)} ${formatSize(total).padStart(9)}`);
console.log(dim('  逻辑大小；node_modules 小文件多，实际占盘会略大（视文件系统块大小而定）'));
console.log(`\n${green('✓ 打包资源已就绪')} ${dim('下一步：pnpm tauri:build')}\n`);
