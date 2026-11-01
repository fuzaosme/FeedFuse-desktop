import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  BookMarked,
  ChevronDown,
  ChevronRight,
  Filter,
  FolderPlus,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Settings,
  Star,
  Trash2,
} from 'lucide-react';
import { useAppStore } from '../store/app';
import { Spinner } from './ui';
import { FeedMenu } from './FeedMenu';

/** 「未分类」是前端拼出来的伪分类，后端没有这条记录，所以用固定 key 区分。 */
const UNCATEGORIZED = 'none';

export function Sidebar() {
  const categories = useAppStore((state) => state.categories);
  const feeds = useAppStore((state) => state.feeds);
  const counts = useAppStore((state) => state.counts);
  const view = useAppStore((state) => state.view);
  const selectView = useAppStore((state) => state.selectView);
  const refresh = useAppStore((state) => state.refresh);
  const refreshAll = useAppStore((state) => state.refreshAll);
  const setUi = useAppStore((state) => state.setUi);
  const toast = useAppStore((state) => state.toast);
  const includeFiltered = useAppStore((state) => state.includeFiltered);
  const setIncludeFiltered = useAppStore((state) => state.setIncludeFiltered);
  const createCategory = useAppStore((state) => state.createCategory);
  const renameCategory = useAppStore((state) => state.renameCategory);
  const deleteCategory = useAppStore((state) => state.deleteCategory);
  const reorderCategories = useAppStore((state) => state.reorderCategories);

  // 折叠状态只影响这一屏的显示，不进 store：它不参与请求，也不需要跨重启记忆。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  // 拖拽结束后浏览器偶尔还会补发一次 click，用一个小时间窗把它吃掉，
  // 否则「拖完就跳视图」和之前的「折叠顺带切视图」是同一类手感事故。
  const suppressClickUntil = useRef(0);

  const unreadByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const feed of feeds) {
      const key = feed.categoryId ?? UNCATEGORIZED;
      map.set(key, (map.get(key) ?? 0) + feed.unreadCount);
    }
    return map;
  }, [feeds]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, typeof feeds>();
    for (const feed of feeds) {
      const key = feed.categoryId ?? UNCATEGORIZED;
      const list = buckets.get(key) ?? [];
      list.push(feed);
      buckets.set(key, list);
    }
    return buckets;
  }, [feeds]);

  const activeFeed = useMemo(
    () => (view.startsWith('feed:') ? feeds.find((feed) => `feed:${feed.id}` === view) ?? null : null),
    [feeds, view],
  );

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitNewCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    const created = await createCategory(name);
    // 失败（重名、空名）时保留输入框，用户可以就地改字重试。
    if (!created) return;
    setNewCategoryName('');
    setCreating(false);
    toast(`已创建分类「${created.name}」`, 'success');
  };

  const handleRenameCategory = async (id: string, current: string) => {
    // 分类不常用，为一次改名引入通用输入弹窗不值得；prompt 在桌面端够用。
    const input = window.prompt('分类名称', current);
    if (input === null) return;
    const name = input.trim();
    if (!name || name === current) return;
    await renameCategory(id, name);
  };

  const handleDeleteCategory = async (id: string, name: string, feedCount: number) => {
    const moved = feedCount > 0 ? `分类下的 ${feedCount} 个订阅会归入「未分类」，` : '分类下的订阅会归入「未分类」，';
    if (!window.confirm(`删除分类「${name}」？${moved}订阅与已抓取的文章都会保留。`)) return;
    await deleteCategory(id);
  };

  /** 返回拖拽结束后应写入的 id 顺序；顺序没变就返回 null，避免无意义的请求。 */
  const computeDropOrder = (source: string, target: string, after: boolean): string[] | null => {
    const current = categories.map((category) => category.id);
    if (!current.includes(source) || !current.includes(target) || source === target) return null;
    const next = current.filter((id) => id !== source);
    const index = next.indexOf(target);
    if (index === -1) return null;
    next.splice(after ? index + 1 : index, 0, source);
    const changed = next.some((id, i) => id !== current[i]);
    return changed ? next : null;
  };

  const endDrag = () => {
    setDragId(null);
    setDropTarget(null);
    suppressClickUntil.current = Date.now() + 200;
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragId;
    // 落点上下半区的判断在这里重算一次：拖拽途中的最后一次 dragover 可能没赶上渲染。
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    endDrag();
    if (!source) return;
    const order = computeDropOrder(source, targetId, after);
    if (order) void reorderCategories(order);
  };

  const renderFeed = (feed: (typeof feeds)[number]) => {
    const active = view === `feed:${feed.id}`;
    return (
      <div
        key={feed.id}
        className={clsx(
          'group flex items-center gap-2 rounded-md py-1 pl-6 pr-1 text-[13px] transition-colors',
          active ? 'font-medium' : '',
        )}
        style={active ? { background: 'var(--ff-accent-soft)', color: 'var(--ff-accent-text)' } : undefined}
        // 订阅行本身不参与分类拖拽：拖它应该是「拖了一条订阅」，不是「拖了整个分类」。
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {/*
          主体用真正的 button：侧栏此前是 div + onClick，键盘完全到不了。
          菜单留在 button 外面，避免按钮套按钮。
        */}
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left"
          style={{ color: 'inherit' }}
          onClick={() => {
            if (Date.now() < suppressClickUntil.current) return;
            void selectView(`feed:${feed.id}`);
          }}
          aria-current={active ? 'page' : undefined}
        >
          <FeedIcon feed={feed} />
          <span className="min-w-0 flex-1 truncate" title={feed.lastFetchError ?? feed.title}>
            {feed.title}
          </span>
          {feed.lastFetchError ? (
            <AlertTriangle size={12} style={{ color: 'var(--ff-danger)' }} aria-label="抓取异常" />
          ) : null}
          {feed.unreadCount > 0 ? (
            <span
              className="shrink-0 rounded-full px-1.5 text-[10px] tabular-nums"
              style={{ background: 'var(--ff-surface-2)', color: 'var(--ff-muted)' }}
            >
              {feed.unreadCount}
            </span>
          ) : null}
        </button>
        {/* 键盘聚焦到这一行时也要露出菜单入口，否则它只对鼠标可用。 */}
        <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <FeedMenu feed={feed} />
        </span>
      </div>
    );
  };

  const renderCategory = (id: string, name: string, items: typeof feeds) => {
    const isCollapsed = collapsed.has(id);
    const unread = unreadByCategory.get(id) ?? 0;
    const active = view === `category:${id}`;
    // 伪分类「未分类」不在后端表里，既不能改名/删除，也不能参与排序。
    const real = id !== UNCATEGORIZED;
    const indicator = dropTarget?.id === id ? (dropTarget.after ? 'after' : 'before') : null;
    const dragging = dragId === id;

    return (
      <div key={id} className="relative mb-0.5">
        {indicator === 'before' ? (
          <span
            className="pointer-events-none absolute inset-x-1 -top-px z-10 h-0.5 rounded-full"
            style={{ background: 'var(--ff-accent)' }}
          />
        ) : null}

        <div
          className={clsx('group flex items-center gap-1 rounded-md py-1 pl-1.5 pr-1 text-[12px]', dragging && 'opacity-40')}
          style={{ color: active ? 'var(--ff-accent-text)' : 'var(--ff-muted)' }}
        >
          {/*
            draggable 只挂在这个头部包裹层上（分类名 + 折叠箭头），不要挂到整行：
            否则从行内任意位置起拖都会被当成「给分类排序」。
          */}
          <div
            className="flex min-w-0 flex-1 items-center gap-1"
            draggable={real}
            onDragStart={
              real
                ? (event) => {
                    setDragId(id);
                    setDropTarget(null);
                    event.dataTransfer.effectAllowed = 'move';
                    // Firefox 不写入数据就不会真正开始拖拽。
                    event.dataTransfer.setData('text/plain', id);
                  }
                : undefined
            }
            onDragOver={
              real
                ? (event) => {
                    if (!dragId) return;
                    // 拖回自己身上时清掉提示线，否则会停在上一处落点上误导用户。
                    if (dragId === id) {
                      setDropTarget(null);
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const rect = event.currentTarget.getBoundingClientRect();
                    const after = event.clientY > rect.top + rect.height / 2;
                    setDropTarget((prev) =>
                      prev && prev.id === id && prev.after === after ? prev : { id, after },
                    );
                  }
                : undefined
            }
            onDrop={real ? (event) => handleDrop(event, id) : undefined}
            onDragEnd={real ? endDrag : undefined}
          >
            <button
              className="ff-btn ff-btn-ghost !border-transparent !p-0.5"
              style={{ color: 'inherit' }}
              onClick={() => toggleCollapsed(id)}
              title={isCollapsed ? '展开分类' : '收起分类'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
            <button
              className="min-w-0 flex-1 truncate text-left font-medium"
              title={real ? `${name}（拖动可排序）` : name}
              onClick={() => {
                if (Date.now() < suppressClickUntil.current) return;
                if (real) void selectView(`category:${id}`);
                // 未分类没有对应视图，点名字就当折叠开关用，行为上不落空。
                else toggleCollapsed(id);
              }}
            >
              {name}
            </button>
            {unread > 0 ? <span className="text-[10px] tabular-nums">{unread}</span> : null}
          </div>
          {real ? (
            // 菜单自带「悬浮显示 / 展开时常亮」，外层不再套透明包裹，
            // 否则菜单打开后鼠标一离开分类行，弹层会变成看不见但仍挡住点击的透明方块。
            <CategoryMenu
              onRename={() => void handleRenameCategory(id, name)}
              onDelete={() => void handleDeleteCategory(id, name, items.length)}
            />
          ) : null}
        </div>

        {indicator === 'after' ? (
          <span
            className="pointer-events-none absolute inset-x-1 -bottom-px z-10 h-0.5 rounded-full"
            style={{ background: 'var(--ff-accent)' }}
          />
        ) : null}

        {isCollapsed ? null : <div className="space-y-0.5">{items.map(renderFeed)}</div>}
      </div>
    );
  };

  const uncategorized = grouped.get(UNCATEGORIZED) ?? [];

  return (
    <aside className="flex h-full w-full flex-col" style={{ background: 'var(--ff-surface-2)' }}>
      <header className="flex items-center gap-2 px-3 pb-2 pt-3">
        {/* 图标底色用实心强调色、图标用对比色：深色模式下强调色会提亮，白字会糊成一片。 */}
        <div
          className="flex size-7 items-center justify-center rounded-lg"
          style={{ background: 'var(--ff-accent-fill)', color: 'var(--ff-accent-contrast)' }}
        >
          <Rss size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight">FeedFuse</div>
          <div className="text-[10px] leading-tight" style={{ color: 'var(--ff-faint)' }}>
            本地阅读工作台
          </div>
        </div>
        <button
          className="ff-btn ff-btn-ghost !p-1.5"
          onClick={() => void refreshAll()}
          disabled={refresh?.running}
          title="刷新全部订阅 (r)"
        >
          {refresh?.running ? <Spinner /> : <RefreshCw size={14} />}
        </button>
      </header>

      {refresh?.running ? (
        <div className="px-3 pb-2">
          <div className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--ff-muted)' }}>
            <span className="truncate">{refresh.current ?? '准备中'}</span>
            <span className="tabular-nums">
              {refresh.done}/{refresh.total}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--ff-border)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${refresh.total === 0 ? 0 : Math.round((refresh.done / refresh.total) * 100)}%`,
                background: 'var(--ff-accent)',
              }}
            />
          </div>
        </div>
      ) : null}

      <nav className="px-2 pb-1">
        <SmartItem
          icon={<Layers size={14} />}
          label="全部文章"
          count={counts.all}
          active={view === 'all'}
          onClick={() => void selectView('all')}
        />
        <SmartItem
          icon={<Rss size={14} />}
          label="未读"
          count={counts.unread}
          active={view === 'unread'}
          onClick={() => void selectView('unread')}
        />
        <SmartItem
          icon={<Star size={14} />}
          label="星标"
          count={counts.starred}
          active={view === 'starred'}
          onClick={() => void selectView('starred')}
        />
        <SmartItem
          icon={<BookMarked size={14} />}
          label="生词本"
          active={false}
          onClick={() => {
            void useAppStore.getState().loadVocabulary();
            setUi({ vocabularyOpen: true });
          }}
        />
      </nav>

      {/*
        只在单源视图放出这个开关：聚合视图里混进已过滤文章会把「未读」的语义搞乱，
        而单源视图恰恰是用户排查「我的文章怎么不见了」的地方。
      */}
      {activeFeed ? (
        <div
          className="mx-3 mb-2 rounded-md border px-2 py-1.5"
          style={{ background: 'var(--ff-surface)', borderColor: 'var(--ff-border)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium" title={activeFeed.title}>
                {activeFeed.title}
              </div>
              <div className="text-[10px] leading-tight" style={{ color: 'var(--ff-faint)' }}>
                显示已过滤文章
              </div>
            </div>
            <MiniSwitch
              checked={includeFiltered}
              onChange={(value) => void setIncludeFiltered(value)}
              label="显示已过滤文章"
            />
          </div>
          {counts.filtered > 0 ? (
            <div className="mt-1 text-[10px] leading-tight" style={{ color: 'var(--ff-faint)' }}>
              {/* 计数是全库口径，这里必须写明，否则用户会以为当前源就有这么多被挡 */}
              全库 {counts.filtered} 篇被过滤规则隐藏
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mx-3 my-2 border-t" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[10px] font-medium tracking-wide" style={{ color: 'var(--ff-faint)' }}>
            分类
          </span>
          <button
            className="ff-btn ff-btn-ghost !border-transparent !p-1"
            style={{ color: 'var(--ff-muted)' }}
            onClick={() => setCreating(true)}
            title="新建分类"
          >
            <FolderPlus size={12} />
          </button>
        </div>

        {creating ? (
          <div className="mb-1 px-1">
            <input
              className="ff-input !py-1 text-[12px]"
              autoFocus
              value={newCategoryName}
              placeholder="分类名称，回车创建"
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitNewCategory();
                if (event.key === 'Escape') {
                  setNewCategoryName('');
                  setCreating(false);
                }
              }}
              onBlur={() => {
                // 失焦时只在输入为空的情况下收起，避免误点别处丢掉已输入的名字。
                if (!newCategoryName.trim()) setCreating(false);
              }}
            />
          </div>
        ) : null}

        {categories.length === 0 && feeds.length === 0 ? (
          <div className="px-3 py-6 text-[12px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
            还没有订阅。点击下方「添加订阅」选择来源，或到设置里导入 OPML 文件。
          </div>
        ) : null}

        {categories.map((category) =>
          renderCategory(category.id, category.name, grouped.get(category.id) ?? []),
        )}
        {uncategorized.length > 0 ? renderCategory(UNCATEGORIZED, '未分类', uncategorized) : null}
      </div>

      <footer className="flex flex-col gap-1 border-t px-2 py-2">
        {counts.filtered > 0 ? (
          <button
            className="ff-btn !justify-start !border-transparent !py-1 !text-[11px]"
            style={{ color: 'var(--ff-muted)' }}
            onClick={() => setUi({ settingsOpen: true })}
            title="过滤规则在设置里调整"
          >
            <Filter size={11} /> {counts.filtered} 篇被过滤规则隐藏
          </button>
        ) : null}
        <div className="flex gap-1">
          <AddSubscriptionMenu />
          <button className="ff-btn" onClick={() => setUi({ settingsOpen: true })} title="设置 (⌘,)">
            <Settings size={14} />
          </button>
        </div>
      </footer>
    </aside>
  );
}

function SmartItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors')}
      style={
        active
          ? { background: 'var(--ff-accent-soft)', color: 'var(--ff-accent-text)', fontWeight: 500 }
          : { color: 'var(--ff-text)' }
      }
      onClick={onClick}
    >
      <span style={{ color: active ? 'var(--ff-accent-text)' : 'var(--ff-muted)' }}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className="text-[10px] tabular-nums" style={{ color: 'var(--ff-faint)' }}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * 「添加订阅」把两种入口收进一个二级菜单：
 * 手动粘贴地址是主路径，从 RSS 目录挑选是辅助路径。
 * 以前目录单占一个一级按钮，侧栏底部挤了四个平级入口，主次不分。
 */
function AddSubscriptionMenu() {
  const setUi = useAppStore((state) => state.setUi);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={container} className="relative flex-1">
      <button
        className="ff-btn w-full"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={14} /> 添加订阅
        <ChevronDown size={12} style={{ color: 'var(--ff-faint)' }} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-40 mb-1 w-full min-w-[11rem] rounded-lg border p-1 text-[12px] shadow-xl"
          style={{ background: 'var(--ff-surface)', boxShadow: 'var(--ff-shadow)', color: 'var(--ff-text)' }}
        >
          <button
            role="menuitem"
            className="ff-btn w-full justify-start !border-transparent"
            onClick={() => {
              setOpen(false);
              setUi({ addFeedOpen: true });
            }}
          >
            <Plus size={12} /> 手动输入订阅地址
          </button>
          <button
            role="menuitem"
            className="ff-btn w-full justify-start !border-transparent"
            onClick={() => {
              setOpen(false);
              setUi({ rssCatalogOpen: true });
            }}
          >
            <Rss size={12} /> 从 RSS 目录挑选
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 分类行的「⋯」菜单：重命名 / 删除，点击外部关闭。 */
function CategoryMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div
      ref={container}
      className={clsx('relative', open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="ff-btn ff-btn-ghost !border-transparent !p-0.5"
        style={{ color: 'inherit' }}
        onClick={() => setOpen((value) => !value)}
        title="分类设置"
      >
        <MoreHorizontal size={12} />
      </button>
      {open ? (
        <div
          className="absolute right-0 z-40 mt-1 w-32 rounded-lg border p-1 text-[12px] shadow-xl"
          style={{ background: 'var(--ff-surface)', boxShadow: 'var(--ff-shadow)', color: 'var(--ff-text)' }}
        >
          <button
            className="ff-btn w-full justify-start !border-transparent"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            <Pencil size={12} /> 重命名
          </button>
          <button
            className="ff-btn w-full justify-start !border-transparent"
            style={{ color: 'var(--ff-danger)' }}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Trash2 size={12} /> 删除
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 侧栏专用的小号开关：ui.tsx 的 Toggle 是带两行文案的整行布局，塞进这里太占地方。 */
function MiniSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
      style={{ background: checked ? 'var(--ff-accent)' : 'var(--ff-border-strong)' }}
    >
      <span
        className="absolute top-0.5 size-3 rounded-full bg-white transition-all"
        style={{ left: checked ? '0.875rem' : '0.125rem' }}
      />
    </button>
  );
}

export function FeedIcon({ feed }: { feed: { title: string; iconUrl: string | null } }) {
  const [failed, setFailed] = useState(false);
  if (!feed.iconUrl || failed) {
    return (
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold"
        style={{ background: 'var(--ff-border)', color: 'var(--ff-muted)' }}
      >
        {feed.title.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={feed.iconUrl}
      alt=""
      className="size-4 shrink-0 rounded object-cover"
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}
