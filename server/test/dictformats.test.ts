import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { parseStarDict } from '../src/domain/dict/stardict';
import { decodeStarDictRecord } from '../src/domain/dict/readers';
import { groupDictionaryFiles, detectFormat, UnsupportedFileError } from '../src/domain/dict/files';
import { prepareDefinition } from '../src/domain/dict/content';

/**
 * StarDict 的测试数据在仓库里没有现成样本，这里按格式规范现场构造：
 * 只要构造器写对了，被测解析逻辑就不是「对着自己造的假数据自说自话」——
 * 每个字段的位置都来自 StarDict 官方格式文档。
 */

function buildIdx(entries: Array<{ word: string; offset: number; size: number }>, offsetBits: 32 | 64 = 32): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const word = Buffer.from(entry.word, 'utf8');
    const tail = Buffer.alloc((offsetBits === 64 ? 8 : 4) + 4);
    if (offsetBits === 64) tail.writeBigUInt64BE(BigInt(entry.offset), 0);
    else tail.writeUInt32BE(entry.offset, 0);
    tail.writeUInt32BE(entry.size, offsetBits === 64 ? 8 : 4);
    chunks.push(word, Buffer.from([0]), tail);
  }
  return Buffer.concat(chunks);
}

function buildDict(records: string[]): { buffer: Buffer; offsets: number[] } {
  const offsets: number[] = [];
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const record of records) {
    const body = Buffer.from(record, 'utf8');
    offsets.push(cursor);
    chunks.push(body);
    cursor += body.length;
  }
  return { buffer: Buffer.concat(chunks), offsets };
}

function ifoText(fields: Record<string, string>): string {
  const lines = ["StarDict's dict ifo file", 'version=2.4.2', ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)];
  return `${lines.join('\n')}\n`;
}

