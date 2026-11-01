export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; fields?: Record<string, string> };
}

export interface Category {
  id: string;
  name: string;
  position: number;
  feedCount: number;
}

export interface Feed {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  iconUrl: string | null;
  enabled: boolean;
  categoryId: string | null;
  categoryName: string | null;
  fetchIntervalMinutes: number;
  lastFetchedAt: string | null;
  lastFetchStatus: number | null;
  lastFetchError: string | null;
  fullTextOnOpenEnabled: boolean;
  fullTextOnFetchEnabled: boolean;
  aiSummaryOnOpenEnabled: boolean;
  titleTranslateEnabled: boolean;
  bodyTranslateEnabled: boolean;
  articleListDisplayMode: 'card' | 'list';
  unreadCount: number;
  articleCount: number;
  createdAt: string;
}

export type FilterStatus = 'passed' | 'filtered' | 'pending' | 'error';

/** 被过滤的原因：关键词、AI 判定、三种查重。展示在列表与阅读器上，让「文章去哪了」有解释。 */
export type FilterReason =
  | 'keyword'
  | 'ai'
  | 'duplicate_url'
  | 'duplicate_title'
  | 'duplicate_similar';

export interface ArticleListItem {
  id: string;
  feedId: string;
  feedTitle: string;
  title: string;
  titleZh: string | null;
  summary: string | null;
  previewImage: string | null;
  author: string | null;
  publishedAt: string;
  link: string | null;
  isRead: boolean;
  isStarred: boolean;
  isFiltered: boolean;
  filterReason: FilterReason | string | null;
  filterStatus: FilterStatus;
  hasFulltext: boolean;
  hasAiSummary: boolean;
  hasTranslation: boolean;
}

export interface AiSummarySession {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  draftText: string;
  finalText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface ArticleDetail extends ArticleListItem {
  titleOriginal: string | null;
  contentHtml: string;
  contentFullHtml: string | null;
  sourceLanguage: string | null;
  aiSummary: string | null;
  aiTranslationZhHtml: string | null;
  aiTranslationBilingualHtml: string | null;
  siteUrl: string | null;
  feedUrl: string;
  aiSummarySession: AiSummarySession | null;
}

export interface Counts {
  all: number;
  unread: number;
  starred: number;
  /** 已过滤的文章数，用于在侧栏提示「有 N 篇被规则挡掉了」。 */
  filtered: number;
}

export interface RefreshProgress {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  inserted: number;
  current: string | null;
  failures: Array<{ feedId: string; title: string; error: string }>;
}

export interface Snapshot {
  categories: Category[];
  feeds: Feed[];
  articles: {
    items: ArticleListItem[];
    nextCursor: string | null;
    totalCount: number;
  };
  counts: Counts;
  refresh: RefreshProgress;
}

export type ThemeColor = 'mono' | 'sage' | 'lilac' | 'rose' | 'mist';

export interface GeneralSettings {
  theme: 'light' | 'dark' | 'auto';
  /** 强调色风格，和明暗是两个独立维度。 */
  themeColor: ThemeColor;
  fontSize: 'small' | 'medium' | 'large';
  fontFamily: 'sans' | 'serif';
  lineHeight: 'compact' | 'normal' | 'relaxed';
  autoMarkReadEnabled: boolean;
  autoMarkReadDelayMs: 0 | 2000 | 5000;
  defaultUnreadOnlyInAll: boolean;
  leftPaneWidth: number;
  middlePaneWidth: number;
}

export interface AiSettings {
  summaryEnabled: boolean;
  translateEnabled: boolean;
  autoSummarize: boolean;
  model: string;
  apiBaseUrl: string;
  summaryPrompt: string;
  translationPrompt: string;
  englishLearningPrompt: string;
  translation: { useSharedAi: boolean; model: string; apiBaseUrl: string };
}

export interface RssSettings {
  fetchIntervalMinutes: number;
  maxStoredArticlesPerFeed: number;
  articleFilter: {
    keyword: { enabled: boolean; keywords: string[] };
    ai: { enabled: boolean; prompt: string };
    duplicate: { enabled: boolean; similarity: number };
  };
}

export interface LoggingSettings {
  enabled: boolean;
  retentionDays: number;
  minLevel: 'error' | 'warning' | 'info';
}

export interface Settings {
  general: GeneralSettings;
  ai: AiSettings;
  rss: RssSettings;
  logging: LoggingSettings;
}

export interface SecretStatus {
  hasAiApiKey: boolean;
  hasTranslationApiKey: boolean;
}

export interface PromptDefaults {
  summary: string;
  translation: string;
  englishLearning: string;
}

export interface SettingsPayload {
  settings: Settings;
  secrets: SecretStatus;
  prompts: PromptDefaults;
}

export interface SystemLogItem {
  id: string;
  level: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  details: string | null;
  source: string;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface LogsPage {
  items: SystemLogItem[];
  page: number;
  pageSize: number;
  total: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

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
  /** 最早一句例句（= sentences[0].text），保留给旧调用方。 */
  sourceSentence: string;
  /** 例句列表，从早到晚，最多 5 句。 */
  sentences: VocabularySentence[];
  createdAt: string;
  updatedAt: string;
}

export interface DictionarySummary {
  id: string;
  name: string;
  entryCount: number;
  enabled: boolean;
  createdAt: string;
  /** 内置核心词库由应用自带，不能删除或停用。 */
  builtin?: boolean;
  description?: string;
  /** inline：词表直接入库；mdx / stardict：原文件留在数据目录，释义按需读取。 */
  format?: 'inline' | 'mdx' | 'stardict';
  storage?: 'sqlite' | 'file';
  contentType?: 'text' | 'html';
  /** 文件型词典的原文件占用字节数。 */
  sizeBytes?: number | null;
}

export interface DictionaryEntry {
  term: string;
  definition: string;
  phonetic: string | null;
  dictionaryName: string;
  /** html 时 definition 是富文本（服务端已清洗），text 时按换行分段。 */
  contentType?: 'text' | 'html';
}

export interface DictionaryLookupResponse {
  term: string;
  entries: DictionaryEntry[];
}

export interface FeedValidation {
  url: string;
  title: string;
  siteUrl: string | null;
  iconUrl: string | null;
  itemCount: number;
  samples: string[];
}

export interface ReapplyFiltersResult {
  scanned: number;
  filtered: number;
  unfiltered: number;
  /** 文章太多时会转到后台跑，此时只有这一项为 true。 */
  running?: boolean;
}

export interface FilterProgress {
  running: boolean;
  scanned: number;
  filtered: number;
  total: number;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  node: string;
  dataDir: string;
}
