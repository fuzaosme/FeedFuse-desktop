import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Download, RotateCcw, Trash2, Upload } from 'lucide-react';
import { applyTheme, useAppStore } from '../store/app';
import * as api from '../api/endpoints';
import { downloadBlob } from '../api/client';
import { Field, Modal, Select, Spinner, Toggle } from './ui';
import { DictionaryPanel } from './DictionaryPanel';
import { formatDateTime } from '../lib/format';
import { THEME_COLOR_OPTIONS } from '../lib/themeColors';
import type { LogsPage, Settings, SystemInfo } from '../api/types';

type Tab = 'general' | 'ai' | 'dictionary' | 'rss' | 'logs' | 'about';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'general', label: '通用' },
  { key: 'ai', label: 'AI' },
  { key: 'dictionary', label: '词典' },
  { key: 'rss', label: '订阅' },
  { key: 'logs', label: '日志' },
  { key: 'about', label: '关于' },
];

export function SettingsModal() {
  const open = useAppStore((state) => state.ui.settingsOpen);
  const setUi = useAppStore((state) => state.setUi);
  const settings = useAppStore((state) => state.settings);
  const secrets = useAppStore((state) => state.secrets);
  const prompts = useAppStore((state) => state.prompts);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const resetSettings = useAppStore((state) => state.resetSettings);
  const reapplyFilters = useAppStore((state) => state.reapplyFilters);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const reloadSnapshot = useAppStore((state) => state.reloadSnapshot);
  const toast = useAppStore((state) => state.toast);
  const askConfirm = useAppStore((state) => state.askConfirm);

  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [aiKey, setAiKey] = useState('');
  const [translationKey, setTranslationKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [importingOpml, setImportingOpml] = useState(false);
  const [exportingOpml, setExportingOpml] = useState(false);
  const opmlInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(useAppStore.getState().settings);
    // 每次重新打开都回到第一个页签，避免停在上次的「日志」等位置。
    setTab('general');
  }, [open]);

  useEffect(() => {
    // 设置是稍后才加载成功时（比如启动重试过），直接把草稿补上，用户不用再点一次重试。
    if (open && !draft && settings) setDraft(settings);
  }, [open, draft, settings]);

  useEffect(() => {
    // 只有真的打开「关于」页才问后端，平时不为一条诊断信息多打一次请求。
    if (!open || tab !== 'about' || systemInfo) return;
    let cancelled = false;
    void api
      .fetchSystemInfo()
      .then((info) => {
        if (!cancelled) setSystemInfo(info);
      })
      .catch(() => {
        // 读不到就显示「未知」，没必要为环境信息弹错误。
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, systemInfo]);

  /**
   * 主题与主题色是唯一两项「所见即所得」的设置：改成预览态立刻生效，
   * 关掉弹窗时再回到已保存的值（保存后两者一致，不会有跳变）。
   * 其它设置（字号、抓取间隔）不走这条路，避免误触后界面乱跳。
   */
  useEffect(() => {
    if (!open || !draft) return;
    applyTheme(draft.general.theme, draft.general.themeColor);
  }, [open, draft?.general.theme, draft?.general.themeColor]);

  useEffect(() => {
    if (open) return;
    const saved = useAppStore.getState().settings;
    if (saved) applyTheme(saved.general.theme, saved.general.themeColor);
  }, [open]);

  if (!open) return null;

  const close = () => setUi({ settingsOpen: false });

  /** settings 读取失败时 draft 一直是 null，以前这里直接返回 null，连入口都点不开。 */
  const reloadDraft = async () => {
    setReloading(true);
    try {
      await loadSettings();
      const next = useAppStore.getState().settings;
      if (next) setDraft(next);
    } finally {
      setReloading(false);
    }
  };

  if (!draft) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="设置"
        description="配置没能从本地服务读取。"
        width="max-w-md"
      >
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
          设置读取失败，暂时无法编辑。请确认本地服务正常后重试。
        </p>
        <div className="mt-3 flex justify-end">
          <button className="ff-btn ff-btn-primary" onClick={() => void reloadDraft()} disabled={reloading}>
            {reloading ? <Spinner /> : <RotateCcw size={12} />} 重试
          </button>
        </div>
      </Modal>
    );
  }

  const patchGeneral = (patch: Partial<Settings['general']>) =>
    setDraft({ ...draft, general: { ...draft.general, ...patch } });
  const patchAi = (patch: Partial<Settings['ai']>) => setDraft({ ...draft, ai: { ...draft.ai, ...patch } });
  const patchRss = (patch: Partial<Settings['rss']>) => setDraft({ ...draft, rss: { ...draft.rss, ...patch } });
  const patchFilter = (patch: Partial<Settings['rss']['articleFilter']>) =>
    patchRss({ articleFilter: { ...draft.rss.articleFilter, ...patch } });

  const save = async (closeAfter = true): Promise<boolean> => {
    setSaving(true);
    try {
      await saveSettings({
        settings: draft,
        secrets: {
          ...(aiKey ? { aiApiKey: aiKey } : {}),
          ...(translationKey ? { translationApiKey: translationKey } : {}),
        },
      });
      setAiKey('');
      setTranslationKey('');
      if (closeAfter) close();
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleReapply = async () => {
    // 重判用的是后端已保存的规则：先把草稿落库，否则用户刚改完条件点这里会毫无反应。
    const ok = await save(false);
    if (!ok) return;
    setReapplying(true);
    try {
      // 开了 AI 过滤就把它也纳入重判，不然改完提示词看不到任何变化。
      await reapplyFilters(draft.rss.articleFilter.ai.enabled);
    } finally {
      setReapplying(false);
    }
  };

  /** 订阅清单的导入/导出：从侧栏移到设置后，这里是唯一的入口。 */
  const handleExportOpml = async () => {
    setExportingOpml(true);
    try {
      const xml = await api.exportOpml();
      downloadBlob('feedfuse-subscriptions.opml', xml, 'application/xml');
      toast('已导出订阅文件', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '导出失败', 'error');
    } finally {
      setExportingOpml(false);
    }
  };

  const handleImportOpml = async (file: File) => {
    setImportingOpml(true);
    try {
      const xml = await file.text();
      const result = await api.importOpml(xml);
      const summary = `导入 ${result.imported} 个订阅${result.skipped ? `，跳过 ${result.skipped} 个重复` : ''}`;
      toast(summary, result.errors.length > 0 ? 'info' : 'success');
      await reloadSnapshot({ keepArticles: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      setImportingOpml(false);
      if (opmlInput.current) opmlInput.current.value = '';
    }
  };

  const handleReset = async () => {
    const confirmed = await askConfirm({
      title: '恢复默认设置',
      message: '恢复默认设置？除已经填写的 API Key 外，其余配置都会回到初始值。已抓取的文章和订阅不受影响。',
      confirmLabel: '恢复默认',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await resetSettings();
      // store 里的 settings 已被换成默认值，草稿要一起换，否则界面上还显示旧值。
      const next = useAppStore.getState().settings;
      if (next) setDraft(next);
      setAiKey('');
      setTranslationKey('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="设置"
      description="全部配置保存在本机 SQLite 中，不上传任何服务器。"
      width="max-w-3xl"
      footer={
        <>
          <button className="ff-btn" onClick={close}>
            取消
          </button>
          <button className="ff-btn ff-btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner /> : null} 保存设置
          </button>
        </>
      }
    >
      <div className="mb-3 flex gap-1">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={clsx('ff-btn !text-[12px]')}
            style={
              tab === item.key
                ? { background: 'var(--ff-accent-soft)', color: 'var(--ff-accent-text)', borderColor: 'var(--ff-accent)' }
                : undefined
            }
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'general' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="主题">
              <Select
                value={draft.general.theme}
                onChange={(value) => patchGeneral({ theme: value })}
                options={[
                  { value: 'auto', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
            </Field>
            <Field label="字号">
              <Select
                value={draft.general.fontSize}
                onChange={(value) => patchGeneral({ fontSize: value })}
                options={[
                  { value: 'small', label: '小' },
                  { value: 'medium', label: '中' },
                  { value: 'large', label: '大' },
                ]}
              />
            </Field>
            <Field label="字体">
              <Select
                value={draft.general.fontFamily}
                onChange={(value) => patchGeneral({ fontFamily: value })}
                options={[
                  { value: 'sans', label: '无衬线（推荐）' },
                  { value: 'serif', label: '衬线' },
                ]}
              />
            </Field>
            <Field label="行高">
              <Select
                value={draft.general.lineHeight}
                onChange={(value) => patchGeneral({ lineHeight: value })}
                options={[
                  { value: 'compact', label: '紧凑' },
                  { value: 'normal', label: '标准' },
                  { value: 'relaxed', label: '宽松' },
                ]}
              />
            </Field>
            <Field label="自动已读延迟">
              <Select
                value={draft.general.autoMarkReadDelayMs}
                onChange={(value) => patchGeneral({ autoMarkReadDelayMs: value })}
                options={[
                  { value: 0, label: '立即' },
                  { value: 2000, label: '2 秒' },
                  { value: 5000, label: '5 秒' },
                ]}
              />
            </Field>
          </div>

          {/* 主题色只换强调色，和上面的「主题（明暗）」互不影响，所以单独一行铺开选。 */}
          <div>
            <span className="ff-label">主题色</span>
            <div className="flex flex-wrap gap-1.5">
              {THEME_COLOR_OPTIONS.map((option) => {
                const active = draft.general.themeColor === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    title={option.description}
                    onClick={() => patchGeneral({ themeColor: option.value })}
                    className="flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[12px] transition-colors"
                    style={
                      active
                        ? {
                            borderColor: 'var(--ff-accent)',
                            background: 'var(--ff-accent-soft)',
                            color: 'var(--ff-accent-text)',
                          }
                        : undefined
                    }
                  >
                    <span
                      className="size-3.5 shrink-0 rounded-full border"
                      style={{ background: option.swatch, borderColor: 'var(--ff-border-strong)' }}
                    />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--ff-faint)' }}>
              只决定强调色：按钮、选中态、链接与正文里的生词标记。深浅仍由上面的「主题」控制。
            </p>
          </div>

          <div className="space-y-1 border-t pt-2">
            <Toggle
              label="打开文章后自动标记已读"
              description="关闭后需要手动点勾选按钮。"
              checked={draft.general.autoMarkReadEnabled}
              onChange={(value) => patchGeneral({ autoMarkReadEnabled: value })}
            />
            <Toggle
              label="「全部文章」默认只看未读"
              description="适合订阅量大、希望聚焦新内容的场景。"
              checked={draft.general.defaultUnreadOnlyInAll}
              onChange={(value) => patchGeneral({ defaultUnreadOnlyInAll: value })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-2">
            <button className="ff-btn" onClick={() => void handleReset()} disabled={saving}>
              <RotateCcw size={12} /> 恢复默认设置
            </button>
            <span className="text-[11px]" style={{ color: 'var(--ff-faint)' }}>
              已填写的 API Key 会保留，不需要重新粘贴。
            </span>
          </div>
        </div>
      ) : null}

      {tab === 'ai' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="API Base URL" hint="需包含版本路径，例如 https://api.openai.com/v1">
              <input
                className="ff-input"
                value={draft.ai.apiBaseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => patchAi({ apiBaseUrl: event.target.value })}
              />
            </Field>
            <Field label="模型名称" hint="例如 gpt-4o-mini / deepseek-chat / qwen-plus">
              <input
                className="ff-input"
                value={draft.ai.model}
                placeholder="gpt-4o-mini"
                onChange={(event) => patchAi({ model: event.target.value })}
              />
            </Field>
          </div>

          <Field
            label="API Key"
            hint={secrets?.hasAiApiKey ? '已保存。留空表示不修改。' : '尚未配置，摘要与翻译都不可用。'}
          >
            <input
              className="ff-input"
              type="password"
              value={aiKey}
              placeholder={secrets?.hasAiApiKey ? '••••••••（已保存）' : 'sk-…'}
              onChange={(event) => setAiKey(event.target.value)}
            />
          </Field>

          <div className="border-t pt-2">
            <Toggle
              label="打开文章时自动生成摘要"
              description="会消耗 token，建议只对重点订阅开启。"
              checked={draft.ai.autoSummarize}
              onChange={(value) => patchAi({ autoSummarize: value })}
            />
            <Toggle
              label="翻译复用同一个 AI 服务"
              description="关闭后可为翻译单独配置地址、模型与 Key。"
              checked={draft.ai.translation.useSharedAi}
              onChange={(value) =>
                patchAi({ translation: { ...draft.ai.translation, useSharedAi: value } })
              }
            />
            {/* 后端不消费 summaryEnabled / translateEnabled：真正决定「什么时候做」的开关挂在订阅上。 */}
            <p
              className="mt-1 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed"
              style={{ background: 'var(--ff-surface-2)', color: 'var(--ff-muted)' }}
            >
              摘要与翻译在订阅菜单里按源开启：每个订阅可以单独决定「打开即摘要 / 打开即翻译」，
              这里不再提供全局开关。
            </p>
          </div>

          {!draft.ai.translation.useSharedAi ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="翻译 API Base URL">
                <input
                  className="ff-input"
                  value={draft.ai.translation.apiBaseUrl}
                  onChange={(event) =>
                    patchAi({ translation: { ...draft.ai.translation, apiBaseUrl: event.target.value } })
                  }
                />
              </Field>
              <Field label="翻译模型">
                <input
                  className="ff-input"
                  value={draft.ai.translation.model}
                  onChange={(event) =>
                    patchAi({ translation: { ...draft.ai.translation, model: event.target.value } })
                  }
                />
              </Field>
              <Field
                label="翻译 API Key"
                hint={secrets?.hasTranslationApiKey ? '已保存。留空表示不修改。' : '未配置时会回退到上方 AI Key。'}
              >
                <input
                  className="ff-input"
                  type="password"
                  value={translationKey}
                  onChange={(event) => setTranslationKey(event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-[12px] font-medium">自定义提示词（留空使用内置默认）</summary>
            <div className="mt-2 space-y-2">
              <Field label="摘要提示词" hint={`默认：${prompts?.summary?.slice(0, 40)}…`}>
                <textarea
                  className="ff-input min-h-20"
                  value={draft.ai.summaryPrompt}
                  onChange={(event) => patchAi({ summaryPrompt: event.target.value })}
                />
              </Field>
              <Field label="翻译提示词">
                <textarea
                  className="ff-input min-h-20"
                  value={draft.ai.translationPrompt}
                  onChange={(event) => patchAi({ translationPrompt: event.target.value })}
                />
              </Field>
              <Field label="英语精读提示词">
                <textarea
                  className="ff-input min-h-20"
                  value={draft.ai.englishLearningPrompt}
                  onChange={(event) => patchAi({ englishLearningPrompt: event.target.value })}
                />
              </Field>
            </div>
          </details>
        </div>
      ) : null}

      {tab === 'dictionary' ? <DictionaryPanel onToast={toast} /> : null}

      {tab === 'rss' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="刷新间隔" hint="保存后会同步到所有订阅。">
              <Select
                value={draft.rss.fetchIntervalMinutes}
                onChange={(value) => patchRss({ fetchIntervalMinutes: value })}
                options={[5, 15, 30, 60, 120].map((value) => ({ value, label: `${value} 分钟` }))}
              />
            </Field>
            <Field label="每个订阅最多保留" hint="超出后自动删除最旧的文章。">
              <Select
                value={draft.rss.maxStoredArticlesPerFeed}
                onChange={(value) => patchRss({ maxStoredArticlesPerFeed: value })}
                options={[100, 200, 500, 1000, 2000].map((value) => ({ value, label: `${value} 篇` }))}
              />
            </Field>
          </div>

          <div className="border-t pt-2">
            <div className="text-[13px] font-medium">订阅清单（OPML）</div>
            <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
              从旧版 FeedFuse 或其他阅读器迁移订阅：导出会得到完整的 OPML 文件，导入会自动创建缺失的分类。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="ff-btn"
                onClick={() => opmlInput.current?.click()}
                disabled={importingOpml}
              >
                {importingOpml ? <Spinner /> : <Upload size={12} />} 导入 OPML
              </button>
              <button
                className="ff-btn"
                onClick={() => void handleExportOpml()}
                disabled={exportingOpml}
              >
                {exportingOpml ? <Spinner /> : <Download size={12} />} 导出 OPML
              </button>
            </div>
            <input
              ref={opmlInput}
              type="file"
              accept=".opml,.xml,text/xml,application/xml"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImportOpml(file);
              }}
            />
          </div>

          <div className="border-t pt-2">
            <Toggle
              label="关键词过滤"
              description="标题或正文命中关键词的文章会被标记为已过滤，默认不在列表显示。"
              checked={draft.rss.articleFilter.keyword.enabled}
              onChange={(value) =>
                patchFilter({ keyword: { ...draft.rss.articleFilter.keyword, enabled: value } })
              }
            />
            <Field label="关键词（每行一个）">
              <textarea
                className="ff-input min-h-24"
                value={draft.rss.articleFilter.keyword.keywords.join('\n')}
                onChange={(event) =>
                  patchFilter({
                    keyword: {
                      ...draft.rss.articleFilter.keyword,
                      keywords: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean),
                    },
                  })
                }
              />
            </Field>
          </div>

          <div className="border-t pt-2">
            <Toggle
              label="AI 语义过滤"
              description="把标题与摘要交给 AI 判断是否值得保留，判为无价值就标记为已过滤。会消耗 token。"
              checked={draft.rss.articleFilter.ai.enabled}
              onChange={(value) =>
                patchFilter({ ai: { ...draft.rss.articleFilter.ai, enabled: value } })
              }
            />
            <Field
              label="过滤提示词"
              hint="留空使用内置规则。写清「什么算不值得保留」，比泛泛地说「过滤垃圾内容」有效得多。"
            >
              <textarea
                className="ff-input min-h-20"
                value={draft.rss.articleFilter.ai.prompt}
                placeholder="例如：过滤掉纯融资公告、产品促销、招聘启事；保留有实质信息增量的技术分析。"
                onChange={(event) =>
                  patchFilter({ ai: { ...draft.rss.articleFilter.ai, prompt: event.target.value } })
                }
              />
            </Field>
          </div>

          <div className="border-t pt-2">
            <Toggle
              label="跨订阅查重"
              description="同一篇转载常被多个源同时推送，只保留最早入库的那一篇。"
              checked={draft.rss.articleFilter.duplicate.enabled}
              onChange={(value) =>
                patchFilter({ duplicate: { ...draft.rss.articleFilter.duplicate, enabled: value } })
              }
            />
            <Field
              label={`相似度阈值 ${Math.round(draft.rss.articleFilter.duplicate.similarity * 100)}%`}
              hint="数值越高越严格：0.9 以上只会过滤几乎逐字相同的转载；调到 0.6 则同一事件的不同报道也可能被判为重复。"
            >
              <input
                type="range"
                min={0.6}
                max={0.98}
                step={0.01}
                value={draft.rss.articleFilter.duplicate.similarity}
                onChange={(event) =>
                  patchFilter({
                    duplicate: {
                      ...draft.rss.articleFilter.duplicate,
                      similarity: Number(event.target.value),
                    },
                  })
                }
                className="w-full"
                style={{ accentColor: 'var(--ff-accent)' }}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-2">
            <button className="ff-btn" onClick={() => void handleReapply()} disabled={saving || reapplying}>
              {reapplying ? <Spinner /> : <RotateCcw size={12} />} 立即重判历史文章
            </button>
            <span className="text-[11px]" style={{ color: 'var(--ff-faint)' }}>
              修改过滤规则后会自动重判，这里可以手动触发。
            </span>
          </div>

          <div className="border-t pt-2">
            <Toggle
              label="记录运行日志"
              checked={draft.logging.enabled}
              onChange={(value) => setDraft({ ...draft, logging: { ...draft.logging, enabled: value } })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="保留天数">
                <Select
                  value={draft.logging.retentionDays}
                  onChange={(value) => setDraft({ ...draft, logging: { ...draft.logging, retentionDays: value } })}
                  options={[1, 3, 7, 14, 30, 90].map((value) => ({ value, label: `${value} 天` }))}
                />
              </Field>
              <Field label="最低级别">
                <Select
                  value={draft.logging.minLevel}
                  onChange={(value) => setDraft({ ...draft, logging: { ...draft.logging, minLevel: value } })}
                  options={[
                    { value: 'info', label: '全部' },
                    { value: 'warning', label: '警告及以上' },
                    { value: 'error', label: '仅错误' },
                  ]}
                />
              </Field>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'logs' ? <LogsPanel /> : null}

      {tab === 'about' ? (
        <div className="space-y-2 text-[12px] leading-relaxed" style={{ color: 'var(--ff-muted)' }}>
          <p className="text-[13px] font-medium" style={{ color: 'var(--ff-text)' }}>
            {/* 版本号只从运行时注入的值取：写死在页面里发版时必然忘记改。 */}
            FeedFuse 桌面版 {window.__FEEDFUSE__?.version ?? '未知版本'}
          </p>
          <p>
            架构：Tauri 外壳 + Node sidecar（本地 127.0.0.1 随机端口）+ SQLite。数据完全留在本机，
            不依赖 Docker、Postgres 或任何登录账号。
          </p>

          <dl
            className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 rounded-md border p-2 text-[11px]"
            style={{ background: 'var(--ff-surface-2)' }}
          >
            <dt style={{ color: 'var(--ff-faint)' }}>平台</dt>
            <dd className="break-all">
              {systemInfo ? `${systemInfo.platform} / ${systemInfo.arch}` : '读取中…'}
            </dd>
            <dt style={{ color: 'var(--ff-faint)' }}>Node</dt>
            <dd className="break-all">{systemInfo?.node ?? '读取中…'}</dd>
            <dt style={{ color: 'var(--ff-faint)' }}>数据目录</dt>
            <dd className="break-all">{systemInfo?.dataDir ?? '读取中…'}</dd>
          </dl>

          <p>
            删掉数据目录里的 <code>feedfuse.db</code> 即可重置应用。报障时把上面的环境信息一起贴出来，
            能省掉一轮来回。
          </p>
          <p>快捷键：j / n 下一篇，k / p 上一篇，m 已读，s 星标，/ 搜索，? 查看全部。</p>
        </div>
      ) : null}
    </Modal>
  );
}

function LogsPanel() {
  const [logs, setLogs] = useState<LogsPage | null>(null);
  const [level, setLevel] = useState('all');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const toast = useAppStore((state) => state.toast);

  useEffect(() => {
    setLoading(true);
    api
      .fetchLogs(page, level)
      .then(setLogs)
      .catch((err) => toast(err.message, 'error'))
      .finally(() => setLoading(false));
  }, [page, level]);

  // 接口没有 category 参数，所以下拉的候选值只能取「当前这一页出现过的分类」，
  // 筛选也只是在前端对当前页生效——这一点在下面的提示里写明，免得用户以为筛的是全库。
  const categories = useMemo(
    () => Array.from(new Set((logs?.items ?? []).map((item) => item.category))).filter(Boolean).sort(),
    [logs],
  );
  // 翻页后旧分类可能不再出现，此时自动退回「全部」，避免看到一张空表。
  const activeCategory = categories.includes(category) ? category : 'all';
  const items = (logs?.items ?? []).filter(
    (item) => activeCategory === 'all' || item.category === activeCategory,
  );

  /** 清空日志：失败必须说出来，否则用户以为已经清干净了。 */
  const clear = async () => {
    setClearing(true);
    try {
      await api.clearLogs();
      // 清完只剩第 1 页，停在原来的页码上会看到一张空表。
      setPage(1);
      setLogs(await api.fetchLogs(1, level));
      toast('日志已清空', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '清空日志失败', 'error');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Select
          value={level}
          onChange={(value) => {
            setLevel(value);
            setPage(1);
          }}
          options={[
            { value: 'all', label: '全部级别' },
            { value: 'error', label: '错误' },
            { value: 'warning', label: '警告' },
            { value: 'info', label: '信息' },
          ]}
        />
        {categories.length > 0 ? (
          <Select
            value={activeCategory}
            onChange={setCategory}
            options={[
              { value: 'all', label: '全部分类' },
              ...categories.map((name) => ({ value: name, label: name })),
            ]}
          />
        ) : null}
        <span className="flex-1" />
        <button className="ff-btn" onClick={() => void clear()} disabled={clearing}>
          {clearing ? <Spinner /> : <Trash2 size={12} />} 清空
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto rounded-md border">
        {loading && !logs ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : items.length > 0 ? (
          <table className="w-full text-[11px]">
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b align-top last:border-b-0">
                  <td className="whitespace-nowrap px-2 py-1.5" style={{ color: 'var(--ff-faint)' }}>
                    {formatDateTime(item.createdAt)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className="ff-chip"
                      style={
                        item.level === 'error'
                          ? { color: 'var(--ff-danger)', borderColor: 'var(--ff-danger)' }
                          : item.level === 'warning'
                            ? { color: 'var(--ff-warning)', borderColor: 'var(--ff-warning-border)' }
                            : undefined
                      }
                    >
                      {item.level}
                    </span>
                  </td>
                  <td className="px-2 py-1.5" style={{ color: 'var(--ff-muted)' }}>
                    {item.category}
                  </td>
                  <td className="px-2 py-1.5">
                    <div>{item.message}</div>
                    {Object.keys(item.context ?? {}).length > 0 ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[10px]" style={{ color: 'var(--ff-faint)' }}>
                          context
                        </summary>
                        <pre
                          className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded p-1.5 text-[10px] leading-relaxed"
                          style={{ background: 'var(--ff-surface-2)', color: 'var(--ff-muted)' }}
                        >
                          {JSON.stringify(item.context, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                  <td className="max-w-[200px] truncate px-2 py-1.5" style={{ color: 'var(--ff-muted)' }}>
                    {item.details ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="py-6 text-center text-[11px]" style={{ color: 'var(--ff-muted)' }}>
            {logs && logs.items.length > 0 ? '当前筛选条件下没有日志' : '暂无日志'}
          </p>
        )}
      </div>

      {logs ? (
        <div className="mt-2 flex items-center justify-end gap-2 text-[11px]">
          <button className="ff-btn" disabled={!logs.hasPreviousPage} onClick={() => setPage((value) => value - 1)}>
            上一页
          </button>
          <span style={{ color: 'var(--ff-muted)' }}>
            {logs.page} / {Math.max(1, Math.ceil(logs.total / logs.pageSize))}
          </span>
          <button className="ff-btn" disabled={!logs.hasNextPage} onClick={() => setPage((value) => value + 1)}>
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}
