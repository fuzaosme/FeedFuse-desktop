/**
 * 主题色（强调色风格）。
 *
 * 和「浅色 / 深色」是两个独立选项：这里只决定强调色及其浅色派生（按钮、选中态、
 * 链接、生词标记），底色与正文颜色始终是中性的。
 * `swatch` 只用于设置页的色板展示，真正的颜色在 styles/index.css 里按
 * `[data-accent]` 定义——黑白那一项浅色用米色、深色用 #26282B。
 */
export type ThemeColor = 'mono' | 'sage' | 'lilac' | 'rose' | 'mist';

export interface ThemeColorOption {
  value: ThemeColor;
  label: string;
  description: string;
  /** 设置页色板：纯色，或黑白那种一半米色一半深灰的双拼。 */
  swatch: string;
}

export const THEME_COLOR_OPTIONS: readonly ThemeColorOption[] = [
  {
    value: 'mono',
    label: '黑白',
    description: '无彩色：浅色模式用米色，深色模式用 #26282B，生词标记是米色',
    swatch: 'linear-gradient(135deg, #26282b 0 50%, #f3ecdf 50% 100%)',
  },
  {
    value: 'sage',
    label: '苔绿',
    description: '低饱和灰绿，长时间阅读最不刺眼',
    swatch: '#849b87',
  },
  {
    value: 'lilac',
    label: '雾紫',
    description: '柔和的灰紫，安静不抢正文',
    swatch: '#a095b8',
  },
  {
    value: 'rose',
    label: '藕粉',
    description: '带灰度的暖粉，接近纸与墨',
    swatch: '#bc929d',
  },
  {
    value: 'mist',
    label: '雾蓝',
    description: '克制的灰蓝，保持冷静的阅读节奏',
    swatch: '#8199b1',
  },
];

export const DEFAULT_THEME_COLOR: ThemeColor = 'sage';

export function themeColorLabel(value: ThemeColor): string {
  return THEME_COLOR_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
