# 架构说明

面向要改代码的人。所有结论都能在 `server/src`、`src-tauri/src` 里找到对应实现，行号可能漂移，以文件为准。

## 1. 进程模型

```
FeedFuse（Rust / Tauri v2）
├── 主进程：窗口、生命周期、拉起并监管 sidecar
└── 子进程：node <Resources>/server/server.mjs
             ├── Hono HTTP 服务（127.0.0.1:<随机端口>）
             ├── 静态资源托管（<Resources>/web）
             └── 定时抓取（每 60s 一次 tick）
```

要点：

- **不用 `tauri-plugin-shell`**。`src-tauri/src/sidecar.rs` 直接用 `std::process::Command`，省掉 capability 配置；`capabilities/default.json` 只有 `core:default`。
- 窗口配置 `visible: false`，收到握手行并 `navigate(baseUrl)` 之后才 `show()`，避免白屏。
- 子进程的 `stdout` 逐行转发到终端（前缀 `[sidecar]`），`stderr` 前缀 `[sidecar!]`；同时从 stdout 里挑出握手行。
- 退出时（`RunEvent::ExitRequested` / `Exit`）调用 `sidecar::shutdown()`：Unix 上先发 `SIGTERM`（`libc::kill`），轮询 `try_wait()` **最多等 5 秒**，让 node 走自己的 `SIGTERM` 处理、把 WAL 落盘；超时才 `child.kill()`（SIGKILL）强杀。Windows 没有 SIGTERM 语义，直接用 `Child::kill()`（TerminateProcess），之后同样轮询等待。
- 前端与 API **同源**：WebView 直接加载 `http://127.0.0.1:<port>/`，不用 `tauri://localhost`。所以生产环境不依赖 CORS，也不需要 Tauri 的资源协议。

## 2. 握手协议

sidecar 在 `serve()` 的监听回调里打印一行（`server/src/main.ts`）：

```
[feedfuse-ready] {"port":56123,"token":"9f2c…","baseUrl":"http://127.0.0.1:56123","dbPath":"…/feedfuse.db","version":"0.5.0"}
```

| 字段 | 说明 |
| --- | --- |
| `port` | 实际监听端口。外壳传 `FEEDFUSE_PORT=0`，由系统分配，避免端口冲突 |
| `token` | 本次运行的本地访问令牌（外壳生成后通过环境变量传入，回读一遍便于校验） |
| `baseUrl` | 完整基地址，外壳直接拿它导航 |
| `dbPath` | 数据库绝对路径，便于日志排查 |
| `version` | 服务端版本，用于日志与设置页展示 |

约定：

- 前缀必须逐字匹配 `[feedfuse-ready]`；外壳用 `serde` 的 `rename_all = "camelCase"` 解析（`base_url` ← `baseUrl`）。
- 只认**第一次**握手，重复打印会被忽略。
- 等待策略：每 5 秒切片轮询（`READY_TICK`），总预算 120 秒（`READY_BUDGET`）；超过 5 秒会先把窗口显示成「正在启动本地服务…」。超预算或子进程提前退出时才显示启动失败页。
- 任何调试输出都不要写进这一行；其余日志随便打，转发层只挑前缀。

## 3. 令牌鉴权

单机也要防「同机其他进程/浏览器页面随手调本机接口」，所以有一次性令牌。

- 令牌来源：`FEEDFUSE_TOKEN`，缺省时 `randomUUID()`（`server/src/config.ts`）。
- 校验中间件挂在 `/api/*` 上（`server/src/http/app.ts`）：
  - `OPTIONS` 预检放行；
  - `/api/image*` 放行（`<img>` 无法带自定义头，改走签名，见第 7 节）；
  - `FEEDFUSE_ALLOW_ANON=1` 时整体放行（**仅开发**，外壳启动前会 `env_remove` 掉它）；
  - 否则要求 `x-feedfuse-token` 请求头**或** `ff_token` cookie 与 `cfg.token` 完全相等，不匹配抛 `401 unauthorized`。
