import { getDb } from '../db/sqlite';
import { nowIso } from '../lib/utils';
import { NotFoundError, ValidationError } from '../http/envelope';

/** 一个单词最多保留几句例句；超出时丢最早的一句。 */
export const MAX_VOCABULARY_SENTENCES = 5;
/** 单句长度上限：整段正文被当成「句子」提交时不该撑爆数据库。 */
const MAX_SENTENCE_LENGTH = 600;

/** 例句出处：记下它出现在哪篇文章里，方便回看上下文。 */
export interface VocabularySentence {
  text: string;
  articleId: string | null;
  articleTitle: string;
  articleUrl: string;
  addedAt: string;
}

export interface VocabularyItem {
  id: string;
  term: string;
  definition: string;
  sourceArticleId: string | null;
  sourceTitle: string;
  sourceUrl: string;
  /** 最早一句例句（老字段，等值于 sentences[0].text）。 */
  sourceSentence: string;
  /** 全部例句，按添加时间从早到晚。 */
  sentences: VocabularySentence[];
  createdAt: string;
  updatedAt: string;
}

interface VocabularyRow {
  id: number;
  term: string;
  normalized_term: string;
  definition: string;
  source_article_id: number | null;
  source_title: string;
  source_url: string;
  source_sentence: string;
  sentences: string;
  created_at: string;
  updated_at: string;
}

function normalizeSentenceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 读库里的 JSON 例句列表。
 *
 * 老库、手改过的库、迁移半途失败的库都可能出现坏 JSON：这里永远返回数组，
 * 坏数据直接当空处理，不能因为一条脏记录让整个生词本 500。
 */
function parseSentences(raw: string): VocabularySentence[] {
  if (!raw || raw === '[]') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        text: typeof item.text === 'string' ? item.text : '',
        articleId: typeof item.articleId === 'string' ? item.articleId : null,
        articleTitle: typeof item.articleTitle === 'string' ? item.articleTitle : '',
        articleUrl: typeof item.articleUrl === 'string' ? item.articleUrl : '',
        addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
      }))
      .filter((item) => item.text.trim())
      .slice(-MAX_VOCABULARY_SENTENCES);
  } catch {
    return [];
  }
}

