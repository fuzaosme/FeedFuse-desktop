import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronUp,
  ExternalLink,
  Filter,
  GraduationCap,
  Languages,
  Loader2,
  Newspaper,
  Sparkles,
  Star,
  Wand2,
} from 'lucide-react';
import { useAppStore } from '../store/app';
import { EmptyState, Spinner } from './ui';
import { articleFontSize, articleLineHeight, formatDateTime, hostOf } from '../lib/format';
import { normalizeVocabularyTerm } from '../lib/englishLearning';
import { useEnglishLearning } from '../features/learning/useEnglishLearning';
import LearningCardStack from '../features/learning/LearningCardStack';
import { emphasizeVocabulary, escapeHtml } from '../features/learning/emphasizeVocabulary';
import { createVocabularyMatcher } from '../features/learning/vocabularyMatch';
import { sentenceAroundElement } from '../features/learning/vocabularyContext';
import { VocabularyWordPopover } from '../features/learning/VocabularyWordPopover';
import type { ArticleDetail } from '../api/types';

/**
 * 阅读位置只写 sessionStorage：正文会被重新抓取、翻译，跨会话恢复一个陈旧偏移
 * 只会让用户以为「打开就看到中间」，所以进程退出就丢弃。
 */
const SCROLL_KEY_PREFIX = 'feedfuse:reader-scroll:';

/**
 * 过滤原因的中文解释。列表项的小标签也从这里取，保证同一件事不会有两种说法。
 */
export function filterReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'keyword':
      return '被关键词规则过滤';
    case 'ai':
      return 'AI 判定不值得保留';
    case 'duplicate_url':
      return '与其他订阅的文章重复（链接相同）';
    case 'duplicate_title':
      return '与其他订阅的文章重复（标题相同）';
    case 'duplicate_similar':
      return '与其他订阅的文章重复（内容高度相似）';
    default:
      // 后端新增了原因但前端还没跟上时，也别显示一句空话或英文枚举值。
      return '原因未记录';
  }
}

/** 「警告」语义：被过滤/降级提示用。不能复用 --ff-danger——文章被规则挡掉不是出错。 */
export const WARNING_TONE = {
  color: 'var(--ff-warning)',
  background: 'var(--ff-warning-soft)',
  borderColor: 'var(--ff-warning-border)',
} as const;

function saveScrollTop(id: string, top: number): void {
  try {
    sessionStorage.setItem(SCROLL_KEY_PREFIX + id, String(Math.round(top)));
  } catch {
    // 个别 WebView 会禁用 sessionStorage；记不住位置不影响阅读，直接放弃。
  }
}

