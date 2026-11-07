import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import * as api from '../api/endpoints';
import type { DictionarySummary } from '../api/types';
import { EmptyState, Spinner, Toggle } from './ui';
import { useAppStore } from '../store/app';

/** 用户下载到的词典就是这些扩展名，多选时一次框住整本词典的全部文件。 */
const ACCEPT = '.mdx,.mdd,.ifo,.idx,.idx.gz,.dict,.dict.dz,.syn';

function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatLabel(format: DictionarySummary['format']): string {
  if (format === 'mdx') return 'MDict';
  if (format === 'stardict') return 'StarDict';
  return '词表';
}

/**
 * 设置中心 → 词典。
 *
 * 三本内置词典（中英核心词库 / WordNet / 词组词典）与用户导入的词典一样可以单独停用，
 * 停用即从查词链路里摘掉；内置词典不能删除，因为它们随应用分发、删了也回不来。
 * 停用状态存在设置里（`dictionaries.disabledIds`），不走 dictionaries 表。
 */
export function DictionaryPanel({ onToast }: { onToast: (message: string, tone: 'success' | 'error' | 'info') => void }) {
  const [dictionaries, setDictionaries] = useState<DictionarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const askConfirm = useAppStore((state) => state.askConfirm);

  const load = useCallback(async () => {
    try {
      setDictionaries(await api.fetchDictionaries());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '词典列表读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleImport = async (files: File[]) => {
    if (files.length === 0) return;
    setImporting(true);
    setProgress({ index: 0, total: files.length, percent: 0 });
    try {
      const imported = await api.importDictionaryFiles(files, (index, loaded, total) => {
        setProgress({ index, total: files.length, percent: total > 0 ? Math.round((loaded / total) * 100) : 0 });
      });
      const summary = imported.map((item) => `${item.name}（${item.entryCount.toLocaleString()} 条）`).join('、');
      onToast(`已导入：${summary}`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      setImporting(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const handleToggle = async (dictionary: DictionarySummary, enabled: boolean) => {
    setBusyId(dictionary.id);
    try {
      const updated = await api.setDictionaryEnabled(dictionary.id, enabled);
      setDictionaries((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
    } catch (err) {
      onToast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (dictionary: DictionarySummary) => {
    const confirmed = await askConfirm({
      title: '删除词典',
      message: `删除「${dictionary.name}」？原文件副本也会一起删掉，之后需要重新导入。`,
      confirmLabel: '删除',
    });
    if (!confirmed) return;
    setBusyId(dictionary.id);
    try {
      await api.deleteDictionary(dictionary.id);
      setDictionaries((list) => list.filter((item) => item.id !== dictionary.id));
      onToast('已删除词典', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-medium">词典</div>
        <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
          内置三本词库装好即用，可以单独开关：同时开启时中文释义在前、英英释义在后。
          这里也可以导入 MDict（.mdx + .mdd）和 StarDict（.ifo + .idx + .dict）词典，
          导入的文件会复制到应用数据目录，原下载文件删掉也不影响查词。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button className="ff-btn" onClick={() => fileInput.current?.click()} disabled={importing}>
          {importing ? <Spinner /> : <Upload size={12} />} 导入词典文件
        </button>
        {progress ? (
          <span className="text-[11px]" style={{ color: 'var(--ff-muted)' }}>
            上传 {progress.index + 1}/{progress.total} · {progress.percent}%
          </span>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) void handleImport(files);
          }}
        />
      </div>

      {error ? (
        <p role="alert" className="text-[12px]" style={{ color: 'var(--ff-danger)' }}>
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : dictionaries.length === 0 ? (
        <EmptyState title="还没有词典" description="导入一本 .mdx 或 StarDict 词典，查词会优先使用它。" />
      ) : (
        <ul className="space-y-1.5">
          {dictionaries.map((dictionary) => (
            <li
              key={dictionary.id}
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--ff-border)', background: 'var(--ff-surface-2)' }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{dictionary.name}</span>
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: 'var(--ff-surface)', color: 'var(--ff-muted)' }}
                    >
                      {formatLabel(dictionary.format)}
                    </span>
                    {dictionary.builtin ? (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                        style={{ background: 'var(--ff-surface)', color: 'var(--ff-accent)' }}
                      >
                        内置
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--ff-muted)' }}>
                    {dictionary.entryCount.toLocaleString()} 条
                    {dictionary.sizeBytes ? ` · ${formatSize(dictionary.sizeBytes)}` : ''}
                    {dictionary.storage === 'file' ? ' · 释义按需读取' : ''}
                  </div>
                  {dictionary.description ? (
                    <div className="mt-0.5 line-clamp-2 text-[10.5px]" style={{ color: 'var(--ff-faint)' }}>
                      {dictionary.description}
                    </div>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="ff-btn ff-btn-ghost !p-1.5"
                    aria-label={`删除 ${dictionary.name}`}
                    disabled={dictionary.builtin || busyId === dictionary.id}
                    onClick={() => void handleDelete(dictionary)}
                    title={dictionary.builtin ? '内置词库随应用分发，不能删除（可以停用）' : '删除词典'}
                  >
                    {busyId === dictionary.id ? <Spinner /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>

              <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--ff-border)' }}>
                <Toggle
                  label="启用"
                  description={dictionary.builtin ? '内置词典，停用后查词会跳过它。' : '停用后查词会跳过这本词典。'}
                  checked={dictionary.enabled}
                  onChange={(value) => void handleToggle(dictionary, value)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
