import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LearningCardState } from './useEnglishLearning';
import LearningCard from './LearningCard';

interface Props {
  cards: LearningCardState[];
  /** 关闭整叠卡片（点击外部、Esc、滚动或跳转设置）。 */
  onClose: () => void;
  onCloseCard: (id: number) => void;
  onRetry: (id: number) => void;
  onSave: (id: number) => void;
  onExplainDetail: (id: number) => void;
  /** 单词卡「详细解释」重新生成（绕缓存）。 */
  onRetryDetail: (id: number) => void;
  onOpenSettings?: () => void;
}

/**
 * 一次选区可能解析出多个整词（例如跨过两个单词各选了一部分）。
 * 桌面端靠中栏与正文栏的分界线向左展开，高度跟随选区，方便对照原句。
 * 这里统一负责定位和关闭行为，按叠放顺序渲染每张词卡。
 */
export default function LearningCardStack({
  cards,
  onClose,
  onCloseCard,
  onRetry,
  onSave,
  onExplainDetail,
  onRetryDetail,
  onOpenSettings,
}: Props) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number } | null>(null);
  const anchor = cards[0]?.selection.rect;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !anchor) return;
    const layout = document.querySelector<HTMLElement>('[data-reader-layout="desktop"]');
    const articlePane = layout?.querySelector<HTMLElement>('[data-reader-pane="articles"]');
    const place = () => {
      const bounds = element.getBoundingClientRect();
      const layoutBounds = layout?.getBoundingClientRect();
      const paneBounds = articlePane?.getBoundingClientRect();
      const regionLeft = Math.max(0, layoutBounds?.left ?? 0);
      const regionRight = Math.min(window.innerWidth, paneBounds?.right ?? 0);
      const regionTop = Math.max(0, layoutBounds?.top ?? 0);
      const regionBottom = Math.min(window.innerHeight, layoutBounds?.bottom ?? 0);
      const useLeftRegion = regionRight > regionLeft + 16 && regionBottom > regionTop + 16;
      const maxWidth = Math.max(0, (useLeftRegion ? regionRight - regionLeft : window.innerWidth) - 16);
      const width = Math.min(bounds.width, maxWidth);
      const left = useLeftRegion
        ? regionRight - width - 8
        : Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      const below = anchor.bottom + 8;
      const preferredTop = below + bounds.height <= window.innerHeight - 8
        ? below : anchor.top - bounds.height - 8;
      const top = useLeftRegion
        ? Math.max(regionTop + 8, Math.min(anchor.top, regionBottom - bounds.height - 8))
        : Math.max(8, Math.min(preferredTop, window.innerHeight - bounds.height - 8));
      setPosition((current) => current?.left === left && current.top === top && current.maxWidth === maxWidth
        ? current : { left, top, maxWidth });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (layout) observer.observe(layout);
    if (articlePane) observer.observe(articlePane);
    return () => observer.disconnect();
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !elementRef.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const onScroll = (event: Event) => {
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

  return createPortal(
    <div
      ref={elementRef}
      className="fixed z-40 flex max-h-[calc(100dvh-16px)] flex-col gap-2 overflow-y-auto"
      style={{
        left: position?.left ?? 8,
        top: position?.top ?? 8,
        maxWidth: position?.maxWidth ?? 'calc(100vw - 16px)',
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {cards.map((card) => (
        <LearningCard
          key={card.id}
          card={card}
          stacked={cards.length > 1}
          onClose={onClose}
          onDismiss={() => onCloseCard(card.id)}
          onRetry={() => onRetry(card.id)}
          onSave={() => onSave(card.id)}
          onExplainDetail={() => onExplainDetail(card.id)}
          onRetryDetail={() => onRetryDetail(card.id)}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>,
    document.body,
  );
}
