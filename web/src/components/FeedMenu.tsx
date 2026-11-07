import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderInput,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Timer,
  Trash2,
} from 'lucide-react';
import * as api from '../api/endpoints';
import { useAppStore } from '../store/app';
import type { Feed } from '../api/types';
import { Toggle } from './ui';

/** 与后端全局默认一起，覆盖「每小时、每几小时」的常见档位。 */
const FETCH_INTERVALS = [5, 15, 30, 60, 120];

export function FeedMenu({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 子菜单做成就地展开而不是 hover 弹出：侧栏是滚动容器，悬浮子菜单容易被裁掉。
  const [section, setSection] = useState<'interval' | 'category' | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const reloadSnapshot = useAppStore((state) => state.reloadSnapshot);
  const toast = useAppStore((state) => state.toast);
  const askConfirm = useAppStore((state) => state.askConfirm);
  const categories = useAppStore((state) => state.categories);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) setSection(null);
  }, [open]);

  const patch = async (input: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.updateFeed(feed.id, input);
      // 未读数、分类归属都写在快照里，改完必须重新拉一次，侧栏才不会停在旧状态。
      await reloadSnapshot({ keepArticles: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    try {
      const result = await api.refreshFeed(feed.id);
      toast(result.error ?? `刷新完成，新增 ${result.inserted} 篇`, result.error ? 'error' : 'success');
      await reloadSnapshot({ keepArticles: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : '刷新失败', 'error');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const handleRename = async () => {
    const input = window.prompt('订阅名称', feed.title);
    if (input === null) return;
    const title = input.trim();
    if (!title || title === feed.title) return;
    await patch({ title });
  };

  const handleDelete = async () => {
    const confirmed = await askConfirm({
      title: '删除订阅',
      message: `删除订阅「${feed.title}」及其所有文章？此操作不可撤销。`,
      confirmLabel: '删除',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.deleteFeed(feed.id);
      toast('订阅已删除', 'success');
      await reloadSnapshot({ keepArticles: true });
      const { view, selectView } = useAppStore.getState();
      // 当前正停在这个源上，删完就退到「全部」，否则列表会停在一个不存在的视图。
      if (view === `feed:${feed.id}`) await selectView('all');
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const moveToCategory = (categoryId: string | null) => {
    void patch({ categoryId });
    setSection(null);
  };

  return (
    <div ref={container} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        className="ff-btn ff-btn-ghost !border-transparent !p-0.5"
        onClick={() => setOpen((value) => !value)}
        title="订阅设置"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <MoreHorizontal size={13} />}
      </button>

      {open ? (
        <div
          className="absolute right-0 z-40 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded-lg border p-2 text-[12px] shadow-xl"
          style={{ background: 'var(--ff-surface)', boxShadow: 'var(--ff-shadow)', color: 'var(--ff-text)' }}
        >
          <button className="ff-btn w-full justify-start" onClick={() => void handleRefresh()}>
            <RefreshCw size={13} /> 立即刷新
          </button>
          <button className="ff-btn w-full justify-start" onClick={() => void handleRename()}>
            <Pencil size={13} /> 重命名订阅
          </button>

          <div className="mt-1 border-t pt-1">
            <div className="ff-label">入库与打开</div>
            <Toggle
              label="入库时抓取全文"
              description="抓到新文章就顺手抓正文，打开时不用再等。"
              checked={feed.fullTextOnFetchEnabled}
              onChange={(value) => void patch({ fullTextOnFetchEnabled: value })}
            />
            <Toggle
              label="打开时抓取全文"
              description="点开这篇文章时才抓正文，平时不占带宽。"
              checked={feed.fullTextOnOpenEnabled}
              onChange={(value) => void patch({ fullTextOnOpenEnabled: value })}
            />
            <Toggle
              label="打开时生成摘要"
              checked={feed.aiSummaryOnOpenEnabled}
              onChange={(value) => void patch({ aiSummaryOnOpenEnabled: value })}
            />
            <Toggle
              label="翻译标题"
              checked={feed.titleTranslateEnabled}
              onChange={(value) => void patch({ titleTranslateEnabled: value })}
            />
            <Toggle
              label="翻译正文"
              checked={feed.bodyTranslateEnabled}
              onChange={(value) => void patch({ bodyTranslateEnabled: value })}
            />
            <Toggle
              label="启用这个订阅"
              checked={feed.enabled}
              onChange={(value) => void patch({ enabled: value })}
            />
          </div>

          <div className="mt-1 border-t pt-1">
            <SectionRow
              icon={<Timer size={13} />}
              label="抓取间隔"
              value={`${feed.fetchIntervalMinutes} 分钟`}
              expanded={section === 'interval'}
              onClick={() => setSection((prev) => (prev === 'interval' ? null : 'interval'))}
            />
            {section === 'interval' ? (
              <div className="mb-1 ml-5 space-y-0.5">
                {FETCH_INTERVALS.map((minutes) => (
                  <button
                    key={minutes}
                    className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[12px]"
                    style={
                      feed.fetchIntervalMinutes === minutes
                        ? { color: 'var(--ff-accent-text)', background: 'var(--ff-accent-soft)' }
                        : undefined
                    }
                    onClick={() => void patch({ fetchIntervalMinutes: minutes })}
                  >
                    <span className="w-3 shrink-0">
                      {feed.fetchIntervalMinutes === minutes ? <Check size={11} /> : null}
                    </span>
                    {minutes} 分钟
                  </button>
                ))}
              </div>
            ) : null}

            <SectionRow
              icon={<FolderInput size={13} />}
              label="移动到分类"
              value={feed.categoryName ?? '未分类'}
              expanded={section === 'category'}
              onClick={() => setSection((prev) => (prev === 'category' ? null : 'category'))}
            />
            {section === 'category' ? (
              <div className="mb-1 ml-5 space-y-0.5">
                {[{ id: null as string | null, name: '未分类' }, ...categories].map((category) => {
                  const active = (feed.categoryId ?? null) === category.id;
                  return (
                    <button
                      key={category.id ?? 'none'}
                      className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[12px]"
                      style={
                        active ? { color: 'var(--ff-accent-text)', background: 'var(--ff-accent-soft)' } : undefined
                      }
                      onClick={() => moveToCategory(category.id)}
                    >
                      <span className="w-3 shrink-0">{active ? <Check size={11} /> : null}</span>
                      <span className="truncate">{category.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="mt-1 border-t pt-2">
            <div className="ff-label">列表样式</div>
            <div className="flex gap-1">
              {(['card', 'list'] as const).map((mode) => (
                <button
                  key={mode}
                  className="ff-btn flex-1"
                  style={
                    feed.articleListDisplayMode === mode
                      ? { borderColor: 'var(--ff-accent)', color: 'var(--ff-accent-text)' }
                      : undefined
                  }
                  onClick={() => void patch({ articleListDisplayMode: mode })}
                >
                  {mode === 'card' ? '卡片' : '紧凑'}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2 border-t pt-2">
            <button
              className="ff-btn w-full justify-start"
              style={{ color: 'var(--ff-danger)' }}
              onClick={() => void handleDelete()}
            >
              <Trash2 size={13} /> 删除订阅
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 可展开的设置行：左侧图标 + 名称，右侧显示当前值，点一下展开候选列表。 */
function SectionRow({
  icon,
  label,
  value,
  expanded,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[12px]"
      onClick={onClick}
      aria-expanded={expanded}
    >
      <span style={{ color: 'var(--ff-muted)' }}>{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="truncate text-[11px]" style={{ color: 'var(--ff-muted)' }}>
        {value}
      </span>
      <span style={{ color: 'var(--ff-faint)' }}>
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </span>
    </button>
  );
}
