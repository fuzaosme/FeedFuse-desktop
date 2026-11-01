import { getDb } from '../db/sqlite';
import { nowIso } from '../lib/utils';
import { ConflictError, NotFoundError, ValidationError } from '../http/envelope';
import { writeLog } from './logs';

export interface CategoryItem {
  id: string;
  name: string;
  position: number;
  feedCount: number;
}

interface CategoryRow {
  id: number;
  name: string;
  position: number;
  feed_count: number;
}

export function listCategories(): CategoryItem[] {
  return getDb()
    .all<CategoryRow>(
      `select c.id, c.name, c.position,
              (select count(*) from feeds f where f.category_id = c.id) as feed_count
       from categories c
       order by c.position asc, c.name asc`,
    )
    .map((row) => ({
      id: String(row.id),
      name: row.name,
      position: row.position,
      feedCount: row.feed_count,
    }));
}

export function getCategory(id: string): CategoryItem | null {
  const row = getDb().get<CategoryRow>(
    `select c.id, c.name, c.position,
            (select count(*) from feeds f where f.category_id = c.id) as feed_count
     from categories c where c.id = ?`,
    Number(id),
  );
  if (!row) return null;
  return { id: String(row.id), name: row.name, position: row.position, feedCount: row.feed_count };
}

function assertName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new ValidationError('分类名称不能为空', { name: 'required' });
  if (value.length > 60) throw new ValidationError('分类名称过长', { name: 'too_long' });
  return value;
}

export function createCategory(name: unknown): CategoryItem {
  const normalized = assertName(name);
  const db = getDb();
  const existing = db.get<{ id: number }>(
    'select id from categories where lower(name) = lower(?)',
    normalized,
  );
  if (existing) throw new ConflictError('同名分类已存在', { name: 'duplicate' });

  const nextPosition =
    db.get<{ max: number | null }>('select max(position) as max from categories')?.max ?? 0;
  const now = nowIso();
  const result = db.run(
    'insert into categories (name, position, created_at, updated_at) values (?, ?, ?, ?)',
    normalized,
    nextPosition + 1,
    now,
    now,
  );
  writeLog({
    level: 'info',
    category: 'category',
    message: '创建分类',
    source: 'domain/categories',
    context: { name: normalized },
  });
  return { id: String(result.lastInsertRowid), name: normalized, position: nextPosition + 1, feedCount: 0 };
}

export function renameCategory(id: string, name: unknown): CategoryItem {
  const normalized = assertName(name);
  const db = getDb();
  const current = getCategory(id);
  if (!current) throw new NotFoundError('分类不存在');
  const clash = db.get<{ id: number }>(
    'select id from categories where lower(name) = lower(?) and id <> ?',
    normalized,
    Number(id),
  );
  if (clash) throw new ConflictError('同名分类已存在', { name: 'duplicate' });
  db.run('update categories set name = ?, updated_at = ? where id = ?', normalized, nowIso(), Number(id));
  return { ...current, name: normalized };
}

export function deleteCategory(id: string): void {
  const db = getDb();
  const current = getCategory(id);
  if (!current) throw new NotFoundError('分类不存在');
  // 删除分类不删除订阅，只把订阅移出分类（与 FK on delete set null 一致，这里显式处理便于计数）。
  db.run('update feeds set category_id = null, updated_at = ? where category_id = ?', nowIso(), Number(id));
  db.run('delete from categories where id = ?', Number(id));
  writeLog({
    level: 'info',
    category: 'category',
    message: '删除分类',
    source: 'domain/categories',
    context: { name: current.name, movedFeeds: current.feedCount },
  });
}

export function reorderCategories(ids: unknown): CategoryItem[] {
  if (!Array.isArray(ids)) throw new ValidationError('排序参数不合法', { ids: 'invalid' });
  const db = getDb();
  db.tx(() => {
    ids.forEach((id, index) => {
      db.run('update categories set position = ?, updated_at = ? where id = ?', index + 1, nowIso(), Number(id));
    });
  });
  return listCategories();
}
