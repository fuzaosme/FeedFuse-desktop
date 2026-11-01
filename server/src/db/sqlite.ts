import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { runMigrations } from './migrate';

/**
 * node:sqlite 是同步 API，绑定参数只接受 null / number / bigint / string / Uint8Array。
 * 业务层大量使用 boolean 和 undefined，这里统一归一化，避免运行期 "cannot be bound"。
 */
export type BindValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

function normalizeParams(params: unknown[]): BindValue[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'bigint' || typeof value === 'string') return value;
    if (value instanceof Uint8Array) return value;
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  });
}

/** 把 sqlite 返回的 null-prototype 行对象转成普通对象，方便展开与序列化。 */
function plain<T>(row: unknown): T {
  return row ? ({ ...(row as object) } as T) : (row as T);
}

export class Db {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #txDepth = 0;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.#db = new DatabaseSync(filePath);
    this.#db.exec('pragma journal_mode = wal');
    this.#db.exec('pragma synchronous = normal');
    this.#db.exec('pragma foreign_keys = on');
    this.#db.exec('pragma busy_timeout = 5000');
    this.#db.exec('pragma temp_store = memory');
  }

  #statement(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#statement(sql).all(...normalizeParams(params)).map((row) => plain<T>(row));
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.#statement(sql).get(...normalizeParams(params));
    return row === undefined ? undefined : plain<T>(row);
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const result = this.#statement(sql).run(...normalizeParams(params));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /** 事务支持嵌套：只有最外层真正提交，内层用 savepoint 保证可回滚。 */
  tx<T>(fn: () => T): T {
    const depth = this.#txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.#db.exec('begin immediate');
    else this.#db.exec(`savepoint ${savepoint}`);
    this.#txDepth += 1;
    try {
      const result = fn();
      this.#txDepth -= 1;
      if (depth === 0) this.#db.exec('commit');
      else this.#db.exec(`release ${savepoint}`);
      return result;
    } catch (err) {
      this.#txDepth -= 1;
      if (depth === 0) this.#db.exec('rollback');
      else this.#db.exec(`rollback to ${savepoint}`);
      throw err;
    }
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

function readSchema(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev 下是 src/db/schema.sql，打包后是 dist/schema.sql。
  const candidates = [join(here, 'schema.sql'), join(here, 'db', 'schema.sql')];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error(`schema.sql not found near ${here}`);
}

export function migrate(db: Db): void {
  // schema.sql 描述最新结构且全部幂等，新库一次建好；老库缺的列交给 runMigrations 补。
  db.exec(readSchema());
  const result = runMigrations(db);
  if (result.applied.length > 0) {
    console.log(`[feedfuse] schema ${result.from} → ${result.to}: ${result.applied.join(', ')}`);
  }
}

let singleton: Db | null = null;

export function openDb(filePath: string): Db {
  if (singleton) return singleton;
  const db = new Db(filePath);
  migrate(db);
  singleton = db;
  return db;
}

export function getDb(): Db {
  if (!singleton) throw new Error('database not initialized');
  return singleton;
}
