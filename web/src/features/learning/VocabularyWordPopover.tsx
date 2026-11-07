import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookMarked, BookOpen, Check, Plus, Trash2, X } from 'lucide-react';
import type { VocabularyItem } from '../../api/types';
import { Spinner } from '../../components/ui';
import { hostOf } from '../../lib/format';
import { MAX_VOCABULARY_SENTENCES } from './vocabulary';

interface Props {
  entry: VocabularyItem;
  /** 被点中那个词的视口位置，用来把浮层贴在词下方（放不下就翻到上方）。 */
  anchor: { left: number; right: number; top: number; bottom: number };
  /** 已经取到「本句」，可以加进例句。 */
  sentence: string;
  adding: boolean;
  onClose: () => void;
  /** 鼠标移入/移出浮层：悬停预览时用来保持浮层不消失。 */
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  onAddSentence: () => void;
  onDelete: () => void;
  onOpenVocabulary: () => void;
}

const POPOVER_WIDTH = 348;

/**
 * 正文里点击已收藏的生词，就地展开释义与例句。
 *
 * 这里不依赖「英语学习」开关，也不发词典/AI 请求：已收藏过的词，读的时候顺手点开看看就好。
 * 两个图标按钮：＋ 把当前这一句收进例句（最多 5 句），垃圾桶从生词本删除。
 */
export function VocabularyWordPopover({
  entry,
  anchor,
  sentence,
  adding,
  onClose,
  onHoverStart,
  onHoverEnd,
  onAddSentence,
  onDelete,
  onOpenVocabulary,
}: Props) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const place = () => {
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 24);
      const height = element.getBoundingClientRect().height;
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
      const below = anchor.bottom + 8;
      const above = anchor.top - height - 8;
      const top = below + height <= window.innerHeight - 12
        ? below
        : above >= 12
          ? above
          : Math.max(12, window.innerHeight - height - 12);
      setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor.left, anchor.top, anchor.bottom, anchor.right]);

  useEffect(() => {
    // 打开瞬间可能还有一次「滚动到位」的余波（点击带 tabindex 的词会触发聚焦滚动），
    // 这段窗口内的 scroll 不能当成用户滚动，否则浮层会一点就消失。
    const openedAt = Date.now();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && elementRef.current?.contains(event.target)) return;
      // 点在正文里的生词上不算「点外部」：点击会就地切换浮层，不能让浮层先闪没。
      if (event.target instanceof Element && event.target.closest('[data-vocabulary-word]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    // 浮层贴在词上，正文一滚就会错位，直接收起比跟着飘更自然。
    const onScroll = (event: Event) => {
      if (Date.now() - openedAt < 300) return;
      if (event.target instanceof Node && elementRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const width = Math.min(POPOVER_WIDTH, window.innerWidth - 24);
  const sentences = entry.sentences;
  const full = sentences.length >= MAX_VOCABULARY_SENTENCES;
  const alreadyAdded = sentence.trim()
    ? sentences.some((item) => item.text.trim().toLowerCase() === sentence.trim().toLowerCase())
    : false;

  return createPortal(
    <div
      ref={elementRef}
      role="dialog"
      aria-label={`生词：${entry.term}`}
      data-testid="vocabulary-word-popover"
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className="fixed z-[70] flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-xl border shadow-xl"
      style={{
        left: position?.left ?? 12,
        top: position?.top ?? 12,
        width,
        // 和查词卡片保持一致：极淡的强调色底，只为把它从普通白面板里稍微区分出来。
        background: 'var(--ff-accent-soft)',
        borderColor: 'var(--ff-vocab-mark-hover)',
        boxShadow: 'var(--ff-shadow)',
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-start gap-2 px-3.5 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide" style={{ color: 'var(--ff-faint)' }}>
            <BookMarked size={11} />
            生词本
          </div>
          <h2 className="mt-1 break-words text-[17px] font-semibold leading-snug">{entry.term}</h2>
        </div>
        <button className="ff-btn ff-btn-ghost !p-1" onClick={onClose} aria-label="关闭">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-1">
        {entry.definition ? (
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
            {entry.definition}
          </p>
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--ff-muted)' }}>
            还没有填写释义，可以到生词本里补充自定义释义。
          </p>
        )}

        {sentences.length ? (
          <ul className="mt-3 space-y-2">
            {sentences.map((item, index) => (
              <li
                key={`${item.addedAt}-${index}`}
                className="border-l-2 pl-2.5 text-[11.5px] leading-relaxed"
                style={{ borderColor: 'var(--ff-vocab-mark-hover)', color: 'var(--ff-muted)' }}
              >
                <p className="break-words">{item.text}</p>
                {item.articleTitle || item.articleUrl ? (
                  <p className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                    {item.articleTitle || hostOf(item.articleUrl)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ff-faint)' }}>
            还没有例句，点右下角的 ＋ 把当前这句收进来。
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 border-t px-2.5 py-1.5" style={{ borderColor: 'var(--ff-border)' }}>
        <button
          className="ff-btn ff-btn-ghost !p-1.5"
          onClick={onOpenVocabulary}
          title="打开生词本"
          aria-label="打开生词本"
        >
          <BookOpen size={14} />
        </button>
        <button
          className="ff-btn ff-btn-ghost !p-1.5"
          onClick={onDelete}
          title="从生词本删除"
          aria-label="从生词本删除"
          style={{ color: 'var(--ff-danger)' }}
        >
          <Trash2 size={14} />
        </button>
        <span className="flex-1 text-[10px] tabular-nums" style={{ color: 'var(--ff-faint)' }}>
          {sentences.length} / {MAX_VOCABULARY_SENTENCES} 句{full ? ' · 加满后替换最早' : ''}
        </span>
        <button
          className="ff-btn !px-2 !py-1"
          onClick={onAddSentence}
          disabled={adding || !sentence.trim() || alreadyAdded}
          title={
            alreadyAdded
              ? '这一句已经在例句里了'
              : full
                ? '把当前这句加入例句（已满 5 句，将替换最早的一句）'
                : '把当前这句加入例句'
          }
          aria-label="把当前这句加入例句"
        >
          {adding ? <Spinner /> : alreadyAdded ? <Check size={13} /> : <Plus size={13} />}
        </button>
      </div>
    </div>,
    document.body,
  );
}
