import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Plus, Rss, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../store/app';
import * as api from '../api/endpoints';
import { Field, Modal, Spinner, Toggle } from './ui';
import type { FeedValidation } from '../api/types';

const FETCH_INTERVALS = [5, 15, 30, 60, 120];
/** 全局设置还没加载出来时的兜底值，取后端建源的默认值。 */
const DEFAULT_INTERVAL = 30;

export function AddFeedDialog() {
  const open = useAppStore((state) => state.ui.addFeedOpen);
  const prefill = useAppStore((state) => state.ui.addFeedPrefill);
  const setUi = useAppStore((state) => state.setUi);
  const categories = useAppStore((state) => state.categories);
  const settings = useAppStore((state) => state.settings);
  const reloadSnapshot = useAppStore((state) => state.reloadSnapshot);
  const toast = useAppStore((state) => state.toast);
  const selectView = useAppStore((state) => state.selectView);
  const openExternal = useAppStore((state) => state.openExternal);

  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [validation, setValidation] = useState<FeedValidation | null>(null);
  // 校验结果里的站点信息只在弹窗里做预览：创建接口不透传这两个字段，
  // 兜底由建源后的首次抓取自动补写，所以这里不回传也不会丢数据。
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 「默认跟随全局设置」得真的跟：全局是 60 分钟时，建源不能还塞 30。 */
  const globalInterval = settings?.rss.fetchIntervalMinutes ?? DEFAULT_INTERVAL;
  const [fetchIntervalMinutes, setFetchIntervalMinutes] = useState(globalInterval);
  const [fullTextOnFetchEnabled, setFullTextOnFetchEnabled] = useState(false);
  const [aiSummaryOnOpenEnabled, setAiSummaryOnOpenEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setUrl('');
      setTitle('');
      setCategoryId('');
      setNewCategory('');
      setValidation(null);
      setIconUrl(null);
      setSiteUrl(null);
      setAdvancedOpen(false);
      // 重开时重新取一次全局间隔：用户可能刚在设置里改过。
      setFetchIntervalMinutes(useAppStore.getState().settings?.rss.fetchIntervalMinutes ?? DEFAULT_INTERVAL);
      setFullTextOnFetchEnabled(false);
      setAiSummaryOnOpenEnabled(false);
      setError(null);
    }
  }, [open]);

  // 目录里选中一个来源后，把名称/地址/站点带进来，用户只需确认分类再点添加。
  // 消费完立即清空 prefill：它是「一次性初始值」，留着会让下一次打开弹窗又变回旧来源。
  useEffect(() => {
    if (!open || !prefill) return;
    setUrl(prefill.url);
    setTitle(prefill.title);
    setSiteUrl(prefill.siteUrl);
    setValidation(null);
    setIconUrl(null);
    setError(null);
    setUi({ addFeedPrefill: null });
  }, [open, prefill, setUi]);

  if (!open) return null;

  const close = () => setUi({ addFeedOpen: false });

  const validate = async () => {
    setBusy(true);
    setError(null);
    setValidation(null);
    try {
      const result = await api.validateFeed(url);
      setValidation(result);
      setIconUrl(result.iconUrl);
      setSiteUrl(result.siteUrl);
      if (!title) setTitle(result.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : '订阅地址无法访问');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let targetCategory = categoryId || null;
      if (newCategory.trim()) {
        const created = await api.createCategory(newCategory.trim());
        targetCategory = created.id;
      }

      const result = await api.createFeed({
        url,
        title: title || undefined,
        categoryId: targetCategory,
        // 高级选项里没动过就是全局间隔，显式传过去；否则后端按 30 分钟建源，
        // 界面上写着「跟随全局设置」却和设置页对不上。
        fetchIntervalMinutes,
      });

      // 其余高级选项 createFeed 也能带，但只在用户真的改过时才值得写：
      // 失败不影响订阅本身，用提示语气而不是报错。
      const advanced: Record<string, unknown> = {};
      if (fullTextOnFetchEnabled) advanced.fullTextOnFetchEnabled = true;
      if (aiSummaryOnOpenEnabled) advanced.aiSummaryOnOpenEnabled = true;
      if (Object.keys(advanced).length > 0) {
        try {
          await api.updateFeed(result.feed.id, advanced);
        } catch (err) {
          toast(
            `订阅已添加，但高级选项未生效：${err instanceof Error ? err.message : '未知错误'}`,
            'info',
          );
        }
      }

      if (result.error) {
        // 订阅确实建好了，只是首抓失败，用提示语气，别让用户以为要重来一遍。
        toast(`订阅已添加，但首次抓取失败：${result.error}。可在订阅菜单里重新刷新。`, 'info');
      } else if (result.inserted > 0) {
        toast(`已添加「${result.feed.title}」，抓取到 ${result.inserted} 篇`, 'success');
      } else {
        toast(`已添加「${result.feed.title}」，暂时没有抓到新文章`, 'success');
      }

      await reloadSnapshot();
      await selectView(`feed:${result.feed.id}`);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加订阅"
      description="粘贴 RSS / Atom 地址。支持本地和自建源，不需要登录任何账号。"
      width="max-w-xl"
      footer={
        <>
          <button className="ff-btn" onClick={close}>
            取消
          </button>
          <button className="ff-btn" onClick={() => void validate()} disabled={busy || !url.trim()}>
            {busy ? <Spinner /> : null} 检测
          </button>
          <button className="ff-btn ff-btn-primary" onClick={() => void submit()} disabled={busy || !url.trim()}>
            <Plus size={13} /> 添加
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="订阅地址">
          <input
            className="ff-input"
            value={url}
            autoFocus
            placeholder="https://example.com/feed.xml"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void validate();
            }}
          />
        </Field>

        <div className="-mt-1 flex justify-end">
          <button
            type="button"
            className="ff-btn ff-btn-ghost !py-1 !text-[11px]"
            style={{ color: 'var(--ff-accent-text)' }}
            onClick={() => setUi({ addFeedOpen: false, rssCatalogOpen: true })}
          >
            <Rss size={11} /> 不知道订阅什么？从 RSS 目录挑选
          </button>
        </div>

        {validation ? (
          <div
            className="rounded-md border px-3 py-2 text-[11px]"
            style={{ background: 'var(--ff-surface-2)', color: 'var(--ff-muted)' }}
          >
            <div className="flex items-center gap-2">
              {iconUrl ? (
                <img src={iconUrl} alt="" className="size-4 shrink-0 rounded object-cover" />
              ) : null}
              <span className="min-w-0 flex-1 truncate font-medium" style={{ color: 'var(--ff-text)' }}>
                {validation.title}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1">
              <span>识别到 {validation.itemCount} 篇文章</span>
              {siteUrl ? (
                <>
                  <span>·</span>
                  <button
                    className="inline-flex min-w-0 items-center gap-0.5 truncate hover:underline"
                    style={{ color: 'var(--ff-accent-text)' }}
                    onClick={() => void openExternal(siteUrl)}
                    title={siteUrl}
                  >
                    <span className="truncate">{siteUrl}</span>
                    <ExternalLink size={10} className="shrink-0" />
                  </button>
                </>
              ) : null}
            </div>
            {validation.samples.length > 0 ? (
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {validation.samples.map((sample, index) => (
                  <li key={index} className="truncate">
                    {sample}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <Field label="显示名称" hint="留空时使用源站标题。">
          <input
            className="ff-input"
            value={title}
            placeholder={validation?.title ?? '订阅名称'}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="加入分类">
            <select className="ff-input" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">未分类</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="或新建分类" hint="填写后优先使用新分类。">
            <input
              className="ff-input"
              value={newCategory}
              placeholder="例如：技术、设计"
              onChange={(event) => setNewCategory(event.target.value)}
            />
          </Field>
        </div>

        {/* 高级选项默认收起：绝大多数人只需要一个地址，别让默认流程被次要设置拖长。 */}
        <div className="rounded-md border">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px]"
            onClick={() => setAdvancedOpen((value) => !value)}
            aria-expanded={advancedOpen}
          >
            <SlidersHorizontal size={12} style={{ color: 'var(--ff-muted)' }} />
            <span className="flex-1 text-left">高级选项</span>
            <span className="text-[11px]" style={{ color: 'var(--ff-faint)' }}>
              {advancedOpen ? '' : '默认跟随全局设置'}
            </span>
            <span style={{ color: 'var(--ff-faint)' }}>
              {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          </button>

          {advancedOpen ? (
            <div className="space-y-2 border-t px-3 py-2">
              <Field label="抓取间隔">
                <select
                  className="ff-input"
                  value={String(fetchIntervalMinutes)}
                  onChange={(event) => setFetchIntervalMinutes(Number(event.target.value))}
                >
                  {FETCH_INTERVALS.map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      {minutes} 分钟
                    </option>
                  ))}
                </select>
              </Field>
              <Toggle
                label="入库时抓取全文"
                description="抓到新文章就抓正文，打开时不用再等。"
                checked={fullTextOnFetchEnabled}
                onChange={setFullTextOnFetchEnabled}
              />
              <Toggle
                label="打开时生成摘要"
                description="点开文章时自动调用 AI 生成摘要。"
                checked={aiSummaryOnOpenEnabled}
                onChange={setAiSummaryOnOpenEnabled}
              />
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="text-[11px]" style={{ color: 'var(--ff-danger)' }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
