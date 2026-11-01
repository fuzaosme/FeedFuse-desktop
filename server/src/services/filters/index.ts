import {
  countArticlesByFilterStatus,
  getArticleContent,
  listArticleFilterCandidates,
  setArticleFilter,
  type ArticleFilterCandidate,
  type FilterStatus,
} from '../../domain/articles';
import { writeLog } from '../../domain/logs';
import { getSettings, type PersistedSettings } from '../../domain/settings';
import { htmlToText, errorMessage, sleep } from '../../lib/utils';
import { judgeArticle } from './ai';
import { findDuplicate } from './duplicate';
import { matchKeywords } from './keyword';
import { contentFingerprint, normalizeTitle, normalizeUrl } from './text';

/**
 * 文章过滤体系统一入口。
 *
 * 三层减噪各管一段：
 * 1. 入库同步判定（关键词 + 跨订阅查重）——便宜、确定，抓取时就出结果；
 * 2. 入库异步判定（AI 语义过滤）——贵、慢，放进内存队列，绝不阻塞抓取；
 * 3. 回溯重判——用户改了设置之后把旧文章重新算一遍。
 */

export interface IngestFilterInput {
  feedId: string;
  title: string;
  link: string | null;
  summary: string | null;
  contentHtml: string | null;
  contentFullHtml?: string | null;
}

export interface IngestFilterResult {
  isFiltered: boolean;
  /** keyword / duplicate_url / duplicate_title / duplicate_similar；未过滤为 null。 */
  filterReason: string | null;
  filteredBy: string[];
  filterStatus: FilterStatus;
  urlNormalized: string | null;
  titleNormalized: string | null;
  contentFingerprint: string | null;
}

function bodyOf(input: { summary: string | null; contentHtml: string | null; contentFullHtml?: string | null }): string {
  return input.contentFullHtml || input.contentHtml || input.summary || '';
}

/**
 * 同步判定：关键词与查重。
 *
 * 输出里的三个归一化字段要原样写回数据库——回溯重判和跨订阅查重都依赖它们，
 * 入库时算一次就够了，没必要每次比较都重新解析。
 */
export function evaluateOnIngest(input: IngestFilterInput): IngestFilterResult {
  const settings = getSettings();
  const urlNormalized = input.link ? normalizeUrl(input.link) : null;
  const titleNormalized = normalizeTitle(input.title);
  const fingerprint = contentFingerprint(bodyOf(input));

  const base = {
    urlNormalized,
    titleNormalized,
    contentFingerprint: fingerprint,
  };

  const keywordConfig = settings.rss.articleFilter.keyword;
  const hits = keywordConfig.enabled ? matchKeywords(input, keywordConfig.keywords) : [];
  if (hits.length > 0) {
    return { ...base, isFiltered: true, filterReason: 'keyword', filteredBy: hits, filterStatus: 'filtered' };
  }

  const duplicate = findDuplicate({
    // 入库前还没有 id：此时「只跟更早的文章比」天然成立。
    id: null,
    feedId: input.feedId,
    url: input.link,
    normalizedUrl: urlNormalized,
    normalizedTitle: titleNormalized,
    fingerprint,
  });
  if (duplicate) {
    return {
      ...base,
      isFiltered: true,
      filterReason: duplicate.reason,
      filteredBy: [],
      filterStatus: 'filtered',
    };
  }

  return { ...base, isFiltered: false, filterReason: null, filteredBy: [], filterStatus: 'passed' };
}

/* ------------------------------ AI 语义过滤队列 ------------------------------ */

const AI_CONCURRENCY = 3;
/** 正文太短时模型只能靠标题瞎猜，直接放行比误杀安全。 */
const MIN_AI_TEXT_LENGTH = 20;

const aiQueue: string[] = [];
const aiQueued = new Set<string>();
let aiActive = 0;

/**
 * 把新文章塞进内存队列做 AI 语义过滤。
 *
 * 刻意做成「发起即返回」：抓取链路上任何一次模型超时都不该拖慢订阅刷新。
 * 队列只在进程内存在，重启会丢——丢了顶多是这几篇没做语义过滤（仍然可见），
 * 比为了持久化再引入一张队列表划算。
 */
export function enqueueAiFilter(articleIds: string[]): void {
  const { ai } = getSettings().rss.articleFilter;
  if (!ai.enabled || !ai.prompt.trim()) return;
  if (articleIds.length === 0) return;

  for (const id of articleIds) {
    if (aiQueued.has(id)) continue;
    aiQueued.add(id);
    aiQueue.push(id);
  }
  pumpAiQueue();
}

