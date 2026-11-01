import { Hono } from 'hono';
import { createWriteStream, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError, ok } from '../http/envelope';
import { addVocabulary, addVocabularySentence, deleteVocabulary, listVocabulary, updateVocabulary } from '../domain/vocabulary';
import {
  deleteDictionary,
  getDictionaryResource,
  importDictionary,
  importDictionaryFiles,
  listDictionaries,
  lookupWord,
  setDictionaryEnabled,
  type RawDictionaryEntry,
} from '../domain/dictionaries';
import { createStagingDir, fileSize, removeStagingDir, stagingDirOf } from '../domain/dict/storage';
import { readJson } from './feeds';

export function vocabularyRoutes() {
  const app = new Hono();

  app.get('/', (c) => ok(c, listVocabulary()));

  app.post('/', async (c) => {
    const body = await readJson(c);
    return ok(
      c,
      addVocabulary({
        term: String(body.term ?? ''),
        definition: typeof body.definition === 'string' ? body.definition : '',
        sourceArticleId: typeof body.sourceArticleId === 'string' ? body.sourceArticleId : null,
        sourceTitle: typeof body.sourceTitle === 'string' ? body.sourceTitle : '',
        sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : '',
        sourceSentence: typeof body.sourceSentence === 'string' ? body.sourceSentence : '',
      }),
    );
  });

  app.delete('/:id', (c) => {
    deleteVocabulary(c.req.param('id'));
    return ok(c, { deleted: true });
  });

  /** 阅读时点开已收藏的生词，可以把当前这句加进去（最多 5 句，超出丢最早的）。 */
  app.post('/:id/sentences', async (c) => {
    const body = await readJson(c);
    return ok(
      c,
      addVocabularySentence(c.req.param('id'), {
        text: String(body.text ?? ''),
        articleId: typeof body.articleId === 'string' ? body.articleId : null,
        articleTitle: typeof body.articleTitle === 'string' ? body.articleTitle : '',
        articleUrl: typeof body.articleUrl === 'string' ? body.articleUrl : '',
      }),
    );
  });

  /** 只允许改释义与例句文本；单词本身改掉会破坏去重键，不如删了重加。 */
  app.patch('/:id', async (c) => {
    const body = await readJson(c);
    return ok(
      c,
      updateVocabulary(c.req.param('id'), {
        definition: typeof body.definition === 'string' ? body.definition : undefined,
        sentences: Array.isArray(body.sentences)
          ? body.sentences.filter((item: unknown): item is string => typeof item === 'string')
          : undefined,
      }),
    );
  });

  return app;
}

export function dictionariesRoutes() {
  const app = new Hono();

  app.get('/', (c) => ok(c, listDictionaries()));

  app.get('/lookup', (c) => {
    const term = new URL(c.req.url).searchParams.get('term') ?? '';
    return ok(c, lookupWord(term));
  });

  /** 开一次上传会话：一次导入的全部文件（.mdx + .mdd / .ifo + .idx + .dict）共用同一个 token。 */
  app.post('/uploads', (c) => {
    const staged = createStagingDir();
    return ok(c, { token: staged.token });
  });

  /**
   * 接收单个文件。
   * 用「原始二进制 + 查询参数带文件名」而不是 multipart：MDX 动辄上百兆，
   * 流式落盘比把 multipart 整体解析进内存稳得多，前端也能直接流式 POST File 对象。
   */
  app.post('/uploads/:token/files', async (c) => {
    const token = c.req.param('token');
    const dir = stagingDirOf(token);
    if (!dir) throw new ValidationError('上传会话已失效，请重新选择文件');

    const rawName = c.req.query('name') ?? 'dictionary.bin';
    const name = basename(rawName.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
    if (!name) throw new ValidationError('文件名无效');

    const body = c.req.raw.body;
    if (!body) throw new ValidationError('没有收到文件内容');
    const target = join(dir, name);
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target));
    return ok(c, { name, size: fileSize(target) });
  });

  /**
   * 开始导入。
   * 两种入口：`token` 为刚上传的暂存目录；`paths` 直接给本机绝对路径（桌面端可选，免一份拷贝）。
   */
  app.post('/import-files', async (c) => {
    const body = await readJson(c);

    const token = typeof body.token === 'string' ? body.token : '';
    if (token) {
      const dir = stagingDirOf(token);
      if (!dir) throw new ValidationError('上传会话已失效，请重新选择文件');
      try {
        const paths = readdirSync(dir)
          .filter((name) => !name.startsWith('.'))
          .map((name) => join(dir, name));
        if (paths.length === 0) throw new ValidationError('没有收到任何文件');
        const summaries = importDictionaryFiles(paths);
        return ok(c, { imported: summaries });
      } finally {
        removeStagingDir(token);
      }
    }

    const paths = Array.isArray(body.paths)
      ? body.paths.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (paths.length === 0) throw new ValidationError('请提供 token 或 paths');
    return ok(c, { imported: importDictionaryFiles(paths) });
  });

  /** 词典内的图片/样式/发音。`<img>` 带不上请求头，令牌走查询参数（见 app.ts 的鉴权）。 */
  app.get('/:id/resource', (c) => {
    const key = c.req.query('key') ?? '';
    if (!key) throw new ValidationError('缺少 key');
    const resource = getDictionaryResource(c.req.param('id'), key);
    return c.body(new Uint8Array(resource.data), 200, {
      'content-type': resource.mime,
      // 词典内容不会变，重复查同一个词不必反复取图。
      'cache-control': 'private, max-age=86400',
    });
  });

  app.post('/import', async (c) => {
    const body = await readJson(c);
    const name = typeof body.name === 'string' ? body.name : '';
    const entries = Array.isArray(body.entries) ? (body.entries as RawDictionaryEntry[]) : [];

    if (entries.length === 0) {
      // 也支持直接贴纯文本：每行 "单词<TAB>释义"。
      const text = typeof body.text === 'string' ? body.text : '';
      const parsed = text
        .split('\n')
        .map((line) => line.split('\t'))
        .filter((parts) => parts.length >= 2 && parts[0].trim() && parts[1].trim())
        .map((parts) => ({ term: parts[0].trim(), definition: parts.slice(1).join('\t').trim() }));

      if (parsed.length === 0) {
        throw new ValidationError('词典内容为空，请提供 entries 数组或制表符分隔的文本', {
          entries: 'required',
        });
      }
      return ok(c, importDictionary({ name: name || '导入词典', entries: parsed }));
    }

    return ok(c, importDictionary({ name: name || '导入词典', entries }));
  });

  app.patch('/:id', async (c) => {
    const body = await readJson(c);
    return ok(c, setDictionaryEnabled(c.req.param('id'), body.enabled !== false));
  });

  app.delete('/:id', (c) => {
    deleteDictionary(c.req.param('id'));
    return ok(c, { deleted: true });
  });

  return app;
}
