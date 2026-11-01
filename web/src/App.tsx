import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ArticleList } from './components/ArticleList';
import { ArticleReader } from './components/ArticleReader';
import { SettingsModal } from './components/SettingsModal';
import { AddFeedDialog } from './components/AddFeedDialog';
import { SearchDialog } from './components/SearchDialog';
import { VocabularyView } from './components/VocabularyView';
import { Toasts } from './components/Toasts';
import { useAppStore, applyTheme } from './store/app';
import { Modal, Spinner } from './components/ui';
import type { RssCatalogEntry } from './data/rssCatalog';

/**
 * 目录数据有 3700+ 条（约 900KB），静态打进主包会让每次启动都白解析一遍。
 * 用 React.lazy 拆成独立 chunk：只有打开目录时才加载。
 */
const RssCatalogDialog = lazy(() => import('./components/RssCatalogDialog'));

/** 快捷键说明表：只放真正绑定过的，避免「帮助里写了但按不出来」。 */
const SHORTCUTS: Array<[string, string]> = [
  ['j / n / ↓', '下一篇'],
  ['k / p / ↑', '上一篇'],
  ['m', '标记已读 / 未读'],
  ['s', '加星标 / 取消星标'],
  ['r', '刷新全部订阅'],
  ['/', '搜索文章'],
  ['[', '收起 / 展开侧栏'],
  ['?', '打开这个面板'],
  ['⌘ , / Ctrl ,', '打开设置'],
  ['Esc', '关闭弹窗'],
];

