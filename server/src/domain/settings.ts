import { getDb } from '../db/sqlite';
import { nowIso, isRecord } from '../lib/utils';
import {
  DEFAULT_ENGLISH_LEARNING_PROMPT,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
} from '../services/prompts';

export type Theme = 'light' | 'dark' | 'auto';
/**
 * 主题色（强调色风格）。与浅色/深色是两个独立维度：
 * 前者决定色调，后者决定明暗，任何组合都成立。
 * mono 是无彩色基线：强调色退回黑白，生词标记用米色。
 */
export type ThemeColor = 'mono' | 'sage' | 'lilac' | 'rose' | 'mist';
export type FontSize = 'small' | 'medium' | 'large';
export type FontFamily = 'sans' | 'serif';
export type LineHeight = 'compact' | 'normal' | 'relaxed';

export interface GeneralSettings {
  theme: Theme;
  themeColor: ThemeColor;
  fontSize: FontSize;
  fontFamily: FontFamily;
  lineHeight: LineHeight;
  autoMarkReadEnabled: boolean;
  autoMarkReadDelayMs: 0 | 2000 | 5000;
  defaultUnreadOnlyInAll: boolean;
  leftPaneWidth: number;
  middlePaneWidth: number;
}

export interface AiSettings {
  summaryEnabled: boolean;
  translateEnabled: boolean;
  autoSummarize: boolean;
  model: string;
  apiBaseUrl: string;
  summaryPrompt: string;
  translationPrompt: string;
  englishLearningPrompt: string;
  translation: {
    useSharedAi: boolean;
    model: string;
    apiBaseUrl: string;
  };
}

export interface RssSettings {
  fetchIntervalMinutes: 5 | 15 | 30 | 60 | 120;
  maxStoredArticlesPerFeed: 100 | 200 | 500 | 1000 | 2000;
  articleFilter: {
    keyword: { enabled: boolean; keywords: string[] };
    ai: { enabled: boolean; prompt: string };
    /** 重复 / 相似转载过滤：同一篇文章被多个源转载时只留最早那条。 */
    duplicate: { enabled: boolean; similarity: number };
  };
}

export interface LoggingSettings {
  enabled: boolean;
  retentionDays: 1 | 3 | 7 | 14 | 30 | 90;
  minLevel: 'error' | 'warning' | 'info';
}

export interface PersistedSettings {
  general: GeneralSettings;
  ai: AiSettings;
  rss: RssSettings;
  logging: LoggingSettings;
}

export interface SecretStatus {
  hasAiApiKey: boolean;
  hasTranslationApiKey: boolean;
}

export const defaultSettings: PersistedSettings = {
  general: {
    theme: 'auto',
    // 默认苔绿：低饱和灰绿最接近纸质阅读，也比原来的图标绿（青绿）安静。
    themeColor: 'sage',
    fontSize: 'medium',
    fontFamily: 'sans',
    lineHeight: 'normal',
    autoMarkReadEnabled: true,
    autoMarkReadDelayMs: 2000,
    defaultUnreadOnlyInAll: false,
    leftPaneWidth: 248,
    middlePaneWidth: 380,
  },
  ai: {
    summaryEnabled: false,
    translateEnabled: false,
    autoSummarize: false,
    model: '',
    apiBaseUrl: '',
    summaryPrompt: '',
    translationPrompt: '',
    englishLearningPrompt: '',
    translation: { useSharedAi: true, model: '', apiBaseUrl: '' },
  },
  rss: {
    fetchIntervalMinutes: 30,
    maxStoredArticlesPerFeed: 500,
    articleFilter: {
      keyword: { enabled: false, keywords: [] },
      ai: { enabled: false, prompt: '' },
      duplicate: { enabled: true, similarity: 0.85 },
    },
  },
  logging: { enabled: true, retentionDays: 7, minLevel: 'info' },
};

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readStr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumEnum<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'number' && (allowed as readonly number[]).includes(value)
    ? (value as T)
    : fallback;
}

