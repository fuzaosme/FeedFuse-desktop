/**
 * 词形变体匹配的单测。
 *
 * 文件放在 web 包下，但由 server 的 tsx 统一跑（`pnpm test`）：
 * web 自己没有测试运行器，为几个纯函数再装一套工具链不值得。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createVocabularyMatcher,
  vocabularyMatchKey,
} from '../src/features/learning/vocabularyMatch';

function hits(terms: string[], text: string): string[] {
  return createVocabularyMatcher(terms).scan(text).map((match) => text.slice(match.start, match.end));
}

describe('生词词形匹配', () => {
  it('复数与所有格', () => {
    const matcher = createVocabularyMatcher(['word']);
    const text = 'One word, two words, the word\u2019s meaning, the words\u2019 meanings.';
    assert.deepEqual(
      matcher.scan(text).map((match) => text.slice(match.start, match.end)),
      ['word', 'words', 'word\u2019s', 'words'],
    );
  });

  it('规则动词：过去式、进行时、三单', () => {
    assert.deepEqual(hits(['stop'], 'It stops, it stopped, it is stopping.'), ['stops', 'stopped', 'stopping']);
    assert.deepEqual(hits(['study'], 'He studies, he studied, he is studying.'), ['studies', 'studied', 'studying']);
    assert.deepEqual(hits(['cope'], 'She copes and coped while coping.'), ['copes', 'coped', 'coping']);
    assert.deepEqual(hits(['visit'], 'They visited and are visiting.'), ['visited', 'visiting']);
  });

  it('不规则动词也能认出来（只作为兜底，不影响规则变形）', () => {
    assert.deepEqual(hits(['make'], 'He makes, made, is making.'), ['makes', 'made', 'making']);
    assert.deepEqual(hits(['go'], 'She goes, went, has gone, is going.'), ['goes', 'went', 'gone', 'going']);
  });

  it('收藏的是变形时，反向还原成本形再匹配', () => {
    assert.deepEqual(hits(['running'], 'They run, he runs, he ran, he is running.'), [
      'run', 'runs', 'ran', 'running',
    ]);
    assert.deepEqual(hits(['studies'], 'They study and studied.'), ['study', 'studied']);
  });

  it('不规则复数与 f→ves', () => {
    assert.deepEqual(hits(['child'], 'One child, two children.'), ['child', 'children']);
    assert.deepEqual(hits(['life'], 'A life, many lives.'), ['life', 'lives']);
    assert.deepEqual(hits(['analysis'], 'Each analysis, several analyses.'), ['analysis', 'analyses']);
  });

  it('词组只变实词，虚词不动', () => {
    assert.deepEqual(
      hits(['give up'], 'He gives up, gave up, and is giving up.'),
      ['gives up', 'gave up', 'giving up'],
    );
    assert.deepEqual(
      hits(['look forward to'], 'She looks forward to it and looked forward to it.'),
      ['looks forward to', 'looked forward to'],
    );
  });

  it('不把相邻单词拼成不存在的命中', () => {
    assert.deepEqual(hits(['give up'], 'Please give. Up we go.'), []);
    // 词内命中不算：wordy / new 都不该被当成 word / news
    assert.deepEqual(hits(['word'], 'A wordy answer.'), []);
    assert.deepEqual(hits(['news'], 'A new day, good news.'), ['news']);
    // us 不该去吃 uses
    assert.deepEqual(hits(['us'], 'He uses it with us.'), ['us']);
  });

  it('大小写、全角撇号、连字符与空格等价', () => {
    assert.deepEqual(hits(['well-being'], 'Their Well Being matters.'), ['Well Being']);
    assert.deepEqual(hits(['well being'], 'A well-being check.'), ['well-being']);
    assert.equal(vocabularyMatchKey('Don\u2019t'), "don't");
  });

  it('空词表与空文本都直接返回空结果', () => {
    assert.deepEqual(createVocabularyMatcher([]).scan('anything'), []);
    assert.deepEqual(createVocabularyMatcher(['word']).scan(''), []);
  });

  it('重叠时最长优先：先命中词组，不重复命中内部单词', () => {
    const matches = createVocabularyMatcher(['give', 'give up']).scan('They give up.');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].term, 'give up');
  });
});