export default function App() {
  const init = useAppStore((state) => state.init);
  const ready = useAppStore((state) => state.ready);
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const articles = useAppStore((state) => state.articles);
  const nextCursor = useAppStore((state) => state.nextCursor);
  const selectedId = useAppStore((state) => state.selectedId);
  const selectAdjacent = useAppStore((state) => state.selectAdjacent);
  const toggleRead = useAppStore((state) => state.toggleRead);
  const toggleStar = useAppStore((state) => state.toggleStar);
  const refreshAll = useAppStore((state) => state.refreshAll);
  const setUi = useAppStore((state) => state.setUi);
  const ui = useAppStore((state) => state.ui);
  const feeds = useAppStore((state) => state.feeds);
  const loadVocabulary = useAppStore((state) => state.loadVocabulary);
  /**
   * store 的启动失败态由另一处维护，字段名可能是 initError 或 loadError。
   * 这里按 unknown 读取两者，避免硬绑一个还没落地的名字与类型。
   */
  const storeInitError = useAppStore((state) => {
    const carrier = state as unknown as { initError?: unknown; loadError?: unknown };
    return errorText(carrier.initError) ?? errorText(carrier.loadError);
  });

  const [leftWidth, setLeftWidth] = useState(248);
  const [middleWidth, setMiddleWidth] = useState(380);
  const [helpOpen, setHelpOpen] = useState(false);
  /** init 自己会吞掉异常：只能用「跑完仍没就绪」判断失败，否则启动页永远转圈。 */
  const [initSettled, setInitSettled] = useState(false);
  const [retrying, setRetrying] = useState(false);

  /** 目录里选中来源后，关掉目录并把名称/地址作为初始值交给「添加订阅」。 */
  const handleCatalogSelect = useCallback(
    (entry: RssCatalogEntry) => {
      setUi({
        rssCatalogOpen: false,
        addFeedOpen: true,
        addFeedPrefill: { title: entry.title, url: entry.url, siteUrl: entry.siteUrl },
      });
    },
    [setUi],
  );

  const runInit = useCallback(async () => {
    setRetrying(true);
    setInitSettled(false);
    try {
      await init();
    } catch {
      // 失败原因由下面的 ready 判断统一兜住，这里不重复弹提示。
    } finally {
      setInitSettled(true);
      setRetrying(false);
    }
  }, [init]);

  useEffect(() => {
    void runInit();
  }, [runInit]);

  /**
   * 生词本要在启动时就拉一次：正文里的生词标记依赖它。
   * 等用户点开生词本才加载的话，第一篇文章里的生词永远是「没标出来」的状态。
   */
  useEffect(() => {
    if (!ready) return;
    void loadVocabulary();
  }, [ready, loadVocabulary]);

  useEffect(() => {
    if (!settings) return;
    setLeftWidth(settings.general.leftPaneWidth);
    setMiddleWidth(settings.general.middlePaneWidth);
  }, [settings?.general.leftPaneWidth, settings?.general.middlePaneWidth]);

  // 系统主题变化时，auto 模式需要跟着切换。
  useEffect(() => {
    if (!settings || settings.general.theme !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('auto', settings.general.themeColor);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [settings?.general.theme, settings?.general.themeColor]);

  const persistWidths = useCallback(
    async (nextLeft: number, nextMiddle: number) => {
      const current = useAppStore.getState().settings;
      if (!current) return;
      try {
        await saveSettings(
          {
            settings: {
              ...current,
              general: { ...current.general, leftPaneWidth: nextLeft, middlePaneWidth: nextMiddle },
            },
          },
          // 拖一次分隔条就弹一次「设置已保存」非常吵：这种隐式保存静默处理。
          { silent: true },
        );
      } catch (err) {
        // 拖分隔条失败不该静默：用户会以为宽度已经记住了。
        const message = err instanceof Error ? err.message : '未知错误';
        useAppStore.getState().toast(`面板宽度未能保存：${message}`, 'error');
      }
    },
    [saveSettings],
  );

  // 键盘快捷键：j/n 下一篇，k/p 上一篇，m 已读，s 星标，r 刷新，/ 搜索，[ 折叠侧栏，? 帮助
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 输入框、文本域、可编辑区域里所有单键快捷键都不触发，否则打字会顺带翻文章。
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
        return;
      }

      const anyModalOpen =
        ui.settingsOpen ||
        ui.addFeedOpen ||
        ui.rssCatalogOpen ||
        ui.searchOpen ||
        ui.vocabularyOpen ||
        helpOpen;

      if (event.key === 'Escape') {
        // 各个弹窗自己也监听 Esc；这里兜一层，保证「一次 Esc 全部收起」，
        // 尤其是快捷键帮助面板不是由 store 管理的。
        if (anyModalOpen) {
          event.preventDefault();
          setUi({
            settingsOpen: false,
            addFeedOpen: false,
            rssCatalogOpen: false,
            addFeedPrefill: null,
            searchOpen: false,
            vocabularyOpen: false,
          });
          setHelpOpen(false);
        }
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        if (event.key === ',') {
          event.preventDefault();
          setUi({ settingsOpen: true });
        }
        if (event.key.toLowerCase() === 'k') {
          event.preventDefault();
          setUi({ searchOpen: true });
        }
        return;
      }

      if (anyModalOpen) return;

      // 走到列表头尾时不拦截方向键：那时它应该继续滚动正文，而不是被快捷键吃掉。
      // 末尾还有 nextCursor 时不算到头——selectAdjacent 会顺手取下一页。
      const index = selectedId ? articles.findIndex((item) => item.id === selectedId) : -1;
      const canGoNext =
        index === -1 ? articles.length > 0 : index < articles.length - 1 || Boolean(nextCursor);
      const canGoPrev = index === -1 ? articles.length > 0 : index > 0;

      if (event.key === '[') {
        event.preventDefault();
        setUi({ sidebarCollapsed: !ui.sidebarCollapsed });
      } else if (event.key === 'j' || event.key === 'n' || event.key === 'ArrowDown') {
        if (canGoNext) {
          event.preventDefault();
          void selectAdjacent(1);
        }
      } else if (event.key === 'k' || event.key === 'p' || event.key === 'ArrowUp') {
        if (canGoPrev) {
          event.preventDefault();
          void selectAdjacent(-1);
        }
      } else if (event.key === 'm' && selectedId) {
        const current = articles.find((item) => item.id === selectedId);
        if (current) void toggleRead(selectedId, !current.isRead);
      } else if (event.key === 's' && selectedId) {
        const current = articles.find((item) => item.id === selectedId);
        if (current) void toggleStar(selectedId, !current.isStarred);
      } else if (event.key === 'r') {
        void refreshAll();
      } else if (event.key === '/') {
        event.preventDefault();
        setUi({ searchOpen: true });
      } else if (event.key === '?') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    articles,
    nextCursor,
    selectedId,
    selectAdjacent,
    toggleRead,
    toggleStar,
    refreshAll,
    setUi,
    ui,
    helpOpen,
  ]);

  if (!ready) {
    // 启动失败时不能继续转圈：本地服务起不来是最常见的一种故障，必须给出可操作的出口。
    // 用 initSettled 而不是一次性的失败标记：store 稍后补上 ready 时这里会自动消失。
    const failure = storeInitError ?? (initSettled ? '本地服务没有就绪。' : null);
    if (failure) {
      return (
        <div className="flex h-full items-center justify-center px-8">
          <div className="max-w-md text-center">
            <div className="text-sm font-semibold">本地服务启动失败</div>
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
              {failure}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--ff-faint)' }}>
              重启应用通常可以恢复；如果反复失败，请检查数据目录是否可写。
            </p>
            <button
              className="ff-btn ff-btn-primary mt-4"
              onClick={() => void runInit()}
              disabled={retrying}
            >
              {retrying ? <Spinner /> : null} 重试
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ff-muted)' }}>
          <Spinner /> 正在启动本地服务…
        </div>
      </div>
    );
  }

  // 生词本是整页视图：占满窗口，阅读区整体让位。关闭后回到原来的文章与阅读位置。
  if (ui.vocabularyOpen) {
    return <VocabularyView />;
  }

  return (
    <div data-reader-layout="desktop" className="relative flex h-full w-full overflow-hidden">
      {/*
        折叠后侧栏宽度归零，必须留一条细栏当入口：否则用户只能靠快捷键 [ 才能把它叫回来，
        鼠标用户会以为侧栏被永久关掉了。
      */}
      {ui.sidebarCollapsed ? (
        <div
          className="flex w-8 shrink-0 flex-col items-center border-r py-2"
          style={{ background: 'var(--ff-surface-2)' }}
        >
          <button
            className="ff-btn ff-btn-ghost !p-1"
            onClick={() => setUi({ sidebarCollapsed: false })}
            title="展开侧栏 ([)"
          >
            <PanelLeftOpen size={15} />
          </button>
        </div>
      ) : (
        // 展开态把按钮压在侧栏与列表的分界线上：那里两侧都是留白，不会盖住文字。
        <button
          className="ff-btn ff-btn-ghost absolute z-30 !rounded-full !p-1"
          style={{ left: leftWidth - 10, top: 8, background: 'var(--ff-surface)' }}
          onClick={() => setUi({ sidebarCollapsed: true })}
          title="收起侧栏 ([)"
        >
          <PanelLeftClose size={13} />
        </button>
      )}

      <div
        className="flex overflow-hidden border-r"
        style={{ width: ui.sidebarCollapsed ? 0 : leftWidth, minWidth: ui.sidebarCollapsed ? 0 : 200, flexShrink: 1 }}
      >
        <Sidebar />
      </div>

      {!ui.sidebarCollapsed ? (
        <ResizeHandle
          onResize={(delta) => setLeftWidth((value) => clamp(value + delta, 200, 420))}
          onDone={() => void persistWidths(leftWidth, middleWidth)}
        />
      ) : null}

      <div
        data-reader-pane="articles"
        className="flex overflow-hidden border-r"
        style={{ width: middleWidth, minWidth: 280, flexShrink: 1 }}
      >
        <ArticleList />
      </div>

      <ResizeHandle
        onResize={(delta) => setMiddleWidth((value) => clamp(value + delta, 300, 640))}
        onDone={() => void persistWidths(leftWidth, middleWidth)}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: 420 }}>
        <ArticleReader />
      </div>

      <SettingsModal />
      <AddFeedDialog />
      {ui.rssCatalogOpen ? (
        <Suspense fallback={null}>
          <RssCatalogDialog
            open
            onClose={() => setUi({ rssCatalogOpen: false })}
            subscribedUrls={feeds.map((feed) => feed.url)}
            onSelect={handleCatalogSelect}
          />
        </Suspense>
      ) : null}
      <SearchDialog />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toasts />
    </div>
  );
}