- 前端从 `window.__FEEDFUSE__.token` 取令牌并塞进请求头（`web/src/api/client.ts`）。
- CORS 只在开发时有用：只放行 `http://localhost:<port>` / `http://127.0.0.1:<port>` 形式的 origin，允许 `content-type`、`x-feedfuse-token` 头。

**令牌注入点**：`injectRuntimeConfig()` 由 `serveIndex` 执行，而 `/`、`/index.html`、SPA 兜底路由都走 `serveIndex`。这个注册顺序是硬约束——`serveIndex` 必须**先于** `serveStatic` 挂载，否则静态中间件会把 `index.html` 原样吐出去，页面里没有令牌，所有 `/api/*` 都 401。改 `mountStatic()` 时不要调换这两段。

## 4. SQLite

驱动是 Node 内置的 `node:sqlite`（同步 API），封装在 `server/src/db/sqlite.ts`：语句缓存、参数归一化（`boolean → 0/1`、`undefined → null`）、可嵌套事务（外层 `begin immediate`，内层 savepoint）。

连接参数：`journal_mode = wal`、`synchronous = normal`、`foreign_keys = on`、`busy_timeout = 5000`、`temp_store = memory`。

### 表结构概览

| 表 | 作用 |
| --- | --- |
| `meta` | 键值元信息，启动时写 `schema_version`（当前为 3） |
| `categories` | 分类，`lower(name)` 唯一 |
| `feeds` | 订阅；含抓取状态（`etag` / `last_modified` / `last_fetch_status` / `last_fetch_error`）、每源开关（全文/摘要/翻译）、`fetch_interval_minutes`、`article_list_display_mode` |
| `articles` | 文章主表；`(feed_id, dedupe_key)` 唯一，正文 `content_html` + 全文 `content_full_html`，状态 `is_read` / `is_starred` / `is_filtered`，AI 结果 `ai_summary*` / `ai_translation_*`；过滤与去重列见第 5 节 |
| `article_ai_summary_sessions` | 摘要生成会话（`queued/running/succeeded/failed` + 草稿文本），刷新页面后仍能续上进度 |
| `app_settings` | 单行表（`id = 1`），业务配置存 `json`，密钥单独放在 `ai_api_key` / `translation_api_key` |
| `system_logs` | 运行日志，`level` / `category` / `details` / `context_json`，按保留天数裁剪 |
| `vocabulary_entries` | 生词本，`normalized_term` 唯一，带来源文章；例句存 `sentences` JSON 数组（最多 5 条，先进先出），`source_sentence` 保留为最早一句的镜像 |
| `dictionaries` / `dictionary_entries` | 词典元信息与词头；两本内置词典是只读资源（`server/assets/builtin/` 分片 + `phrases.json`），不进库。文件型词典（MDX / StarDict）在这里只存 `record_start` / `record_end`，释义回原文件读 |
| `articles_fts` | FTS5 虚拟表（`title` / `summary` / `content`，`content='articles'`），由三个触发器与 `articles` 同步 |
| `dictionary_entries_fts` | 词条 FTS5，同样由触发器维护 |

索引要点：`feeds_url_unique`、`articles_feed_sort_idx`（`feed_id, published_at desc, id desc`）、`articles_unread_idx`、`articles_starred_idx`、`articles_sort_idx`、`system_logs_created_idx`、`ai_summary_sessions_article_idx`、`dictionary_entries_norm_idx`（划词查词只按 `normalized_term` 过滤，复合索引 `(dictionary_id, normalized_term)` 的前导列用不上）。

**有版本迁移系统**（`server/src/db/migrate.ts`）。启动流程固定为：`schema.sql`（描述最新结构，全部 `if not exists`）→ `runMigrations()` 按 `meta.schema_version` 补 `alter table`。

