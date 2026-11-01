import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { openDb } from '../src/db/sqlite';
import { exportOpml, importOpml } from '../src/services/opml';
import { listFeeds } from '../src/domain/feeds';
import { listCategories } from '../src/domain/categories';
import { defaultSettings, normalizeSettings, saveSettings, getSettings } from '../src/domain/settings';

/** 迁移后用户最常做的两件事：导入自己的订阅清单、调设置。这两条链路必须有回归测试。 */

const SAMPLE_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>我的订阅</title></head>
  <body>
    <outline text="科技">
      <outline type="rss" text="少数派" xmlUrl="https://sspai.com/feed"/>
      <outline type="rss" text="阮一峰" xmlUrl="https://www.ruanyifeng.com/blog/atom.xml"/>
    </outline>
    <outline type="rss" text="独立博客" xmlUrl="https://example.com/rss"/>
  </body>
</opml>`;

describe('OPML', () => {
  before(() => {
    openDb(':memory:');
  });

  it('导入会建分类、跳过重复、把裸 feed 留在未分类', () => {
    const first = importOpml(SAMPLE_OPML);
    assert.equal(first.imported, 3);
    assert.equal(first.skipped, 0);
    assert.equal(first.createdCategories, 1);

    const feeds = listFeeds();
    assert.equal(feeds.length, 3);
    assert.equal(feeds.find((feed) => feed.title === '少数派')!.categoryName, '科技');
    assert.equal(feeds.find((feed) => feed.title === '独立博客')!.categoryId, null);

    // 再导一次：全部按 URL 去重跳过，不能产生重复订阅。
    const second = importOpml(SAMPLE_OPML);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 3);
    assert.equal(listFeeds().length, 3);
  });

  it('导出的结果能被自己再导入（往返一致）', () => {
    const xml = exportOpml();
    assert.match(xml, /<opml/);
    assert.match(xml, /sspai\.com\/feed/);
    assert.match(xml, /科技/);

    const roundTrip = importOpml(xml);
    assert.equal(roundTrip.imported, 0);
    assert.equal(roundTrip.skipped, 3);
    assert.equal(listCategories().length, 1);
  });

  it('非 OPML 内容要明确报错，而不是静默导入 0 条', () => {
    assert.throws(() => importOpml('<html></html>'), /OPML/);
  });
});

describe('设置归一化', () => {
  it('非法值与越界值回落到默认，不让坏配置把功能带崩', () => {
    const normalized = normalizeSettings({
      general: { theme: 'neon', fontSize: 'huge', leftPaneWidth: 9999, middlePaneWidth: 1 },
      rss: { fetchIntervalMinutes: 7, maxStoredArticlesPerFeed: 3 },
    });

    assert.equal(normalized.general.theme, defaultSettings.general.theme);
    assert.equal(normalized.general.fontSize, defaultSettings.general.fontSize);
    // 分栏宽度只做夹紧，不重置：用户拖到一半的值应该留在有效范围内。
    assert.equal(normalized.general.leftPaneWidth, 420);
    assert.equal(normalized.general.middlePaneWidth, 280);
    assert.equal(normalized.rss.fetchIntervalMinutes, defaultSettings.rss.fetchIntervalMinutes);
    assert.equal(
      normalized.rss.maxStoredArticlesPerFeed,
      defaultSettings.rss.maxStoredArticlesPerFeed,
    );
  });

  it('主题色只接受五套色板，坏值回落默认且不影响明暗', () => {
    for (const value of ['mono', 'sage', 'lilac', 'rose', 'mist'] as const) {
      const normalized = normalizeSettings({ general: { theme: 'dark', themeColor: value } });
      assert.equal(normalized.general.themeColor, value);
      assert.equal(normalized.general.theme, 'dark');
    }
    // 老库没有这个字段，或前端传了未知颜色：回落到默认色板，而不是把界面弄成无色。
    assert.equal(normalizeSettings({}).general.themeColor, defaultSettings.general.themeColor);
    assert.equal(
      normalizeSettings({ general: { themeColor: 'teal' } }).general.themeColor,
      defaultSettings.general.themeColor,
    );
  });

  it('查重默认开启，相似度被夹在 0.6–0.98', () => {
    assert.equal(defaultSettings.rss.articleFilter.duplicate.enabled, true);

    assert.equal(normalizeSettings({}).rss.articleFilter.duplicate.similarity, 0.85);
    assert.equal(
      normalizeSettings({ rss: { articleFilter: { duplicate: { similarity: 0.1 } } } })
        .rss.articleFilter.duplicate.similarity,
      0.6,
    );
    assert.equal(
      normalizeSettings({ rss: { articleFilter: { duplicate: { similarity: 5 } } } })
        .rss.articleFilter.duplicate.similarity,
      0.98,
    );
  });

  it('关键词去空、去重前的长度上限生效', () => {
    const keywords = Array.from({ length: 250 }, (_, index) => `kw${index}`);
    const normalized = normalizeSettings({
      rss: { articleFilter: { keyword: { enabled: true, keywords: [...keywords, '  ', ' kw0 '] } } },
    });
    assert.equal(normalized.rss.articleFilter.keyword.keywords.length, 200);
    assert.ok(normalized.rss.articleFilter.keyword.keywords.every((word) => word.trim() === word));
  });

  it('保存后读回一致（JSON 往返不丢字段）', () => {
    saveSettings({
      settings: normalizeSettings({
        rss: { articleFilter: { keyword: { enabled: true, keywords: ['广告'] } } },
      }),
    });
    const reloaded = getSettings();
    assert.equal(reloaded.rss.articleFilter.keyword.enabled, true);
    assert.deepEqual(reloaded.rss.articleFilter.keyword.keywords, ['广告']);
  });
});