/** 快捷键帮助面板。 */
function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="快捷键"
      description="输入框获得焦点时这些快捷键不会触发。"
      width="max-w-md"
    >
      <table className="w-full text-[12px]">
        <tbody>
          {SHORTCUTS.map(([keys, label]) => (
            <tr key={keys} className="border-b last:border-b-0">
              <td className="w-32 whitespace-nowrap py-1.5 pr-3 align-middle">
                <span className="ff-chip !px-1.5 tabular-nums">{keys}</span>
              </td>
              <td className="py-1.5 align-middle" style={{ color: 'var(--ff-muted)' }}>
                {label}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 失败态可能是字符串、Error 或空值，统一成可显示的一行字。 */
function errorText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  return '启动时发生未知错误';
}

function ResizeHandle({
  onResize,
  onDone,
}: {
  onResize: (delta: number) => void;
  onDone: () => void;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const [active, setActive] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={clsx('group relative z-10 -mx-[3px] w-[6px] shrink-0 cursor-col-resize')}
      onPointerDown={(event) => {
        dragging.current = true;
        lastX.current = event.clientX;
        setActive(true);
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const delta = event.clientX - lastX.current;
        lastX.current = event.clientX;
        if (delta !== 0) onResize(delta);
      }}
      onPointerUp={() => {
        if (!dragging.current) return;
        dragging.current = false;
        setActive(false);
        onDone();
      }}
    >
      <span
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors"
        style={{ background: active ? 'var(--ff-accent)' : 'transparent' }}
      />
    </div>
  );
}