describe('StarDict 解析', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-stardict-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('按 .idx 偏移逐条产出词头，释义留给查询期读取', () => {
    const records = ['苹果\n', '香蕉\n', '樱桃\n'];
    const { buffer, offsets } = buildDict(records);
    const idx = buildIdx([
      { word: 'apple', offset: offsets[0], size: Buffer.byteLength(records[0]) },
      { word: 'banana', offset: offsets[1], size: Buffer.byteLength(records[1]) },
      { word: 'cherry', offset: offsets[2], size: Buffer.byteLength(records[2]) },
    ]);

    writeFileSync(join(dir, 'basic.dict'), buffer);
    writeFileSync(join(dir, 'basic.idx'), idx);
    writeFileSync(join(dir, 'basic.ifo'), ifoText({ wordcount: '3', idxfilesize: String(idx.length), sametypesequence: 'm' }));

    const source = parseStarDict({
      ifo: join(dir, 'basic.ifo'),
      idx: join(dir, 'basic.idx'),
      dict: join(dir, 'basic.dict'),
      dz: null,
      syn: null,
    });

    assert.equal(source.format, 'stardict');
    assert.equal(source.storage, 'file');
    assert.equal(source.contentType, 'text');
    assert.equal(source.totalKeys, 3);

    const entries = [...source.iterate()];
    assert.deepEqual(entries.map((entry) => entry.term), ['apple', 'banana', 'cherry']);
    assert.equal(entries[0].recordStart, 0);
    assert.equal(entries[0].recordEnd, Buffer.byteLength('苹果\n'));
    // 文件型词典不在库里存释义，靠偏移回原文件取。
    assert.equal(entries[0].definition, '');

    const slice = buffer.subarray(entries[1].recordStart!, entries[1].recordEnd!);
    assert.equal(decodeStarDictRecord(slice, 'm'), '香蕉');
  });

  it('.dict.dz 压缩包也能导入，meta 里记下解压方式', () => {
    const records = ['压缩内容\n'];
    const { buffer, offsets } = buildDict(records);
    const idx = buildIdx([{ word: 'zip', offset: offsets[0], size: Buffer.byteLength(records[0]) }]);
    writeFileSync(join(dir, 'zip.dict.dz'), gzipSync(buffer));
    writeFileSync(join(dir, 'zip.idx'), idx);
    writeFileSync(join(dir, 'zip.ifo'), ifoText({ wordcount: '1', sametypesequence: 'm' }));

    const source = parseStarDict({
      ifo: join(dir, 'zip.ifo'),
      idx: join(dir, 'zip.idx'),
      dict: null,
      dz: join(dir, 'zip.dict.dz'),
      syn: null,
    });
    assert.equal(source.meta.compressed, true);
    assert.equal([...source.iterate()][0].term, 'zip');
  });

  it('.syn 里的同义词指向主词条的数据块', () => {
    const records = ['复数形式\n'];
    const { buffer, offsets } = buildDict(records);
    const idx = buildIdx([{ word: 'mouse', offset: offsets[0], size: Buffer.byteLength(records[0]) }]);
    const syn = Buffer.concat([Buffer.from('mice', 'utf8'), Buffer.from([0]), Buffer.from([0, 0, 0, 0])]);
    writeFileSync(join(dir, 'syn.dict'), buffer);
    writeFileSync(join(dir, 'syn.idx'), idx);
    writeFileSync(join(dir, 'syn.syn'), syn);
    writeFileSync(join(dir, 'syn.ifo'), ifoText({ wordcount: '1', sametypesequence: 'm' }));

    const source = parseStarDict({
      ifo: join(dir, 'syn.ifo'),
      idx: join(dir, 'syn.idx'),
      dict: join(dir, 'syn.dict'),
      dz: null,
      syn: join(dir, 'syn.syn'),
    });
    const entries = [...source.iterate()];
    assert.deepEqual(entries.map((entry) => entry.term), ['mouse', 'mice']);
    // 同义词没有自己的数据块，必须指向主词条的区间。
    assert.equal(entries[1].recordStart, entries[0].recordStart);
    assert.equal(entries[1].recordEnd, entries[0].recordEnd);
  });

  it('idxoffsetbits=64 的词典按 8 字节偏移读取', () => {
    const records = ['大偏移\n'];
    const { buffer } = buildDict(records);
    const idx = buildIdx([{ word: 'big', offset: 0, size: Buffer.byteLength(records[0]) }], 64);
    writeFileSync(join(dir, 'b64.dict'), buffer);
    writeFileSync(join(dir, 'b64.idx'), idx);
    writeFileSync(join(dir, 'b64.ifo'), ifoText({ wordcount: '1', idxoffsetbits: '64', sametypesequence: 'm' }));

    const source = parseStarDict({
      ifo: join(dir, 'b64.ifo'),
      idx: join(dir, 'b64.idx'),
      dict: join(dir, 'b64.dict'),
      dz: null,
      syn: null,
    });
    assert.equal([...source.iterate()][0].term, 'big');
    assert.equal(source.meta.offsetBits, 64);
  });

  it('缺少 .dict / .idx 时给出可读的报错，而不是抛底层异常', () => {
    writeFileSync(join(dir, 'broken.ifo'), ifoText({ wordcount: '1' }));
    assert.throws(
      () => parseStarDict({ ifo: join(dir, 'broken.ifo'), idx: null, dict: null, dz: null, syn: null }),
      UnsupportedFileError,
    );
  });
});

