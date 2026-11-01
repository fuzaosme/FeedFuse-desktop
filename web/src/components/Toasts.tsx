import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useAppStore } from '../store/app';

export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);

  // 容器必须常驻：aria-live 区域如果等到有内容才挂载，读屏软件不会播报第一批提示。
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => {
        const tone =
          toast.tone === 'error'
            ? { color: 'var(--ff-danger)', icon: <AlertCircle size={14} /> }
            : toast.tone === 'success'
              ? { color: 'var(--ff-accent)', icon: <CheckCircle2 size={14} /> }
              : { color: 'var(--ff-muted)', icon: <Info size={14} /> };

        return (
          <div
            key={toast.id}
            className="ff-fade-in pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-lg"
            style={{ background: 'var(--ff-surface)', boxShadow: 'var(--ff-shadow)' }}
          >
            <span className="mt-0.5 shrink-0" style={{ color: tone.color }}>
              {tone.icon}
            </span>
            <span className="flex-1 leading-relaxed">{toast.message}</span>
            <button className="ff-btn ff-btn-ghost !p-0.5" onClick={() => dismiss(toast.id)}>
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
