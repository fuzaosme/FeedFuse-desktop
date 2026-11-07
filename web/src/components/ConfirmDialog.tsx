import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store/app';

/**
 * 应用内确认框（`askConfirm` 的渲染端）。
 *
 * 为什么不用 `window.confirm`：macOS 的 WKWebView 没有实现 JS 确认面板，
 * 调用既不弹窗也不抛错，直接返回 false。于是所有写成
 * `if (!window.confirm(...)) return;` 的删除入口都变成「点了没反应」——
 * 生词、订阅、分类、词典全都删不掉。这里换成真正的 DOM 弹窗，
 * 键盘 Enter/Esc、点遮罩都能结束，并且返回一个可 await 的布尔值。
 */
export function ConfirmDialog() {
  const request = useAppStore((state) => state.confirmRequest);
  const resolveConfirm = useAppStore((state) => state.resolveConfirm);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!request) return;
    // 打开就把焦点放到确认按钮：键盘用户直接敲 Enter 即可，Esc 取消。
    confirmRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // 捕获阶段就吃掉事件：底下的阅读器/整页视图也在监听 Esc，不能让它们一起关掉。
      event.stopPropagation();
      resolveConfirm(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [request, resolveConfirm]);

  if (!request) return null;

  const danger = request.danger;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-6 backdrop-blur-[2px]"
      onPointerDown={(event) => {
        // 只认遮罩本身：点卡片内部不该关掉。
        if (event.target === event.currentTarget) resolveConfirm(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        className="ff-card ff-fade-in w-full max-w-sm p-4"
        style={{ boxShadow: 'var(--ff-shadow)' }}
      >
        <div className="flex items-start gap-2.5">
          {danger ? (
            <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--ff-danger)' }} />
          ) : null}
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold">{request.title}</h2>
            <p
              className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed"
              style={{ color: 'var(--ff-muted)' }}
            >
              {request.message}
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="ff-btn ff-btn-ghost" onClick={() => resolveConfirm(false)}>
            {request.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className="ff-btn"
            style={
              danger
                ? { background: 'var(--ff-danger)', borderColor: 'var(--ff-danger)', color: '#fff' }
                : { background: 'var(--ff-accent-fill)', borderColor: 'var(--ff-accent-fill)', color: 'var(--ff-accent-contrast)' }
            }
            onClick={() => resolveConfirm(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
