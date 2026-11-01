import { ApiError, request, streamRequest, uploadFile, type SseHandlers } from './client';
import type {
  ArticleDetail,
  ArticleListItem,
  Category,
  Counts,
  DictionaryLookupResponse,
  DictionarySummary,
  Feed,
  FeedValidation,
  FilterProgress,
  LogsPage,
  ReapplyFiltersResult,
  RefreshProgress,
  Settings,
  SettingsPayload,
  Snapshot,
  SystemInfo,
  VocabularyItem,
} from './types';

/* ------------------------------- 阅读快照 ------------------------------- */

export interface SnapshotQuery {
  view: string;
  limit?: number;
  cursor?: string | null;
  unreadOnly?: boolean;
  includeFiltered?: boolean;
}

export function fetchSnapshot(query: SnapshotQuery): Promise<Snapshot> {
  const params = new URLSearchParams({ view: query.view });
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.unreadOnly) params.set('unreadOnly', 'true');
  if (query.includeFiltered) params.set('includeFiltered', 'true');
  return request<Snapshot>(`/api/snapshot?${params.toString()}`);
}

/* --------------------------------- 订阅 --------------------------------- */

export function fetchFeeds(): Promise<Feed[]> {
  return request<Feed[]>('/api/feeds');
}

export function validateFeed(url: string): Promise<FeedValidation> {
  // 校验要真的去抓一次源站，15s 默认超时不够（源站慢时会被前端提前掐掉）。
  return request<FeedValidation>('/api/feeds/validate', { method: 'POST', body: { url }, timeoutMs: 60_000 });
}

export function createFeed(input: {
  url: string;
  title?: string;
  categoryId?: string | null;
  /** 高级项：一次创建到位，省掉「建完再 PATCH」的中间失败窗口。 */
  fetchIntervalMinutes?: number;
  fullTextOnOpenEnabled?: boolean;
  fullTextOnFetchEnabled?: boolean;
  aiSummaryOnOpenEnabled?: boolean;
  titleTranslateEnabled?: boolean;
  bodyTranslateEnabled?: boolean;
}): Promise<{ feed: Feed; inserted: number; error: string | null }> {
  // 创建订阅会同步抓取一次首屏文章，慢源可能几十秒。
  return request('/api/feeds', { method: 'POST', body: input, timeoutMs: 120_000 });
}

export function updateFeed(id: string, patch: Record<string, unknown>): Promise<Feed> {
  return request<Feed>(`/api/feeds/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export function deleteFeed(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function refreshFeed(id: string): Promise<{ inserted: number; error: string | null }> {
  return request(`/api/feeds/${encodeURIComponent(id)}/refresh`, {
    method: 'POST',
    body: {},
    timeoutMs: 120_000,
  });
}

export function refreshAllFeeds(): Promise<RefreshProgress> {
  return request<RefreshProgress>('/api/feeds/refresh', { method: 'POST', body: {} });
}

export function fetchRefreshStatus(): Promise<RefreshProgress> {
  return request<RefreshProgress>('/api/feeds/refresh/status');
}

/* --------------------------------- 分类 --------------------------------- */

export function fetchCategories(): Promise<Category[]> {
  return request<Category[]>('/api/categories');
}

export function createCategory(name: string): Promise<Category> {
  return request<Category>('/api/categories', { method: 'POST', body: { name } });
}

export function renameCategory(id: string, name: string): Promise<Category> {
  return request<Category>(`/api/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
  });
}