function readScrollTop(id: string): number {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY_PREFIX + id);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function ArticleReader() {
  const article = useAppStore((state) => state.article);
  // 抓全文有自己的 loading：和「正在打开文章」是两个独立状态，
  // 混用会让整篇阅读区在抓取时看起来像重新加载。
  const fetchingFulltext = useAppStore((state) => state.fetchingFulltext);
  const settings = useAppStore((state) => state.settings);
  const secrets = useAppStore((state) => state.secrets);
  const feeds = useAppStore((state) => state.feeds);
  const articles = useAppStore((state) => state.articles);
  const nextCursor = useAppStore((state) => state.nextCursor);
  const selectedId = useAppStore((state) => state.selectedId);
  const summary = useAppStore((state) => state.summary);
  const translation = useAppStore((state) => state.translation);
  const ui = useAppStore((state) => state.ui);
  const toggleRead = useAppStore((state) => state.toggleRead);
  const toggleStar = useAppStore((state) => state.toggleStar);
  const generateSummary = useAppStore((state) => state.generateSummary);
  const fetchFulltext = useAppStore((state) => state.fetchFulltext);
  const translateTitle = useAppStore((state) => state.translateTitle);
  const translateBody = useAppStore((state) => state.translateBody);
  const setTranslationMode = useAppStore((state) => state.setTranslationMode);
  const setUi = useAppStore((state) => state.setUi);
  const selectAdjacent = useAppStore((state) => state.selectAdjacent);
  const openExternal = useAppStore((state) => state.openExternal);
  const vocabulary = useAppStore((state) => state.vocabulary);
  const removeVocabulary = useAppStore((state) => state.removeVocabulary);
  const addVocabularySentence = useAppStore((state) => state.addVocabularySentence);
  const toast = useAppStore((state) => state.toast);

  const [summaryOpen, setSummaryOpen] = useState(true);
  /** 被点开的生词浮层：只存 id 与位置，内容始终从 store 取，删改/加句后自动跟着变。 */
  const [wordPopover, setWordPopover] = useState<{
    id: string;
    rect: { left: number; right: number; top: number; bottom: number };
  } | null>(null);
  const [addingSentence, setAddingSentence] = useState(false);
  /** 点开时算好的「当前这一句」，加句按钮直接用它，不必再回头找 DOM。 */
  const popoverSentence = useRef('');
  // 只有本组件发起的流式请求才该转圈。store 里的 summary.status 可能是「上次留下的 running」，
  // 拿它当 loading 会让用户盯着一个永远不会结束的动画。
  const [streaming, setStreaming] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** 标题在正文容器之外：选中标题里的单词同样要能触发查词。 */
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 最近一次已知的滚动位置。滚动时实时记，避免在 cleanup 里读到已被重置的 scrollTop。 */
  const scrollMemo = useRef<{ id: string | null; top: number }>({ id: null, top: 0 });

  const articleId = article?.id ?? null;

  /**
   * 划词学习：正文优先、标题兜底。contentHtml 参与 effect 依赖，
   * 切换「原文 / 双语 / 仅译文」时旧选区卡片会整体失效，避免释义对不上新正文。
   */
  const learning = useEnglishLearning({
    articleId,
    contentRef: bodyRef,
    titleRef,
    contentHtml: article ? pickHtml(article, ui.translationMode) : '',
    // Tauri 窗口最小宽度 960，三栏布局始终存在；移动端形态不在桌面版范围内。
    isDesktop: true,
  });

  /**
   * 生词标记。
   *
   * 索引按词条集合建一次（收藏/删除后才重建），正文 HTML 再按 matcher 走一遍：
   * 每个词条会展开成复数、所有格、规则时态等变体，所以 `resilient` 也能标出 `resilient` /
   * 收藏的 `studies` 能标出正文里的 `study`。翻译模式切换时 rawHtml 变，标记跟着重算。
   */
  const rawHtml = article ? pickHtml(article, ui.translationMode) : '';
  const vocabularyMatcher = useMemo(
    () => createVocabularyMatcher(vocabulary.map((item) => item.term)),
    [vocabulary],
  );
  const html = useMemo(
    () => emphasizeVocabulary(rawHtml, vocabularyMatcher),
    [rawHtml, vocabularyMatcher],
  );
  /**
   * 标题也参与标记：生词不只是出现在正文段落里，标题里的词同样值得点开看。
   * 标题是纯文本，先转义再交给 emphasise，避免标题里的 `<` 被当成标签。
   */
  const titleText = article
    ? (ui.translationMode !== 'off' && article.titleZh ? article.titleZh : article.title)
    : '';
  const titleHtml = useMemo(
    () => emphasizeVocabulary(escapeHtml(titleText), vocabularyMatcher),
    [titleText, vocabularyMatcher],
  );
  const popoverEntry = wordPopover
    ? vocabulary.find((item) => item.id === wordPopover.id) ?? null
    : null;

  // 换文章/切译文后旧浮层的位置已经失效，直接收起。
  useEffect(() => {
    setWordPopover(null);
  }, [articleId, ui.translationMode]);

  const feed = useMemo(
    () => (article ? feeds.find((item) => item.id === article.feedId) : undefined),
    [article, feeds],
  );

  const startSummary = async (id: string) => {
    setStreaming(true);
    try {
      await generateSummary(id);
    } finally {
      setStreaming(false);
    }
  };

  useEffect(() => {
    setSummaryOpen(true);
    setStreaming(false);
  }, [articleId]);

  // 订阅级「打开即摘要 / 打开即翻译」在这里落地，避免用户每次手动点。
  useEffect(() => {
    if (!article || !settings) return;
    const pending =
      article.aiSummarySession?.status === 'running' || article.aiSummarySession?.status === 'queued';
    // 上次的会话还没结束：不自动重来，留给用户自己决定要不要覆盖。
    if (pending) return;
    const wantsSummary = feed?.aiSummaryOnOpenEnabled || settings.ai.autoSummarize;
    // 没填 Base URL 或 Key 时自动生成必然失败，不要每打开一篇就弹一次红条。
    const aiReady = Boolean(settings.ai.apiBaseUrl) && secrets?.hasAiApiKey !== false;
    if (wantsSummary && aiReady && !article.aiSummary && summary.status === 'idle') {
      void startSummary(article.id);
    }
  }, [article?.id, feed?.aiSummaryOnOpenEnabled, settings?.ai.autoSummarize]);

  useEffect(() => {
    if (!article || !feed) return;
    if (feed.bodyTranslateEnabled && article.aiTranslationBilingualHtml && ui.translationMode === 'off') {
      setTranslationMode('bilingual');
    }
  }, [article?.id, feed?.bodyTranslateEnabled]);

  // 打开时按订阅设置自动抓全文
  useEffect(() => {
    if (!article || !feed) return;
    if (feed.fullTextOnOpenEnabled && !article.hasFulltext && !fetchingFulltext) {
      void fetchFulltext(article.id);
    }
  }, [article?.id, feed?.fullTextOnOpenEnabled]);

  /**
   * 切文章：先把上一篇的阅读位置落盘，再恢复这一篇。
   * 用 layout effect 而不是普通的 effect，是为了在浏览器绘制前把 scrollTop 设好，
   * 否则用户会看到内容从顶部闪一下再跳到目标位置。
   */
  useLayoutEffect(() => {
    const memo = scrollMemo.current;
    if (memo.id && memo.id !== articleId) saveScrollTop(memo.id, memo.top);
    scrollMemo.current = { id: articleId, top: 0 };

    const node = scrollRef.current;
    if (!node || !articleId) return;
    // 此时 dangerouslySetInnerHTML 的内容已在 DOM 里，设置 scrollTop 不会被后续渲染覆盖；
    // 图片异步撑开高度后会有一点偏移，但远好于每次都从顶部开始。
    node.scrollTop = readScrollTop(articleId);
  }, [articleId]);

  // 阅读区被卸载（切到别的视图）时也要记住位置，否则这次的阅读进度就白记了。
  useEffect(() => {
    return () => {
      const memo = scrollMemo.current;
      if (memo.id) saveScrollTop(memo.id, memo.top);
    };
  }, []);

  if (!article) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Newspaper size={30} />}
            title="选择一篇文章开始阅读"
            description="左侧切换视图，中间列表选择文章。快捷键：j / n 下一篇，k / p 上一篇，m 已读，s 星标，? 查看全部。"
          />
        </div>
      </div>
    );
  }

  const fontStyle = {
    '--ff-article-size': articleFontSize(settings?.general.fontSize ?? 'medium'),
    '--ff-article-leading': articleLineHeight(settings?.general.lineHeight ?? 'normal'),
  } as React.CSSProperties;

  const externalLink = article.link;
  const hasBody = Boolean(article.contentHtml?.trim() || article.contentFullHtml?.trim());

  /**
   * 正文点击的事件委托。
   *
   * 两件事必须在这里兜住：
   * 1. 桌面 WebView 对 `target="_blank"` 没有默认行为，必须交给系统浏览器；
   * 2. 站内相对链接（`/post/123`）如果放过，WebView 会真的导航过去，被 sidecar 的 SPA
   *    兜底接住，等于整页重载、阅读现场全丢。所以除页内锚点外一律拦下，按文章地址
   *    补全后再决定交给谁。
   */
  /**
   * 打开生词浮层。
   *
   * `data-vocabulary-term` 存的是词条在生词本里的原始写法，用它定位条目；
   * 找不到（刚被删掉/词条改了）就直接不弹，别让用户点出一个空壳。
   */
  const openWordPopover = (element: HTMLElement) => {
    const term = element.getAttribute('data-vocabulary-term') ?? '';
    const normalized = normalizeVocabularyTerm(term);
    const entry = vocabulary.find((item) => item.term === term) ??
      vocabulary.find((item) => normalizeVocabularyTerm(item.term) === normalized);
    if (!entry) return;
    const rect = element.getBoundingClientRect();
    popoverSentence.current = sentenceAroundElement(element);
    setWordPopover({
      id: entry.id,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    });
  };

  /** 把「当前这句」收进例句；满 5 句时由服务端替换最早的一句。 */
  const handleAddSentence = async () => {
    if (!wordPopover || !article) return;
    const text = popoverSentence.current.trim();
    if (!text) {
      toast('没能取到当前这一句，请重新点开这个单词', 'error');
      return;
    }
    setAddingSentence(true);
    try {
      const updated = await addVocabularySentence(wordPopover.id, {
        text,
        articleId: article.id,
        articleTitle: article.title,
        articleUrl: article.link ?? '',
      });
      if (updated) {
        toast(`已加入例句（${updated.sentences.length}/5）`, 'success');
      }
    } finally {
      setAddingSentence(false);
    }
  };

  const handleDeleteWord = async () => {
    if (!popoverEntry) return;
    if (!window.confirm(`从生词本删除「${popoverEntry.term}」？它的例句也会一并删除。`)) return;
    await removeVocabulary(popoverEntry.id);
    setWordPopover(null);
  };

  /** 命中带标记的生词就打开浮层；键盘激活时也走这一条。 */
  const openVocabularyWord = (target: EventTarget | null): boolean => {
    const word = (target as HTMLElement | null)?.closest?.('[data-vocabulary-word]');
    if (!(word instanceof HTMLElement)) return false;
    openWordPopover(word);
    return true;
  };

  /** 返回是否已经处理掉这次点击（处理了就不要再走链接逻辑）。 */
  const handleVocabularyClick = (event: React.MouseEvent<HTMLElement>): boolean => {
    if (!openVocabularyWord(event.target)) return false;
    event.preventDefault();
    return true;
  };

  const handleBodyClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // 生词优先于链接：加亮后的词可能正好落在一段链接文字里，此时应当看释义而不是跳原文。
    if (handleVocabularyClick(event)) return;

    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a[href]');
    if (!anchor) return;

    const href = anchor.getAttribute('href') ?? '';
    // 页内锚点交给浏览器滚动，这是唯一该放行的默认行为。
    if (!href || href.startsWith('#')) return;

    event.preventDefault();

    let resolved: URL;
    try {
      resolved = new URL(href, externalLink ?? window.location.href);
    } catch {
      return;
    }
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      void openExternal(resolved.toString());
      return;
    }
    // sidecar 的 opener 只放行 http/https；以前这里直接改 location，会把整个 SPA 顶掉、
    // 阅读现场全丢。改为只把地址交给用户，让他自己决定怎么处理。
    if (resolved.protocol === 'mailto:') {
      toast(`邮件地址：${resolved.toString().slice('mailto:'.length)}（复制后到邮件客户端发送）`, 'info');
    }
  };

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    scrollMemo.current.top = node.scrollTop;
  };

  const handleOpenOriginal = () => {
    if (!externalLink) return;
    void openExternal(externalLink);
  };

  // 上下篇：位置只在「文章确实在当前列表里」时才显示，搜索等场景下列表和阅读区可能不重合。
  const navIndex = selectedId ? articles.findIndex((item) => item.id === selectedId) : -1;
  const totalInList = articles.length;

  // 摘要：区分「本次真的在生成」与「上次留下的未完成会话」。
  const session = article.aiSummarySession;
  const sessionStatus = session?.status ?? null;
  const finalSummary = article.aiSummary ?? session?.finalText ?? '';
  const summaryText = summary.text || finalSummary;
  const generating = streaming;
  const queued = !generating && !finalSummary && sessionStatus === 'queued';
  const stalled = !generating && !finalSummary && sessionStatus === 'running';
  const failed = summary.status === 'error' || (!finalSummary && sessionStatus === 'failed');
  const summaryError = summary.error ?? session?.errorMessage ?? '生成失败';
  const showSummary = Boolean(summaryText) || generating || queued || stalled || failed;

  return (
    <article className="flex h-full flex-col" style={{ background: 'var(--ff-surface)' }}>
      <header className="border-b px-6 py-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--ff-muted)' }}>
          <span className="max-w-[40%] truncate font-medium">{article.feedTitle}</span>
          <span>·</span>
          <span className="shrink-0 whitespace-nowrap">{formatDateTime(article.publishedAt)}</span>
          {article.author ? (
            <>
              <span>·</span>
              <span className="max-w-[30%] shrink-0 truncate">{article.author}</span>
            </>
          ) : null}
          <span className="min-w-2 flex-1" />
          <button
            className="ff-btn ff-btn-ghost !px-1.5 !py-1"
            onClick={() => void toggleStar(article.id, !article.isStarred)}
            title="星标 (s)"
          >
            <Star
              size={14}
              style={article.isStarred ? { color: 'var(--ff-accent)', fill: 'var(--ff-accent)' } : undefined}
            />
          </button>
          <button
            className="ff-btn ff-btn-ghost !px-1.5 !py-1"
            onClick={() => void toggleRead(article.id, !article.isRead)}
            title="切换已读 (m)"
          >
            <Check size={14} style={article.isRead ? { color: 'var(--ff-accent)' } : undefined} />
          </button>
          {externalLink ? (
            // 用 <a href> 保留「复制链接 / 悬停看地址」，但点击必须改走系统浏览器。
            <a
              className="ff-btn ff-btn-ghost !px-1.5 !py-1"
              href={externalLink}
              title="在浏览器打开原文"
              onClick={(event) => {
                event.preventDefault();
                handleOpenOriginal();
              }}
            >
              <ExternalLink size={14} />
            </a>
          ) : null}
        </div>

        <h1
          ref={titleRef}
          className="text-[19px] font-semibold leading-snug"
          onPointerUp={learning.onPointerUp}
          onDoubleClick={learning.onDoubleClick}
          onClick={(event) => {
            handleVocabularyClick(event);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (!openVocabularyWord(event.target)) return;
            event.preventDefault();
          }}
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
        {article.titleZh && ui.translationMode === 'off' ? (
          <p className="mt-1 text-[13px]" style={{ color: 'var(--ff-muted)' }}>
            {article.titleZh}
          </p>
        ) : null}
        {ui.translationMode !== 'off' && article.titleZh ? (
          <p className="mt-1 text-[12px]" style={{ color: 'var(--ff-faint)' }}>
            {article.title}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            className={clsx('ff-btn !px-2 !py-1 text-[11px]')}
            onClick={() => void startSummary(article.id)}
            disabled={generating}
          >
            {generating ? <Spinner /> : <Sparkles size={12} />}
            {article.aiSummary || summary.text ? '重新生成摘要' : 'AI 摘要'}
          </button>

          <button
            className="ff-btn !px-2 !py-1 text-[11px]"
            onClick={() => void translateTitle(article.id)}
            title="把标题翻译成中文"
          >
            <Languages size={12} /> 译标题
          </button>

          <button
            className="ff-btn !px-2 !py-1 text-[11px]"
            onClick={() => void translateBody(article.id)}
            disabled={translation.status === 'running'}
            title="逐段翻译正文并保留原文"
          >
            {translation.status === 'running' ? <Spinner /> : <Wand2 size={12} />}
            {translation.status === 'running'
              ? `翻译中 ${translation.progress}`
              : article.aiTranslationBilingualHtml
                ? '重新翻译'
                : 'AI 翻译'}
          </button>

          {article.aiTranslationBilingualHtml ? (
            <div className="flex overflow-hidden rounded-md border text-[11px]">
              {(
                [
                  ['off', '原文'],
                  ['bilingual', '双语'],
                  ['zh', '仅译文'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className="px-2 py-1 transition-colors"
                  style={
                    ui.translationMode === mode
                      ? { background: 'var(--ff-accent-fill)', color: 'var(--ff-accent-contrast)' }
                      : { color: 'var(--ff-muted)' }
                  }
                  onClick={() => setTranslationMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          {/*
            英语学习模式：开启后才能划词查词 / AI 讲解。
            以前这个能力是常驻的，任何选中都会弹卡片，等于没有关闭入口；
            做成显式开关并与摘要、翻译放在一起，用户才知道它何时生效。
          */}
          <button
            className={clsx('ff-btn !px-2 !py-1 text-[11px]')}
            aria-pressed={ui.learningEnabled}
            style={
              ui.learningEnabled
                ? {
                    background: 'var(--ff-accent-soft)',
                    borderColor: 'var(--ff-accent)',
                    color: 'var(--ff-accent-text)',
                  }
                : undefined
            }
            onClick={() => setUi({ learningEnabled: !ui.learningEnabled })}
            title={
              ui.learningEnabled
                ? '关闭英语学习模式：选中文字不再弹出查词卡片'
                : '开启英语学习模式：选中文字可查词、AI 讲解、加入生词本'
            }
          >
            <GraduationCap size={12} /> 英语学习
          </button>

          {!article.hasFulltext ? (
            <button
              className="ff-btn !px-2 !py-1 text-[11px]"
              onClick={() => void fetchFulltext(article.id)}
              disabled={fetchingFulltext}
            >
              {fetchingFulltext ? <Spinner /> : <Newspaper size={12} />} 抓取全文
            </button>
          ) : (
            <span className="ff-chip">
              <Check size={10} /> 全文
            </span>
          )}

          {feed?.fullTextOnOpenEnabled ? <span className="ff-chip">打开即全文</span> : null}
          {feed?.aiSummaryOnOpenEnabled ? <span className="ff-chip">打开即摘要</span> : null}

          {navIndex >= 0 ? (
            <div className="ml-auto flex items-center gap-1 text-[11px]" style={{ color: 'var(--ff-muted)' }}>
              <button
                className="ff-btn ff-btn-ghost !px-1.5 !py-1"
                onClick={() => void selectAdjacent(-1)}
                disabled={navIndex <= 0}
                title="上一篇 (k)"
              >
                <ArrowUp size={13} />
              </button>
              <span className="whitespace-nowrap tabular-nums">
                第 {navIndex + 1} / {totalInList} 篇
              </span>
              <button
                className="ff-btn ff-btn-ghost !px-1.5 !py-1"
                onClick={() => void selectAdjacent(1)}
                // 已加载的最后一篇后面还有页时，store 会顺手 loadMore，别在这里提前禁掉。
                disabled={navIndex >= totalInList - 1 && !nextCursor}
                title="下一篇 (j)"
              >
                <ArrowDown size={13} />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onScroll={handleScroll}
      >
        {article.isFiltered ? (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[11.5px] leading-relaxed"
            style={WARNING_TONE}
          >
            <Filter size={13} className="mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">这篇文章被过滤规则挡下了：</span>
              {filterReasonText(article.filterReason)}
              <span className="ml-1 opacity-75">
                （默认不在列表里显示，可在侧栏单源视图打开「显示已过滤文章」查看）
              </span>
            </div>
          </div>
        ) : null}

        {showSummary ? (
          <section
            className="mb-4 rounded-lg border p-3"
            style={{ background: 'var(--ff-surface-2)', borderColor: 'var(--ff-border)' }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Sparkles size={13} style={{ color: 'var(--ff-accent)' }} />
              <span className="text-[12px] font-medium">AI 摘要</span>
              {generating ? (
                <span className="text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                  生成中…
                </span>
              ) : null}
              {queued ? (
                <span className="text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                  排队中
                </span>
              ) : null}
              {stalled ? (
                <span className="text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                  上次中断
                </span>
              ) : null}
              <span className="flex-1" />
              <button
                className="ff-btn ff-btn-ghost !p-1"
                onClick={() => setSummaryOpen((value) => !value)}
                title={summaryOpen ? '收起' : '展开'}
              >
                <ChevronUp
                  size={13}
                  style={{ transform: summaryOpen ? undefined : 'rotate(180deg)' }}
                />
              </button>
            </div>

            {summaryOpen ? (
              <div className="space-y-1.5">
                {summaryText ? (
                  <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">
                    {summaryText}
                    {generating ? (
                      <span
                        className="ml-0.5 inline-block h-3 w-1 animate-pulse align-middle"
                        style={{ background: 'var(--ff-accent)' }}
                      />
                    ) : null}
                  </div>
                ) : null}

                {failed ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[12px]" style={{ color: 'var(--ff-danger)' }}>
                      {summaryError}
                    </span>
                    <button
                      className="ff-btn !px-2 !py-1 text-[11px]"
                      onClick={() => void startSummary(article.id)}
                      disabled={generating}
                    >
                      <Sparkles size={12} /> 重试
                    </button>
                  </div>
                ) : null}

                {queued || stalled ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[11.5px]" style={{ color: 'var(--ff-muted)' }}>
                      {queued ? '摘要任务还在排队，上次生成未完成。' : '上次生成未完成，可重新生成。'}
                    </span>
                    <button
                      className="ff-btn !px-2 !py-1 text-[11px]"
                      onClick={() => void startSummary(article.id)}
                      disabled={generating}
                    >
                      <Sparkles size={12} /> 重新生成
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {translation.status === 'running' ? (
          <div
            className="mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-[11px]"
            style={{ background: 'var(--ff-surface-2)', color: 'var(--ff-muted)' }}
          >
            <Loader2 size={12} className="animate-spin" /> 正在逐段翻译，已完成 {translation.progress} 段
          </div>
        ) : null}

        {hasBody ? (
          <div
            ref={bodyRef}
            className="ff-article prose max-w-none"
            style={{ ...fontStyle, fontFamily: settings?.general.fontFamily === 'serif' ? 'Georgia, "Songti SC", serif' : undefined }}
            onClick={handleBodyClick}
            onPointerUp={learning.onPointerUp}
            onDoubleClick={learning.onDoubleClick}
            onKeyDown={(event) => {
              // 标记出来的词带 role=button/tabindex，键盘回车也要能打开。
              if (event.key !== 'Enter' && event.key !== ' ') return;
              const word = (event.target as HTMLElement | null)?.closest('[data-vocabulary-word]');
              if (!(word instanceof HTMLElement)) return;
              event.preventDefault();
              openWordPopover(word);
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          // 只有标题的条目在 RSS 里很常见（尤其是聚合站），给个明确的下一步而不是一句「没有正文」。
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Newspaper size={26} style={{ color: 'var(--ff-faint)' }} />
            <div className="text-sm font-medium">这篇文章没有正文</div>
            <p className="max-w-sm text-xs leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
              订阅源只提供了标题或摘要，可以尝试从原文抓取全文。
            </p>
            <button
              className="ff-btn ff-btn-primary !text-[12px]"
              onClick={() => void fetchFulltext(article.id)}
              disabled={fetchingFulltext}
            >
              {fetchingFulltext ? <Spinner /> : <Newspaper size={12} />} 抓取全文
            </button>
          </div>
        )}

        <footer className="mt-8 border-t pt-3 text-[11px]" style={{ color: 'var(--ff-faint)' }}>
          来源：{hostOf(article.link)} {article.sourceLanguage ? `· 语言 ${article.sourceLanguage}` : ''}
        </footer>
      </div>

      {learning.cards.length ? (
        <LearningCardStack
          cards={learning.cards}
          onClose={learning.close}
          onCloseCard={learning.closeCard}
          onRetry={learning.retry}
          onSave={(id) => { void learning.saveWord(id); }}
          onExplainDetail={(id) => { void learning.explainDetail(id); }}
          onRetryDetail={learning.retryDetail}
          onOpenSettings={() => setUi({ settingsOpen: true })}
        />
      ) : null}

      {wordPopover && popoverEntry ? (
        <VocabularyWordPopover
          entry={popoverEntry}
          anchor={wordPopover.rect}
          sentence={popoverSentence.current}
          adding={addingSentence}
          onClose={() => setWordPopover(null)}
          onAddSentence={() => { void handleAddSentence(); }}
          onDelete={() => { void handleDeleteWord(); }}
          onOpenVocabulary={() => {
            setWordPopover(null);
            setUi({ vocabularyOpen: true });
          }}
        />
      ) : null}
    </article>
  );
}

function pickHtml(article: ArticleDetail, mode: 'off' | 'zh' | 'bilingual'): string {
  if (mode === 'bilingual' && article.aiTranslationBilingualHtml) return article.aiTranslationBilingualHtml;
  if (mode === 'zh' && article.aiTranslationZhHtml) return article.aiTranslationZhHtml;
  return article.contentFullHtml || article.contentHtml || '<p>这篇文章没有正文内容。</p>';
}
