import { useEffect, useState } from 'react';
import { BookPlus, Check, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import type { LearningCardState } from './useEnglishLearning';

interface Props {
  card: LearningCardState;
  /** 兼容叠放容器的旧参数；单卡模式下始终为 false。 */
  stacked?: boolean;
  /** 关闭整组卡片（例如跳转设置中心前）。 */
  onClose: () => void;
  /** 只关闭当前这张卡片。 */
  onDismiss: () => void;
  onRetry: () => void;
  onSave: () => void;
  /** 词典查询失败时的自定义生词：可以改词条、写自己的释义。 */
  onSaveCustom: (term: string, definition: string) => void;
  /** 单词卡「详细解释」：词典读不懂时用专用提示词深挖语境用法。 */
  onExplainDetail: () => void;
  /** 单词卡「详细解释」重新生成：绕过缓存强制重跑，废回答可覆盖。 */
  onRetryDetail: () => void;
  onOpenSettings?: () => void;
}

const DICTIONARY_ERROR_MESSAGE = '词典查询失败，请重试';

export default function LearningCard({
  card,
  stacked = false,
  onClose,
  onDismiss,
  onRetry,
  onSave,
  onSaveCustom,
  onExplainDetail,
  onRetryDetail,
  onOpenSettings,
}: Props) {
  const word = card.kind === 'word';
  const dictionary = card.dictionary;
  const showSettings = card.missingConfig || card.detailMissingConfig;
  /** 词典没有给出释义：此时用 AI 兜底，并提供自定义生词入口。 */
  const fallbackExplanation = word && dictionary?.status === 'not_found';
  const lookupFailed = word && (dictionary?.status === 'not_found' || dictionary?.status === 'error');
  // 句子讲解失败 → 重试；成功但不满意（例如曾外露思维链的废回答）→ 重新生成（绕缓存）。
  const showSentenceRetry = !word && !card.invalidSelection && !showSettings && !!card.error;
  const showSentenceRegen = !word && !card.invalidSelection && !showSettings && !card.error && !!card.explanation;
  // 词典失败 → 重试词典；词典未收录后 AI 解释失败/成功 → 重试或重新生成。
  const showDictionaryRetry = word && !card.invalidSelection && !showSettings && dictionary?.status === 'error';
  const showFallbackRetry = fallbackExplanation && !card.invalidSelection && !showSettings && !!card.error;
  const showFallbackRegen = fallbackExplanation && !card.invalidSelection && !showSettings &&
    !card.error && !!card.explanation;
  const showDetailRetry = word && !card.invalidSelection && !card.detailMissingConfig && !!card.detailError;
  const showDetailRegen = word && !card.invalidSelection && !card.detailMissingConfig &&
    !card.detailError && !!card.detailText;

  return (
    <div
      role="dialog"
      aria-modal={false}
      aria-label={word ? `单词释义：${card.term}` : '英语句子讲解'}
      className="ff-card ff-fade-in flex max-w-full shrink-0 flex-col overflow-y-auto p-3.5 shadow-xl"
      style={{
        width: word ? '22rem' : '30rem',
        maxHeight: stacked ? 'calc(50dvh - 16px)' : 'calc(100dvh - 16px)',
        boxShadow: 'var(--ff-shadow)',
        // 单词卡用一层极淡的强调色垫底：只是把「这是查出来的词卡」从白色面板里区分出来，
        // 不抢正文的注意力，所以取最淡的 accent-soft 而不是 accent-fill。
        background: word ? 'var(--ff-accent-soft)' : undefined,
        borderColor: word ? 'var(--ff-vocab-mark-hover)' : undefined,
      }}
    >
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-[10.5px]" style={{ color: 'var(--ff-faint)' }}>
            {word ? '英语查词' : 'AI 句子讲解'}
          </p>
          {word ? <h2 className="break-words text-[17px] font-semibold leading-snug">{card.term}</h2> : null}
          {word && dictionary?.status === 'found' && dictionary.entry.phonetic ? (
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--ff-muted)' }}>
              {dictionary.entry.phonetic}
            </p>
          ) : null}
          {word && dictionary?.status === 'found' ? (
            <p className="mt-1 text-[10px]" style={{ color: 'var(--ff-faint)' }}>
              {dictionary.dictionaryId}
            </p>
          ) : null}
        </div>
        <button
          className="ff-btn ff-btn-ghost shrink-0 !p-1"
          aria-label="关闭学习卡片"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>

      {word ? (
        <div className="space-y-2.5">
          {dictionary?.status === 'found' ? (
            dictionary.entry.contentType === 'html' ? (
              // 服务端已经做过白名单清洗（去脚本、去外部样式、图片改写成词典资源接口），
              // 这里只需要控制排版，不再二次处理内容。
              <div
                className="ff-dict-html text-[12.5px] leading-relaxed"
                dangerouslySetInnerHTML={{ __html: dictionary.entry.meanings[0] ?? '' }}
              />
            ) : (
              <ul className="space-y-1 text-[12.5px] leading-relaxed">
                {dictionary.entry.meanings.map((meaning, index) => <li key={index}>{meaning}</li>)}
              </ul>
            )
          ) : dictionary?.status === 'error' ? (
            <p className="text-[12px]" style={{ color: 'var(--ff-muted)' }}>
              {DICTIONARY_ERROR_MESSAGE}
            </p>
          ) : null}
          {fallbackExplanation && card.explanation ? (
            <div className="rounded-lg border p-2.5" style={{ background: 'var(--ff-surface)' }}>
              <p className="mb-1 text-[10.5px] font-medium" style={{ color: 'var(--ff-muted)' }}>
                AI 解释
              </p>
              <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
                {card.explanation}
              </p>
            </div>
          ) : null}
          {lookupFailed ? (
            card.saved ? (
              <p className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--ff-accent-text)' }}>
                <Check size={12} />已加入生词本：{card.term}
              </p>
            ) : (
              <CustomVocabularyForm
                term={card.term}
                saving={card.saving}
                onSave={onSaveCustom}
              />
            )
          ) : null}
          {card.detailText ? (
            <div className="rounded-lg border p-2.5" style={{ background: 'var(--ff-surface)' }}>
              <p className="mb-1 text-[10.5px] font-medium" style={{ color: 'var(--ff-muted)' }}>
                AI 详细解释
              </p>
              <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">{card.detailText}</p>
            </div>
          ) : null}
          {card.detailError ? (
            <p role="alert" className="text-[12px]" style={{ color: 'var(--ff-danger)' }}>{card.detailError}</p>
          ) : null}
          <details className="text-[10.5px]" style={{ color: 'var(--ff-muted)' }}>
            <summary className="cursor-pointer">查看原句</summary>
            <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{card.selection.sentences.join('\n')}</p>
          </details>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="space-y-1.5 rounded-lg p-2.5 text-[12px] leading-relaxed" style={{ background: 'var(--ff-surface-2)' }}>
            {card.selection.sentences.map((sentence, index) => <p key={index}>{sentence}</p>)}
          </div>
          {card.explanation ? (
            <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">{card.explanation}</p>
          ) : null}
        </div>
      )}

      {card.loading ? (
        <div role="status" className="mt-2.5 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--ff-muted)' }}>
          <Loader2 size={13} className="animate-spin" />
          {word ? (fallbackExplanation ? '正在生成 AI 解释…' : '正在查词…') : '正在生成讲解…'}
        </div>
      ) : null}
      {card.detailLoading ? (
        <div role="status" className="mt-2.5 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--ff-muted)' }}>
          <Loader2 size={13} className="animate-spin" />正在生成详细解释…
        </div>
      ) : null}
      {card.error ? (
        <p role="alert" className="mt-2.5 text-[12px]" style={{ color: 'var(--ff-danger)' }}>{card.error}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {word && dictionary?.status === 'found' ? (
          <>
            <button
              className="ff-btn !py-1 text-[11px]"
              onClick={onSave}
              disabled={card.saving || card.saved || card.loading || card.invalidSelection}
            >
              {card.saving ? <Loader2 size={12} className="animate-spin" /> : card.saved ? <Check size={12} /> : <BookPlus size={12} />}
              {card.saved ? '已加入生词本' : card.saving ? '正在保存…' : '加入生词本'}
            </button>
            <button
              className="ff-btn ff-btn-ghost !p-1"
              title="详细解释"
              aria-label="详细解释"
              onClick={onExplainDetail}
              disabled={card.detailLoading || card.loading || card.saving || card.invalidSelection}
            >
              {card.detailLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            </button>
          </>
        ) : null}
        {showSettings ? (
          onOpenSettings ? (
            <button className="ff-btn ff-btn-primary !py-1 text-[11px]" onClick={() => { onClose(); onOpenSettings(); }}>
              打开设置
            </button>
          ) : null
        ) : (
          <>
            {showSentenceRetry || showDictionaryRetry || showFallbackRetry ? (
              <button className="ff-btn !py-1 text-[11px]" onClick={onRetry} disabled={card.loading || card.saving}>
                <RotateCcw size={12} />重试
              </button>
            ) : null}
            {showDetailRetry ? (
              <button className="ff-btn !py-1 text-[11px]" onClick={onRetryDetail} disabled={card.detailLoading || card.loading || card.saving}>
                <RotateCcw size={12} />重试详细解释
              </button>
            ) : null}
            {showSentenceRegen || showFallbackRegen ? (
              <button className="ff-btn ff-btn-ghost !py-1 text-[11px]" onClick={onRetry} disabled={card.loading || card.saving}>
                <RotateCcw size={12} />重新生成
              </button>
            ) : null}
            {showDetailRegen ? (
              <button className="ff-btn ff-btn-ghost !py-1 text-[11px]" onClick={onRetryDetail} disabled={card.detailLoading || card.loading || card.saving}>
                <RotateCcw size={12} />重新生成解释
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 词典查询失败时才出现的自定义生词表单。
 * 词条默认带上刚选中的表达，用户可以改成同义表达或词组，再写自己的释义。
 */
function CustomVocabularyForm({
  term,
  saving,
  onSave,
}: {
  term: string;
  saving: boolean;
  onSave: (term: string, definition: string) => void;
}) {
  const [termDraft, setTermDraft] = useState(term);
  const [definition, setDefinition] = useState('');

  useEffect(() => {
    setTermDraft(term);
  }, [term]);

  const submit = () => {
    if (!termDraft.trim() || saving) return;
    onSave(termDraft.trim(), definition);
  };

  // 卡片本体是淡强调色底，表单用纯 surface 才能看出层次。
  return (
    <div className="space-y-2 rounded-lg border p-2.5" style={{ background: 'var(--ff-surface)' }}>
      <p className="text-[10.5px] font-medium" style={{ color: 'var(--ff-muted)' }}>
        自定义生词
      </p>
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ff-faint)' }}>
        词典没有收录这个表达，可以自己写释义后加入生词本。
      </p>
      <input
        className="ff-input !py-1 !text-[12px]"
        value={termDraft}
        maxLength={120}
        placeholder="单词或词组"
        aria-label="自定义生词词条"
        onChange={(event) => setTermDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <textarea
        className="ff-input min-h-16 !py-1 !text-[11.5px]"
        value={definition}
        maxLength={4000}
        placeholder="自定义释义（可选）"
        aria-label="自定义释义"
        onChange={(event) => setDefinition(event.target.value)}
      />
      <div className="flex justify-end">
        <button
          className="ff-btn !px-2 !py-1 text-[11px]"
          onClick={submit}
          disabled={saving || !termDraft.trim()}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <BookPlus size={12} />}
          {saving ? '正在保存…' : '加入生词本'}
        </button>
      </div>
    </div>
  );
}
