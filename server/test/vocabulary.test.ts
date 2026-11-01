import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { openDb, getDb } from '../src/db/sqlite';
import {
  MAX_VOCABULARY_SENTENCES,
  addVocabulary,
  addVocabularySentence,
  appendSentence,
  deleteVocabulary,
  listVocabulary,
  updateVocabulary,
  type VocabularySentence,
} from '../src/domain/vocabulary';

function sentence(text: string): VocabularySentence {
  return { text, articleId: null, articleTitle: '文章', articleUrl: '', addedAt: '2026-10-31T00:00:00.000Z' };
}

describe('生词例句列表', () => {
  before(() => {
    openDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('delete from vocabulary_entries');
  });

  it('纯函数：追加时去重，超过 5 句丢最早的一句', () => {
    let list: VocabularySentence[] = [];
    for (let index = 1; index <= 7; index += 1) {
      list = appendSentence(list, sentence(`第 ${index} 句`));
    }
    assert.equal(list.length, MAX_VOCABULARY_SENTENCES);
    assert.deepEqual(list.map((item) => item.text), ['第 3 句', '第 4 句', '第 5 句', '第 6 句', '第 7 句']);

    // 重复的同一句不产生新条目，只把时间/出处刷新成最新一次。
    const before = list.length;
    list = appendSentence(list, { ...sentence('第 7 句'), articleTitle: '另一篇' });
    assert.equal(list.length, before);
    assert.equal(list.at(-1)?.articleTitle, '另一篇');
  });

  it('首次收藏把选区里的多句一起存下，顺序保持从早到晚', () => {
    const item = addVocabulary({
      term: 'resilient',
      definition: '有韧性的',
      sourceArticleId: '12',
      sourceTitle: '标题',
      sourceUrl: 'https://example.com/a',
      sourceSentence: 'She is resilient.\nShe stayed resilient under pressure.',
    });
    assert.equal(item.sentences.length, 2);
    assert.equal(item.sourceSentence, 'She is resilient.');
    assert.equal(item.sentences[0].articleId, '12');
    assert.equal(item.sentences[1].text, 'She stayed resilient under pressure.');
  });

  it('再次收藏同一个词会追加例句而不是覆盖（老实现会丢上一句）', () => {
    addVocabulary({ term: 'resilient', sourceSentence: 'First sentence.' });
    const updated = addVocabulary({ term: 'Resilient', sourceSentence: 'Second sentence.' });
    assert.deepEqual(updated.sentences.map((item) => item.text), ['First sentence.', 'Second sentence.']);
    // 单词大小写以首次收藏为准，避免列表里同一个词出现两种写法。
    assert.equal(updated.term, 'resilient');
  });

  it('补句接口第 6 句会挤掉最早那句', () => {
    const created = addVocabulary({ term: 'cope', sourceSentence: 's0' });
    for (let index = 1; index <= 5; index += 1) {
      addVocabularySentence(created.id, { text: `s${index}`, articleId: '9', articleTitle: 'T' });
    }
    const latest = listVocabulary()[0];
    assert.equal(latest.sentences.length, MAX_VOCABULARY_SENTENCES);
    assert.deepEqual(latest.sentences.map((item) => item.text), ['s1', 's2', 's3', 's4', 's5']);
    // source_sentence 仍然是最早一句的镜像，老前端读它不会错位。
    assert.equal(latest.sourceSentence, 's1');
  });

  it('空白例句被拒绝，不写库', () => {
    const created = addVocabulary({ term: 'cope' });
    assert.throws(() => addVocabularySentence(created.id, { text: '   ' }), /例句不能为空/);
    assert.equal(listVocabulary()[0].sentences.length, 0);
  });

  it('改释义与删句都能落库，删句后 source_sentence 跟着变', () => {
    const created = addVocabulary({
      term: 'cope',
      sourceSentence: 'one\ntwo',
    });
    const patched = updateVocabulary(created.id, { definition: '应对', sentences: ['two'] });
    assert.equal(patched.definition, '应对');
    assert.deepEqual(patched.sentences.map((item) => item.text), ['two']);
    assert.equal(patched.sourceSentence, 'two');
  });

  it('坏 JSON 不会让整个列表崩掉', () => {
    const created = addVocabulary({ term: 'cope', sourceSentence: 'ok' });
    getDb().run('update vocabulary_entries set sentences = ? where id = ?', '{oops', Number(created.id));
    const listed = listVocabulary();
    assert.deepEqual(listed[0].sentences, []);
    // 兜底回到老字段，列表里至少还能看到一句。
    assert.equal(listed[0].sourceSentence, 'ok');
  });

  it('删除后从列表消失', () => {
    const created = addVocabulary({ term: 'cope' });
    deleteVocabulary(created.id);
    assert.equal(listVocabulary().length, 0);
  });
});
