import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { CheckCheck, Inbox, RefreshCw, Search, SlidersHorizontal, Star } from 'lucide-react';
import { useAppStore } from '../store/app';
import { EmptyState, Spinner } from './ui';
import { formatRelative, hostOf, viewLabel } from '../lib/format';
import type { ArticleListItem } from '../api/types';
// 过滤文案与配色都从阅读器取，避免同一状态在两处长得不一样。
import { filterReasonText, WARNING_TONE } from './ArticleReader';

export function ArticleList() {
  const articles = useAppStore((state) => state.articles);
  const feeds = useAppStore((state) => state.feeds);
  const categories = useAppStore((state) => state.categories);
  const view = useAppStore((state) => state.view);
  const selectedId = useAppStore((state) => state.selectedId);
  const totalCount = useAppStore((state) => state.totalCount);
  const loadError = useAppStore((state) => state.loadError);
  const retrySnapshot = useAppStore((state) => state.retrySnapshot);
  const loadingSnapshot = useAppStore((state) => state.loadingSnapshot);
  const loadingMore = useAppStore((state) => state.loadingMore);
  const nextCursor = useAppStore((state) => state.nextCursor);
  const unreadOnly = useAppStore((state) => state.unreadOnly);
  const setUnreadOnly = useAppStore((state) => state.setUnreadOnly);
  const selectArticle = useAppStore((state) => state.selectArticle);
  const loadMore = useAppStore((state) => state.loadMore);
  const markAllRead = useAppStore((state) => state.markAllRead);
  const askConfirm = useAppStore((state) => state.askConfirm);
  const setUi = useAppStore((state) => state.setUi);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /**
   * 本地的翻页失败标记。store 的 loadMore 会自己弹 toast 但不会 reject，
   * 而失败后 nextCursor 不变，观察器再触发也是同样的请求——不记下来就只能无限重试。
   */
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);

  /**
   * 列表样式（卡片 / 紧凑）只配在单个订阅上，没有全局默认项。
   *
   * 分类视图选择「跟随该分类下第一个订阅」而不是新造一个全局默认：
   *  - 造全局默认要动 settings/types 与设置界面，且和「按源配置」的既有语义冲突；
   *  - 跟随第一个源时，用户在分类里看到的样式和他刚设过的源一致，结果可预期。
   * 分类下没有订阅时退回卡片，和旧行为一致。
   */
  const displayMode = useMemo(() => {
    if (view.startsWith('feed:')) {
      const id = view.slice('feed:'.length);
      return feeds.find((feed) => feed.id === id)?.articleListDisplayMode ?? 'card';
    }
    if (view.startsWith('category:')) {
      const id = view.slice('category:'.length);
      const first = feeds.find((feed) => feed.categoryId === id);
      return first?.articleListDisplayMode ?? 'card';
    }
    return 'card';
  }, [view, feeds]);

  /**
   * 取下一页，并判断这一页到底有没有进来。
   * loadMore 内部吞掉了异常，只能看「游标没变、条数没涨」；据此把重试入口摆到哨兵上，
   * 否则无限滚动会在失败后彻底停住，且没有任何反馈。
   */
  const attemptLoadMore = useCallback(async () => {
    const before = useAppStore.getState();
    // 已经在翻页或根本没有下一页时，loadMore 会直接返回；此时「没变化」是正常的，
    // 不能算成失败，否则会误报重试按钮。
    if (before.loadingMore || !before.nextCursor) return;
    const cursorBefore = before.nextCursor;
    const countBefore = before.articles.length;
    setLoadMoreFailed(false);
    try {
      await loadMore();
    } finally {
      const after = useAppStore.getState();
      if (after.nextCursor && after.nextCursor === cursorBefore && after.articles.length === countBefore) {
        setLoadMoreFailed(true);
      }
    }
  }, [loadMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && nextCursor && !loadMoreFailed) {
          void attemptLoadMore();
        }
      },
      { root: scrollRef.current, rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, loadMoreFailed, attemptLoadMore]);

  useEffect(() => {
    // 切换视图后回到顶部，避免停留在上一个视图的滚动位置。
    scrollRef.current?.scrollTo({ top: 0 });
    // 上一个视图的翻页失败不该跟到新视图里。
    setLoadMoreFailed(false);
  }, [view, unreadOnly]);

  const title = viewLabel(view, feeds, categories);

  const handleMarkAllRead = async () => {
    // 全部已读不可撤销，先确认；文案里写清范围，免得用户以为清的是整个书库。
    const confirmed = await askConfirm({
      title: '全部标为已读',
      message: `把「${title}」里的全部文章标为已读？只影响当前视图，无法撤销。`,
      confirmLabel: '标为已读',
    });
    if (!confirmed) return;
    // 范围已经在确认框里说清楚了，store 执行完会报数量，这里不再叠第二条 toast。
    await markAllRead();
  };

  return (
    <section className="flex h-full w-full flex-col" style={{ background: 'var(--ff-surface)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{title}</div>
          <div className="text-[10px]" style={{ color: 'var(--ff-faint)' }}>
            {/* 用 totalCount 而不是 articles.length：滚动加载会让后者一直变大，看起来像文章在增加 */}
            {totalCount > 0 ? `${totalCount} 篇` : '暂无文章'}
          </div>
        </div>

        <button
          className="ff-btn ff-btn-ghost !p-1.5"
          onClick={() => setUi({ searchOpen: true })}
          title="搜索 (/)"
        >
          <Search size={14} />
        </button>
        <button
          className="ff-btn ff-btn-ghost !p-1.5"
          onClick={() => void setUnreadOnly(!unreadOnly)}
          title={unreadOnly ? '显示全部' : '只看未读'}
          style={unreadOnly ? { color: 'var(--ff-accent-text)', background: 'var(--ff-accent-soft)' } : undefined}
        >
          <SlidersHorizontal size={14} />
        </button>
        <button
          className="ff-btn ff-btn-ghost !p-1.5"
          onClick={() => void handleMarkAllRead()}
          title="全部标为已读"
        >
          <CheckCheck size={14} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {loadingSnapshot && articles.length === 0 ? (
          <div className="space-y-3 p-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="space-y-2">
                <div className="ff-skeleton h-3 w-2/3" />
                <div className="ff-skeleton h-3 w-full" />
                <div className="ff-skeleton h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : articles.length === 0 ? (
          // 拉列表失败和「确实没有文章」是两件事：前者必须给重试入口，
          // 否则用户只会看到一句「这里还没有文章」，以为订阅被清空了。
          loadError ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <Inbox size={26} style={{ color: 'var(--ff-faint)' }} />
              <div className="text-sm font-medium">列表加载失败</div>
              <p className="max-w-xs text-xs leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
                {loadError}
              </p>
              <button className="ff-btn ff-btn-primary !text-[12px]" onClick={() => void retrySnapshot()}>
                <RefreshCw size={12} /> 重试
              </button>
            </div>
          ) : (
            <EmptyState
              icon={<Inbox size={28} />}
              title={unreadOnly ? '没有未读文章' : '这里还没有文章'}
              description={
                unreadOnly
                  ? '试试关闭「只看未读」，或刷新订阅获取新内容。'
                  : '添加一个 RSS 订阅后，文章会自动出现在这里。'
              }
            />
          )
        ) : (
          <ul>
            {articles.map((article) => {
              const active = article.id === selectedId;
              return (
                <li key={article.id}>
                  <button
                    className={clsx('w-full border-b px-3 py-2.5 text-left transition-colors')}
                    style={{
                      background: active ? 'var(--ff-accent-soft)' : undefined,
                      borderLeft: active ? '2px solid var(--ff-accent)' : '2px solid transparent',
                    }}
                    onClick={() => void selectArticle(article.id)}
                    onMouseEnter={(event) => {
                      if (!active) event.currentTarget.style.background = 'var(--ff-surface-2)';
                    }}
                    onMouseLeave={(event) => {
                      if (!active) event.currentTarget.style.background = '';
                    }}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                      <span className="truncate">{article.feedTitle}</span>
                      <span>·</span>
                      <span className="shrink-0">{formatRelative(article.publishedAt)}</span>
                      {article.isStarred ? <Star size={10} style={{ color: 'var(--ff-accent)' }} /> : null}
                      {article.hasTranslation ? <span className="ff-chip !px-1 !py-0">译</span> : null}
                    </div>

                    <div className="flex gap-2">
                      <div className="min-w-0 flex-1">
                        <div
                          className={clsx('text-[13px] leading-snug', article.isRead ? '' : 'font-semibold')}
                          style={{ color: article.isRead ? 'var(--ff-muted)' : 'var(--ff-text)' }}
                        >
                          {article.titleZh || article.title}
                        </div>

                        {displayMode === 'card' && article.summary ? (
                          <p
                            className="mt-1 line-clamp-2 text-[11px] leading-relaxed"
                            style={{ color: 'var(--ff-faint)' }}
                          >
                            {article.summary}
                          </p>
                        ) : null}

                        {displayMode === 'card' && article.titleZh ? (
                          <p className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                            {article.title}
                          </p>
                        ) : null}

                        <div className="mt-1 flex items-center gap-1.5">
                          {!article.isRead ? (
                            <span className="size-1.5 rounded-full" style={{ background: 'var(--ff-accent)' }} />
                          ) : null}
                          <FilterBadge article={article} />
                          {article.hasFulltext ? <span className="ff-chip !px-1 !py-0">全文</span> : null}
                          {article.hasAiSummary ? <span className="ff-chip !px-1 !py-0">摘要</span> : null}
                          <span className="truncate text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                            {hostOf(article.link)}
                          </span>
                        </div>
                      </div>

                      {displayMode === 'card' && article.previewImage ? (
                        <img
                          src={article.previewImage}
                          alt=""
                          className="mt-0.5 h-14 w-20 shrink-0 rounded-md object-cover"
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div ref={sentinelRef} className="flex flex-col items-center justify-center gap-1 py-4">
          {loadingMore ? <Spinner /> : null}
          {loadMoreFailed ? (
            <button
              className="ff-btn ff-btn-ghost !text-[11px]"
              onClick={() => void attemptLoadMore()}
            >
              <RefreshCw size={11} /> 加载失败，点击重试
            </button>
          ) : null}
          {!nextCursor && !loadingMore && articles.length > 0 ? (
            <span className="text-[10px]" style={{ color: 'var(--ff-faint)' }}>
              已经到底了
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * 过滤状态小标签。默认视图里已过滤文章是隐藏的，所以这里主要出现在
 * 单源视图打开「显示已过滤文章」之后——那时用户最想知道的就是「为什么它在这」。
 */
function FilterBadge({ article }: { article: ArticleListItem }) {
  if (article.isFiltered) {
    return (
      <span
        className="ff-chip max-w-full !px-1 !py-0"
        style={{ color: WARNING_TONE.color, borderColor: WARNING_TONE.borderColor }}
      >
        <span className="truncate">{filterReasonText(article.filterReason)}</span>
      </span>
    );
  }
  if (article.filterStatus === 'pending') {
    return <span className="ff-chip !px-1 !py-0">AI 判定中</span>;
  }
  if (article.filterStatus === 'error') {
    return (
      <span className="ff-chip !px-1 !py-0" style={{ color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }}>
        判定失败
      </span>
    );
  }
  return null;
}
