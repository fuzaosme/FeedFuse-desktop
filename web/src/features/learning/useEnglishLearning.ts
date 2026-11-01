import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { ApiError } from '../../api/client';
import * as api from '../../api/endpoints';
import { useAppStore } from '../../store/app';
import {
  cleanVocabularyTerm,
  ENGLISH_LEARNING_CACHE_VERSION,
  ENGLISH_LEARNING_MAX_TEXT_LENGTH,
} from '../../lib/englishLearning';
import { buildSelectionContext } from './context';
import { lookupDictionary, warmLearningDictionaries, type DictionaryResult } from './dictionary';
import {
  completeLearningSelection,
  resolveLookupPlan,
  resolveSelectionMode,
  type LookupPlan,
} from './lookupTerms';
import { readLearningSelection, type LearningSelection } from './selection';

export interface LearningCardState {
  /** 卡片稳定标识：一次选区可能生成多张卡片，收起某一张时不能打乱其它卡片的在途请求。 */
  id: number;
  selection: LearningSelection;
  /** 这张卡片实际查询、展示和收藏的整词；句子卡片不使用。 */
  term: string;
  articleId: string;
  kind: 'word' | 'sentence';
  loading: boolean;
  dictionary: DictionaryResult | null;
  /** 词组未收录后的处理也用于查询失败后的重试。 */
  phraseFallback?: { terms: string[]; explainOnMiss: boolean };
  explanation: string;
  error: string;
  missingConfig: boolean;
  saving: boolean;
  saved: boolean;
  invalidSelection: boolean;
  /** 选区所在段落的原文，随请求一起发给 AI 做语境分析。 */
  context: string;
  /** 单词卡「详细解释」：独立于句子讲解的在途状态与结果。 */
  detailLoading: boolean;
  detailText: string;
  detailError: string;
  detailMissingConfig: boolean;
}

interface HookInput {
  articleId: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  /** 文章标题容器：标题在正文容器之外，选中标题单词同样触发查词（链接视为可选区）。 */
  titleRef?: RefObject<HTMLElement | null>;
  contentHtml: string;
  isDesktop: boolean;
}

/** 服务端返回的配置缺失文案不是错误码，这里统一判断，给卡片一个「打开设置」的出口。 */
function isMissingAiConfig(error: unknown): boolean {
  if (error instanceof ApiError && error.code === 'missing_ai_config') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /尚未配置|缺少\s*API Key/.test(message);
}

