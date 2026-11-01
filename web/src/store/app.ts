import { create } from 'zustand';
import * as api from '../api/endpoints';
import { ApiError } from '../api/client';
import type {
  ArticleDetail,
  ArticleListItem,
  Category,
  Counts,
  Feed,
  FilterProgress,
  PromptDefaults,
  RefreshProgress,
  SecretStatus,
  Settings,
  VocabularyItem,
} from '../api/types';

export type TranslationMode = 'off' | 'zh' | 'bilingual';

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

/** 从 RSS 目录选中一个来源后带进「添加订阅」的初始值。 */
export interface FeedPrefill {
  title: string;
  url: string;
  siteUrl: string | null;
}

interface UiState {
  settingsOpen: boolean;
  addFeedOpen: boolean;
  rssCatalogOpen: boolean;
  /** 只作为一次性的初始值：AddFeedDialog 消费后立即清空，避免下次打开被旧值污染。 */
  addFeedPrefill: FeedPrefill | null;
  searchOpen: boolean;
  vocabularyOpen: boolean;
  sidebarCollapsed: boolean;
  translationMode: TranslationMode;
  /**
   * 英语学习模式：开启后选中正文才会弹出查词 / AI 讲解卡片。
   *
   * 默认关闭，且只保留在当前会话里——它改变的是「选中文字会发生什么」，
   * 像翻译模式一样属于阅读现场状态，不该在重启后偷偷继续生效。
   */
  learningEnabled: boolean;
  rightPaneVisible: boolean;
}

interface SummaryState {
  status: 'idle' | 'running' | 'done' | 'error';
  text: string;
  error: string | null;
}

interface TranslationState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  total: number;
  error: string | null;
  mode: TranslationMode;
}

interface AppState {
  ready: boolean;
  loadingSnapshot: boolean;
  loadingMore: boolean;
  loadingArticle: boolean;
  /** 全文抓取自己的 spinner：和「打开文章」分开，否则抓全文会把整块阅读区刷成加载态。 */
  fetchingFulltext: boolean;

  categories: Category[];
  feeds: Feed[];
  counts: Counts;
  view: string;
  unreadOnly: boolean;
  /**
   * 单源视图里是否显示被过滤的文章。
   *
   * 只能在 `feed:<id>` 视图打开：聚合视图下混进已过滤文章会把「未读/全部」的语义搞乱，
   * 而单源视图恰恰是用户排查「我的文章怎么不见了」的地方。
   */
  includeFiltered: boolean;

  articles: ArticleListItem[];
  nextCursor: string | null;
  totalCount: number;
  /** 上次列表加载失败的原因；非空时界面应给出「重试」入口而不是一片空白。 */
  loadError: string | null;

  selectedId: string | null;
  article: ArticleDetail | null;

  settings: Settings | null;
  secrets: SecretStatus | null;
  prompts: PromptDefaults | null;

  refresh: RefreshProgress | null;
  summary: SummaryState;
  translation: TranslationState;
  vocabulary: VocabularyItem[];

  ui: UiState;
  toasts: Toast[];

  init: () => Promise<void>;
  reloadSnapshot: (options?: { keepArticles?: boolean }) => Promise<void>;
  /** 列表加载失败后的重试入口，语义等同一次完整 reloadSnapshot。 */
  retrySnapshot: () => Promise<void>;
  loadMore: () => Promise<void>;
  selectView: (view: string) => Promise<void>;
  setUnreadOnly: (value: boolean) => Promise<void>;
  setIncludeFiltered: (value: boolean) => Promise<void>;
  selectArticle: (id: string | null) => Promise<void>;
  /** 上下篇：delta 为 +1 表示下一篇。列表到头时什么也不做。 */
  selectAdjacent: (delta: number) => Promise<void>;
  refreshArticle: (id: string) => Promise<void>;
  toggleRead: (id: string, value: boolean) => Promise<void>;
  toggleStar: (id: string, value: boolean) => Promise<void>;
  markAllRead: () => Promise<void>;
  refreshAll: () => Promise<void>;
  pollRefresh: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (
    input: {
      settings: Settings;
      secrets?: { aiApiKey?: string; translationApiKey?: string };
    },
    /** 拖动分栏这类隐式保存不必每次弹「设置已保存」。 */
    options?: { silent?: boolean },
  ) => Promise<void>;
  resetSettings: () => Promise<void>;
  reapplyFilters: (includeAi?: boolean) => Promise<void>;