两条硬规矩：

1. **不要在 `schema.sql` 里给「新增列」建索引**。schema.sql 先于迁移执行，老库还没这一列，`create index` 会直接报 `no such column`。新列的索引写在迁移步骤里。
2. 迁移的每一步都要幂等（`addColumn` 先查 `pragma table_info`），这样新库、老库、半途失败的库跑完都得到同一结果。

当前有 2 步迁移（`2: articles 过滤原因与去重指纹`、`3: vocabulary 例句列表`）。改表结构的完整流程见 `docs/DEVELOPMENT.md`。

## 5. RSS 抓取链路

```
scheduler（每 60s）
  → listDueFeeds()（按 feeds.fetch_interval_minutes 与 last_fetched_at 判断到期）
  → refreshFeeds(取前 12 个, 并发受限)
      → GET feed.url
          headers: User-Agent(FeedFuse/<ver> (+desktop)) / If-None-Match / If-Modified-Since / 超时 15s
          → 304 则跳过
          → 字符集判定：Content-Type → XML 声明 → utf-8；非 utf-8 走 iconv-lite 解码
      → rss-parser 解析（自定义字段 content:encoded / media:content / media:thumbnail / dc:creator）
      → sanitize-html 净化正文 + 生成纯文本摘要 + 首图
      → dedupe_key 去重 → upsert articles（唯一索引兜底）
      → 同步过滤：关键词命中 / 跨订阅查重 → is_filtered + filter_reason
      → 异步过滤：未被前两层挡掉的，入 AI 语义过滤队列（并发 3）
      → 每源保留 maxStoredArticlesPerFeed 条，超出裁剪
      → 回写 etag / last_modified / last_fetch_status / last_fetch_error
```

细节：

- 单源手动刷新走 `POST /api/feeds/:id/refresh`（`force: true`，忽略到期与 `enabled`）；全量刷新走 `POST /api/feeds/refresh`，进度在内存里，用 `GET /api/feeds/refresh/status` 轮询。
- 首次 tick 延迟 8s，让界面先完成首屏；`setInterval` 已 `unref()`，不会阻止进程退出。
- 每分钟 tick 只做抓取，另有每小时一次的维护 tick（按 `logging.retentionDays` 裁日志）。
- 日志落在 `system_logs`，`category` 取 `feed` / `article` / `settings` 等，界面「日志」页可直接看。
- 抓取失败只记录、不抛给前端（除非是手动刷新/校验这类同步请求）。
- 网络抖动会重试一次（500ms 后）；429 不重试，文案提示调大该订阅的抓取间隔。

## 5.1 文章过滤体系（`server/src/services/filters/`）

三层，代价从低到高，前面的能判就不问后面的：

| 层 | 触发时机 | 判定 | 落库 |
| --- | --- | --- | --- |
| 关键词 | 入库同步 | `title` + 摘要 + 正文纯文本，大小写不敏感包含 | `filter_reason = 'keyword'`，命中词存 `filtered_by` |
| 查重 | 入库同步 | URL 归一 → 标题归一 → SimHash 相似度 | `duplicate_url` / `duplicate_title` / `duplicate_similar` |
| AI 语义 | 入库后异步 | 模型只回 `FILTER`/`ALLOW`（`temperature=0`，8 token） | `ai`；失败落 `filter_status='error'` 但**不隐藏文章** |

要点：

