import { Hono } from 'hono';
import { ok } from '../http/envelope';
import {
  defaultSettings,
  getSecretStatus,
  getSettings,
  normalizeSettings,
  saveSettings,
} from '../domain/settings';
import { syncFetchInterval } from '../domain/feeds';
import { clearAiFilteredArticles, pruneAllFeeds } from '../domain/articles';
import { writeLog } from '../domain/logs';
import { readJson } from './feeds';
import { startReapplyFilters } from '../services/filters';
import { DEFAULT_SUMMARY_PROMPT, DEFAULT_TRANSLATION_PROMPT, DEFAULT_ENGLISH_LEARNING_PROMPT } from '../services/prompts';

export function settingsRoutes() {
  const app = new Hono();

  const payload = () => ({
    settings: getSettings(),
    secrets: getSecretStatus(),
    prompts: {
      summary: DEFAULT_SUMMARY_PROMPT,
      translation: DEFAULT_TRANSLATION_PROMPT,
      englishLearning: DEFAULT_ENGLISH_LEARNING_PROMPT,
    },
  });

  app.get('/', (c) => ok(c, payload()));

  app.put('/', async (c) => {
    const body = await readJson(c);
    const previous = getSettings();
    const input = body.settings ?? body;
    const next = normalizeSettings(input);

    if (body.settings === undefined) {
      // 允许只提交部分字段：合并到当前设置上，避免前端漏字段导致配置回退默认值。
      saveSettings({ settings: mergeSettings(previous, body) as typeof next });
    } else {
      const secrets = (body.secrets ?? {}) as Record<string, unknown>;
      saveSettings({
        settings: next,
        aiApiKey: typeof secrets.aiApiKey === 'string' ? secrets.aiApiKey : undefined,
        translationApiKey:
          typeof secrets.translationApiKey === 'string' ? secrets.translationApiKey : undefined,
      });
    }

    const applied = getSettings();

    if (previous.rss.fetchIntervalMinutes !== applied.rss.fetchIntervalMinutes) {
      // 只影响「跟随全局」的订阅，单独设过间隔的源保持原样。
      const synced = syncFetchInterval(
        previous.rss.fetchIntervalMinutes,
        applied.rss.fetchIntervalMinutes,
      );
      writeLog({
        level: 'info',
        category: 'settings',
        message: '同步订阅抓取间隔',
        source: 'routes/settings',
        context: { from: previous.rss.fetchIntervalMinutes, to: applied.rss.fetchIntervalMinutes, synced },
      });
    }

    if (previous.rss.maxStoredArticlesPerFeed !== applied.rss.maxStoredArticlesPerFeed) {
      const pruned = pruneAllFeeds(applied.rss.maxStoredArticlesPerFeed);
      writeLog({
        level: 'info',
        category: 'settings',
        message: '按新的留存上限清理文章',
        source: 'routes/settings',
        context: { pruned, keep: applied.rss.maxStoredArticlesPerFeed },
      });
    }

    // 过滤规则改了就得把旧文章重判一遍：否则用户删掉关键词之后，被它误杀的文章
    // 仍然留在「已过滤」里，看起来像设置没生效。重判走后台，避免保存请求卡住。
    if (filterRulesChanged(previous.rss.articleFilter, applied.rss.articleFilter)) {
      startReapplyFilters();
      writeLog({
        level: 'info',
        category: 'settings',
        message: '过滤规则已变更，开始重判历史文章',
        source: 'routes/settings',
      });
    }

    // 关掉 AI 语义过滤要把被它判掉的文章放回来：那些文章是模型判的，
    // 用户关掉开关之后没有理由继续隐身。
    if (previous.rss.articleFilter.ai.enabled && !applied.rss.articleFilter.ai.enabled) {
      const restored = clearAiFilteredArticles();
      writeLog({
        level: 'info',
        category: 'settings',
        message: '已关闭 AI 语义过滤，恢复被它过滤的文章',
        source: 'routes/settings',
        context: { restored },
      });
    }

    writeLog({
      level: 'info',
      category: 'settings',
      message: '保存设置',
      source: 'routes/settings',
      context: { fetchIntervalMinutes: applied.rss.fetchIntervalMinutes },
    });

    return ok(c, payload());
  });

  app.post('/reset', (c) => {
    saveSettings({ settings: defaultSettings });
    // 恢复默认会把过滤规则一起还原（关键词清空、查重打开），所以也要重判一次。
    startReapplyFilters();
    return ok(c, payload());
  });

  return app;
}

function mergeSettings(previous: ReturnType<typeof getSettings>, patch: Record<string, unknown>) {
  return {
    general: { ...previous.general, ...(patch.general as object | undefined) },
    ai: { ...previous.ai, ...(patch.ai as object | undefined) },
    rss: { ...previous.rss, ...(patch.rss as object | undefined) },
    logging: { ...previous.logging, ...(patch.logging as object | undefined) },
  };
}

/** 只看过滤相关的开关与词表；主题、字号这些改了没必要重判全库。 */
function filterRulesChanged(
  previous: ReturnType<typeof getSettings>['rss']['articleFilter'],
  next: ReturnType<typeof getSettings>['rss']['articleFilter'],
): boolean {
  return (
    previous.keyword.enabled !== next.keyword.enabled ||
    previous.duplicate.enabled !== next.duplicate.enabled ||
    previous.duplicate.similarity !== next.duplicate.similarity ||
    previous.keyword.keywords.join('\n') !== next.keyword.keywords.join('\n') ||
    // AI 提示词改了也值得重判一次：用户改提示词就是为了让判定结果变。
    // （是否真的调用模型由 reapply 的 includeAi 决定，这里只负责触发。）
    previous.ai.enabled !== next.ai.enabled ||
    previous.ai.prompt !== next.ai.prompt
  );
}