function mapRow(row: VocabularyRow): VocabularyItem {
  const sentences = parseSentences(row.sentences);
  return {
    id: String(row.id),
    term: row.term,
    definition: row.definition,
    sourceArticleId: row.source_article_id === null ? null : String(row.source_article_id),
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    sourceSentence: sentences[0]?.text ?? row.source_sentence,
    sentences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sameSentence(left: string, right: string): boolean {
  return normalizeSentenceText(left).toLowerCase() === normalizeSentenceText(right).toLowerCase();
}

/**
 * 追加例句：先去重（同一句重复收藏不算新例句），再按上限丢最早的。
 * 返回新数组，调用方负责落库。
 */
export function appendSentence(
  current: VocabularySentence[],
  next: VocabularySentence,
): VocabularySentence[] {
  const text = normalizeSentenceText(next.text).slice(0, MAX_SENTENCE_LENGTH);
  if (!text) return current;
  const kept = current.filter((item) => !sameSentence(item.text, text));
  // 重复的句子不新增，但把时间与出处更新成最新一次，列表里就不会显示成「很久以前」。
  return [...kept, { ...next, text }].slice(-MAX_VOCABULARY_SENTENCES);
}

export function listVocabulary(): VocabularyItem[] {
  return getDb()
    .all<VocabularyRow>('select * from vocabulary_entries order by updated_at desc, id desc')
    .map(mapRow);
}

export interface AddVocabularyInput {
  term: string;
  definition?: string;
  sourceArticleId?: string | null;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceSentence?: string;
}

function readById(id: number): VocabularyItem {
  const row = getDb().get<VocabularyRow>('select * from vocabulary_entries where id = ?', id);
  if (!row) throw new NotFoundError('生词不存在');
  return mapRow(row);
}

function saveSentences(id: number, sentences: VocabularySentence[], updatedAt: string): void {
  getDb().run(
    `update vocabulary_entries
     set sentences = ?, source_sentence = ?, updated_at = ?
     where id = ?`,
    JSON.stringify(sentences),
    sentences[0]?.text ?? '',
    updatedAt,
    id,
  );
}

export function addVocabulary(input: AddVocabularyInput): VocabularyItem {
  const term = (input.term ?? '').trim();
  if (!term) throw new ValidationError('单词不能为空', { term: 'required' });
  if (term.length > 120) throw new ValidationError('单词过长', { term: 'too_long' });

  const db = getDb();
  const normalized = normalizeTerm(term);
  const now = nowIso();
  const incomingSentences = (input.sourceSentence ?? '')
    .split('\n')
    .map(normalizeSentenceText)
    .filter(Boolean);
  const existing = db.get<VocabularyRow>(
    'select * from vocabulary_entries where normalized_term = ?',
    normalized,
  );

  if (existing) {
    // 同一个词再次收藏：更新释义与出处，并把这次遇到的句子追加进例句列表。
    // 早先的实现用 coalesce 覆盖 source_sentence，等于「再收藏一次就把上一句丢了」。
    let sentences = parseSentences(existing.sentences);
    for (const text of incomingSentences) {
      sentences = appendSentence(sentences, {
        text,
        articleId: input.sourceArticleId ?? null,
        articleTitle: input.sourceTitle ?? '',
        articleUrl: input.sourceUrl ?? '',
        addedAt: now,
      });
    }
    db.run(
      `update vocabulary_entries
       set definition = coalesce(nullif(?, ''), definition),
           source_article_id = coalesce(?, source_article_id),
           source_title = coalesce(nullif(?, ''), source_title),
           source_url = coalesce(nullif(?, ''), source_url),
           sentences = ?,
           source_sentence = ?,
           updated_at = ?
       where id = ?`,
      input.definition ?? '',
      input.sourceArticleId ? Number(input.sourceArticleId) : null,
      input.sourceTitle ?? '',
      input.sourceUrl ?? '',
      JSON.stringify(sentences),
      sentences[0]?.text ?? existing.source_sentence,
      now,
      existing.id,
    );
    return readById(existing.id);
  }

  let sentences: VocabularySentence[] = [];
  // 首次收藏保留选区里**最早**的 5 句：例句按阅读顺序排列，开头才是用户真正在读的上下文。
  for (const text of incomingSentences.slice(0, MAX_VOCABULARY_SENTENCES)) {
    sentences = appendSentence(sentences, {
      text,
      articleId: input.sourceArticleId ?? null,
      articleTitle: input.sourceTitle ?? '',
      articleUrl: input.sourceUrl ?? '',
      addedAt: now,
    });
  }

  const result = db.run(
    `insert into vocabulary_entries
       (term, normalized_term, definition, source_article_id, source_title, source_url,
        source_sentence, sentences, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    term,
    normalized,
    input.definition ?? '',
    input.sourceArticleId ? Number(input.sourceArticleId) : null,
    input.sourceTitle ?? '',
    input.sourceUrl ?? '',
    sentences[0]?.text ?? '',
    JSON.stringify(sentences),
    now,
    now,
  );

  return readById(result.lastInsertRowid);
}

export interface AddSentenceInput {
  text: string;
  articleId?: string | null;
  articleTitle?: string;
  articleUrl?: string;
}

/** 给已有生词补一句例句；超过 5 句时服务端负责丢掉最早的那句。 */
export function addVocabularySentence(id: string, input: AddSentenceInput): VocabularyItem {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) throw new NotFoundError('生词不存在');
  const text = normalizeSentenceText(input.text ?? '');
  if (!text) throw new ValidationError('例句不能为空', { text: 'required' });
  if (text.length > MAX_SENTENCE_LENGTH) {
    throw new ValidationError('例句过长，请只保留一句话', { text: 'too_long' });
  }

  const current = readById(numeric);
  const now = nowIso();
  const sentences = appendSentence(current.sentences, {
    text,
    articleId: input.articleId ?? current.sourceArticleId,
    articleTitle: input.articleTitle ?? current.sourceTitle,
    articleUrl: input.articleUrl ?? current.sourceUrl,
    addedAt: now,
  });
  saveSentences(numeric, sentences, now);
  return readById(numeric);
}

/** 修正释义：查词卡片给的释义偶尔不准，用户应当能就地改掉。 */
export function updateVocabulary(
  id: string,
  patch: { definition?: string; sentences?: string[] },
): VocabularyItem {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) throw new NotFoundError('生词不存在');
  const current = readById(numeric);
  const now = nowIso();

  if (patch.definition !== undefined) {
    getDb().run(
      'update vocabulary_entries set definition = ?, updated_at = ? where id = ?',
      String(patch.definition).slice(0, 4000),
      now,
      numeric,
    );
  }

  if (patch.sentences) {
    // 整表覆盖（删单句等）：保持顺序、去掉空句、仍然卡上限。
    const sentences = patch.sentences
      .map(normalizeSentenceText)
      .filter(Boolean)
      .slice(-MAX_VOCABULARY_SENTENCES)
      .map((text) => {
        const matched = current.sentences.find((item) => sameSentence(item.text, text));
        return matched ?? {
          text: text.slice(0, MAX_SENTENCE_LENGTH),
          articleId: current.sourceArticleId,
          articleTitle: current.sourceTitle,
          articleUrl: current.sourceUrl,
          addedAt: now,
        };
      });
    saveSentences(numeric, sentences, now);
  }

  return readById(numeric);
}

export function deleteVocabulary(id: string): void {
  const row = getDb().get<{ id: number }>('select id from vocabulary_entries where id = ?', Number(id));
  if (!row) throw new NotFoundError('生词不存在');
  getDb().run('delete from vocabulary_entries where id = ?', Number(id));
}
