import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  ExternalLink,
  Pencil,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import clsx from 'clsx';
import { useAppStore } from '../store/app';
import * as api from '../api/endpoints';
import { EmptyState, Field, Spinner } from './ui';
import { formatDate, formatDateTime, hostOf } from '../lib/format';
import { MAX_VOCABULARY_SENTENCES, coreDefinition } from '../features/learning/vocabulary';
import type { DictionarySummary, VocabularyItem } from '../api/types';

/**
 * 生词本整页视图。
 *
 * 早先它是弹窗：一屏装不下几个词，长释义把弹窗撑得忽高忽低。
 * 现在改成整页表格，一行一个词，五列固定职责，扫一眼就能复习：
 * 单词 → 核心释义 → 添加时的句子（悬停看全部）→ 原文链接 → 添加时间。
 */
export function VocabularyView() {
  const vocabulary = useAppStore((state) => state.vocabulary);
  const loadVocabulary = useAppStore((state) => state.loadVocabulary);
  const removeVocabulary = useAppStore((state) => state.removeVocabulary);
  const openExternal = useAppStore((state) => state.openExternal);
  const updateVocabulary = useAppStore((state) => state.updateVocabulary);
  const toast = useAppStore((state) => state.toast);
  const setUi = useAppStore((state) => state.setUi);

  const [tab, setTab] = useState<'words' | 'dictionaries'>('words');
  const [query, setQuery] = useState('');
  // 已经有数据时不显示加载态，避免每次进页面都闪一下「生词本还是空的」。
  const [busy, setBusy] = useState(vocabulary.length === 0);

  useEffect(() => {
    setBusy(true);
    void loadVocabulary().finally(() => setBusy(false));
  }, [loadVocabulary]);

  // Esc 退出整页视图：这里和 App 的全局快捷键各管一半，谁先跑都能回到阅读。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setUi({ vocabularyOpen: false });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setUi]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return vocabulary;
    return vocabulary.filter((item) =>
      item.term.toLowerCase().includes(keyword) ||
      item.definition.toLowerCase().includes(keyword) ||
      item.sourceTitle.toLowerCase().includes(keyword) ||
      item.sentences.some((sentence) => sentence.text.toLowerCase().includes(keyword)),
    );
  }, [vocabulary, query]);

  const close = () => setUi({ vocabularyOpen: false });

  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--ff-bg)' }}>
      <header
        className="shrink-0 border-b"
        style={{ background: 'var(--ff-surface)', borderColor: 'var(--ff-border)' }}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-8 py-5">
          <button className="ff-btn ff-btn-ghost !p-1.5" onClick={close} title="返回阅读 (Esc)" aria-label="返回阅读">
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[15px] font-semibold">
              生词本
              <span className="ff-chip tabular-nums">{vocabulary.length} 个词条</span>
            </h1>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ff-muted)' }}>
              阅读时再次遇到这些词会用浅色标记，点一下就能看释义；每个词最多留 5 句例句。
            </p>
          </div>

          <span className="min-w-4 flex-1" />

          <div className="flex overflow-hidden rounded-md border text-[11.5px]" style={{ borderColor: 'var(--ff-border)' }}>
            {(
              [
                ['words', '生词'],
                ['dictionaries', '本地词典'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className="px-2.5 py-1.5 transition-colors"
                style={
                  tab === key
                    ? { background: 'var(--ff-accent-fill)', color: 'var(--ff-accent-contrast)' }
                    : { color: 'var(--ff-muted)' }
                }
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'words' ? (
            <label className="relative block w-56">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--ff-faint)' }}
              />
              <input
                className="ff-input !py-1.5 !pl-8 !text-[12px]"
                value={query}
                placeholder="搜索单词、释义或例句…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-5">
          {tab === 'words' ? (
            <VocabularyTable
              items={filtered}
              total={vocabulary.length}
              query={query}
              busy={busy}
              onDelete={(item) => void removeVocabulary(item.id)}
              onSaveDefinition={async (item, definition) => {
                const updated = await updateVocabulary(item.id, { definition });
                if (updated) toast(`已更新「${item.term}」的释义`, 'success');
              }}
              onOpenLink={(url) => void openExternal(url)}
            />
          ) : (
            <DictionaryPanel />
          )}
        </div>
      </div>
    </div>
  );
}

const COLUMNS: Array<{ key: string; label: string; width: string; hint?: string }> = [
  { key: 'term', label: '单词', width: '18%' },
  { key: 'definition', label: '词典释义', width: '26%' },
  { key: 'sentence', label: '添加时出现的句子', width: '30%', hint: '悬停查看全部例句' },
  { key: 'link', label: '原文链接', width: '16%' },
  { key: 'created', label: '添加时间', width: '10%' },
];

function VocabularyTable({
  items,
  total,
  query,
  busy,
  onDelete,
  onSaveDefinition,
  onOpenLink,
}: {
  items: VocabularyItem[];
  total: number;
  query: string;
  busy: boolean;
  onDelete: (item: VocabularyItem) => void;
  onSaveDefinition: (item: VocabularyItem, definition: string) => Promise<void>;
  onOpenLink: (url: string) => void;
}) {
  const [hover, setHover] = useState<{ item: VocabularyItem; rect: DOMRect } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startEdit = (item: VocabularyItem) => {
    cancelHover();
    setHover(null);
    setEditingId(item.id);
    setDraft(item.definition);
  };

  const commitEdit = async (item: VocabularyItem) => {
    if (editingId !== item.id) return;
    setEditingId(null);
    if (draft.trim() === item.definition.trim()) return;
    await onSaveDefinition(item, draft.trim());
  };

  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  useEffect(() => cancelHover, []);

  if (busy && !total) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-[12px]" style={{ color: 'var(--ff-muted)' }}>
        <Spinner /> 正在读取生词本…
      </div>
    );
  }

  if (!total) {
    return (
      <EmptyState
        icon={<BookMarked size={28} />}
        title="生词本还是空的"
        description="在阅读工具栏打开「英语学习」，选中单词查词后点收藏，就会出现在这里。"
      />
    );
  }

  if (!items.length) {
    return (
      <EmptyState
        icon={<Search size={26} />}
        title="没有匹配的词条"
        description={`没有找到包含「${query.trim()}」的单词、释义或例句。`}
      />
    );
  }

  return (
    <>
      <div
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--ff-border)', background: 'var(--ff-surface)' }}
      >
      <table className="w-full table-fixed border-collapse text-[12.5px]">
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
          <col style={{ width: 60 }} />
        </colgroup>
        <thead>
          <tr style={{ background: 'var(--ff-surface-2)' }}>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className="border-b px-3.5 py-2.5 text-left text-[11px] font-medium"
                style={{ borderColor: 'var(--ff-border)', color: 'var(--ff-muted)' }}
                title={column.hint}
              >
                {column.label}
              </th>
            ))}
            <th className="border-b" style={{ borderColor: 'var(--ff-border)' }} aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const sentence = item.sentences[0];
            const host = hostOf(item.sourceUrl) || (item.sourceUrl ? item.sourceUrl : '');
            return (
              <tr
                key={item.id}
                className="group transition-colors hover:bg-[var(--ff-surface-2)]"
                style={{ borderColor: 'var(--ff-border)' }}
              >
                <td className="border-b px-3.5 py-2.5 align-middle" style={{ borderColor: 'var(--ff-border)' }}>
                  <span className="block truncate text-[13px] font-medium" title={item.term}>
                    {item.term}
                  </span>
                </td>
                <td className="border-b px-3.5 py-2.5 align-middle" style={{ borderColor: 'var(--ff-border)' }}>
                  {editingId === item.id ? (
                    <div className="space-y-1">
                      <textarea
                        autoFocus
                        className="ff-input min-h-14 !py-1 !text-[11.5px]"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          // Enter 保存、Shift+Enter 换行：释义常常是多行，两个动作都要留。
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void commitEdit(item);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
                      <div className="flex items-center gap-1">
                        <button
                          className="ff-btn ff-btn-primary !px-2 !py-0.5 !text-[11px]"
                          onClick={() => void commitEdit(item)}
                        >
                          保存
                        </button>
                        <button
                          className="ff-btn ff-btn-ghost !px-2 !py-0.5 !text-[11px]"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : item.definition ? (
                    <span
                      className="block cursor-text truncate"
                      style={{ color: 'var(--ff-muted)' }}
                      title={`${item.definition}\n（双击可修改释义）`}
                      onDoubleClick={() => startEdit(item)}
                    >
                      {coreDefinition(item.definition)}
                    </span>
                  ) : (
                    <button
                      className="text-[11.5px] underline-offset-2 hover:underline"
                      style={{ color: 'var(--ff-faint)' }}
                      onClick={() => startEdit(item)}
                    >
                      补充释义
                    </button>
                  )}
                </td>
                <td
                  data-sentence-cell
                  className="border-b px-3.5 py-2.5 align-middle"
                  style={{ borderColor: 'var(--ff-border)' }}
                  onMouseEnter={(event) => {
                    if (!item.sentences.length) return;
                    // 140ms 延迟：鼠标扫过整张表时不该一路弹卡片。
                    const rect = event.currentTarget.getBoundingClientRect();
                    cancelHover();
                    hoverTimer.current = setTimeout(() => setHover({ item, rect }), 140);
                  }}
                  onMouseLeave={() => {
                    cancelHover();
                    setHover(null);
                  }}
                >
                  {sentence ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ff-muted)' }}>
                        {sentence.text}
                      </span>
                      {item.sentences.length > 1 ? (
                        <span className="ff-chip !px-1.5 shrink-0 tabular-nums">
                          {item.sentences.length}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-[11.5px]" style={{ color: 'var(--ff-faint)' }}>
                      还没有例句
                    </span>
                  )}
                </td>
                <td className="border-b px-3.5 py-2.5 align-middle" style={{ borderColor: 'var(--ff-border)' }}>
                  {item.sourceUrl ? (
                    <button
                      className="flex w-full min-w-0 items-center gap-1 text-left text-[11.5px] hover:underline"
                      style={{ color: 'var(--ff-accent)' }}
                      onClick={() => onOpenLink(item.sourceUrl)}
                      title={item.sourceUrl}
                    >
                      <span className="min-w-0 flex-1 truncate">{host || item.sourceUrl}</span>
                      <ExternalLink size={11} className="shrink-0 opacity-60" />
                    </button>
                  ) : (
                    <span className="block truncate text-[11.5px]" style={{ color: 'var(--ff-faint)' }} title={item.sourceTitle}>
                      {item.sourceTitle || '—'}
                    </span>
                  )}
                </td>
                <td
                  className="border-b px-3 py-2 align-middle text-[11.5px] tabular-nums"
                  style={{ borderColor: 'var(--ff-border)', color: 'var(--ff-faint)' }}
                  title={formatDateTime(item.createdAt)}
                >
                  {formatDate(item.createdAt)}
                </td>
                <td className="border-b px-1.5 py-2.5 text-right align-middle" style={{ borderColor: 'var(--ff-border)' }}>
                  <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      className="ff-btn ff-btn-ghost !p-1"
                      title={`修改「${item.term}」的释义`}
                      aria-label={`修改 ${item.term} 的释义`}
                      onClick={() => startEdit(item)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="ff-btn ff-btn-ghost !p-1"
                      style={{ color: 'var(--ff-danger)' }}
                      title={`删除「${item.term}」`}
                      aria-label={`删除 ${item.term}`}
                      onClick={() => {
                        if (!window.confirm(`从生词本删除「${item.term}」？它的例句也会一并删除。`)) return;
                        cancelHover();
                        setHover(null);
                        onDelete(item);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {hover ? <SentenceHoverCard item={hover.item} rect={hover.rect} /> : null}
    </>
  );
}

const CARD_WIDTH = 420;

/** 例句预览卡：表格里只放一行，全部例句和出处靠悬停展开。 */
function SentenceHoverCard({ item, rect }: { item: VocabularyItem; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const width = Math.min(CARD_WIDTH, window.innerWidth - 24);
    const height = element.getBoundingClientRect().height;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 12
      ? below
      : Math.max(12, rect.top - height - 6);
    setPosition({ left, top });
  }, [rect.left, rect.top, rect.bottom]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[60] rounded-lg border p-3 shadow-xl"
      style={{
        left: position?.left ?? 12,
        top: position?.top ?? 12,
        width: Math.min(CARD_WIDTH, window.innerWidth - 24),
        background: 'var(--ff-surface)',
        borderColor: 'var(--ff-border)',
        boxShadow: 'var(--ff-shadow)',
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="mb-2 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--ff-faint)' }}>
        <BookOpen size={11} />
        例句 {item.sentences.length} / {MAX_VOCABULARY_SENTENCES}
      </div>
      <ul className="space-y-2">
        {item.sentences.map((sentence, index) => (
          <li
            key={`${sentence.addedAt}-${index}`}
            className="border-l-2 pl-2.5 text-[11.5px] leading-relaxed"
            style={{ borderColor: 'var(--ff-vocab-mark-hover)', color: 'var(--ff-muted)' }}
          >
            <p className="whitespace-pre-wrap break-words">{sentence.text}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--ff-faint)' }}>
              <span className="tabular-nums">{formatDateTime(sentence.addedAt)}</span>
              {sentence.articleTitle || sentence.articleUrl ? (
                <span className="min-w-0 truncate">· {sentence.articleTitle || hostOf(sentence.articleUrl)}</span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}

/** 本地词典管理：以前和生词列表挤在一个弹窗里，现在是第二个标签页。 */
function DictionaryPanel() {
  const [dicts, setDicts] = useState<DictionarySummary[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useAppStore((state) => state.toast);

  const reload = async () => {
    try {
      setDicts(await api.fetchDictionaries());
    } catch (err) {
      toast(err instanceof Error ? err.message : '读取词典失败', 'error');
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const importDict = async () => {
    setBusy(true);
    try {
      const result = await api.importDictionary({ name: name || '导入词典', text });
      toast(`已导入 ${result.entryCount} 条词条`, 'success');
      setName('');
      setText('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 删除词典会连带删掉它所有词条，先确认；失败也要说清楚，别让用户以为已经删了。 */
  const removeDict = async (dict: DictionarySummary) => {
    const detail = dict.entryCount > 0 ? `连同其中的 ${dict.entryCount} 条词条` : '';
    if (!window.confirm(`删除词典「${dict.name}」${detail}？此操作不可撤销。`)) return;
    try {
      await api.deleteDictionary(dict.id);
      toast('词典已删除', 'success');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除词典失败', 'error');
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <div className="space-y-2 rounded-xl border p-3.5" style={{ background: 'var(--ff-surface)' }}>
        <Field
          label="导入词典"
          hint="每行一条，格式：单词<TAB>释义。导入后优先于内置核心词库命中；可先粘贴纯文本，本地即可查词，不走网络。"
        >
          <input
            className="ff-input mb-2"
            value={name}
            placeholder="词典名称"
            onChange={(event) => setName(event.target.value)}
          />
          <textarea
            className="ff-input min-h-28 font-mono text-[11px]"
            value={text}
            placeholder={'serendipity\t意外发现珍奇事物的能力\nresilient\t有韧性的'}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <div className="flex justify-end">
          <button className="ff-btn ff-btn-primary" onClick={() => void importDict()} disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : <Upload size={12} />} 导入
          </button>
        </div>
      </div>

      <div className="rounded-xl border" style={{ background: 'var(--ff-surface)' }}>
        {dicts.length === 0 ? (
          <p className="py-10 text-center text-[11.5px]" style={{ color: 'var(--ff-muted)' }}>
            还没有可用词典。
          </p>
        ) : (
          <ul>
            {dicts.map((dict, index) => (
              <li
                key={dict.id}
                className={clsx('flex items-start gap-2 px-3.5 py-2.5 text-[12px]', index > 0 && 'border-t')}
                style={{ borderColor: 'var(--ff-border)' }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{dict.name}</span>
                    {dict.builtin ? <span className="ff-chip !py-0">内置</span> : null}
                  </div>
                  {dict.description ? (
                    <p className="mt-0.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--ff-faint)' }}>
                      {dict.description}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 pt-0.5 text-[10.5px] tabular-nums" style={{ color: 'var(--ff-faint)' }}>
                  {dict.entryCount} 条
                </span>
                {dict.builtin ? null : (
                  <button
                    className="ff-btn ff-btn-ghost !p-1"
                    style={{ color: 'var(--ff-danger)' }}
                    onClick={() => void removeDict(dict)}
                    title="删除词典"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 悬停卡由表格状态驱动，单独抽出来便于以后复用到别的地方。 */
