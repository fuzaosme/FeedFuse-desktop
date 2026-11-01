# 开发指南

## 目录结构

```
FeedFuse-rust/
├── package.json              # 根脚本：build / tauri / fetch-node …（workspace 根）
├── pnpm-workspace.yaml       # server、web 两个包
├── scripts/
│   ├── dev-local.mjs         # 一键起 sidecar(9559) + vite(5173)
│   ├── stage-sidecar.mjs     # 把运行时摊到 src-tauri/resources（打包前必跑）
│   └── fetch-node.mjs        # 下载 Node 运行时到 src-tauri/binaries
├── server/                   # 后端（Node + Hono + node:sqlite）
│   ├── build.mjs             # esbuild → dist/server.mjs + dist/schema.sql + dist/en-zh.json
│   ├── assets/en-zh.json     # 内置核心词库（约 2.9 万条，查词主路径）
│   └── src/
│       ├── main.ts           # 入口：openDb → createApp → serve → 打印握手行
│       ├── config.ts         # 环境变量与默认值
│       ├── http/             # app.ts（装配/CORS/鉴权/静态）、envelope（响应包裹）、health
│       ├── routes/           # 每个资源一个 Hono 子路由
│       ├── domain/           # 纯 SQL 读写，不碰 HTTP
│       ├── services/         # 抓取、全文、AI、翻译、图片代理、调度
│       │   └── filters/      # 关键词 / AI 语义 / 重复相似 三层过滤
│       ├── db/               # sqlite 封装 + schema.sql + migrate.ts
│       └── lib/utils.ts      # htmlToText、truncate、nowIso、mapLimit…
│   └── test/                 # node:test 单测（*.test.ts）
├── web/                      # 前端（Vite + React 19 + Tailwind 4）
│   └── src/
│       ├── api/              # client.ts（fetch/SSE 底座）、endpoints.ts、types.ts
│       ├── store/app.ts      # zustand 状态
│       ├── components/       # 三栏与各弹窗
│       ├── features/learning/ # 划词选区、词典查询、学习卡片（移植自原版 english-learning）
│       └── styles/index.css
├── src-tauri/                # 外壳
│   ├── src/main.rs           # Builder / 生命周期
│   ├── src/sidecar.rs        # spawn node、握手、导航、退出清理
│   ├── tauri.conf.json       # externalBin=binaries/node，resources=resources/**/*
│   ├── binaries/             # fetch-node 产物（不入库）
│   └── resources/            # stage-sidecar 产物（不入库）
└── docs/
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装 workspace 依赖 |
| `node scripts/dev-local.mjs` | **推荐**：sidecar 9559 + Vite 5173，日志带 `[server]`/`[web]` 前缀，Ctrl-C 一起退 |
| `pnpm dev:server` | 只起后端（`tsx watch src/main.ts`），端口默认随机 |
| `pnpm dev:web` | 只起前端（Vite 5173，`/api` 代理到 9559） |
| `pnpm build` | `build:server` + `build:web` |
| `pnpm build:server` | esbuild 打 `server/dist/server.mjs`，并复制 `schema.sql` 与内置词典 `en-zh.json` |
| `pnpm build:web` | `tsc --noEmit && vite build` → `web/dist` |
| `pnpm typecheck` | 两个包的 `tsc --noEmit` |
| `pnpm test` | 单元测试（`tsx --test`，Node 内置 runner，无额外依赖）；同时跑 `server/test/` 与 `web/test/` 的纯函数用例 |
| `pnpm check` | `typecheck` + `test`，提交前跑这一条 |
| `node scripts/stage-sidecar.mjs` | 摊平运行时到 `src-tauri/resources/`（含生产 `node_modules`，解符号链接） |
| `pnpm fetch-node` | 下载 Node 到 `src-tauri/binaries/node-<triple>` |
| `pnpm tauri:dev` | `build:server` + `stage` + `tauri dev` |
| `pnpm tauri:build` | `build` + `fetch-node` + `stage` + `tauri build`（已串好，日常用这条） |

打包完整顺序：

```bash
pnpm install
pnpm build
node scripts/stage-sidecar.mjs
pnpm fetch-node
pnpm tauri build
```

漏了 stage 会打出「找不到 server.mjs」的空壳；漏了 fetch-node 会「找不到 node 可执行文件」。`pnpm tauri:build` 已经把这四步串好了，分步执行只是为了排查问题。

## 一次请求的代码路径

以「拉取某篇文章」为例：

```
web/src/components/ArticleReader.tsx
  → web/src/api/endpoints.ts  fetchArticle(id)          // 只拼路径
  → web/src/api/client.ts     request('/api/articles/1') // 头里带 x-feedfuse-token，解 {ok,data}
  → server/src/http/app.ts    鉴权中间件 + app.route('/api/articles', …)
  → server/src/routes/articles.ts  app.get('/:id')       // HTTP 语义、present 视图
  → server/src/domain/articles.ts  getArticleDetail(id)  // SQL
  → server/src/db/sqlite.ts    getDb().get(...)
