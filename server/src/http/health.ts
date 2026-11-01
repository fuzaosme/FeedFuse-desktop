import { getDb } from '../db/sqlite';

const TABLES = ['feeds', 'categories', 'articles', 'system_logs', 'vocabulary_entries', 'dictionaries'];

export function countTables(): Record<string, number> {
  const db = getDb();
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    try {
      result[table] = db.get<{ total: number }>(`select count(*) as total from ${table}`)?.total ?? 0;
    } catch {
      result[table] = 0;
    }
  }
  return result;
}
