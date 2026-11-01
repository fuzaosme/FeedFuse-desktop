import { getDb } from '../db/sqlite';
import { nowIso, errorMessage } from '../lib/utils';
import { getSettings } from './settings';

export type LogLevel = 'error' | 'warning' | 'info';
export type LogCategory =
  | 'feed'
  | 'article'
  | 'category'
  | 'opml'
  | 'settings'
  | 'scheduler'
  | 'ai_summary'
  | 'ai_translate'
  | 'external_api'
  | 'english';

const LEVEL_WEIGHT: Record<LogLevel, number> = { info: 1, warning: 2, error: 3 };

export interface WriteLogInput {
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: string | null;
  source: string;
  context?: Record<string, unknown>;
}

export interface SystemLogItem {
  id: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details: string | null;
  source: string;
  context: Record<string, unknown>;
  createdAt: string;
}

export function writeLog(input: WriteLogInput): void {
  try {
    const { logging } = getSettings();
    if (!logging.enabled) return;
    if (LEVEL_WEIGHT[input.level] < LEVEL_WEIGHT[logging.minLevel]) return;

    getDb().run(
      `insert into system_logs (level, category, message, details, source, context_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      input.level,
      input.category,
      input.message,
      input.details ?? null,
      input.source,
      JSON.stringify(input.context ?? {}),
      nowIso(),
    );
  } catch {
    // 日志写入失败绝不影响主流程
  }
}

export function logError(err: unknown, input: Omit<WriteLogInput, 'level' | 'details'>): void {
  writeLog({ ...input, level: 'error', details: errorMessage(err) });
}

export interface LogsQuery {
  page?: number;
  pageSize?: number;
  level?: LogLevel | 'all';
}

export interface LogsPage {
  items: SystemLogItem[];
  page: number;
  pageSize: number;
  total: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

interface LogRow {
  id: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details: string | null;
  source: string;
  context_json: string;
  created_at: string;
}

/** 分页参数一律夹到有效区间：Number('abc') 是 NaN，直接进 sqlite 会报 datatype mismatch。 */
function normalizeInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

export function listLogs(query: LogsQuery): LogsPage {
  const pageSize = normalizeInteger(query.pageSize, 50, 1, 200);
  const page = normalizeInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
  const level = query.level === 'info' || query.level === 'warning' || query.level === 'error' ? query.level : 'all';
  const db = getDb();
  const where = level !== 'all' ? 'where level = ?' : '';
  const params = level !== 'all' ? [level] : [];

  const total =
    db.get<{ total: number }>(`select count(*) as total from system_logs ${where}`, ...params)?.total ?? 0;

  const rows = db.all<LogRow>(
    `select * from system_logs ${where} order by created_at desc, id desc limit ? offset ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );

  return {
    items: rows.map((row) => ({
      id: String(row.id),
      level: row.level,
      category: row.category,
      message: row.message,
      details: row.details,
      source: row.source,
      context: safeParse(row.context_json),
      createdAt: row.created_at,
    })),
    page,
    pageSize,
    total,
    hasPreviousPage: page > 1,
    hasNextPage: page * pageSize < total,
  };
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function clearLogs(): void {
  getDb().run('delete from system_logs');
}

export function pruneLogs(): void {
  const { retentionDays } = getSettings().logging;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  getDb().run('delete from system_logs where created_at < ?', cutoff);
}
