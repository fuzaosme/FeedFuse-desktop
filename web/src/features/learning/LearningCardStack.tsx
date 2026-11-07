import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LearningCardState } from './useEnglishLearning';
import LearningCard from './LearningCard';

interface Props {
  cards: LearningCardState[];
  /** 关闭整叠卡片（点击卡片外的区域、Esc、跳转设置，或重新划词查下一个）。 */
  onClose: () => void;
  onCloseCard: (id: number) => void;
  onRetry: (id: number) => void;
  onSave: (id: number) => void;
  /** 词典查询失败时的自定义生词。 */
  onSaveCustom: (id: number, term: string, definition: string) => void;
  onExplainDetail: (id: number) => void;
  /** 单词卡「详细解释」重新生成（绕缓存）。 */
  onRetryDetail: (id: number) => void;
  onOpenSettings?: () => void;
}

/**
 * 一次选区只解析出一张卡片；仍保留叠放容器，便于以后扩展或同时展示多张。
 * 桌面端靠中栏与正文栏的分界线向左展开，高度跟随选区，方便对照原句。
 * 这里统一负责定位和关闭行为。
 */
export default function LearningCardStack({
  cards,
  onClose,
  onCloseCard,
  onRetry,
  onSave,
  onSaveCustom,
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
    // 滚动与改变窗口大小都不再收起卡片：查词时经常要上下翻着对照原文，
    // 卡片一滚就消失等于逼用户重新划词。位置由上面的 ResizeObserver 重新夹取，
    // 卡片是 fixed 定位，滚动时停在原地不跟着正文跑。
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
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
          onSaveCustom={(term, definition) => onSaveCustom(card.id, term, definition)}
          onExplainDetail={() => onExplainDetail(card.id)}
          onRetryDetail={() => onRetryDetail(card.id)}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>,
    document.body,
  );
}