function pumpAiQueue(): void {
  while (aiActive < AI_CONCURRENCY && aiQueue.length > 0) {
    const id = aiQueue.shift();
    if (!id) break;
    aiActive += 1;
    void judgeOne(id)
      // judgeOne 里写 pending 的 setArticleFilter 在 try 之外，DB 忙时同样会抛。
      // 这里必须自己吞掉，否则会变成 unhandledRejection，日志里只剩一句没头没尾的堆栈。
      .catch((err) => {
        writeLog({
          level: 'error',
          category: 'article',
          message: 'AI 语义过滤任务异常退出',
          source: 'services/filters',
          details: errorMessage(err),
          context: { articleId: id },
        });
      })
      .finally(() => {
        aiActive -= 1;
        aiQueued.delete(id);
        pumpAiQueue();
      });
  }
}

async function judgeOne(articleId: string): Promise<void> {
  const article = getArticleContent(articleId);
  // 已经被关键词或查重判掉的文章不再问模型，省一次调用。
  if (!article || article.isFiltered) return;

  const { ai } = getSettings().rss.articleFilter;
  if (!ai.enabled || !ai.prompt.trim()) return;

  const text = htmlToText(article.contentFullHtml || article.contentHtml || article.summary || '');
  if (text.length < MIN_AI_TEXT_LENGTH) return;

  setArticleFilter(articleId, { isFiltered: false, reason: null, status: 'pending' });

  try {
    const verdict = await judgeArticle({ title: article.title, text }, ai.prompt);
    if (verdict === 'filter') {
      setArticleFilter(articleId, { isFiltered: true, reason: 'ai', status: 'filtered' });
    } else {
      setArticleFilter(articleId, { isFiltered: false, reason: null, status: 'passed' });
    }
  } catch (err) {
    // 判定失败时保持可见：模型抽风不能变成「文章消失」。
    setArticleFilter(articleId, { isFiltered: false, reason: null, status: 'error' });
    writeLog({
      level: 'error',
      category: 'article',
      message: 'AI 语义过滤判定失败，已按放行处理',
      source: 'services/filters',
      details: errorMessage(err),
      context: { articleId },
    });
  }
}

/* ------------------------------ 回溯重判 ------------------------------ */

export interface ReapplyResult {
  scanned: number;
  filtered: number;
  unfiltered: number;
}

export interface FilterProgress {
  running: boolean;
  scanned: number;
  filtered: number;
  total: number;
}

export interface ReapplyOptions {
  /** AI 语义过滤默认不回溯：几千篇文章就是几千次模型调用，必须显式开启。 */
  includeAi?: boolean;
}

const REAPPLY_BATCH_SIZE = 500;

let filterProgress: FilterProgress = { running: false, scanned: 0, filtered: 0, total: 0 };

export function getFilterProgress(): FilterProgress {
  return { ...filterProgress };
}

interface ReapplyState {
  scanned: number;
  filtered: number;
  unfiltered: number;
}

/**
 * 单篇重判。
 *
 * 只改过滤相关的四列，绝不碰 is_read / is_starred：用户手动的阅读与收藏状态
 * 是唯一不可再生的数据，重判一次就该恢复一次。
 * 返回重判后的过滤状态，供调用方决定要不要接着问 AI。
 */
function reapplyOne(
  row: ArticleFilterCandidate,
  settings: PersistedSettings,
  includeAi: boolean,
  state: ReapplyState,
): boolean {
  state.scanned += 1;

  // pending 可能正在判定中，error 是上次失败的痕迹；两者都别覆盖，除非显式重跑 AI。
  if (!includeAi && (row.filterReason === 'ai' || row.filterStatus === 'pending' || row.filterStatus === 'error')) {
    return row.isFiltered;
  }

  const urlNormalized = row.urlNormalized ?? (row.link ? normalizeUrl(row.link) : null);
  const titleNormalized = row.titleNormalized || normalizeTitle(row.title);
  const fingerprint =
    row.contentFingerprint ?? contentFingerprint(bodyOf({ summary: row.summary, contentHtml: row.contentHtml, contentFullHtml: row.contentFullHtml }));

  const body = { summary: row.summary, contentHtml: row.contentHtml, contentFullHtml: row.contentFullHtml };

  const keywordConfig = settings.rss.articleFilter.keyword;
  const hits = keywordConfig.enabled
    ? matchKeywords({ title: row.title, ...body }, keywordConfig.keywords)
    : [];

  let isFiltered = false;
  let reason: string | null = null;

  if (hits.length > 0) {
    isFiltered = true;
    reason = 'keyword';
  } else {
    const duplicate = findDuplicate({
      id: row.id,
      feedId: row.feedId,
      url: row.link,
      normalizedUrl: urlNormalized,
      normalizedTitle: titleNormalized,
      fingerprint,
    });
    if (duplicate) {
      isFiltered = true;
      reason = duplicate.reason;
    }
  }

  const status: FilterStatus = isFiltered ? 'filtered' : 'passed';
  // 正文太短本来就算不出指纹（合法为 null），无链接的条目（播客、纯标题）也合法没有
  // url_normalized。这些都不算「缺列」，否则每次重判都会白白把整表重写一遍。
  const normalizedMissing =
    (row.link !== null && row.urlNormalized === null) ||
    row.titleNormalized === null ||
    (fingerprint !== null && row.contentFingerprint === null);

  const changed =
    isFiltered !== row.isFiltered || reason !== row.filterReason || status !== row.filterStatus || normalizedMissing;

  if (changed) {
    setArticleFilter(row.id, {
      isFiltered,
      reason,
      status,
      filteredBy: hits,
      // 老库这两列还是空的，趁重判顺手补齐，否则跨订阅查重永远匹配不到它。
      ...(row.urlNormalized === null ? { urlNormalized } : {}),
      ...(row.titleNormalized === null ? { titleNormalized } : {}),
      ...(row.contentFingerprint === null ? { contentFingerprint: fingerprint } : {}),
    });
    if (isFiltered && !row.isFiltered) state.filtered += 1;
    if (!isFiltered && row.isFiltered) state.unfiltered += 1;
  }

  return isFiltered;
}