- `filter_status` 取 `passed` / `filtered` / `pending` / `error`，与 `is_filtered` 分开：前者说「流程走到哪」，后者说「用户能不能看见」。
- 去重的三个归一化字段（`url_normalized` / `title_normalized` / `content_fingerprint`）在入库时算一次并存库，之后比较只走索引，不再重复解析 HTML。
- 指纹是 64 位 SimHash（3-gram shingle → sha1 前 8 字节），正文 < 80 字符不生成；候选集用 **LSH 分带**（4 段 ×16 位，任一段相同即候选）缩小，再用汉明距离判阈值。只用「前 16 位相同」召回太低（相似度 0.85 时约 6%），分带能到 ~25%。
- 查重只跟 `id` 更小的文章比，保证每次留下最早入库的那条；标题短于 8 字符不参与标题查重（「周报」这类栏目名会大面积误杀）。
- AI 队列是**纯内存**的：进程退出会丢，所以启动时 `clearPendingFilterStatus()` 把残留 `pending` 放回 `passed`，否则那些文章会永远显示「判定中」。
- 改过滤规则（关键词、查重开关、相似度、AI 开关与提示词）后，`routes/settings.ts` 会自动触发 `startReapplyFilters()` 后台重判；关键词与查重可以**取消**已有过滤（删掉关键词，被误杀的文章要回来），AI 语义过滤默认不参与回溯（每篇都是一次真实调用），需要显式 `includeAi`（`POST /api/articles/reapply-filters` 的请求体）。
- **关掉 AI 语义过滤会把被它判掉的文章一次性放回可见**（`clearAiFilteredArticles()`）：那些文章的 `is_filtered` 是模型写的，用户关掉开关后没有理由让它们继续隐身，而唯一的恢复路径不该是「再花几千次模型调用重判一遍」。
- 重判只动过滤相关的列，绝不碰 `is_read` / `is_starred`。留存裁剪（`pruneFeedArticles`）同样跳过 `is_starred = 1`：收藏是唯一不可再生的数据。

## 6. 全文提取

`server/src/services/fulltext.ts`：

1. `fetch` 原文 URL（固定 UA、`accept-language`、15s 超时），跟随重定向；
2. 按 `Content-Type` / `<meta charset>` 解码（iconv-lite）；
3. `JSDOM` + `@mozilla/readability` 取主体；
4. `sanitize-html` 净化 → 图片 `src` 绝对化（**不**改写成代理地址）；
5. 结果写回 `articles.content_full_html`，同时返回 `wordCount` / `excerpt`。

> 抓全文后要在同一处重算 `content_fingerprint`：全文比 RSS 摘要长得多，指纹才有区分度，
> 否则跨订阅查重只能拿两行摘要去比，几乎匹配不到转载。

**代理改写只发生在出站**（`presentArticle()`）：数据库里存的永远是源站原始地址。曾经在
`extractFulltext` 里就把图片改写成 `/api/image?u=…` 存库，结果下一次 `presentArticle()`
又把这条相对地址按文章 URL 绝对化，包成 `u=http://源站/api/image?u=…` 的两层嵌套，图片全部 502。
`rewriteImagesToProxy()` 现在对已经是 `/api/image?…` 的地址直接原样返回（幂等），
同时会一并改写 `srcset`——只改 `src` 时浏览器优先用 `srcset`，等于没绕开第三方直连。

提取失败或结果过短会返回 `null`，调用方保留 RSS 原始正文，前端提示「未能提取到正文内容，可能被源站反爬拦截」。

触发点：`POST /api/articles/:id/fulltext`（打开时按需）、以及抓取阶段当 `feeds.full_text_on_fetch_enabled = 1`。

## 7. 图片代理与签名

`<img>` 发不出自定义头，所以图片走「URL 签名」而不是令牌：

```
/api/image?u=<encodeURIComponent(绝对URL)>&s=<签名>
签名 = base64url(HMAC-SHA256(FEEDFUSE_IMAGE_SECRET, 绝对URL)).slice(0, 16)
```

- 密钥：`FEEDFUSE_IMAGE_SECRET`，缺省 `feedfuse-local`（本机单用户，够用；改它等于让旧链接全部失效）。
- 校验：`timingSafeEqual` 逐字符异或比较，长度也要相等。
- 代理端只允许 `http:` / `https:`，只回 `image/*`，单张上限 12 MB，超时用 `requestTimeoutMs`；失败分别回 502 / 415 / 413。
- 响应带 `cache-control: public, max-age=86400`，WebView 会缓存一天。
- 使用范围：订阅图标（`feeds.iconUrl`）、文章正文、全文、双语译文 HTML —— 统一在 `presentArticle()` / `present()` 里改写，数据库里存的始终是原始地址。

