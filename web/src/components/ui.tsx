import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';

/** 弹窗内可参与 Tab 的元素：隐藏项用 offsetParent 过滤掉，避免把焦点送进看不见的按钮。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      aria-hidden
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  width = 'max-w-2xl',
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  width?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  /**
   * 焦点管理。
   *
   * 不做这一步时，⌘, 打开弹窗后 Tab 会继续在背后的页面里走，用户以为模态失效；
   * 关闭时焦点又落在 body 上，得从头 Tab 一遍才能回到触发按钮。
   */
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 子元素里的 autoFocus 已经先执行过：只有焦点还在外面时才抢回面板本身。
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const node = panelRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (item) => item.offsetParent !== null,
      );
      if (items.length === 0) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && node.contains(active);
      if (event.shiftKey && (active === first || active === node || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', trap);
    return () => {
      window.removeEventListener('keydown', trap);
      previous?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/35 p-6 backdrop-blur-[2px]">
      <div
        ref={panelRef}
        className={clsx('ff-card ff-fade-in my-auto flex max-h-[calc(100vh-3rem)] w-full flex-col outline-none shadow-2xl', width)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ boxShadow: 'var(--ff-shadow)' }}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 id={titleId} className="text-sm font-semibold">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-xs" style={{ color: 'var(--ff-muted)' }}>
                {description}
              </p>
            ) : null}
          </div>
          <button className="ff-btn ff-btn-ghost !p-1.5" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="ff-label">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] leading-relaxed" style={{ color: 'var(--ff-faint)' }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
            {description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{
          // 轨道用「墨色」强调色、滑块用面板底色：任意主题色下都保证一深一浅。
          background: checked ? 'var(--ff-accent)' : 'var(--ff-border-strong)',
        }}
      >
        <span
          className="absolute top-0.5 size-4 rounded-full transition-all"
          style={{
            left: checked ? '1.125rem' : '0.125rem',
            background: 'var(--ff-surface)',
          }}
        />
      </button>
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <select
      className="ff-input"
      value={String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        const matched = options.find((option) => String(option.value) === raw);
        if (matched) onChange(matched.value);
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      {icon ? <div style={{ color: 'var(--ff-faint)' }}>{icon}</div> : null}
      <div className="text-sm font-medium">{title}</div>
      {description ? (
        <p className="max-w-xs text-xs leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}
