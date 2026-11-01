import type { Db } from './sqlite';

/**
 * 极简迁移系统。
 *
 * 桌面版有「用户装了就一直在用」的特点，不能再靠删库升级。做法：
 * - `schema.sql` 始终描述**最新**结构，且全部 `if not exists`，新库一次到位；
 * - 这里按版本号补 `alter table`，老库升级到同一结构；
 * - 每一步都写成幂等的（先看列在不在），所以重复执行、半途失败都不怕。
 *
 * 新增字段的顺序：先改 `schema.sql`，再在这里加一步迁移，两者必须描述同一结果。
 */

const SCHEMA_VERSION_KEY = 'schema_version';

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

/** 当前库结构版本。每次改结构就 +1，并在 MIGRATIONS 末尾追加一步。 */
export const CURRENT_SCHEMA_VERSION = 4;

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.all<{ name: string }>(`pragma table_info(${table})`);
  return rows.some((row) => row.name === column);
}

/** 加列：已存在就跳过，避免老库/新库走不同分支。 */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: 'articles: 过滤原因与去重指纹',
    up(db) {
      // 过滤：区分「谁判的」与「判成什么」，pending/error 用于 AI 语义过滤的异步状态。
      addColumn(db, 'articles', 'filter_reason', 'text');
      addColumn(db, 'articles', 'filter_status', "text not null default 'passed'");

      // 去重：入库时算好归一化 URL / 标题 / 内容指纹，跨订阅比较才不需要全表扫。
      addColumn(db, 'articles', 'url_normalized', 'text');
      addColumn(db, 'articles', 'title_normalized', 'text');
      addColumn(db, 'articles', 'content_fingerprint', 'text');

      db.exec('create index if not exists articles_url_norm_idx on articles (url_normalized)');
      db.exec('create index if not exists articles_fingerprint_idx on articles (content_fingerprint)');
      db.exec('create index if not exists articles_filtered_idx on articles (is_filtered, published_at desc, id desc)');
      db.exec('create index if not exists articles_filter_status_idx on articles (filter_status, id)');
    },
  },
  {
    version: 3,
    name: 'vocabulary: 例句列表',
    up(db) {
      // 一个词可以有多个例句（最多 5 句，超出丢最早的），单独存一列 JSON 比拆表少一次 join。
      addColumn(db, 'vocabulary_entries', 'sentences', "text not null default '[]'");
      // 老数据只有单句：回填成一条，句子出处取当时记录的标题/链接/添加时间。
      const rows = db.all<{
        id: number;
        source_sentence: string;
        source_article_id: number | null;
        source_title: string;
        source_url: string;
        created_at: string;
        sentences: string;
      }>(
        `select id, source_sentence, source_article_id, source_title, source_url, created_at, sentences
         from vocabulary_entries`,
      );
      for (const row of rows) {
        if (row.sentences && row.sentences !== '[]') continue;
        if (!row.source_sentence.trim()) continue;
        db.run(
          'update vocabulary_entries set sentences = ? where id = ?',
          JSON.stringify([
            {
              text: row.source_sentence,
              articleId: row.source_article_id === null ? null : String(row.source_article_id),
              articleTitle: row.source_title,
              articleUrl: row.source_url,
              addedAt: row.created_at,
            },
          ]),
          row.id,
        );
      }
    },
  },
  {
    version: 4,
    name: 'dictionaries: 文件型词典（MDX / StarDict）与词条唯一约束',
    up(db) {
      // 文件型词典的释义不进库：原文件副本留在 dictionaries/<uuid>/，
      // 这里只记「去哪找、怎么渲染」，避免把 MDX 的 HTML 释义撑进 SQLite（约 3～4 倍体积）。
      addColumn(db, 'dictionaries', 'format', "text not null default 'inline'");
      addColumn(db, 'dictionaries', 'storage', "text not null default 'sqlite'");
      addColumn(db, 'dictionaries', 'content_type', "text not null default 'text'");
      addColumn(db, 'dictionaries', 'source_dir', 'text');
      addColumn(db, 'dictionaries', 'source_file', 'text');
      addColumn(db, 'dictionaries', 'resource_file', 'text');
      addColumn(db, 'dictionaries', 'meta_json', 'text');
      addColumn(db, 'dictionaries', 'size_bytes', 'integer');
      addColumn(db, 'dictionary_entries', 'record_start', 'integer');
      addColumn(db, 'dictionary_entries', 'record_end', 'integer');

      // 老库里同一词典可能有重复词条（open-import 没有唯一约束），先收敛再建索引，
      // 否则 create unique index 会直接失败，用户升级后词典页就打不开了。
      db.exec(
        `delete from dictionary_entries
         where id not in (select min(id) from dictionary_entries group by dictionary_id, normalized_term)`,
      );
      db.exec(
        'create unique index if not exists dictionary_entries_unique on dictionary_entries (dictionary_id, normalized_term)',
      );
    },
  },
];

function readVersion(db: Db): number {
  try {
    const row = db.get<{ value: string }>('select value from meta where key = ?', SCHEMA_VERSION_KEY);
    const parsed = Number.parseInt(row?.value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // meta 表还不存在（全新库由 schema.sql 创建），视为 0。
    return 0;
  }
}

function writeVersion(db: Db, version: number): void {
  db.run(
    `insert into meta (key, value) values (?, ?)
     on conflict(key) do update set value = excluded.value`,
    SCHEMA_VERSION_KEY,
    String(version),
  );
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

/** 在 `schema.sql` 执行完之后调用。 */
export function runMigrations(db: Db): MigrationResult {
  const from = readVersion(db);
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.tx(() => {
      migration.up(db);
      writeVersion(db, migration.version);
    });
    applied.push(`${migration.version}:${migration.name}`);
  }

  // 全新库（schema.sql 已建到最新结构）没有可跑的迁移，但要补上版本号。
  // 只在「比当前版本旧」时写：用户回滚到旧版应用时 from 会更大，这时把版本号改小
  // 会让下次升级误判「迁移未应用」，也丢掉了这库其实更新的信息。
  if (applied.length === 0 && from < CURRENT_SCHEMA_VERSION) {
    writeVersion(db, CURRENT_SCHEMA_VERSION);
  }

  return { from, to: from > CURRENT_SCHEMA_VERSION ? from : CURRENT_SCHEMA_VERSION, applied };
}
