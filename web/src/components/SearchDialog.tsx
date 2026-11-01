import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useAppStore } from '../store/app';
import * as api from '../api/endpoints';
import { Modal, Spinner } from './ui';
import { formatRelative } from '../lib/format';
import type { ArticleListItem } from '../api/types';

export function SearchDialog() {
  const open = useAppStore((state) => state.ui.searchOpen);
  const setUi = useAppStore((state) => state.setUi);
  const selectArticle = useAppStore((state) => state.selectArticle);
  const toast = useAppStore((state) => state.toast);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ArticleListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /** 请求序号：慢的旧请求回来时不能覆盖新查询的结果。 */
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      seqRef.current += 1;
      setQuery('');
      setResults([]);
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    // 输入一变就先作废旧结果：否则在 220ms 防抖窗口内按 Enter，
    // 打开的还是上一次查询里那一篇。
    seqRef.current += 1;
    const seq = seqRef.current;
    setResults([]);
    setActiveIndex(0);
    if (term.length < 2) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .searchArticles(term)
        .then((result) => {
          if (seq !== seqRef.current) return;
          setResults(result.items);
          setActiveIndex(0);
        })
        .catch((err) => {
          if (seq === seqRef.current) toast(err.message, 'error');
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  const header = useMemo(
    () => (loading ? '搜索中…' : query.trim().length >= 2 ? `${results.length} 条结果` : '输入至少 2 个字符'),
    [loading, results.length, query],
  );

  if (!open) return null;

  const close = () => setUi({ searchOpen: false });

  const choose = async (item: ArticleListItem) => {
    close();
    await selectArticle(item.id);
  };

  return (
    <Modal open={open} onClose={close} title="搜索文章" description={header} width="max-w-2xl">
      <div className="flex items-center gap-2 rounded-md border px-2">
        <Search size={14} style={{ color: 'var(--ff-muted)' }} />
        <input
          autoFocus
          className="w-full border-0 bg-transparent py-2 text-[13px] outline-none"
          style={{ color: 'var(--ff-text)' }}
          value={query}
          placeholder="搜索标题或正文…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(results.length - 1, index + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter' && results[activeIndex]) {
              event.preventDefault();
              void choose(results[activeIndex]);
            }
          }}
        />
        {loading ? <Spinner /> : null}
      </div>

      <div className="mt-2 max-h-80 overflow-y-auto">
        {results.length === 0 && query.trim().length >= 2 && !loading ? (
          <p className="py-6 text-center text-[12px]" style={{ color: 'var(--ff-muted)' }}>
            没有匹配的文章
          </p>
        ) : null}

        {results.map((item, index) => (
          <button
            key={item.id}
            className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left"
            style={index === activeIndex ? { background: 'var(--ff-accent-soft)' } : undefined}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => void choose(item)}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">{item.titleZh || item.title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                <span className="truncate">{item.feedTitle}</span>
                <span>·</span>
                <span>{formatRelative(item.publishedAt)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