export function normalizeSettings(raw: unknown): PersistedSettings {
  const input = isRecord(raw) ? raw : {};
  const general = isRecord(input.general) ? input.general : {};
  const ai = isRecord(input.ai) ? input.ai : {};
  const translation = isRecord(ai.translation) ? ai.translation : {};
  const rss = isRecord(input.rss) ? input.rss : {};
  const filter = isRecord(rss.articleFilter) ? rss.articleFilter : {};
  const keyword = isRecord(filter.keyword) ? filter.keyword : {};
  const aiFilter = isRecord(filter.ai) ? filter.ai : {};
  const duplicate = isRecord(filter.duplicate) ? filter.duplicate : {};
  const logging = isRecord(input.logging) ? input.logging : {};

  return {
    general: {
      theme: readEnum(general.theme, ['light', 'dark', 'auto'] as const, defaultSettings.general.theme),
      themeColor: readEnum(
        general.themeColor,
        ['mono', 'sage', 'lilac', 'rose', 'mist'] as const,
        defaultSettings.general.themeColor,
      ),
      fontSize: readEnum(
        general.fontSize,
        ['small', 'medium', 'large'] as const,
        defaultSettings.general.fontSize,
      ),
      fontFamily: readEnum(
        general.fontFamily,
        ['sans', 'serif'] as const,
        defaultSettings.general.fontFamily,
      ),
      lineHeight: readEnum(
        general.lineHeight,
        ['compact', 'normal', 'relaxed'] as const,
        defaultSettings.general.lineHeight,
      ),
      autoMarkReadEnabled: readBool(
        general.autoMarkReadEnabled,
        defaultSettings.general.autoMarkReadEnabled,
      ),
      autoMarkReadDelayMs: readNumEnum(
        general.autoMarkReadDelayMs,
        [0, 2000, 5000] as const,
        defaultSettings.general.autoMarkReadDelayMs,
      ),
      defaultUnreadOnlyInAll: readBool(
        general.defaultUnreadOnlyInAll,
        defaultSettings.general.defaultUnreadOnlyInAll,
      ),
      leftPaneWidth: clampPane(general.leftPaneWidth, 200, 420, defaultSettings.general.leftPaneWidth),
      middlePaneWidth: clampPane(
        general.middlePaneWidth,
        280,
        640,
        defaultSettings.general.middlePaneWidth,
      ),
    },
    ai: {
      summaryEnabled: readBool(ai.summaryEnabled, false),
      translateEnabled: readBool(ai.translateEnabled, false),
      autoSummarize: readBool(ai.autoSummarize, false),
      model: readStr(ai.model, '').trim(),
      apiBaseUrl: readStr(ai.apiBaseUrl, '').trim(),
      summaryPrompt: readStr(ai.summaryPrompt, ''),
      translationPrompt: readStr(ai.translationPrompt, ''),
      englishLearningPrompt: readStr(ai.englishLearningPrompt, ''),
      translation: {
        useSharedAi: readBool(translation.useSharedAi, true),
        model: readStr(translation.model, '').trim(),
        apiBaseUrl: readStr(translation.apiBaseUrl, '').trim(),
      },
    },
    rss: {
      fetchIntervalMinutes: readNumEnum(
        rss.fetchIntervalMinutes,
        [5, 15, 30, 60, 120] as const,
        defaultSettings.rss.fetchIntervalMinutes,
      ),
      maxStoredArticlesPerFeed: readNumEnum(
        rss.maxStoredArticlesPerFeed,
        [100, 200, 500, 1000, 2000] as const,
        defaultSettings.rss.maxStoredArticlesPerFeed,
      ),
      articleFilter: {
        keyword: {
          enabled: readBool(keyword.enabled, false),
          keywords: Array.isArray(keyword.keywords)
            ? keyword.keywords
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 200)
            : [],
        },
        ai: {
          enabled: readBool(aiFilter.enabled, false),
          prompt: readStr(aiFilter.prompt, ''),
        },
        duplicate: {
          enabled: readBool(duplicate.enabled, true),
          similarity: clampSimilarity(duplicate.similarity),
        },
      },
    },
    logging: {
      enabled: readBool(logging.enabled, defaultSettings.logging.enabled),
      retentionDays: readNumEnum(
        logging.retentionDays,
        [1, 3, 7, 14, 30, 90] as const,
        defaultSettings.logging.retentionDays,
      ),
      minLevel: readEnum(
        logging.minLevel,
        ['error', 'warning', 'info'] as const,
        defaultSettings.logging.minLevel,
      ),
    },
  };
}

