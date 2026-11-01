import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTranslations, extractSegments } from '../src/services/translate';

/**
 * 分段与回填必须用同一套筛选标准。
 *
 * 这里刻意在中间放一段「只有数字与符号」的段落：它会被切分阶段跳过，
 * 如果回填阶段只判长度，序号就会错位一格，后面的译文整体前移、覆盖真实段落。
 * 这是内容级损坏，比排版错乱严重得多，所以单独立一个用例卡住。
 */
test('分段与回填的序号一致：非文字段落不参与编号', () => {
  const html = [
    '<p>Hello world.</p>',
    '<p>2024-10-30</p>',
    '<p>Second English paragraph.</p>',
  ].join('');

  const { segments } = extractSegments(html);
  assert.deepEqual(
    segments.map((segment) => segment.id),
    [1, 2],
  );
  assert.equal(segments[1].text, 'Second English paragraph.');

  const { zhHtml, bilingualHtml } = applyTranslations(
    html,
    new Map([
      [1, '第一段译文'],
      [2, '第二段译文'],
    ]),
  );

  // 纯数字段落保持原文，紧跟其后的段落拿到属于自己的译文。
  assert.match(zhHtml, /<p>第一段译文<\/p>/);
  assert.match(zhHtml, /<p>2024-10-30<\/p>/);
  assert.match(zhHtml, /<p>第二段译文<\/p>/);
  assert.doesNotMatch(zhHtml, /Second English paragraph/);

  // 双语模式：译文插在各自原段之后，顺序不能乱。
  const firstIndex = bilingualHtml.indexOf('第一段译文');
  const dateIndex = bilingualHtml.indexOf('2024-10-30');
  const secondIndex = bilingualHtml.indexOf('第二段译文');
  assert.ok(firstIndex > 0 && dateIndex > firstIndex && secondIndex > dateIndex);
});

test('只翻译最内层块，父容器不重复计入', () => {
  const html = '<blockquote><p>Nested text.</p></blockquote><ul><li>Item one</li></ul>';
  const { segments } = extractSegments(html);
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ['Nested text.', 'Item one'],
  );
});

test('非拉丁文字同样算可翻译段落', () => {
  // 只认 [A-Za-z] + 汉字时，韩文/俄文/日文假名段落会被整体丢掉，
  // 用户点翻译只会得到「正文中没有可翻译的段落」。
  const html = '<p>Привет мир</p><p>안녕하세요 세계</p><p>こんにちは世界</p><p>!!!</p>';
  const { segments } = extractSegments(html);
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((segment) => segment.id),
    [1, 2, 3],
  );
});

test('译文缺失时保留原文，不写成空段落', () => {
  const html = '<p>Alpha text.</p><p>Beta text.</p>';
  const { zhHtml } = applyTranslations(html, new Map([[1, '甲']]));
  assert.match(zhHtml, /<p>甲<\/p>/);
  assert.match(zhHtml, /<p>Beta text.<\/p>/);
});