这样做的两个目的：绕开源站 Referer 防盗链；让 WebView 不必直连任意第三方域名。

## 8. AI 与 SSE 事件格式

上游调用（`server/src/services/ai.ts`）：

- `POST ${apiBaseUrl}/chat/completions`，`authorization: Bearer <key>`，`stream: true`；
- 逐行解析 `data:`，只取 `choices[0].delta.content`（`reasoning_content` 丢弃）；
- 网关不支持流式时（返回非 `text/event-stream`）自动退回一次性解析；
- 状态码翻译成人话：401/403 → Key 无效、404 → Base URL 缺 `/v1`、429 → 频率/额度、5xx → 上游异常。

对前端的流（`streamSSE`），事件名固定为三种：

**摘要 `POST /api/articles/:id/summary/stream`**

```
event: delta   data: {"text":"..."}       # 增量片段
event: done    data: {"text":"完整摘要"}   # 结束，已写入 articles.ai_summary
event: error   data: {"message":"..."}    # 失败原因（同时落库 system_logs）
```

生成过程每 800ms 把草稿写进 `article_ai_summary_sessions.draft_text`；进程异常退出后，启动时 `failStaleSummarySessions()` 把残留会话标成失败，避免前端一直转圈。
同一篇文章再次点「生成」时，`startSummarySession()` 会先把该篇残留的 `running/queued` 会话标成 `superseded`，保证「一篇只有一个在跑的会话」——否则两条流会互相覆盖，后结束的那条决定成败，另一条永远停在 running。

模型返回空内容（上游提前断流、网关返回空 `choices`）时直接抛错，**不落库**：一条空摘要会覆盖用户已经生成好的那份，前端还只会看到「成功但什么都没有」。

**正文翻译 `POST /api/articles/:id/translation/body/stream`**

正文按 `TRANSLATABLE_SELECTOR`（`p/h1-h6/li/blockquote/figcaption/td`）切成最内层段落，每 8 段一批：

```
event: progress  data: {"translated":[{"id":1,"text":"..."}]}   # 每批完成后回传"累计已翻译"
event: done      data: {"zhHtml":"...","bilingualHtml":"...","totalSegments":42,"translatedSegments":40}
event: error     data: {"message":"..."}
```

某一批失败只记 warning 日志并跳过；全批都失败才抛错。

**英文讲解 `POST /api/english/explain` / `POST /api/english/word-detail`**

请求体：

```json
{ "articleId": "1", "selectedText": "完整选区", "sentences": ["完整句子"], "context": "所在段落" }
```

单词详细解释额外带 `term`；两条链路都固定使用内置提示词，其中句子讲解允许设置里覆盖。

```
event: delta  data: {"text":"..."}
event: done   data: {}
event: error  data: {"message":"..."}
```

查词优先级全部合并在服务端（`domain/dictionaries.ts` 的 `lookupWord`）：

1. 用户导入词典（精确命中，按导入先后）；
2. 启用中的内置词典——三本独立数据源：中英核心词库 / WordNet / 词组词典，
   同一词头命中多本时合成一条（行序：词组 → 中文 → 英英，音标优先 IPA）；
3. 词形还原后的 1～2 步；
4. 用户词典的 FTS / 前缀模糊兜底。

三本内置词典的开关存在 `app_settings` 的 `dictionaries.disabledIds`（默认全开，存「停用了哪些」）。
设置页整包保存不会覆盖它，只有词典面板的 PATCH 能改——避免草稿快照把开关写回去。