export function deleteCategory(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderCategories(ids: string[]): Promise<Category[]> {
  return request<Category[]>('/api/categories/reorder', { method: 'POST', body: { ids } });
}

/* --------------------------------- 文章 --------------------------------- */

export function fetchArticle(id: string): Promise<ArticleDetail> {
  return request<ArticleDetail>(`/api/articles/${encodeURIComponent(id)}`);
}

export function patchArticle(
  id: string,
  patch: { isRead?: boolean; isStarred?: boolean },
): Promise<{ counts: Counts }> {
  return request(`/api/articles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export function markAllRead(view: string): Promise<{ updated: number; counts: Counts }> {
  return request('/api/articles/mark-all-read', { method: 'POST', body: { view } });
}

export function searchArticles(q: string): Promise<{ items: ArticleListItem[] }> {
  return request(`/api/articles/search?q=${encodeURIComponent(q)}`);
}

export function fetchFulltext(
  id: string,
): Promise<{ contentFullHtml: string; wordCount: number; title: string | null }> {
  return request(`/api/articles/${encodeURIComponent(id)}/fulltext`, {
    method: 'POST',
    body: {},
    // 服务端抓取超时 15s，前端必须留出余量，否则会把还在进行的抓取掐断。
    timeoutMs: 40_000,
  });
}

export function streamSummary(
  id: string,
  handlers: SseHandlers,
): Promise<void> {
  return streamRequest(`/api/articles/${encodeURIComponent(id)}/summary/stream`, {}, handlers);
}

export function translateTitle(id: string): Promise<{ title: string }> {
  return request(`/api/articles/${encodeURIComponent(id)}/translation/title`, {
    method: 'POST',
    body: {},
    // 服务端给模型 60s，前端再留一点余量。
    timeoutMs: 90_000,
  });
}

export function streamBodyTranslation(id: string, handlers: SseHandlers): Promise<void> {
  return streamRequest(`/api/articles/${encodeURIComponent(id)}/translation/body/stream`, {}, handlers);
}

/* -------------------------------- 过滤 -------------------------------- */

/** 按当前过滤规则把所有历史文章重判一遍（关键词/查重的增删改都要跑一次才生效）。 */
export function reapplyFilters(includeAi = false): Promise<ReapplyFiltersResult> {
  return request('/api/articles/reapply-filters', { method: 'POST', body: { includeAi } });
}

export function fetchFilterProgress(): Promise<FilterProgress> {
  return request<FilterProgress>('/api/articles/reapply-filters/status');
}

/* ------------------------------ 系统集成 ------------------------------ */

/** 交给系统默认浏览器打开：Tauri 窗口里点外链没有默认行为，必须走这个接口。 */
export function openExternalUrl(url: string): Promise<{ opened: boolean }> {
  return request('/api/system/open-url', { method: 'POST', body: { url } });
}

export function fetchSystemInfo(): Promise<SystemInfo> {
  return request<SystemInfo>('/api/system/info');
}

/* --------------------------------- 设置 --------------------------------- */

export function fetchSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>('/api/settings');
}

export function saveSettings(input: {
  settings: Settings;
  secrets?: { aiApiKey?: string; translationApiKey?: string };
}): Promise<SettingsPayload> {
  return request<SettingsPayload>('/api/settings', { method: 'PUT', body: input });
}

/** 恢复默认设置：会保留已填写的 API Key，否则每次重置都要重新贴一遍密钥。 */
export function resetSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>('/api/settings/reset', { method: 'POST', body: {} });
}

export function fetchLogs(page: number, level: string): Promise<LogsPage> {
  return request<LogsPage>(`/api/logs?page=${page}&pageSize=50&level=${level}`);
}

export function clearLogs(): Promise<{ cleared: boolean }> {
  return request('/api/logs', { method: 'DELETE' });
}

/* --------------------------------- OPML --------------------------------- */

export function exportOpml(): Promise<string> {
  return request<string>('/api/opml/export', { raw: true });
}

export function importOpml(xml: string): Promise<{
  imported: number;
  skipped: number;
  createdCategories: number;
  errors: string[];
}> {
  return request('/api/opml/import', { method: 'POST', body: { xml }, timeoutMs: 180_000 });
}

/* -------------------------------- 生词本 -------------------------------- */

export function fetchVocabulary(): Promise<VocabularyItem[]> {
  return request<VocabularyItem[]>('/api/vocabulary');
}

export function addVocabulary(input: {
  term: string;
  definition?: string;
  sourceArticleId?: string | null;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceSentence?: string;
}): Promise<VocabularyItem> {
  return request<VocabularyItem>('/api/vocabulary', { method: 'POST', body: input });
}

export function deleteVocabulary(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/vocabulary/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 给已有生词补一句例句：服务端保证最多 5 句并丢掉最早的。 */
export function addVocabularySentence(
  id: string,
  input: { text: string; articleId?: string | null; articleTitle?: string; articleUrl?: string },
): Promise<VocabularyItem> {
  return request<VocabularyItem>(`/api/vocabulary/${encodeURIComponent(id)}/sentences`, {
    method: 'POST',
    body: input,
  });
}

export function updateVocabulary(
  id: string,
  patch: { definition?: string; sentences?: string[] },
): Promise<VocabularyItem> {
  return request<VocabularyItem>(`/api/vocabulary/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/* --------------------------------- 词典 --------------------------------- */

export function fetchDictionaries(): Promise<DictionarySummary[]> {
  return request<DictionarySummary[]>('/api/dictionaries');
}

export function lookupWord(term: string, signal?: AbortSignal): Promise<DictionaryLookupResponse> {
  return request<DictionaryLookupResponse>(
    `/api/dictionaries/lookup?term=${encodeURIComponent(term)}`,
    { signal, timeoutMs: 5_000 },
  );
}

export function importDictionary(input: {
  name: string;
  entries?: Array<{ term: string; definition: string; phonetic?: string }>;
  text?: string;
}): Promise<DictionarySummary> {
  return request<DictionarySummary>('/api/dictionaries/import', { method: 'POST', body: input });
}

/**
 * 文件型词典导入分两步：先建上传会话把文件逐个传上去，再让服务端统一解析。
 * 分成两步是为了让「.mdx + .mdd」「.ifo + .idx + .dict」这类多文件词典
 * 能在同一次导入里被正确配对，而不是各自变成半本词典。
 */
export async function importDictionaryFiles(
  files: File[],
  onProgress?: (fileIndex: number, loaded: number, total: number) => void,
): Promise<DictionarySummary[]> {
  const { token } = await request<{ token: string }>('/api/dictionaries/uploads', { method: 'POST' });

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    await uploadFile(
      `/api/dictionaries/uploads/${token}/files?name=${encodeURIComponent(file.name)}`,
      file,
      (loaded, total) => onProgress?.(index, loaded, total),
    );
  }

  const result = await request<{ imported: DictionarySummary[] }>('/api/dictionaries/import-files', {
    method: 'POST',
    body: { token },
    // 解析几十万词条要几秒，默认 15 秒超时对超大词典不够用。
    timeoutMs: 120_000,
  });
  return result.imported;
}

export function deleteDictionary(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/dictionaries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function setDictionaryEnabled(id: string, enabled: boolean): Promise<DictionarySummary> {
  return request<DictionarySummary>(`/api/dictionaries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { enabled },
  });
}

export interface LearningStreamInput {
  articleId: string;
  selectedText: string;
  sentences: string[];
  context?: string;
}

export interface LearningStreamHandlers {
  /** 每次收到增量时回传「目前为止的完整文本」，界面直接覆盖渲染即可。 */
  onDelta?: (accumulated: string) => void;
  signal?: AbortSignal;
}

/**
 * 英语精读 / 单词详细解释都走同一条 SSE 协议：累积 delta，error 事件转成异常。
 * 服务端没有 missing_ai_config 这类业务错误码（SSE 里只有 message），
 * 这里用文案判断配置缺失，供卡片给出「打开设置」的出口。
 */
function streamLearning(
  path: string,
  input: unknown,
  handlers: LearningStreamHandlers,
): Promise<string> {
  let accumulated = '';
  return streamRequest(path, input, {
    signal: handlers.signal,
    onEvent: (event, data) => {
      const payload = data as { text?: string; message?: string };
      if (event === 'delta' && typeof payload.text === 'string') {
        accumulated += payload.text;
        handlers.onDelta?.(accumulated);
        return;
      }
      if (event === 'error') {
        const message = payload.message ?? '生成失败';
        const missingConfig = /尚未配置|缺少\s*API Key/.test(message);
        throw new ApiError(
          message,
          missingConfig ? 'missing_ai_config' : 'english_failed',
          500,
        );
      }
    },
  }).then(() => accumulated);
}

/** 句子讲解（完整选区 + 句子列表 + 段落语境）。 */
export function streamEnglishExplanation(
  input: LearningStreamInput,
  handlers: LearningStreamHandlers = {},
): Promise<string> {
  return streamLearning('/api/english/explain', input, handlers);
}

/** 单词卡的「详细解释」：固定使用内置词汇提示词。 */
export function streamWordDetail(
  input: LearningStreamInput & { term: string },
  handlers: LearningStreamHandlers = {},
): Promise<string> {
  return streamLearning('/api/english/word-detail', input, handlers);
}
