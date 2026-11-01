export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const diff = Date.now() - time;
  if (diff < 0) return '刚刚';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(iso);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 侧栏与列表共用的视图标题 */
export function viewLabel(
  view: string,
  feeds: Array<{ id: string; title: string }>,
  categories: Array<{ id: string; name: string }> = [],
): string {
  if (view === 'all') return '全部文章';
  if (view === 'unread') return '未读';
  if (view === 'starred') return '星标';
  if (view.startsWith('feed:')) {
    const id = view.slice(5);
    return feeds.find((feed) => feed.id === id)?.title ?? '订阅';
  }
  if (view.startsWith('category:')) {
    // 列表头和「全部标为已读」的确认文案都靠这里点名分类；查不到时才退回泛称。
    const id = view.slice('category:'.length);
    return categories.find((category) => category.id === id)?.name ?? '分类';
  }
  return '文章';
}

export function articleFontSize(size: 'small' | 'medium' | 'large'): string {
  return size === 'small' ? '0.9375rem' : size === 'large' ? '1.125rem' : '1rem';
}

export function articleLineHeight(value: 'compact' | 'normal' | 'relaxed'): string {
  return value === 'compact' ? '1.6' : value === 'relaxed' ? '1.95' : '1.75';
}