  createCategory: (name: string) => Promise<Category | null>;
  renameCategory: (id: string, name: string) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  reorderCategories: (ids: string[]) => Promise<void>;
  loadVocabulary: () => Promise<void>;
  addVocabulary: (input: Parameters<typeof api.addVocabulary>[0]) => Promise<void>;
  removeVocabulary: (id: string) => Promise<void>;
  /** 阅读时给已有生词补一句例句；返回服务端的最新条目，失败返回 null。 */
  addVocabularySentence: (
    id: string,
    input: Parameters<typeof api.addVocabularySentence>[1],
  ) => Promise<VocabularyItem | null>;
  /** 改释义 / 例句文本（整表覆盖），返回最新条目。 */
  updateVocabulary: (
    id: string,
    patch: Parameters<typeof api.updateVocabulary>[1],
  ) => Promise<VocabularyItem | null>;

  generateSummary: (id: string) => Promise<void>;
  translateTitle: (id: string) => Promise<void>;
  translateBody: (id: string) => Promise<void>;
  setTranslationMode: (mode: TranslationMode) => void;
  fetchFulltext: (id: string) => Promise<void>;

  setUi: (patch: Partial<UiState>) => void;
  /** 交给系统浏览器打开，桌面上唯一能真正打开外链的路径。 */
  openExternal: (url: string) => Promise<void>;
  toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;
}

const initialSummary: SummaryState = { status: 'idle', text: '', error: null };
const initialTranslation: TranslationState = {
  status: 'idle',
  progress: 0,
  total: 0,
  error: null,
  mode: 'off',
};

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '发生了未知错误';
}

/**
 * 请求序号：连按 j/k 时先发的请求可能后到，只有最新一次的结果才允许落到 state 上。
 * 快照与详情各用一条，避免互相干扰。
 */
let snapshotSeq = 0;
let articleSeq = 0;

/** 自动已读定时器，按文章 id 记账。手动改已读状态、切走文章时要能取消，否则会被悄悄改回去。 */
const markReadTimers = new Map<string, number>();

function clearMarkReadTimer(id: string): void {
  const handle = markReadTimers.get(id);
  if (handle === undefined) return;
  window.clearTimeout(handle);
  markReadTimers.delete(id);
}

/** 刷新轮询只允许有一个循环，否则「r」连按会有多条循环同时改 refresh。 */
let polling = false;

/** 正在抓全文的文章 id。阅读器和「打开即抓全文」可能同时发起，同一篇只该抓一次。 */
const fulltextInFlight = new Set<string>();

