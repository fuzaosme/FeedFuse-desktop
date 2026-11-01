import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { openDb } from '../src/db/sqlite';
import { createFeed } from '../src/domain/feeds';
import { saveSettings, defaultSettings, type PersistedSettings } from '../src/domain/settings';
import { listArticles, setArticleFilter, type ArticleListItem } from '../src/domain/articles';
import { evaluateOnIngest, reapplyArticleFilters } from '../src/services/filters';
import { upsertArticle } from '../src/domain/articles';

/**
 * 过滤链路的端到端断言。
 *
 * 用内存库跑真实 SQL：查重依赖 `id < ?` 与归一化列，只有真库才能验证这些条件。
 */

function withSettings(patch: (settings: PersistedSettings) => void): void {
  const settings = structuredClone(defaultSettings);
  patch(settings);
  saveSettings({ settings });
}

function ingest(feedId: string, input: { title: string; link: string; body: string }): string {
  const evaluation = evaluateOnIngest({
    feedId,
    title: input.title,
    link: input.link,
    summary: null,
    contentHtml: input.body,
    contentFullHtml: null,
  });
  const result = upsertArticle({
    feedId,
    dedupeKey: input.link,
    title: input.title,
    link: input.link,
    author: null,
    publishedAt: new Date().toISOString(),
    contentHtml: input.body,
    summary: null,
    previewImage: null,
    sourceLanguage: null,
    isFiltered: evaluation.isFiltered,
    filteredBy: evaluation.filteredBy,
    filterReason: evaluation.filterReason,
    filterStatus: evaluation.filterStatus,
    urlNormalized: evaluation.urlNormalized,
    titleNormalized: evaluation.titleNormalized,
    contentFingerprint: evaluation.contentFingerprint,
  });
  return result.id;
}

function visible(view: string): ArticleListItem[] {
  return listArticles({ view, limit: 100 }).items;
}

const LONG_BODY =
  '<p>' +
  'A long article body about local-first software, conflict resolution and sync engines. '.repeat(6) +
  '</p>';

describe('入库过滤', () => {
  let feedA = '';
  let feedB = '';

  before(() => {
    openDb(':memory:');
    withSettings(() => {});
    feedA = createFeed({ url: 'https://a.example.com/feed' }).id;
    feedB = createFeed({ url: 'https://b.example.com/feed' }).id;
  });

  it('关键词命中即标记过滤，并记录原因', () => {
    withSettings((s) => {
      s.rss.articleFilter.keyword = { enabled: true, keywords: ['促销'] };
    });

    const id = ingest(feedA, {
      title: '限时促销：机械键盘五折',
      link: 'https://a.example.com/p/1',
      body: '<p>键盘打折</p>',
    });

    const item = listArticles({ view: `feed:${feedA}`, limit: 100, includeFiltered: true }).items.find(
      (row) => row.id === id,
    );
    assert.ok(item);
    assert.equal(item!.isFiltered, true);
    assert.equal(item!.filterReason, 'keyword');
    assert.equal(item!.filterStatus, 'filtered');
  });

  it('改回规则后，被关键词误杀的文章会恢复（回溯重判的两个方向都要通）', () => {
    withSettings((s) => {
      s.rss.articleFilter.keyword = { enabled: false, keywords: [] };
    });
    reapplyArticleFilters();
    assert.equal(visible(`feed:${feedA}`).length, 1);

    withSettings((s) => {
      s.rss.articleFilter.keyword = { enabled: true, keywords: ['促销'] };
    });
    reapplyArticleFilters();
    assert.equal(visible(`feed:${feedA}`).length, 0);
  });

  it('归一化 URL 相同（忽略 utm）判为重复，只留最早那条', () => {
    withSettings((s) => {
      s.rss.articleFilter.keyword = { enabled: false, keywords: [] };
    });
    // 第一份已经在上面入库过；这里换一个带 utm 的写法，模拟镜像站点。
    const dupId = ingest(feedB, {
      title: '限时促销：机械键盘五折',
      link: 'https://a.example.com/p/1?utm_source=mirror',
      body: '<p>键盘打折</p>',
    });

    const item = listArticles({ view: `feed:${feedB}`, limit: 100, includeFiltered: true }).items.find(
      (row) => row.id === dupId,
    );
    assert.equal(item!.filterReason, 'duplicate_url');
  });

  it('太短的标题不参与查重：避免「周报」这类栏目名互相误杀', () => {
    withSettings((s) => {
      s.rss.articleFilter.duplicate = { enabled: true, similarity: 0.85 };
    });
    // 正文刻意写成两个完全不同的主题，这样唯一可能命中的就是标题，而标题又太短。
    const otherBody =
      '<p>' + 'Today we planted basil on the balcony and wrote down the watering schedule. '.repeat(6) + '</p>';
    ingest(feedA, { title: '周报', link: 'https://a.example.com/p/week-1', body: LONG_BODY });
    ingest(feedB, { title: '周报', link: 'https://b.example.com/p/week-1', body: otherBody });

    const second = listArticles({ view: `feed:${feedB}`, limit: 100, includeFiltered: true }).items.find(
      (row) => row.link === 'https://b.example.com/p/week-1',
    );
    assert.notEqual(second!.filterReason, 'duplicate_title');
    assert.equal(second!.isFiltered, false);
  });

  it('关闭查重后，之前被判重复的文章恢复可见', () => {
    withSettings((s) => {
      s.rss.articleFilter.duplicate = { enabled: false, similarity: 0.85 };
    });
    reapplyArticleFilters();
    assert.ok(visible(`feed:${feedB}`).length >= 2);
  });

  it('includeFiltered 只在单源视图生效：聚合视图不能混进已过滤文章', () => {
    withSettings((s) => {
      s.rss.articleFilter.keyword = { enabled: true, keywords: ['促销'] };
    });
    setArticleFilter(
      listArticles({ view: 'all', limit: 1, includeFiltered: true }).items[0].id,
      { isFiltered: true, reason: 'keyword', status: 'filtered' },
    );

    const allWithFlag = listArticles({ view: 'all', limit: 100, includeFiltered: true }).items;
    assert.equal(
      allWithFlag.some((row) => row.isFiltered),
      false,
      '聚合视图应忽略 includeFiltered',
    );
  });
});