```

改东西时按这条链定位：**HTTP 相关（状态码、错误码、字段名）在 `routes/`，SQL 在 `domain/`，外部世界（网络、文件、模型）在 `services/`。**

## 新增一个 API 路由

以「新增 `GET /api/stats`：返回各表条数」为例，四步：

**1) domain：写 SQL（`server/src/domain/articles.ts` 或新建文件）**

```ts
import { getDb } from '../db/sqlite';

export function getStats() {
  const db = getDb();
  return {
    articles: db.get<{ n: number }>('select count(*) as n from articles')?.n ?? 0,
    feeds: db.get<{ n: number }>('select count(*) as n from feeds')?.n ?? 0,
  };
}
```

**2) routes：挂到子路由（`server/src/routes/articles.ts`）**

```ts
import { ok } from '../http/envelope';
import { getStats } from '../domain/articles';

// 注意：静态路径要注册在 '/:id' 之前，否则会被参数路由吃掉
app.get('/stats', (c) => ok(c, getStats()));
```

需要读请求体时用 `readJson(c)`（`routes/feeds.ts` 导出，其他路由已经在复用）；出错直接 `throw new ValidationError('…')` / `NotFoundError` / `ConflictError`，`app.onError` 会统一转成 `{ok:false,error}`，**不要自己 `c.json` 错误体**。

**3) 挂载**：如果新建了子路由文件，在 `server/src/http/app.ts` 里加一行：

```ts
import { statsRoutes } from '../routes/stats';
app.route('/api/stats', statsRoutes());
```

（注意它要放在 `app.all('/api/*', …)` 404 兜底之前。）

**4) 前端：`web/src/api/types.ts` 加类型，`endpoints.ts` 加函数**

```ts
export function fetchStats(): Promise<{ articles: number; feeds: number }> {
  return request('/api/stats');
}
```

流式接口用 `streamRequest(path, body, { onEvent })`，事件名见 `docs/ARCHITECTURE.md` 第 8 节。

自测：

```bash
node scripts/dev-local.mjs
curl --noproxy '*' http://127.0.0.1:9559/api/stats        # ALLOW_ANON 下免令牌
```

## 改 SQLite 表结构

有版本迁移机制，**不需要删库**。

- `server/src/db/schema.sql` 描述**最新**结构，全部 `create … if not exists`：新库一次建到位。
- `server/src/db/migrate.ts` 负责老库升级：`MIGRATIONS` 里按版本号追加一步，启动时 `schema.sql` → `runMigrations()` 依次执行。

加字段的四步：

1. 在 `schema.sql` 的建表语句里加上这一列（新库用）；
2. 在 `migrate.ts` 里 `addColumn(db, 'articles', 'new_col', 'text')`，并把 `CURRENT_SCHEMA_VERSION` +1；
3. 同步 `server/src/domain/*.ts` 的 `select` 列名与 `web/src/api/types.ts`；
4. `pnpm check`，然后拿一个旧库跑一次确认（下面有命令）。

两条容易踩的坑：

- **不要在 `schema.sql` 里给新列建索引**。schema.sql 先于迁移执行，老库还没这列，`create index` 会直接抛 `no such column`，整个进程起不来。索引写进迁移步骤里。
- 迁移步骤必须**幂等**（`addColumn` 会先查 `pragma table_info`）：新库、老库、上次升级到一半崩掉的库，跑完都要得到同一结果。

验证老库升级（`openDb` 只在 meta 里记版本号，所以随便找个旧库副本就行）：

```bash
cp .dev-data/feedfuse.db /tmp/ff-upgrade.db
FEEDFUSE_DB_PATH=/tmp/ff-upgrade.db FEEDFUSE_ALLOW_ANON=1 node server/dist/server.mjs
# 启动日志里应出现：[feedfuse] schema 1 → 2: …
sqlite3 /tmp/ff-upgrade.db "select value from meta where key='schema_version';"
```

FTS5 虚拟表用触发器与主表同步；新增可搜索字段时，`articles_fts` 的列、三个触发器、以及 `domain/articles.ts` 里的查询要一起改（改完删库重建是最省事的重建索引方式，仅限开发库）。

## 测试

```bash
pnpm test          # 只跑 server 单测
pnpm check         # typecheck + test
```

用的是 Node 内置 test runner + 已有的 `tsx`，**没有引入 vitest/jest**，所以不需要装任何新依赖。测试文件在 `server/test/` 与 `web/test/`，命名 `*.test.ts`，node 会为每个文件起独立进程——这一点很重要：`openDb()` 是单例，多个文件共享进程会互相污染数据库。

`web/test/` 放前端纯逻辑的用例（例如 `vocabularyMatch` 的词形推导），由 server 的 `tsx` 统一执行：web 自己没有测试运行器，为几个纯函数再装一套工具链不值得。写这类用例时注意别 import 触碰 DOM 的模块，除非自己补上 `DOMParser`。

现有覆盖（13 个文件、68 个用例）：文本归一化与 SimHash 指纹、查重（URL / 标题门槛 / 相似度）、关键词过滤与回溯重判的两个方向、`includeFiltered` 的视图约束、OPML 导入导出往返、设置归一化的越界夹紧、分页游标、图片代理签名与改写幂等、**翻译分段与回填的序号映射**、**AI 流的 CRLF 分帧 / 结尾补帧 / 读 body 阶段超时**、生词例句的入队去重与 5 句上限、**生词词形兜底（复数 / 所有格 / 规则时态 / 不规则动词反查）**。

后两类是「静默损坏型」缺陷的守门员，改 `translate.ts` 或 `ai.ts` 时请一起跑：译文错位不会报错，只会让用户读到张冠李戴的内容。`test/ai-stream.test.ts` 用本地 `http` 起一个假模型服务，不连外网。

写新测试时优先打**纯函数**与**内存库**（`openDb(':memory:')`），不要连真实网络（`rss.ts` / `ai.ts` 的网络路径靠手工验证）。

## 调试技巧

**跳过令牌**：`FEEDFUSE_ALLOW_ANON=1` 启动 sidecar，所有 `/api/*` 直接放行（`dev-local.mjs` 已经帮你设好）。生产路径上外壳会 `env_remove` 掉它，别在发布版里留这个开关。

**健康检查**：`GET /api/health` 返回版本、uptime、`dbPath`、各表条数、pid —— 判断「服务活着但数据没写进去」很快。

```bash
curl --noproxy '*' http://127.0.0.1:9559/api/health
```

> 本机有 `HTTP(S)_PROXY` 时访问 127.0.0.1 也要加 `--noproxy '*'`，否则请求会被代理吞掉（表现为连不上或 502）。

**看数据库**：`node:sqlite` 写的是标准 SQLite 文件，直接用 CLI：

```bash
sqlite3 .dev-data/feedfuse.db '.tables'
sqlite3 .dev-data/feedfuse.db "select id,title,last_fetch_status,last_fetch_error from feeds;"
sqlite3 .dev-data/feedfuse.db "select level,message,created_at from system_logs order by id desc limit 20;"
```

**看日志**：应用内「日志」页（`/api/logs`）按 `level` 过滤；抓取问题看 `category` 为 `rss`/`ingest`，AI 问题看 `ai_summary`/`ai_translate`。

**后端热重启**：`dev-local.mjs` / `pnpm dev:server` 用的是 `tsx watch`，改 `server/src` 自动重启（注意此时端口释放-重占用要一两秒，前端会短暂 502）。

**前端连不上后端**：Vite 代理写死 `127.0.0.1:9559`，单独跑 `pnpm dev:server` 时也要 `FEEDFUSE_PORT=9559`。

**端口被占 / 上次没退干净**：`dev-local.mjs` 启动前会双栈（127.0.0.1 + ::1）探测端口：

- **9559 被占** → 直接报错退出并给出占用 PID（不能顺延，Vite 代理写死了这个端口）
- **5173 被占** → 打印警告，Vite 自动顺延到 5174，脚本会把真实地址高亮成 `▸ 前端已就绪：…`

```bash
lsof -nP -iTCP:9559 -sTCP:LISTEN     # 查占用者
lsof -nP -iTCP:5173 -sTCP:LISTEN
kill <PID>                            # 释放端口
```

> 如果用 `kill -9` 杀掉过 `dev-local.mjs`，它拉起的 `vite` / `tsx` 子进程可能存活（子进程在独立进程组里）。正常 `Ctrl-C` 会连带收掉；被强杀后按上面两条 `lsof` 清理即可。

**只想临时换个端口**：`FEEDFUSE_PORT` 无效（脚本写死 9559），要改请同时改 `scripts/dev-local.mjs` 的 `SERVER_PORT` 与 `web/vite.config.ts` 的 proxy target。

**模拟打包态**（不装 Tauri，只验证资源齐不齐）：

```bash
pnpm build && node scripts/stage-sidecar.mjs
cd src-tauri/resources/server
FEEDFUSE_ALLOW_ANON=1 FEEDFUSE_DATA_DIR=/tmp/ff-probe \
FEEDFUSE_STATIC_DIR="$PWD/../web" FEEDFUSE_PORT=9589 node server.mjs
# 另开：curl --noproxy '*' http://127.0.0.1:9589/api/health
```

`stage-sidecar.mjs` 会打印每个产物的体积；`node_modules` 只有生产依赖（约 30 MB，全是解引用后的真实文件，没有 pnpm 符号链接，避免打包/Windows 上的软链问题）。

**外壳侧**：`tauri dev` 时不用先 `fetch-node`——`resolve_node()` 会回退到 PATH 里的 node；想指定特定版本可以用 `FEEDFUSE_NODE_BIN=/path/to/node`。外壳日志里 `[feedfuse] node = … / server = … / staticDir = …` 三行能直接看出解析到了哪套路径。

## 代码约定

- 响应包裹只用 `ok()` / `fail()`；错误用 `AppError` 子类，`code` 用下划线小写（`validation_error`、`not_found`、`conflict`、`upstream_error`）。
- 面向用户的文案统一中文；日志 `message` 也是中文，`context` 里放结构化字段。
- `domain/` 不 import `hono`，只依赖 `db/` 与 `lib/`；`routes/` 不做 SQL；`services/` 只处理外部交互。
- 数据库里存**原始** HTML 与**原始**图片地址，图片代理改写只发生在 `presentArticle()` / `present()` 这种出站转换里。
- esbuild 保持 `packages: 'external'`：不要把第三方依赖打进 `server.mjs`，`jsdom` 这类库含动态 `require`，打包后会运行期失效。