/** AI 是否可用：没配 baseUrl 或没存 key 时，任何「自动摘要」都只会换来一个红色报错。 */
function aiConfigured(state: Pick<AppState, 'settings' | 'secrets'>): boolean {
  if (!state.settings?.ai.apiBaseUrl) return false;
  // secrets 还没加载时不做否定判断，交给后端去报错。
  return state.secrets?.hasAiApiKey !== false;
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  loadingSnapshot: false,
  loadingMore: false,
  loadingArticle: false,
  fetchingFulltext: false,

  categories: [],
  feeds: [],
  counts: { all: 0, unread: 0, starred: 0, filtered: 0 },
  view: 'all',
  unreadOnly: false,
  includeFiltered: false,

  articles: [],
  nextCursor: null,
  totalCount: 0,
  loadError: null,

  selectedId: null,
  article: null,

  settings: null,
  secrets: null,
  prompts: null,

  refresh: null,
  summary: initialSummary,
  translation: initialTranslation,
  vocabulary: [],

  ui: {
    settingsOpen: false,
    addFeedOpen: false,
    rssCatalogOpen: false,
    addFeedPrefill: null,
    searchOpen: false,
    vocabularyOpen: false,
    sidebarCollapsed: false,
    translationMode: 'off',
    learningEnabled: false,
    rightPaneVisible: true,
  },
  toasts: [],

  async init() {
    try {
      await get().loadSettings();
      await get().reloadSnapshot();
      set({ ready: true });
      const settings = get().settings;
      if (settings?.general.defaultUnreadOnlyInAll) {
        set({ unreadOnly: true });
        await get().reloadSnapshot();
      }
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async reloadSnapshot(options) {
    // 两次 reload 可能并发（切视图 + 轮询收尾），只让最后一次的结果落地。
    const seq = (snapshotSeq += 1);
    set({ loadingSnapshot: true });
    try {
      const snapshot = await api.fetchSnapshot({
        view: get().view,
        limit: 50,
        unreadOnly: get().unreadOnly,
        includeFiltered: get().includeFiltered,
      });
      if (seq !== snapshotSeq) return;

      // keepArticles：只更新侧栏与计数，列表和游标原地不动。
      // 翻到第 5 页时改个分类名，不该被踹回第一页。
      if (options?.keepArticles) {
        set({
          categories: snapshot.categories,
          feeds: snapshot.feeds,
          counts: snapshot.counts,
          refresh: snapshot.refresh,
          loadingSnapshot: false,
          loadError: null,
        });
        return;
      }

      set({
        categories: snapshot.categories,
        feeds: snapshot.feeds,
        counts: snapshot.counts,
        articles: snapshot.articles.items,
        nextCursor: snapshot.articles.nextCursor,
        totalCount: snapshot.articles.totalCount,
        refresh: snapshot.refresh,
        loadingSnapshot: false,
        loadError: null,
      });
    } catch (err) {
      if (seq !== snapshotSeq) return;
      const message = describeError(err);
      // 整表加载失败就别留着上一份列表冒充当前视图；keepArticles 是纯侧栏刷新，列表照旧。
      if (options?.keepArticles) {
        set({ loadingSnapshot: false, loadError: message });
      } else {
        set({ loadingSnapshot: false, loadError: message, articles: [], nextCursor: null, totalCount: 0 });
      }
      get().toast(message, 'error');
    }
  },

  async retrySnapshot() {
    set({ loadError: null });
    await get().reloadSnapshot();
  },

  async loadMore() {
    const { nextCursor, view, unreadOnly, includeFiltered, loadingMore } = get();
    if (!nextCursor || loadingMore) return;
    set({ loadingMore: true });
    try {
      const snapshot = await api.fetchSnapshot({
        view,
        cursor: nextCursor,
        limit: 50,
        unreadOnly,
        includeFiltered,
      });
      // 请求期间切了视图或列表被重载过：这一页属于旧列表，直接丢掉。
      if (get().view !== view || get().nextCursor !== nextCursor) {
        set({ loadingMore: false });
        return;
      }
      set((state) => {
        // 视图切换与分页可能并发，按 id 去重，避免同一篇被追加两次。
        const seen = new Set(state.articles.map((item) => item.id));
        const merged = [...state.articles, ...snapshot.articles.items.filter((item) => !seen.has(item.id))];
        return {
          articles: merged,
          nextCursor: snapshot.articles.nextCursor,
          loadingMore: false,
        };
      });
    } catch (err) {
      set({ loadingMore: false });
      get().toast(describeError(err), 'error');
    }
  },

  async selectView(view) {
    articleSeq += 1;
    const leaving = get().selectedId;
    if (leaving) clearMarkReadTimer(leaving);
    set({
      view,
      loadingArticle: false,
      fetchingFulltext: false,
      selectedId: null,
      article: null,
      summary: initialSummary,
      translation: initialTranslation,
      // 换个视图就收回「显示已过滤」，否则聚合视图会混进本该隐藏的内容。
      includeFiltered: false,
      loadError: null,
    });
    await get().reloadSnapshot();
    // 加载失败时列表是空的，别再去自动选中一篇不存在的文章。
    if (get().loadError) return;
    const first = get().articles[0];
    if (first) await get().selectArticle(first.id);
  },

  async setUnreadOnly(value) {
    set({ unreadOnly: value });
    await get().reloadSnapshot();
  },

  async setIncludeFiltered(value) {
    set({ includeFiltered: value });
    // 这一项直接决定列表里有哪些文章，必须整表重载，不能走 keepArticles。
    await get().reloadSnapshot();
  },

  async selectAdjacent(delta) {
    let { articles, selectedId } = get();
    if (articles.length === 0) return;
    let index = selectedId ? articles.findIndex((item) => item.id === selectedId) : -1;
    let nextIndex = index === -1 ? (delta > 0 ? 0 : articles.length - 1) : index + delta;

    // 一路按 j 到已加载的末尾时顺手取下一页：否则用户以为文章只有 50 篇。
    if (delta > 0 && nextIndex >= articles.length && get().nextCursor) {
      await get().loadMore();
      articles = get().articles;
      index = selectedId ? articles.findIndex((item) => item.id === selectedId) : -1;
      nextIndex = index === -1 ? 0 : index + delta;
    }

    if (nextIndex < 0 || nextIndex >= articles.length) return;
    await get().selectArticle(articles[nextIndex].id);
  },

  async selectArticle(id) {
    const seq = (articleSeq += 1);
    const leaving = get().selectedId;
    if (leaving && leaving !== id) clearMarkReadTimer(leaving);
    if (!id) {
      set({ selectedId: null, article: null, loadingArticle: false, fetchingFulltext: false, summary: initialSummary, translation: initialTranslation });
      return;
    }

    // 离开上一篇时先把它的自动已读定时器掐掉，否则会在后台把上一篇标成已读。
    set({ selectedId: id, loadingArticle: true, fetchingFulltext: fulltextInFlight.has(id), summary: initialSummary, translation: initialTranslation });
    try {
      const article = await api.fetchArticle(id);
      // 连按 j/k：早发晚到的响应不能覆盖当前选中项。
      if (seq !== articleSeq) return;
      const translationMode = get().ui.translationMode;
      set({
        article,
        loadingArticle: false,
        summary: article.aiSummary
          ? { status: 'done', text: article.aiSummary, error: null }
          : article.aiSummarySession?.status === 'running'
            ? { status: 'running', text: article.aiSummarySession.draftText, error: null }
            : initialSummary,
        translation: {
          ...initialTranslation,
          mode: translationMode,
          status: article.aiTranslationBilingualHtml ? 'done' : 'idle',
        },
      });

      const settings = get().settings;
      if (!article.isRead && settings?.general.autoMarkReadEnabled) {
        // 同一篇重复打开时先清掉上一次的定时器，否则会叠好几个。
        clearMarkReadTimer(id);
        markReadTimers.set(
          id,
          window.setTimeout(() => {
            markReadTimers.delete(id);
            if (get().selectedId !== id) return;
            void get().toggleRead(id, true);
          }, settings.general.autoMarkReadDelayMs),
        );
      }

      // 「打开时自动做点事」的策略都挂在订阅上，而不是全局开关上：
      // 同一个源里的长文想抓全文、短讯不想，只有按源配置才说得清。
      const feed = get().feeds.find((item) => item.id === article.feedId);
      const summaryPending =
        article.aiSummarySession?.status === 'running' || article.aiSummarySession?.status === 'queued';

      if (feed?.fullTextOnOpenEnabled && !article.hasFulltext) {
        void get().fetchFulltext(id);
      }
      if (feed?.titleTranslateEnabled && !article.titleZh && article.titleOriginal === null) {
        void get().translateTitle(id);
      }
      if (feed?.bodyTranslateEnabled && !article.hasTranslation) {
        void get().translateBody(id);
      }
      // 没配 AI 时别自动摘要：每打开一篇就弹一个红色报错，比不做还烦。
      if (
        !article.aiSummary &&
        !summaryPending &&
        (feed?.aiSummaryOnOpenEnabled || settings?.ai.autoSummarize) &&
        aiConfigured(get())
      ) {
        void get().generateSummary(id);
      }
    } catch (err) {
      if (seq !== articleSeq) return;
      // 打开失败就把旧的详情清掉，别让上一篇的内容留在阅读区冒充这一篇。
      set({ loadingArticle: false, article: null });
      get().toast(describeError(err), 'error');
    }
  },

  async refreshArticle(id) {
    try {
      const article = await api.fetchArticle(id);
      if (get().selectedId === id) set({ article });
    } catch {
      // 刷新失败时保留旧内容
    }
  },

  async toggleRead(id, value) {
    // 用户自己按了 m/点了按钮：挂着的自动已读不能再把它改回去。
    clearMarkReadTimer(id);
    const previousArticles = get().articles;
    const previousCounts = get().counts;
    const previousArticle = get().article;
    set({
      articles: previousArticles.map((item) => (item.id === id ? { ...item, isRead: value } : item)),
      counts: {
        ...previousCounts,
        unread: Math.max(0, previousCounts.unread + (value ? -1 : 1)),
      },
      article: previousArticle && previousArticle.id === id ? { ...previousArticle, isRead: value } : previousArticle,
    });
    try {
      const result = await api.patchArticle(id, { isRead: value });
      set({ counts: result.counts });
    } catch (err) {
      // 失败要把列表、计数、打开中的详情一起回滚，只回滚列表会留下对不上的未读数。
      set((state) => ({
        articles: previousArticles,
        counts: previousCounts,
        article: state.article?.id === id ? previousArticle : state.article,
      }));
      get().toast(describeError(err), 'error');
    }
  },

  async toggleStar(id, value) {
    const previousArticles = get().articles;
    const previousCounts = get().counts;
    const previousArticle = get().article;
    set({
      articles: previousArticles.map((item) => (item.id === id ? { ...item, isStarred: value } : item)),
      counts: {
        ...previousCounts,
        starred: Math.max(0, previousCounts.starred + (value ? 1 : -1)),
      },
      article:
        previousArticle && previousArticle.id === id
          ? { ...previousArticle, isStarred: value }
          : previousArticle,
    });
    try {
      const result = await api.patchArticle(id, { isStarred: value });
      set({ counts: result.counts });
    } catch (err) {
      set((state) => ({
        articles: previousArticles,
        counts: previousCounts,
        article: state.article?.id === id ? previousArticle : state.article,
      }));
      get().toast(describeError(err), 'error');
    }
  },

  async markAllRead() {
    try {
      const result = await api.markAllRead(get().view);
      get().toast(`已标记 ${result.updated} 篇为已读`, 'success');
      // 全部已读会改变列表本身（未读视图会清空），这里不能用 keepArticles。
      await get().reloadSnapshot();
      set({ counts: result.counts });
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async refreshAll() {
    // 「r」连按：已经在刷新就直接忽略，别再弹一次「已开始刷新」。
    if (polling) return;
    if (get().refresh?.running) {
      // 后端已经在刷（比如重开窗口后状态还在）：只把轮询接上，不重复发起。
      void get().pollRefresh();
      return;
    }
    try {
      const progress = await api.refreshAllFeeds();
      set({ refresh: progress });
      get().toast('已开始刷新全部订阅', 'info');
      void get().pollRefresh();
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async pollRefresh() {
    if (polling) return;
    polling = true;
    try {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try {
          const progress = await api.fetchRefreshStatus();
          set({ refresh: progress });
          if (!progress.running) {
            await get().reloadSnapshot({ keepArticles: true });
            if (progress.inserted > 0) get().toast(`刷新完成，新增 ${progress.inserted} 篇`, 'success');
            else if (progress.failures.length > 0) get().toast(`${progress.failures.length} 个订阅抓取失败`, 'error');
            else get().toast('刷新完成，没有新文章', 'info');
            return;
          }
        } catch {
          // 轮询本身失败不该把按钮永久锁在「刷新中」：收尾并把状态放回可点。
          set((state) => ({ refresh: state.refresh ? { ...state.refresh, running: false } : state.refresh }));
          get().toast('刷新状态获取失败，请稍后重试', 'error');
          return;
        }
      }
    } finally {
      polling = false;
    }
  },

  async loadSettings() {
    try {
      const payload = await api.fetchSettings();
      set({ settings: payload.settings, secrets: payload.secrets, prompts: payload.prompts });
      applyTheme(payload.settings.general.theme, payload.settings.general.themeColor);
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async saveSettings(input, options) {
    const payload = await api.saveSettings(input);
    set({ settings: payload.settings, secrets: payload.secrets, prompts: payload.prompts });
    applyTheme(payload.settings.general.theme, payload.settings.general.themeColor);
    if (!options?.silent) get().toast('设置已保存', 'success');
  },

  async resetSettings() {
    const payload = await api.resetSettings();
    set({ settings: payload.settings, secrets: payload.secrets, prompts: payload.prompts });
    applyTheme(payload.settings.general.theme, payload.settings.general.themeColor);
    get().toast('已恢复默认设置', 'success');
  },

  async reapplyFilters(includeAi = false) {
    try {
      const result = await api.reapplyFilters(includeAi);
      if (result.running) {
        // 文章太多时后端转后台跑，这里轮询到结束再刷新列表。
        get().toast('正在重新判定历史文章…', 'info');
        let last: FilterProgress | null = null;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            last = await api.fetchFilterProgress();
            if (!last.running) break;
          } catch {
            // 单次轮询失败不该中断整轮：后台任务还在跑，等下一拍继续问。
          }
        }
        // 过滤状态变了，列表必须整表重载；keepArticles 会留着旧的是否被过滤标记。
        await get().reloadSnapshot();
        if (last && !last.running) get().toast('重新判定完成', 'success');
        else get().toast('判定仍在后台进行，完成后刷新列表即可看到结果', 'info');
        return;
      }
      // 同步跑完的那条路也一样：过滤标记变了，列表得整表重载。
      await get().reloadSnapshot();
      get().toast(
        `已重判 ${result.scanned} 篇：新过滤 ${result.filtered} 篇，恢复 ${result.unfiltered} 篇`,
        'success',
      );
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async createCategory(name) {
    try {
      const category = await api.createCategory(name);
      await get().reloadSnapshot({ keepArticles: true });
      return category;
    } catch (err) {
      get().toast(describeError(err), 'error');
      return null;
    }
  },

  async renameCategory(id, name) {
    try {
      await api.renameCategory(id, name);
      await get().reloadSnapshot({ keepArticles: true });
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async deleteCategory(id) {
    try {
      await api.deleteCategory(id);
      // 删掉的分类如果正是当前视图，退到「全部」，否则会停在一个不存在的视图上。
      if (get().view === `category:${id}`) {
        await get().selectView('all');
      } else {
        await get().reloadSnapshot({ keepArticles: true });
      }
      get().toast('分类已删除，原订阅归入未分类', 'success');
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async reorderCategories(ids) {
    // 先在本地排好序，拖拽松手时界面不该跳一下再归位。
    const byId = new Map(get().categories.map((item) => [item.id, item]));
    const optimistic = ids
      .map((id) => byId.get(id))
      .filter((item): item is Category => Boolean(item));
    if (optimistic.length === get().categories.length) set({ categories: optimistic });
    try {
      const categories = await api.reorderCategories(ids);
      set({ categories });
    } catch (err) {
      get().toast(describeError(err), 'error');
      await get().reloadSnapshot({ keepArticles: true });
    }
  },

  async loadVocabulary() {
    try {
      set({ vocabulary: await api.fetchVocabulary() });
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async addVocabulary(input) {
    try {
      await api.addVocabulary(input);
      await get().loadVocabulary();
      get().toast(`已加入生词本：${input.term}`, 'success');
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async removeVocabulary(id) {
    try {
      await api.deleteVocabulary(id);
      set((state) => ({ vocabulary: state.vocabulary.filter((item) => item.id !== id) }));
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async addVocabularySentence(id, input) {
    try {
      const updated = await api.addVocabularySentence(id, input);
      set((state) => ({
        vocabulary: state.vocabulary.map((item) => (item.id === updated.id ? updated : item)),
      }));
      return updated;
    } catch (err) {
      get().toast(describeError(err), 'error');
      return null;
    }
  },

  async updateVocabulary(id, patch) {
    try {
      const updated = await api.updateVocabulary(id, patch);
      set((state) => ({
        vocabulary: state.vocabulary.map((item) => (item.id === updated.id ? updated : item)),
      }));
      return updated;
    } catch (err) {
      get().toast(describeError(err), 'error');
      return null;
    }
  },

  async generateSummary(id) {
    // 只对「当前打开的那篇」动 state：切走后流还在跑，旧文章的 token 不能灌进新文章。
    const isCurrent = () => get().article?.id === id;
    if (!isCurrent()) return;
    set({ summary: { status: 'running', text: '', error: null } });
    try {
      await api.streamSummary(id, {
        onEvent: (event, data) => {
          if (!isCurrent()) return;
          const payload = data as { text?: string; message?: string };
          if (event === 'delta' && typeof payload.text === 'string') {
            set((state) => ({ summary: { ...state.summary, status: 'running', text: state.summary.text + payload.text } }));
          } else if (event === 'done' && typeof payload.text === 'string') {
            const current = get().article;
            set({
              summary: { status: 'done', text: payload.text, error: null },
              article:
                current && current.id === id
                  ? { ...current, aiSummary: payload.text, hasAiSummary: true }
                  : current,
            });
          } else if (event === 'error') {
            set({ summary: { status: 'error', text: '', error: payload.message ?? '生成失败' } });
            get().toast(payload.message ?? '生成摘要失败', 'error');
          }
        },
      });
    } catch (err) {
      if (!isCurrent()) return;
      set({ summary: { status: 'error', text: '', error: describeError(err) } });
      get().toast(describeError(err), 'error');
    }
  },

  async translateTitle(id) {
    try {
      const result = await api.translateTitle(id);
      set((state) => ({
        // 详情是否还在这一篇要重新判断：翻译回来时用户可能已经切走了。
        article:
          state.article && state.article.id === id
            ? { ...state.article, titleZh: result.title }
            : state.article,
        articles: state.articles.map((item) =>
          item.id === id ? { ...item, titleZh: result.title } : item,
        ),
      }));
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  async translateBody(id) {
    const isCurrent = () => get().article?.id === id;
    set({ translation: { status: 'running', progress: 0, total: 0, error: null, mode: 'bilingual' } });
    try {
      await api.streamBodyTranslation(id, {
        onEvent: (event, data) => {
          if (!isCurrent()) return;
          const payload = data as {
            translated?: Array<{ id: number; text: string }>;
            bilingualHtml?: string;
            zhHtml?: string;
            totalSegments?: number;
            message?: string;
          };
          if (event === 'progress' && Array.isArray(payload.translated)) {
            set((state) => ({
              translation: {
                ...state.translation,
                progress: payload.translated!.length,
                total: state.translation.total || payload.translated!.length,
              },
            }));
          } else if (event === 'done') {
            set((state) => {
              const same = state.article?.id === id;
              return {
                translation: {
                  ...state.translation,
                  status: 'done',
                  total: payload.totalSegments ?? state.translation.total,
                  progress: payload.totalSegments ?? state.translation.progress,
                },
                article: same
                  ? {
                      ...state.article!,
                      aiTranslationZhHtml: payload.zhHtml ?? null,
                      aiTranslationBilingualHtml: payload.bilingualHtml ?? null,
                      hasTranslation: true,
                    }
                  : state.article,
                // 只有还停在这一篇时才顺手切到双语；用户已经切走就别动他的阅读模式。
                ui: same ? { ...state.ui, translationMode: 'bilingual' } : state.ui,
              };
            });
            get().toast('正文翻译完成', 'success');
          } else if (event === 'error') {
            set((state) => ({
              translation: { ...state.translation, status: 'error', error: payload.message ?? '翻译失败' },
            }));
            get().toast(payload.message ?? '正文翻译失败', 'error');
          }
        },
      });
    } catch (err) {
      if (!isCurrent()) return;
      set((state) => ({
        translation: { ...state.translation, status: 'error', error: describeError(err) },
      }));
      get().toast(describeError(err), 'error');
    }
  },

  setTranslationMode(mode) {
    set((state) => ({ ui: { ...state.ui, translationMode: mode } }));
  },

  async fetchFulltext(id) {
    // 阅读器的 effect 和「打开即抓全文」可能各发一次，同一篇只抓一次。
    if (fulltextInFlight.has(id)) return;
    fulltextInFlight.add(id);
    // 自己的 spinner：抓全文不该让阅读区整块变成「打开中」。
    if (get().selectedId === id) set({ fetchingFulltext: true });
    try {
      const result = await api.fetchFulltext(id);
      set((state) => ({
        fetchingFulltext: state.selectedId === id ? false : state.fetchingFulltext,
        // 抓取期间可能已经切走，只有还停在这一篇时才写正文。
        article:
          state.article && state.article.id === id
            ? { ...state.article, contentFullHtml: result.contentFullHtml, hasFulltext: true }
            : state.article,
      }));
      get().toast(`已抓取全文（约 ${result.wordCount} 字）`, 'success');
    } catch (err) {
      if (get().selectedId === id) set({ fetchingFulltext: false });
      get().toast(describeError(err), 'error');
    } finally {
      fulltextInFlight.delete(id);
    }
  },

  setUi(patch) {
    set((state) => ({ ui: { ...state.ui, ...patch } }));
  },

  async openExternal(url) {
    try {
      await api.openExternalUrl(url);
    } catch (err) {
      get().toast(describeError(err), 'error');
    }
  },

  toast(message, tone = 'info') {
    const id = Math.random().toString(36).slice(2);
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }));
    window.setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 3000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));

export function applyTheme(
  theme: 'light' | 'dark' | 'auto',
  themeColor: import('../api/types').ThemeColor = 'sage',
): void {
  const root = document.documentElement;
  const resolved =
    theme === 'auto'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  root.dataset.theme = resolved;
  // 主题色只切强调色变量，明暗仍由 data-theme 决定；两者可以任意组合。
  root.dataset.accent = themeColor;
  root.style.colorScheme = resolved;
}
