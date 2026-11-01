import { JSDOM } from 'jsdom';
import { createCategory, listCategories } from '../domain/categories';
import { createFeed, findFeedByUrl, listFeeds, normalizeFeedUrl } from '../domain/feeds';
import { writeLog } from '../domain/logs';
import { nowIso } from '../lib/utils';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function exportOpml(): string {
  const categories = listCategories();
  const feeds = listFeeds();
  const grouped = new Map<string | null, typeof feeds>();
  for (const feed of feeds) {
    const key = feed.categoryId ?? null;
    const bucket = grouped.get(key) ?? [];
    bucket.push(feed);
    grouped.set(key, bucket);
  }

  const renderFeed = (feed: (typeof feeds)[number]) =>
    `      <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(
      feed.url,
    )}"${feed.siteUrl ? ` htmlUrl="${escapeXml(feed.siteUrl)}"` : ''} />`;

  const body: string[] = [];
  const uncategorized = grouped.get(null) ?? [];
  body.push(...uncategorized.map(renderFeed));

  for (const category of categories) {
    const items = grouped.get(category.id) ?? [];
    body.push(`    <outline text="${escapeXml(category.name)}" title="${escapeXml(category.name)}">`);
    body.push(...items.map(renderFeed));
    body.push('    </outline>');
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>FeedFuse 订阅导出</title>',
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    ...body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

export interface OpmlImportResult {
  imported: number;
  skipped: number;
  createdCategories: number;
  errors: string[];
}

interface OutlineNode {
  text: string;
  xmlUrl: string | null;
  children: OutlineNode[];
}

/**
 * 订阅都挂在 `<opml><body><outline/></body></opml>` 里，所以要从 body 开始找。
 *
 * 早先的实现直接从 `documentElement`（也就是 `<opml>`）往下找 outline，
 * 结果 `<head>` / `<body>` 都被过滤掉、一条订阅也解析不出来——连自己导出的文件都导不回去。
 * 这里先定位 body，body 缺失时（部分导出器省略）再看根节点的直接子节点。
 */
function parseOutlines(xml: string): OutlineNode[] {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const document = dom.window.document;

  // XML 解析失败时 jsdom 会给出 <parsererror> 节点，而不是抛错。
  if (document.querySelector('parsererror')) {
    throw new Error('OPML 内容不是合法 XML');
  }

  const parse = (element: Element): OutlineNode[] =>
    [...element.children]
      .filter((child) => child.tagName.toLowerCase() === 'outline')
      .map((child) => ({
        text: child.getAttribute('text') ?? child.getAttribute('title') ?? '',
        xmlUrl: child.getAttribute('xmlUrl') ?? child.getAttribute('xmlurl'),
        children: parse(child),
      }));

  const body = document.querySelector('body') ?? document.documentElement;
  return parse(body);
}

/** 导入 OPML：分类作为分组处理，已存在的订阅按 URL 去重后跳过。 */
export function importOpml(xml: string): OpmlImportResult {
  if (!/<opml[\s>]/i.test(xml)) {
    throw new Error('这不是有效的 OPML 文件');
  }

  const result: OpmlImportResult = {
    imported: 0,
    skipped: 0,
    createdCategories: 0,
    errors: [],
  };

  const existingCategories = new Map(listCategories().map((item) => [item.name.toLowerCase(), item.id]));

  const walk = (nodes: OutlineNode[], categoryId: string | null): void => {
    for (const node of nodes) {
      if (node.xmlUrl) {
        try {
          const url = normalizeFeedUrl(node.xmlUrl);
          if (findFeedByUrl(url)) {
            result.skipped += 1;
            continue;
          }
          createFeed({ url, title: node.text || undefined, categoryId });
          result.imported += 1;
        } catch (err) {
          result.errors.push(`${node.text || node.xmlUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      if (node.children.length === 0) continue;

      let targetCategoryId = categoryId;
      const name = node.text.trim();
      if (name) {
        const known = existingCategories.get(name.toLowerCase());
        if (known) {
          targetCategoryId = known;
        } else {
          try {
            const created = createCategory(name);
            existingCategories.set(name.toLowerCase(), created.id);
            targetCategoryId = created.id;
            result.createdCategories += 1;
          } catch (err) {
            // 分类名过长等单节点错误不能中断整个导入：退回未分类，把错误记进结果。
            result.errors.push(
              `分类「${name}」: ${err instanceof Error ? err.message : String(err)}`,
            );
            targetCategoryId = null;
          }
        }
      }
      walk(node.children, targetCategoryId);
    }
  };

  try {
    walk(parseOutlines(xml), null);
  } catch (err) {
    throw new Error(`OPML 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  writeLog({
    level: result.errors.length > 0 ? 'warning' : 'info',
    category: 'opml',
    message: '导入 OPML',
    source: 'services/opml',
    details: result.errors.slice(0, 5).join('; ') || null,
    context: { ...result, at: nowIso() },
  });

  return result;
}
