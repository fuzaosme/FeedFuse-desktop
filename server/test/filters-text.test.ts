import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contentFingerprint,
  fingerprintBands,
  hammingSimilarity,
  normalizeTitle,
  normalizeUrl,
} from '../src/services/filters/text';

/**
 * 归一化与指纹是跨订阅查重的地基：这些函数改了，历史数据算出来的值就跟新数据对不上，
 * 所以每个行为都钉死在测试里。
 */
describe('normalizeUrl', () => {
  it('剪掉追踪参数、排好序、去掉末尾斜杠', () => {
    assert.equal(
      normalizeUrl('https://Example.com:443/post/1/?utm_source=x&b=2&a=1&fbclid=zz#section'),
      'https://example.com/post/1?a=1&b=2',
    );
  });

  it('保留非默认端口，去掉默认端口', () => {
    assert.equal(normalizeUrl('http://127.0.0.1:8080/a'), 'http://127.0.0.1:8080/a');
    assert.equal(normalizeUrl('http://127.0.0.1:80/a'), 'http://127.0.0.1/a');
  });

  it('root 路径收成空串，同一篇文章的两种写法应归一', () => {
    assert.equal(normalizeUrl('https://a.com/'), normalizeUrl('https://a.com'));
  });

  it('非法输入返回 null，宁可不去重也不拿坏字符串比', () => {
    assert.equal(normalizeUrl(''), null);
    assert.equal(normalizeUrl('not a url'), null);
  });
});

describe('normalizeTitle', () => {
  it('摊平全角、大小写与标点噪声', () => {
    assert.equal(normalizeTitle('【独家】Hello，World！'), '独家 hello world');
  });
});

describe('contentFingerprint', () => {
  const longText = (repeat: number) =>
    `<p>${'A long enough article body about distributed systems and databases. '.repeat(repeat)}</p>`;

  it('同一内容 → 同一指纹，且是 16 位 hex', () => {
    const a = contentFingerprint(longText(6));
    const b = contentFingerprint(longText(6));
    assert.ok(a);
    assert.equal(a, b);
    assert.match(a!, /^[0-9a-f]{16}$/);
  });

  it('正文过短时返回 null：短文本没有区分度，硬算只会互相误判', () => {
    assert.equal(contentFingerprint('<p>很短</p>'), null);
  });

  it('中文正文也能算出有效指纹', () => {
    const text = `<p>${'这是一篇关于本地优先软件设计的文章，讨论了数据同步与冲突解决的取舍。'.repeat(4)}</p>`;
    assert.ok(contentFingerprint(text));
  });

  it('改写少量措辞仍高度相似，换主题则明显不同', () => {
    const base = longText(8);
    const tweaked = base.replace('distributed systems', 'distributed platform');
    const other = `<p>${'今天给阳台上的绿萝换了盆，顺便记录一下浇水和日照的节奏。'.repeat(20)}</p>`;

    const baseFp = contentFingerprint(base)!;
    assert.ok(hammingSimilarity(baseFp, contentFingerprint(tweaked)!) > 0.85);
    assert.ok(hammingSimilarity(baseFp, contentFingerprint(other)!) < 0.85);
  });
});

describe('hammingSimilarity', () => {
  it('相同指纹为 1，非法输入为 0', () => {
    assert.equal(hammingSimilarity('ffffffffffffffff', 'ffffffffffffffff'), 1);
    assert.equal(hammingSimilarity('bad', 'ffffffffffffffff'), 0);
    assert.equal(hammingSimilarity('0000000000000000', 'ffffffffffffffff'), 0);
  });
});

describe('fingerprintBands', () => {
  it('切成 4 段 16 位，供 LSH 查候选', () => {
    assert.deepEqual(fingerprintBands('0123456789abcdef'), ['0123', '4567', '89ab', 'cdef']);
    assert.deepEqual(fingerprintBands('oops'), []);
  });
});