function clampPane(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 相似度阈值：低于 0.6 会把不相关的文章误判为转载，高于 0.98 又几乎不生效，两头都夹住。 */
function clampSimilarity(value: unknown): number {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(num)) return 0.85;
  return Math.min(0.98, Math.max(0.6, Math.round(num * 100) / 100));
}

interface SettingsRow {
  json: string;
  ai_api_key: string | null;
  translation_api_key: string | null;
}

function readRow(): SettingsRow | undefined {
  return getDb().get<SettingsRow>(
    'select json, ai_api_key, translation_api_key from app_settings where id = 1',
  );
}

export function getSettings(): PersistedSettings {
  const row = readRow();
  if (!row) return structuredClone(defaultSettings);
  try {
    return normalizeSettings(JSON.parse(row.json));
  } catch {
    return structuredClone(defaultSettings);
  }
}

export function getSecretStatus(): SecretStatus {
  const row = readRow();
  return {
    hasAiApiKey: Boolean(row?.ai_api_key),
    hasTranslationApiKey: Boolean(row?.translation_api_key),
  };
}

export function getAiApiKey(): string {
  return readRow()?.ai_api_key ?? '';
}

export function getTranslationApiKey(): string {
  const row = readRow();
  const own = row?.translation_api_key ?? '';
  return own || row?.ai_api_key || '';
}

export interface SaveSettingsInput {
  settings: PersistedSettings;
  aiApiKey?: string;
  translationApiKey?: string;
}

export function saveSettings(input: SaveSettingsInput): PersistedSettings {
  const normalized = normalizeSettings(input.settings);
  const db = getDb();
  const current = readRow();
  db.run(
    `insert into app_settings (id, json, ai_api_key, translation_api_key, updated_at)
     values (1, ?, ?, ?, ?)
     on conflict(id) do update set
       json = excluded.json,
       ai_api_key = excluded.ai_api_key,
       translation_api_key = excluded.translation_api_key,
       updated_at = excluded.updated_at`,
    JSON.stringify(normalized),
    input.aiApiKey === undefined ? (current?.ai_api_key ?? null) : input.aiApiKey || null,
    input.translationApiKey === undefined
      ? (current?.translation_api_key ?? null)
      : input.translationApiKey || null,
    nowIso(),
  );
  return normalized;
}

export interface AiRuntimeConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export type AiPurpose = 'summary' | 'translation' | 'english';

/** 解析出可直接调用的 AI 运行时配置；缺失关键项时抛出带 user-facing 文案的错误。 */
export function resolveAiRuntime(purpose: AiPurpose): AiRuntimeConfig {
  const settings = getSettings();
  const ai = settings.ai;

  if (purpose === 'translation' && !ai.translation.useSharedAi) {
    const key = getTranslationApiKey();
    const baseUrl = ai.translation.apiBaseUrl || ai.apiBaseUrl;
    const model = ai.translation.model || ai.model;
    if (!baseUrl || !model) {
      throw new Error('翻译模型尚未配置，请到设置中心填写服务地址与模型名');
    }
    if (!key) {
      throw new Error('翻译服务缺少 API Key，请到设置中心填写');
    }
    return { apiBaseUrl: baseUrl.replace(/\/+$/, ''), apiKey: key, model };
  }

  if (!ai.apiBaseUrl || !ai.model) {
    throw new Error('AI 服务尚未配置，请到设置中心填写服务地址与模型名');
  }
  const apiKey = purpose === 'translation' ? getTranslationApiKey() : getAiApiKey();
  if (!apiKey) {
    throw new Error('AI 服务缺少 API Key，请到设置中心填写');
  }
  return { apiBaseUrl: ai.apiBaseUrl.replace(/\/+$/, ''), apiKey, model: ai.model };
}