describe('StarDict 数据块解码', () => {
  it('sametypesequence 存在时最后一个字段吃到块尾', () => {
    const text = Buffer.from('释义文本', 'utf8');
    const html = Buffer.from('<b>带标签的释义</b>', 'utf8');
    const buffer = Buffer.concat([Buffer.alloc(4), text, html]);
    buffer.writeUInt32BE(text.length, 0);
    // m 段带 4 字节长度前缀，h 段是最后一段，直接吃到块尾。
    assert.equal(decodeStarDictRecord(buffer, 'mh'), '释义文本\n<b>带标签的释义</b>');
    assert.equal(decodeStarDictRecord(Buffer.from('纯文本', 'utf8'), 'm'), '纯文本');
  });

  it('没有 sametypesequence 时按 [type][size][data] 逐段解析', () => {
    const text = Buffer.from('内容', 'utf8');
    const buffer = Buffer.concat([Buffer.from('m'), Buffer.alloc(4), text]);
    buffer.writeUInt32BE(text.length, 1);
    assert.equal(decodeStarDictRecord(buffer, ''), '内容');
  });

  it('图片字段（P）不参与文本渲染', () => {
    const text = Buffer.from('文字', 'utf8');
    const buffer = Buffer.concat([Buffer.from('m'), Buffer.alloc(4), text, Buffer.from('P'), Buffer.alloc(4), Buffer.from([1, 2, 3])]);
    buffer.writeUInt32BE(text.length, 1);
    buffer.writeUInt32BE(3, text.length + 5);
    assert.equal(decodeStarDictRecord(buffer, ''), '文字');
  });
});

describe('文件分组与格式识别', () => {
  it('同名 .mdx/.mdd 配成一本词典', () => {
    const groups = groupDictionaryFiles(['/tmp/d/a.mdx', '/tmp/d/a.mdd', '/tmp/d/b.ifo', '/tmp/d/b.idx', '/tmp/d/b.dict']);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].mdx, '/tmp/d/a.mdx');
    assert.equal(groups[0].mdd, '/tmp/d/a.mdd');
    assert.equal(detectFormat(groups[0]), 'mdx');
    assert.equal(detectFormat(groups[1]), 'stardict');
  });

  it('名字对不上的单个 .mdd 仍然挂到唯一的 .mdx 上', () => {
    const groups = groupDictionaryFiles(['/tmp/d/ODE.mdx', '/tmp/d/资源.mdd']);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].mdd, '/tmp/d/资源.mdd');
  });

  it('.dict.dz 与 .idx.gz 都按正确扩展名归类', () => {
    const groups = groupDictionaryFiles(['/tmp/d/x.ifo', '/tmp/d/x.idx.gz', '/tmp/d/x.dict.dz']);
    assert.equal(groups[0].idx, '/tmp/d/x.idx.gz');
    assert.equal(groups[0].dz, '/tmp/d/x.dict.dz');
  });

  it('完全不认识的文件要报错并说明支持范围', () => {
    assert.throws(() => groupDictionaryFiles(['/tmp/d/a.txt', '/tmp/d/b.png']), UnsupportedFileError);
  });
});

describe('释义清洗', () => {
  const resourceUrl = (key: string) => `/api/dictionaries/1/resource?key=${key}`;

  it('MDX 释义里的样式表被丢掉、相对图片地址改写成词典资源接口', () => {
    const raw = '<link rel="stylesheet"href="ODE.css"><div class="x"><h2>word</h2><img src="p/abacus.png"></div>\r\n\u0000';
    const html = prepareDefinition(raw, 'html', resourceUrl);
    assert.ok(!html.includes('<link'));
    assert.ok(!html.includes('\u0000'));
    assert.ok(html.includes('src="/api/dictionaries/1/resource?key=p/abacus.png"'));
  });

  it('外部图片与危险标签按白名单处理', () => {
    const raw = '<div onclick="evil()"><script>alert(1)</script><img src="https://x/y.png"><b>ok</b></div>';
    const html = prepareDefinition(raw, 'html', resourceUrl);
    assert.ok(!html.includes('script'));
    assert.ok(!html.includes('onclick'));
    assert.ok(html.includes('https://x/y.png'));
    assert.ok(html.includes('<b>ok</b>'));
  });

  it('纯文本词典不会被当成标签渲染', () => {
    assert.equal(prepareDefinition('<b>不是标签</b>\n第二行', 'text', resourceUrl), '<b>不是标签</b>\n第二行');
  });
});