/** 按批返回的生成器：同步调用方忽略 yield，异步调用方每批之间让出事件循环。 */
function* reapplyBatches(options: ReapplyOptions): Generator<void, ReapplyResult, void> {
  const settings = getSettings();
  const includeAi =
    options.includeAi === true &&
    settings.rss.articleFilter.ai.enabled &&
    settings.rss.articleFilter.ai.prompt.trim().length > 0;

  const state: ReapplyState = { scanned: 0, filtered: 0, unfiltered: 0 };
  filterProgress = { running: true, scanned: 0, filtered: 0, total: countArticlesByFilterStatus().total };

  try {
    let cursor: string | null = null;
    for (;;) {
      const rows = listArticleFilterCandidates({ afterId: cursor, limit: REAPPLY_BATCH_SIZE });
      if (rows.length === 0) break;

      const aiCandidates: string[] = [];
      for (const row of rows) {
        const isFiltered = reapplyOne(row, settings, includeAi, state);
        if (includeAi && !isFiltered) aiCandidates.push(row.id);
      }

      cursor = rows[rows.length - 1].id;
      filterProgress.scanned = state.scanned;
      filterProgress.filtered = state.filtered;

      if (aiCandidates.length > 0) enqueueAiFilter(aiCandidates);
      yield;
    }
  } finally {
    filterProgress.running = false;
    filterProgress.scanned = state.scanned;
    filterProgress.filtered = state.filtered;
  }

  writeLog({
    level: 'info',
    category: 'article',
    message: `过滤规则重判完成：扫描 ${state.scanned} 篇，新过滤 ${state.filtered} 篇，恢复 ${state.unfiltered} 篇`,
    source: 'services/filters',
    context: { scanned: state.scanned, filtered: state.filtered, unfiltered: state.unfiltered, includeAi: options.includeAi === true },
  });

  return { scanned: state.scanned, filtered: state.filtered, unfiltered: state.unfiltered };
}

/**
 * 按当前设置重判全部文章（同步）。
 *
 * 关键词与查重可以「取消」之前的过滤：用户删掉某个关键词后，被它误杀的文章必须回来。
 * AI 语义过滤默认不参与，因为每一篇都是一次真金白银的模型调用。
 */
export function reapplyArticleFilters(options: ReapplyOptions = {}): ReapplyResult {
  // 已经有回溯在跑就直接返回，避免两轮并发互相翻写同一批过滤结果。
  if (filterProgress.running) return { scanned: 0, filtered: 0, unfiltered: 0 };

  const iterator = reapplyBatches(options);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

/** 数据量大时的后台版本：每批之间让出事件循环，HTTP 与抓取不会被长任务卡住。 */
export function startReapplyFilters(options: ReapplyOptions = {}): void {
  if (filterProgress.running) return;
  filterProgress = { running: true, scanned: 0, filtered: 0, total: countArticlesByFilterStatus().total };

  void (async () => {
    const iterator = reapplyBatches(options);
    let step = iterator.next();
    while (!step.done) {
      await sleep(0);
      step = iterator.next();
    }
  })().catch((err) => {
    // 后台任务没人等它的 Promise，异常必须自己吞掉并落日志，否则会变成 unhandled rejection。
    filterProgress.running = false;
    writeLog({
      level: 'error',
      category: 'article',
      message: '后台重判过滤规则失败',
      source: 'services/filters',
      details: errorMessage(err),
    });
  });
}
