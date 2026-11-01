-- FeedFuse desktop schema (SQLite)
-- 单用户本地库：不再有 user_id 维度，也不再有 Fever 远程账号投影。

create table if not exists meta (
  key text primary key,
  value text not null
);

create table if not exists categories (
  id integer primary key autoincrement,
  name text not null,
  position integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists categories_name_unique on categories (lower(name));

create table if not exists feeds (
  id integer primary key autoincrement,
  title text not null,
  url text not null,
  site_url text,
  icon_url text,
  enabled integer not null default 1,
  category_id integer references categories(id) on delete set null,
  fetch_interval_minutes integer not null default 30,
  etag text,
  last_modified text,
  last_fetched_at text,
  last_fetch_status integer,
  last_fetch_error text,
  full_text_on_open_enabled integer not null default 0,
  full_text_on_fetch_enabled integer not null default 0,
  ai_summary_on_open_enabled integer not null default 0,
  title_translate_enabled integer not null default 0,
  body_translate_enabled integer not null default 0,
  article_list_display_mode text not null default 'card',
  created_at text not null,
  updated_at text not null
);
create unique index if not exists feeds_url_unique on feeds (url);
create index if not exists feeds_category_idx on feeds (category_id);
create index if not exists feeds_enabled_idx on feeds (enabled, id);

create table if not exists articles (
  id integer primary key autoincrement,
  feed_id integer not null references feeds(id) on delete cascade,
  dedupe_key text not null,
  title text not null,
  title_original text,
  title_zh text,
  link text,
  author text,
  published_at text,
  content_html text,
  content_full_html text,
  summary text,
  preview_image_url text,
  source_language text,
  fetched_at text not null,
  is_read integer not null default 0,
  read_at text,
  is_starred integer not null default 0,
  starred_at text,
  ai_summary text,
  ai_summary_model text,
  ai_summarized_at text,
  ai_translation_zh_html text,
  ai_translation_bilingual_html text,
  is_filtered integer not null default 0,
  filtered_by text,
  -- passed / filtered / pending / error；pending 与 error 只出现在 AI 语义过滤的异步判定里。
  filter_status text not null default 'passed',
  -- 给前端展示「为什么被过滤」：keyword / ai / duplicate_url / duplicate_title / duplicate_similar
  filter_reason text,
  -- 去重用的归一化字段，入库时算一次，之后跨订阅比较只走索引。
  url_normalized text,
  title_normalized text,
  content_fingerprint text
);
create unique index if not exists articles_dedupe_unique on articles (feed_id, dedupe_key);
create index if not exists articles_sort_idx on articles (published_at desc, id desc);
create index if not exists articles_feed_sort_idx on articles (feed_id, published_at desc, id desc);
create index if not exists articles_unread_idx on articles (is_read, published_at desc, id desc);
create index if not exists articles_starred_idx on articles (is_starred, published_at desc, id desc);
-- 注意：`filter_status` / `url_normalized` 等新列的索引不能写在这里。
-- schema.sql 先于迁移执行，老库还没这些列时 create index 会直接报 "no such column"。
-- 新列的索引统一放在 db/migrate.ts 里。

create virtual table if not exists articles_fts using fts5(
  title,
  summary,
  content,
  content='articles',
  content_rowid='id',
  tokenize='unicode61'
);

create trigger if not exists articles_fts_ai after insert on articles begin
  insert into articles_fts(rowid, title, summary, content)
  values (new.id, new.title, coalesce(new.summary, ''), coalesce(new.content_html, ''));
end;

create trigger if not exists articles_fts_ad after delete on articles begin
  insert into articles_fts(articles_fts, rowid, title, summary, content)
  values ('delete', old.id, old.title, coalesce(old.summary, ''), coalesce(old.content_html, ''));
end;

create trigger if not exists articles_fts_au after update of title, summary, content_html on articles begin
  insert into articles_fts(articles_fts, rowid, title, summary, content)
  values ('delete', old.id, old.title, coalesce(old.summary, ''), coalesce(old.content_html, ''));
  insert into articles_fts(rowid, title, summary, content)
  values (new.id, new.title, coalesce(new.summary, ''), coalesce(new.content_html, ''));
end;

-- AI 摘要会话：把「排队/进行中/完成/失败」落到库里，前端刷新后仍能看到进度。
create table if not exists article_ai_summary_sessions (
  id integer primary key autoincrement,
  article_id integer not null references articles(id) on delete cascade,
  status text not null,
  draft_text text not null default '',
  final_text text,
  error_code text,
  error_message text,
  model text,
  created_at text not null,
  updated_at text not null,
  finished_at text
);
create index if not exists ai_summary_sessions_article_idx
  on article_ai_summary_sessions (article_id, updated_at desc);

create table if not exists app_settings (
  id integer primary key check (id = 1),
  json text not null,
  ai_api_key text,
  translation_api_key text,
  updated_at text not null
);

create table if not exists system_logs (
  id integer primary key autoincrement,
  level text not null,
  category text not null,
  message text not null,
  details text,
  source text not null,
  context_json text not null default '{}',
  created_at text not null
);
create index if not exists system_logs_created_idx on system_logs (created_at desc, id desc);

create table if not exists vocabulary_entries (
  id integer primary key autoincrement,
  term text not null,
  normalized_term text not null,
  definition text not null default '',
  source_article_id integer,
  source_title text not null default '',
  source_url text not null default '',
  source_sentence text not null default '',
  -- 例句列表（JSON 数组，最多 5 条，先进先出）。source_sentence 保留为最早一句的镜像，
  -- 老版本前端与已有数据都还依赖它，不能直接删列。
  sentences text not null default '[]',
  created_at text not null,
  updated_at text not null
);
create unique index if not exists vocabulary_normalized_unique on vocabulary_entries (normalized_term);

create table if not exists dictionaries (
  id integer primary key autoincrement,
  name text not null,
  entry_count integer not null default 0,
  enabled integer not null default 1,
  created_at text not null,
  -- inline：词条直接存库（CSV/JSON/纯文本导入）
  -- mdx / stardict：原文件留在 dictionaries/<uuid>/，库里只存词头与 record 偏移
  format text not null default 'inline',
  storage text not null default 'sqlite',
  content_type text not null default 'text',
  source_dir text,
  source_file text,
  resource_file text,
  meta_json text,
  size_bytes integer
);

create table if not exists dictionary_entries (
  id integer primary key autoincrement,
  dictionary_id integer not null references dictionaries(id) on delete cascade,
  term text not null,
  normalized_term text not null,
  definition text not null,
  phonetic text,
  -- 文件型词典专用：释义在原文件里的字节区间（StarDict 是 .dict 偏移，MDX 是 record 偏移）
  record_start integer,
  record_end integer
);
create index if not exists dictionary_entries_term_idx on dictionary_entries (dictionary_id, normalized_term);
-- 划词查词的查询只按 normalized_term 过滤（词典是否启用走 join），
-- 复合索引的前导列是 dictionary_id，用不上，所以单独给这一列建一个。
create index if not exists dictionary_entries_norm_idx on dictionary_entries (normalized_term);
-- 同一本词典内一个词条只该有一行：重复导入、MDX 里同名词头都靠它收敛。
create unique index if not exists dictionary_entries_unique on dictionary_entries (dictionary_id, normalized_term);

create virtual table if not exists dictionary_entries_fts using fts5(
  term,
  normalized_term,
  definition,
  content='dictionary_entries',
  content_rowid='id',
  tokenize='unicode61'
);

create trigger if not exists dictionary_entries_fts_ai after insert on dictionary_entries begin
  insert into dictionary_entries_fts(rowid, term, normalized_term, definition)
  values (new.id, new.term, new.normalized_term, new.definition);
end;

create trigger if not exists dictionary_entries_fts_ad after delete on dictionary_entries begin
  insert into dictionary_entries_fts(dictionary_entries_fts, rowid, term, normalized_term, definition)
  values ('delete', old.id, old.term, old.normalized_term, old.definition);
end;
