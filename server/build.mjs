import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * sidecar 只打包自己的源码：第三方依赖保持 external，
 * 由随包分发的 server/node_modules 在运行时解析。
 * 这样避免 jsdom 这类含动态 require 的库被打包器改写后运行期失效。
 */
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: [
      "import { createRequire as __ffCreateRequire } from 'node:module';",
      'const require = __ffCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

// schema.sql 以运行时读取的方式加载，需要跟着产物一起落到 dist。
await mkdir('dist', { recursive: true });
await copyFile('src/db/schema.sql', 'dist/schema.sql');

// 内置词典随 sidecar 一起分发：运行时按 import.meta.url 就近读取（见 domain/builtinDictionary.ts）。
await copyFile('assets/en-zh.json', 'dist/en-zh.json');