export function useEnglishLearning({ articleId, contentRef, titleRef, contentHtml, isDesktop }: HookInput) {
  const enabled = useAppStore((state) => state.ui.learningEnabled);
  const vocabularyOpen = useAppStore((state) => state.ui.vocabularyOpen);
  const ai = useAppStore((state) => state.settings?.ai);
  const [cards, setCards] = useState<LearningCardState[]>([]);
  const cardsRef = useRef<LearningCardState[]>([]);
  const sequence = useRef(0);
  const nextCardId = useRef(0);
  const controllers = useRef(new Map<number, AbortController>());
  // 详细解释与查词/保存并行使用独立控制器，避免保存单词时中断在途的详细解释。
  const detailControllers = useRef(new Map<number, AbortController>());
  // 保存单词走独立控制器：绝不能覆盖 controllers 里同卡的讲解请求。
  const saveControllers = useRef(new Map<number, AbortController>());
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerType = useRef('');
  const cache = useRef(new Map<string, string>());
  const detailCache = useRef(new Map<string, string>());

  const commit = useCallback((next: LearningCardState[]) => {
    cardsRef.current = next;
    setCards(next);
  }, []);

  const abortAll = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    for (const controller of detailControllers.current.values()) controller.abort();
    detailControllers.current.clear();
    for (const controller of saveControllers.current.values()) controller.abort();
    saveControllers.current.clear();
  }, []);

  const close = useCallback(() => {
    sequence.current += 1;
    abortAll();
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    selectionTimer.current = null;
    commit([]);
  }, [abortAll, commit]);

  /** 只收起一张卡片，其余卡片（含在途请求）保持不动。 */
  const closeCard = useCallback((id: number) => {
    if (!cardsRef.current.some((card) => card.id === id)) return;
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    detailControllers.current.get(id)?.abort();
    detailControllers.current.delete(id);
    saveControllers.current.get(id)?.abort();
    saveControllers.current.delete(id);
    commit(cardsRef.current.filter((card) => card.id !== id));
  }, [commit]);

  const update = useCallback((requestId: number, id: number, patch: Partial<LearningCardState>) => {
    if (sequence.current !== requestId) return;
    const index = cardsRef.current.findIndex((card) => card.id === id);
    if (index < 0) return;
    const next = cardsRef.current.slice();
    next[index] = { ...next[index], ...patch };
    commit(next);
  }, [commit]);

  const explain = useCallback(async (cardId: number, selection: LearningSelection, requestId: number, force = false) => {
    if (!articleId) return;
    const context = buildSelectionContext(selection);
    const key = JSON.stringify([
      ENGLISH_LEARNING_CACHE_VERSION,
      articleId, selection.selectedText, selection.sentences, context,
      ai?.model, ai?.apiBaseUrl, ai?.englishLearningPrompt,
    ]);
    const cached = cache.current.get(key);
    if (cached && !force) {
      update(requestId, cardId, { loading: false, explanation: cached });
      return;
    }
    // 同一卡片重入（例如连续点两次重新生成）：先中断旧请求再建新请求。
    controllers.current.get(cardId)?.abort();
    const abort = new AbortController();
    controllers.current.set(cardId, abort);
    const payload = {
      articleId: articleId!,
      selectedText: selection.selectedText,
      sentences: selection.sentences,
      context,
    };
    try {
      // 流式优先：服务端每推一个 delta 就把累积文本写回卡片，首字无需等整段生成完。
      const explanation = await api.streamEnglishExplanation(payload, {
        signal: abort.signal,
        onDelta: (partial) => update(requestId, cardId, { explanation: partial }),
      });
      if (sequence.current !== requestId || abort.signal.aborted) return;
      if (!explanation.trim()) {
        update(requestId, cardId, { loading: false, error: '讲解内容为空，请重新生成' });
        return;
      }
      cache.current.set(key, explanation);
      if (cache.current.size > 100) {
        const oldest = cache.current.keys().next().value;
        if (oldest !== undefined) cache.current.delete(oldest);
      }
      update(requestId, cardId, { loading: false, explanation });
    } catch (error) {
      if (abort.signal.aborted) return;
      update(requestId, cardId, {
        loading: false,
        missingConfig: isMissingAiConfig(error),
        error: error instanceof Error ? error.message : '暂时无法生成讲解，请重试',
      });
    } finally {
      if (controllers.current.get(cardId) === abort) controllers.current.delete(cardId);
    }
  }, [articleId, ai?.model, ai?.apiBaseUrl, ai?.englishLearningPrompt, update]);

  /**
   * 单词卡「详细解释」：词典释义读不懂时，用专用提示词深挖该词在当前语境中的用法。
   * 与句子讲解完全独立：不共用缓存、不读取句子讲解提示词，保存单词也不会中断它。
   */
  const explainDetail = useCallback(async (cardId: number, force = false) => {
    const current = cardsRef.current.find((card) => card.id === cardId);
    if (!articleId || !current || current.kind !== 'word' ||
        current.loading || current.detailLoading || current.invalidSelection) return;
    const requestId = sequence.current;
    const key = JSON.stringify([
      ENGLISH_LEARNING_CACHE_VERSION,
      'word-detail', articleId, current.term, current.selection.sentences, current.context,
      ai?.model, ai?.apiBaseUrl,
    ]);
    const cached = detailCache.current.get(key);
    if (cached && !force) {
      update(requestId, cardId, {
        detailLoading: false, detailText: cached, detailError: '', detailMissingConfig: false,
      });
      return;
    }
    detailControllers.current.get(cardId)?.abort();
    const abort = new AbortController();
    detailControllers.current.set(cardId, abort);
    update(requestId, cardId, { detailLoading: true, detailError: '', detailMissingConfig: false });
    try {
      const explanation = await api.streamWordDetail({
        articleId,
        term: current.term,
        selectedText: current.selection.selectedText,
        sentences: current.selection.sentences,
        context: current.context,
      }, {
        signal: abort.signal,
        onDelta: (partial) => update(requestId, cardId, { detailText: partial }),
      });
      if (sequence.current !== requestId || abort.signal.aborted) return;
      if (!explanation.trim()) {
        update(requestId, cardId, { detailLoading: false, detailError: '详细解释内容为空，请重新生成' });
        return;
      }
      detailCache.current.set(key, explanation);
      if (detailCache.current.size > 100) {
        const oldest = detailCache.current.keys().next().value;
        if (oldest !== undefined) detailCache.current.delete(oldest);
      }
      update(requestId, cardId, { detailLoading: false, detailText: explanation, detailError: '' });
    } catch (error) {
      if (abort.signal.aborted) return;
      update(requestId, cardId, {
        detailLoading: false,
        detailMissingConfig: isMissingAiConfig(error),
        detailError: error instanceof Error ? error.message : '暂时无法生成详细解释，请重试',
      });
    } finally {
      if (detailControllers.current.get(cardId) === abort) detailControllers.current.delete(cardId);
    }
  }, [articleId, ai?.model, ai?.apiBaseUrl, update]);

  const lookupAllTerms = useCallback(async (entries: { id: number; term: string }[], requestId: number) => {
    await Promise.all(entries.map(async ({ id, term }) => {
      const dictionary = await lookupDictionary(term);
      update(requestId, id, { dictionary, loading: false });
    }));
  }, [update]);

  /**
   * 完整词组未被任何词典收录时，把词组卡原地替换成逐词卡片。
   * 沿用原卡片的选区信息；新卡片不再带词组回退，避免反复展开。
   */
  const expandPhraseCard = useCallback((phraseId: number, words: string[], requestId: number) => {
    if (sequence.current !== requestId || !words.length) return;
    const current = cardsRef.current;
    const index = current.findIndex((card) => card.id === phraseId);
    if (index < 0) return;
    const source = current[index];
    const replacements: LearningCardState[] = words.map((term) => {
      nextCardId.current += 1;
      return {
        ...source,
        id: nextCardId.current,
        term,
        loading: true,
        dictionary: null,
        error: '',
        phraseFallback: undefined,
      };
    });
    commit([...current.slice(0, index), ...replacements, ...current.slice(index + 1)]);
    void lookupAllTerms(replacements.map((card) => ({ id: card.id, term: card.term })), requestId);
  }, [commit, lookupAllTerms]);

  const lookupPhrase = useCallback(async (card: LearningCardState, requestId: number) => {
    const dictionary = await lookupDictionary(card.term);
    if (sequence.current !== requestId || !cardsRef.current.some((current) => current.id === card.id)) return;
    if (dictionary.status === 'not_found' && card.phraseFallback) {
      if (card.phraseFallback.explainOnMiss) {
        update(requestId, card.id, { kind: 'sentence', dictionary: null, phraseFallback: undefined });
        void explain(card.id, card.selection, requestId);
      } else {
        expandPhraseCard(card.id, card.phraseFallback.terms, requestId);
      }
      return;
    }
    update(requestId, card.id, { dictionary, loading: false });
  }, [explain, expandPhraseCard, update]);

  const openSelection = useCallback(() => {
    if (!enabled || !isDesktop || vocabularyOpen || !articleId ||
        !window.matchMedia('(any-pointer: fine)').matches) return;
    // 正文优先，标题兜底：两者是不同容器，选区只可能落在其中一个里面。
    const rawSelection = (contentRef.current && readLearningSelection(contentRef.current)) ||
      (titleRef?.current && readLearningSelection(titleRef.current));
    if (!rawSelection || (!contentRef.current && !titleRef?.current)) return;
    const mode = resolveSelectionMode(rawSelection);
    const selection = completeLearningSelection(rawSelection);
    const kind = mode === 'sentence' ? 'sentence' : 'word';
    const tooLong = selection.selectedText.length > ENGLISH_LEARNING_MAX_TEXT_LENGTH ||
      selection.sentences.join('\n').length > ENGLISH_LEARNING_MAX_TEXT_LENGTH ||
      selection.sentences.length > 100 ||
      (kind === 'word' && cleanVocabularyTerm(selection.selectedText).length > 200);
    const plan: LookupPlan = kind === 'word' && !tooLong
      ? resolveLookupPlan(rawSelection.pieces)
      : { terms: [], fallbackTerms: [] };
    const terms = plan.terms.length ? plan.terms : [cleanVocabularyTerm(selection.selectedText)];
    // 完整和补全后的词组都先整体查询，未命中时再拆词或讲解。
    const fallbackTerms = plan.terms.length ? plan.fallbackTerms : [];
    const current = cardsRef.current;
    const unchanged = current.length === terms.length &&
      current.every((card, index) => card.term === terms[index]) &&
      current[0]?.selection.selectedText === selection.selectedText &&
      JSON.stringify(current[0]?.selection.sentences) === JSON.stringify(selection.sentences) &&
      current[0]?.selection.rect.left === selection.rect.left &&
      current[0]?.selection.rect.top === selection.rect.top;
    // 同一次选区（pointerup 与 dblclick）只处理一次；收起过某张卡片后再次选择则重新展开。
    if (unchanged) return;
    close();
    const requestId = sequence.current;
    const context = buildSelectionContext(selection);
    const next: LearningCardState[] = terms.map((term) => {
      nextCardId.current += 1;
      return {
        id: nextCardId.current,
        selection,
        term,
        articleId,
        kind,
        loading: !tooLong,
        dictionary: null,
        explanation: '',
        phraseFallback: kind === 'word' && terms.length === 1 && fallbackTerms.length
          ? { terms: fallbackTerms, explainOnMiss: mode === 'phrase-or-sentence' }
          : undefined,
        error: tooLong ? '所选内容过长，请缩小选区' : '',
        missingConfig: false,
        saving: false,
        saved: false,
        invalidSelection: tooLong,
        context,
        detailLoading: false,
        detailText: '',
        detailError: '',
        detailMissingConfig: false,
      };
    });
    commit(next);
    if (tooLong) return;
    if (kind === 'sentence') {
      void explain(next[0].id, selection, requestId);
    } else if (mode === 'phrase-or-sentence' && !next[0].phraseFallback) {
      // 含标点的长片段没有可查询的完整词组，直接讲解。
      const [card] = next;
      commit([{ ...card, kind: 'sentence' }]);
      void explain(card.id, selection, requestId);
    } else if (next[0].phraseFallback) {
      void lookupPhrase(next[0], requestId);
    } else {
      void lookupAllTerms(next.map((card) => ({ id: card.id, term: card.term })), requestId);
    }
  }, [enabled, isDesktop, vocabularyOpen, articleId, contentRef, titleRef, close, commit, explain,
    lookupPhrase, lookupAllTerms]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    lastPointerType.current = event.pointerType;
    if (!enabled || !isDesktop || event.pointerType !== 'mouse' || event.button !== 0) return;
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    // 等待浏览器完成选区更新；双击的 pointerup 和 dblclick 合并为一次处理。
    selectionTimer.current = setTimeout(openSelection, 0);
  }, [enabled, isDesktop, openSelection]);

  const onDoubleClick = useCallback(() => {
    if (lastPointerType.current !== 'mouse') return;
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    selectionTimer.current = null;
    openSelection();
  }, [openSelection]);

  const retry = useCallback((id: number) => {
    const current = cardsRef.current.find((card) => card.id === id);
    if (!current || current.loading || current.saving || current.invalidSelection) return;
    // 沿用当前 requestId：重试只影响这张卡片，不能让同一次选区的另一张卡片丢掉在途结果。
    // force=true：重新生成必须绕过缓存，否则拿到的是上次缓存的废回答。
    const requestId = sequence.current;
    if (current.kind === 'sentence') {
      // 重新生成时保留旧讲解直到首个 delta 到达，避免闪空；失败则旧文仍在、可再重试。
      update(requestId, id, { loading: true, error: '', missingConfig: false });
      void explain(id, current.selection, requestId, true);
    } else {
      update(requestId, id, { loading: true, error: '', missingConfig: false });
      if (current.phraseFallback) void lookupPhrase(current, requestId);
      else void lookupAllTerms([{ id, term: current.term }], requestId);
    }
  }, [explain, lookupPhrase, lookupAllTerms, update]);

  /** 单词卡「详细解释」重新生成：force=true 绕过缓存、覆盖旧结果。 */
  const retryDetail = useCallback((id: number) => {
    const current = cardsRef.current.find((card) => card.id === id);
    if (!current || current.kind !== 'word' || current.detailLoading ||
        current.loading || current.saving || current.invalidSelection) return;
    void explainDetail(id, true);
  }, [explainDetail]);

  const saveWord = useCallback(async (id: number) => {
    const current = cardsRef.current.find((card) => card.id === id);
    if (!current || current.kind !== 'word' || current.saving || current.saved ||
        current.loading || current.invalidSelection) return;
    const requestId = sequence.current;
    // 保存走独立控制器：不能复用 controllers，否则会顶掉同卡在途讲解的引用。
    saveControllers.current.get(id)?.abort();
    const abort = new AbortController();
    saveControllers.current.set(id, abort);
    update(requestId, id, { saving: true, error: '' });
    try {
      const article = useAppStore.getState().article;
      await api.addVocabulary({
        term: current.term,
        definition: current.dictionary?.status === 'found'
          ? current.dictionary.entry.meanings.join('\n')
          : '',
        sourceArticleId: current.articleId,
        sourceTitle: article?.id === current.articleId ? article.title : '',
        sourceUrl: article?.id === current.articleId ? article.link ?? '' : '',
        sourceSentence: current.selection.sentences.join('\n'),
      });
      if (abort.signal.aborted) return;
      void useAppStore.getState().loadVocabulary();
      update(requestId, id, { saving: false, saved: true });
      useAppStore.getState().toast(`已加入生词本：${current.term}`, 'success');
    } catch (error) {
      if (abort.signal.aborted) return;
      update(requestId, id, {
        saving: false,
        error: error instanceof Error ? error.message : '保存失败，请重试',
      });
    } finally {
      if (saveControllers.current.get(id) === abort) saveControllers.current.delete(id);
    }
  }, [update]);

  // 选区依赖的上下文变化后旧卡片必须整体失效（同时中断在途请求）。
  useEffect(() => {
    if (enabled && isDesktop) warmLearningDictionaries();
  }, [enabled, isDesktop]);

  useEffect(() => {
    close();
    return close;
  }, [articleId, contentHtml, enabled, isDesktop, vocabularyOpen,
    ai?.model, ai?.apiBaseUrl, ai?.englishLearningPrompt, close]);

  useEffect(() => {
    cache.current.clear();
    detailCache.current.clear();
  }, [articleId]);

  const visible = enabled && isDesktop && !vocabularyOpen &&
    cards.every((card) => card.articleId === articleId);
  return {
    cards: visible ? cards : [],
    close,
    closeCard,
    retry,
    retryDetail,
    saveWord,
    explainDetail,
    onPointerUp,
    onDoubleClick,
  };
}