第 4 步是「选中的是变形」的出路，规则在 `lib/morphology.ts`：候选必须带词性
（`-ed` / `-ing` 只能来自动词，`-er` / `-est` 只能来自形容词），并且**必须真的存在于词典**。
变形词自己也是词条时（`studied` 作形容词）两条释义合并返回，中间插一行「（studied 是 study 的过去式/过去分词）」。
词组只还原一个位置：`looked forward to → look forward to`。

划词侧的选区补全、整句裁剪、词组回退在 `web/src/features/learning/` 里，和原版保持同一套规则。

### 文件型词典（MDX / StarDict）

用户从网上下到的词典基本都是 MDict（`.mdx` + `.mdd`）或 StarDict（`.ifo` + `.idx` + `.dict`），
两种格式本身就是「词头索引 + 可随机访问的数据块」，所以**释义不搬进 SQLite**：

```
dictionaries/<uuid>/xxx.mdx          原文件副本（随导入复制，用户删掉下载目录也不影响）
dictionaries/<uuid>/xxx.mdd          图片/样式/音频，只做资源托管
dictionaries/_staging/<token>/       上传暂存，导入完成后整目录删除
```

- `dictionaries.storage = 'file'` 时，`dictionary_entries.definition` 为空字符串，
  靠 `record_start` / `record_end`（StarDict 是 `.dict` 字节偏移，MDX 是 record 偏移）回原文件取。
  这样 24 万词条的词典只占约 15 MB 索引，而不是把 HTML 释义撑成 3～4 倍体积。
- 查询期由 `domain/dict/readers.ts` 缓存已打开的句柄（最多 2 个、空闲 5 分钟回收）：
  MDX 打开时会解出全部词头（24 万词头约 56 MB 堆内存），不回收的话装几本大词典就很难看。
- `.mdd` 里的资源走 `GET /api/dictionaries/:id/resource?key=`，`<img>` 带不上请求头，
  所以令牌允许走查询参数（`app.ts` 的鉴权中间件）。
- MDX 的释义是 HTML：`content_type = 'html'`，服务端用 `sanitize-html` 去脚本/外部样式、
  把相对图片地址改写成本地资源接口，前端用 `.ff-dict-html` 容器渲染。
- `@@@LINK=target` 重定向词条在导入期就解析到目标 record；目标缺失直接丢弃，
  避免用户点开看到一行裸的 `@@@LINK=`。
- 同一本词典里 `-ability` 与 `ability` 归一化后都是 `ability`，导入时按「正常词头优先」排序，
  否则 MDX 的字典序会让后缀词条顶掉常用词。

导入接口分两步：`POST /api/dictionaries/uploads` 建会话 → 逐个文件 `POST .../uploads/:token/files`
（原始二进制流式落盘，不用 multipart）→ `POST /api/dictionaries/import-files` 统一解析。
多文件分成两步是为了让 `.mdx` 和 `.mdd` 能在同一次导入里配对，而不是各自变成半本词典。

纯文本词表（CSV / JSON / `word<TAB>释义`）仍走 `storage = 'sqlite'`：词条直接入库，FTS 全文检索可用。

前端统一用 `streamRequest()`（`web/src/api/client.ts`）手工解析：按 `\n\n` 切事件块，读 `event:` / `data:`，`data` 尽量 `JSON.parse`，支持 `AbortSignal` 取消（取消后 `reader` 抛 `AbortError` 视为正常结束）。

两端的流解析都要容忍三件「不规范但常见」的事：

- **CRLF 分帧**：网关回 `\r\n\r\n` 时只找 `\n\n` 会一个事件都切不出来，读到的增量是 0；
- **最后一帧没有空行结尾**：读完流后缓冲区里还留着完整数据，必须再解析一次；
- **超时要覆盖读 body 阶段**：只在 `fetch` 返回响应头时清理定时器的话，上游「先回 200 再挂起」会让 SSE 永远不结束、摘要会话永远停在 running。`ai.ts` 的 `ChatFetch` 把 `dispose()` 交给调用方，读完 body 才释放。

