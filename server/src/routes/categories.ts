import { Hono } from 'hono';
import { ok } from '../http/envelope';
import {
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  reorderCategories,
} from '../domain/categories';
import { readJson } from './feeds';

export function categoriesRoutes() {
  const app = new Hono();

  app.get('/', (c) => ok(c, listCategories()));

  app.post('/', async (c) => {
    const body = await readJson(c);
    return ok(c, createCategory(body.name));
  });

  app.post('/reorder', async (c) => {
    const body = await readJson(c);
    return ok(c, reorderCategories(body.ids));
  });

  app.patch('/:id', async (c) => {
    const body = await readJson(c);
    return ok(c, renameCategory(c.req.param('id'), body.name));
  });

  app.delete('/:id', (c) => {
    deleteCategory(c.req.param('id'));
    return ok(c, { deleted: true });
  });

  return app;
}
