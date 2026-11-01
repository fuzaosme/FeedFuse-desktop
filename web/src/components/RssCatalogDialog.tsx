import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Plus, Rss, Search } from 'lucide-react';
import { Modal } from './ui';
import { useAppStore } from '../store/app';
import {
  RSS_CATALOG,
  RSS_DIRECTORIES,
  normalizeCatalogFeedUrl,
  type RssCatalogEntry,
} from '../data/rssCatalog';

interface RssCatalogDialogProps {
  open: boolean;
  onClose: () => void;
  /** 已订阅地址：用来把目录里已经加过的来源标成「已添加」。 */
  subscribedUrls: string[];
  /** 选中一个来源：上层负责关掉目录、带着名称与地址打开「添加订阅」。 */
  onSelect: (entry: RssCatalogEntry) => void;
}

/** 一次渲染多少条：目录有 3700+ 条，全量挂到 DOM 会让打开和搜索都变卡。 */
const PAGE_SIZE = 60;

const CATEGORIES = ['全部', ...new Set(RSS_CATALOG.map((entry) => entry.category))];
const LANGUAGES = ['全部语言', '中文', '英文'];

export default function RssCatalogDialog({
  open,
  onClose,
  subscribedUrls,
  onSelect,
}: RssCatalogDialogProps) {
  const openExternal = useAppStore((state) => state.openExternal);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [language, setLanguage] = useState('全部语言');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const subscribed = useMemo(
    () => new Set(subscribedUrls.map(normalizeCatalogFeedUrl)),
    [subscribedUrls],
  );

  const entries = useMemo(() => {
    const keywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return RSS_CATALOG.filter((entry) => {
      const text =
        `${entry.title} ${entry.description} ${entry.category} ${entry.language} ${entry.url}`.toLowerCase();
      return (
        (category === '全部' || entry.category === category) &&
        (language === '全部语言' || entry.language === language) &&
        keywords.every((word) => text.includes(word))
      );
    });
  }, [query, category, language]);

  // 换筛选条件后回到第一屏，否则用户会在「只剩 3 条结果」时还停留在旧的 500 条位置。
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, category, language]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="RSS 目录"
      description="按主题、语言和关键词挑选来源，选中后可确认名称与分类再添加。"
      width="max-w-4xl"
      footer={
        <>
          <span className="mr-auto text-[11px]" style={{ color: 'var(--ff-muted)' }}>
            {entries.length} 个来源
          </span>
          <button className="ff-btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div
        className="sticky -top-4 z-10 -mx-5 -mt-4 mb-3 border-b px-5 pb-3 pt-4"
        style={{ background: 'var(--ff-surface)' }}
      >
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--ff-faint)' }}
            />
            <input
              className="ff-input !pl-8"
              aria-label="搜索 RSS 来源"
              placeholder="搜索名称、主题或网址…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <select
            className="ff-input !w-28 shrink-0"
            aria-label="筛选来源语言"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {LANGUAGES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="来源分类">
          {CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
              className="rounded-full px-2.5 py-0.5 text-[11px] transition-colors"
              style={
                category === item
                  ? { background: 'var(--ff-accent-fill)', color: 'var(--ff-accent-contrast)' }
                  : { background: 'var(--ff-surface-2)', color: 'var(--ff-muted)' }
              }
            >
              {item}
            </button>
          ))}
        </div>

        <p className="mt-1.5 text-[11px]" style={{ color: 'var(--ff-faint)' }} role="status">
          {entries.length} 个来源 · 选择后可确认名称与分类
        </p>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2" aria-label="RSS 来源">
        {entries.slice(0, visible).map((entry) => {
          const alreadyAdded = subscribed.has(normalizeCatalogFeedUrl(entry.url));
          return (
            <li
              key={entry.id}
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
              style={{ background: 'var(--ff-surface-2)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 break-words text-left text-[13px] font-medium hover:underline"
                  title={entry.siteUrl}
                  onClick={() => void openExternal(entry.siteUrl)}
                >
                  {entry.title}
                  <ExternalLink aria-hidden size={10} className="ml-1 inline align-baseline" style={{ color: 'var(--ff-faint)' }} />
                </button>
                <span className="shrink-0 text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                  {entry.language}
                </span>
              </div>
              <p className="flex-1 text-[11px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
                {entry.description}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                  {entry.category}
                </span>
                <button
                  type="button"
                  className="ff-btn !py-1 text-[11px]"
                  disabled={alreadyAdded}
                  aria-label={alreadyAdded ? `已添加 ${entry.title}` : `添加 ${entry.title}`}
                  onClick={() => onSelect(entry)}
                >
                  {alreadyAdded ? <Check size={11} /> : <Plus size={11} />}
                  {alreadyAdded ? '已添加' : '添加'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {entries.length === 0 ? (
        <p className="py-10 text-center text-[13px]" style={{ color: 'var(--ff-muted)' }}>
          没有找到匹配的来源，试试其他关键词或分类。
        </p>
      ) : null}

      {visible < entries.length ? (
        <div className="mt-3 flex justify-center">
          <button className="ff-btn" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
            加载更多（还有 {entries.length - visible} 个）
          </button>
        </div>
      ) : null}

      <section className="mt-5 space-y-2 border-t pt-4">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <Rss size={13} /> 寻找更多 RSS
        </h3>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
          这些公开目录收录了更多来源。找到 RSS 地址后，可通过「添加订阅」粘贴。
        </p>
        <div className="space-y-1.5">
          {RSS_DIRECTORIES.map((directory) => (
            <button
              key={directory.url}
              type="button"
              className="block w-full rounded-lg px-3 py-2 text-left transition-colors hover:brightness-[0.98]"
              style={{ background: 'var(--ff-surface-2)' }}
              onClick={() => void openExternal(directory.url)}
            >
              <span className="text-[12px] font-medium">
                {directory.title}
                <ExternalLink aria-hidden size={10} className="ml-1 inline align-baseline" style={{ color: 'var(--ff-faint)' }} />
              </span>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ff-muted)' }}>
                {directory.description}
              </p>
            </button>
          ))}
        </div>
        <p className="pt-1 text-[10px] leading-relaxed" style={{ color: 'var(--ff-faint)' }}>
          列表整理于 2026-10-15，汇总自公开 RSS 清单，新增地址未经逐一验证。部分网站仅提供摘要，阅读全文可能需要登录或订阅。
        </p>
      </section>
    </Modal>
  );
}