统一响应包裹：普通接口一律 `{"ok":true,"data":…}` / `{"ok":false,"error":{"code","message","fields?"}}`，由 `server/src/http/envelope.ts` 的 `ok()` / `fail()` 产出；未预期异常回 500 并**带上真实 `detail`**（单机场景，方便排查）。

## 9. 静态资源托管

`mountStatic()`（`server/src/http/app.ts`）：

- 没有 `FEEDFUSE_STATIC_DIR`（或目录不存在）→ 纯 API 模式，`/` 回一个说明页；
- 有 → `serveStatic({ root })`，`/` 重写为 `/index.html`；
- 其余未命中路径走 `app.get('*')` 兜底返回 `index.html`（SPA 路由），并在这里注入 `window.__FEEDFUSE__ = { token, version, apiBase: '' }`。

`apiBase` 恒为空串：前端所有请求都是相对路径，同源即可。

## 10. 外链打开（为什么不用 plugin-shell）

窗口加载的是 `http://127.0.0.1:<port>/`，WebView 里点 `target="_blank"` 的链接**没有任何默认行为**——不装 `tauri-plugin-shell` / `tauri-plugin-opener` 的话，正文里的链接和「原文」按钮全是死的。

本项目选择让 sidecar 打开系统浏览器，而不是引入插件：

- 前端 `openExternal(url)` → `POST /api/system/open-url` → `services/opener.ts`；
- opener 只放行 `http:` / `https:`（长度 ≤2048、无控制字符），用 `spawn(detached, stdio: 'ignore')` 调用 `open` / `cmd /c start ""` / `xdg-open`，**不用 `exec`**（避免 shell 注入）；同一 URL 500ms 内去重，防双击开两个窗口；
- 好处是能力全部留在本地 HTTP 层：`capabilities/default.json` 仍然只有 `core:default`，不必为「打开一个链接」给 WebView 开 IPC 权限。

`GET /api/system/info` 顺带提供 `platform` / `arch` / `node` / `dataDir`，给「关于」页展示，报障时用户直接截图即可。

## 11. 主题与强调色（`web/src/styles/index.css`）

「明暗」和「主题色」是两个独立设置项，分别落在 `<html>` 的两个属性上：

| 属性 | 取值 | 作用 |
| --- | --- | --- |
| `data-theme` | `light` / `dark`（`auto` 由系统 `prefers-color-scheme` 解析后写入） | 中性底色、描边、正文颜色 |
| `data-accent` | `sage` / `lilac` / `rose` / `mist` / `mono` | 只改强调色及其浅色派生 |

任何一个主题色都能和任一明暗组合，所以色板是「`[data-theme][data-accent]` 覆盖同一组变量」，而不是两套独立主题。

强调色拆成 6 个 token，各自解决一类场景：

- `--ff-accent`：**墨色**强调色。用于图标、圆点、描边、焦点环、正文链接——必须在当前中性底上看得清，深色模式下会提亮；
- `--ff-accent-fill`：实心填充色，就是用户选中的那个颜色（黑白方案浅色是米色、深色是 `#26282B`）；
- `--ff-accent-contrast`：填色上的文字。这几个颜色都是中间调，白字对比度不够，一律用深色字；黑白深色方案反过来；
- `--ff-accent-soft` / `--ff-accent-text`：选中态与提示条的浅底及其文字；
- `--ff-vocab-mark` / `--ff-vocab-mark-hover`：正文生词标记，取强调色再淡一大截（黑白方案是米色），只做「这个词我收过」的提示。

新增主题色的步骤：`server/src/domain/settings.ts` 的 `ThemeColor` 联合类型与 `normalizeSettings` 白名单、`web/src/lib/themeColors.ts` 的选项（色板与文案）、`index.css` 里两段 `[data-theme][data-accent]` 变量，共四处。
