import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { openDb } from '../src/db/sqlite';
import {
  deleteDictionary,
  importDictionary,
  listDictionaries,
  lookupWord,
  setDictionaryEnabled,
} from '../src/domain/dictionaries';
import {
  PHRASE_DICTIONARY_ID,
  PHRASE_DICTIONARY_NAME,
  WORDNET_DICTIONARY_ID,
  WORDNET_DICTIONARY_NAME,
  ZH_CORE_DICTIONARY_ID,
  ZH_CORE_DICTIONARY_NAME,
  loadBuiltinDictionary,
} from '../src/domain/builtinDictionary';

/**
 * 查词是英语精读的主路径：三本内置词典必须在不导入任何词典时就能命中，
 * 用户导入的词典优先于内置词典，内置词典之间可以单独停用。
 */
describe('内置词典', () => {
  before(() => {
    openDb(':memory:');
  });

  it('三本内置词典都随应用分发，且排在列表最前', () => {
    assert.ok(loadBuiltinDictionary().size > 150_000);

    const [zh, wordnet, phrases] = listDictionaries();
    assert.equal(zh.id, ZH_CORE_DICTIONARY_ID);
    assert.equal(zh.builtin, true);
    assert.ok(zh.entryCount > 28_000, `中英核心词库条目过少：${zh.entryCount}`);
    assert.equal(wordnet.id, WORDNET_DICTIONARY_ID);
    assert.ok(wordnet.entryCount > 150_000, `WordNet 条目过少：${wordnet.entryCount}`);
    assert.equal(phrases.id, PHRASE_DICTIONARY_ID);
    assert.ok(phrases.entryCount > 8_000, `词组词典条目过少：${phrases.entryCount}`);
    for (const summary of [zh, wordnet, phrases]) assert.equal(summary.enabled, true);
  });

  it('同时开启时中文释义与英英释义合成一条，音标取 IPA', () => {
    const result = lookupWord('Resilient');
    assert.equal(result.term, 'Resilient');
    assert.equal(result.entries.length, 1);
    const [entry] = result.entries;
    assert.match(entry.dictionaryName, new RegExp(ZH_CORE_DICTIONARY_NAME));
    assert.match(entry.dictionaryName, new RegExp(WORDNET_DICTIONARY_NAME));
    // 中文行在前、英英行在后。
    const lines = entry.definition.split('\n');
    assert.ok(lines[0].includes('弹'), lines[0]);
    assert.ok(entry.definition.includes('recovering readily'));
    assert.ok(entry.phonetic);
  });

  it('停用 WordNet 后只剩中文释义，重新启用即恢复', () => {
    setDictionaryEnabled(WORDNET_DICTIONARY_ID, false);
    try {
      const [entry] = lookupWord('resilient').entries;
      assert.equal(entry.dictionaryName, ZH_CORE_DICTIONARY_NAME);
      assert.ok(entry.definition.includes('弹'));
      assert.ok(!entry.definition.includes('recovering readily'));
      // 列表里状态同步。
      assert.equal(listDictionaries()[1].enabled, false);
    } finally {
      setDictionaryEnabled(WORDNET_DICTIONARY_ID, true);
    }
    const [restored] = lookupWord('resilient').entries;
    assert.match(restored.dictionaryName, new RegExp(WORDNET_DICTIONARY_NAME));
  });

  it('停用中英核心词库后只剩英英释义', () => {
    setDictionaryEnabled(ZH_CORE_DICTIONARY_ID, false);
    try {
      const [entry] = lookupWord('resilient').entries;
      assert.equal(entry.dictionaryName, WORDNET_DICTIONARY_NAME);
      assert.ok(!entry.definition.includes('弹'));
      assert.ok(entry.definition.includes('recovering readily'));
    } finally {
      setDictionaryEnabled(ZH_CORE_DICTIONARY_ID, true);
    }
  });

  it('带连字符/所有格的写法都按候选归一化命中', () => {
    assert.equal(lookupWord('well-being').entries.length, 1);
    assert.equal(lookupWord("day's").entries.length, 1);
  });

  it('词组词典只对多词表达命中，且释义排在英英释义之前', () => {
    const result = lookupWord('break off');
    const [entry] = result.entries;
    // 短语在 WordNet 里也有动词词条，两本都命中；中文短语释义必须排第一行。
    assert.match(entry.dictionaryName, new RegExp(PHRASE_DICTIONARY_NAME));
    assert.ok(entry.definition.split('\n')[0].includes('中断'), entry.definition.split('\n')[0]);
    assert.ok(entry.definition.includes('例：'));
    // 单词不会命中词组词典。
    assert.equal(lookupWord('break').entries[0].dictionaryName.includes(PHRASE_DICTIONARY_NAME), false);
  });

  it('选中的是变形时，还原成词头再查', () => {
    // studied 自己也是形容词词条：两边都保留，并标出它是 study 的过去式。
    const studied = lookupWord('studied').entries[0].definition;
    assert.ok(studied.includes('study 的过去式'), studied);
    assert.ok(studied.includes('学习'), studied);

    // 分词形容词同理：interesting 的形容词义在前，词头 interest 跟在后面。
    const interesting = lookupWord('interesting').entries[0].definition;
    assert.ok(interesting.includes('有趣的'), interesting);
    assert.ok(interesting.includes('interest'), interesting);

    // 变形本身不是词条的，直接给词头。
    assert.equal(lookupWord('mice').entries[0].term, 'mouse');
    assert.equal(lookupWord('boxes').entries[0].term, 'box');
    assert.equal(lookupWord('went').entries[0].term, 'go');
    assert.equal(lookupWord('happier').entries[0].term, 'happy');
    // -es → -is：axes 优先落到 axis，而不是 ax（斧头）。
    assert.equal(lookupWord('axes').entries[0].term, 'axis');
  });

  it('词组里的变形也能还原（只动一个词）', () => {
    const result = lookupWord('looked forward to');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].term, 'look forward to');
  });

  it('还原不出真词就返回空，不硬猜', () => {
    assert.equal(lookupWord('us').entries[0]?.term === 'use', false);
    assert.equal(lookupWord('zzzzings').entries.length, 0);
  });

  it('用户导入的词典优先于内置词典，删除后回落到内置', () => {
    importDictionary({
      name: '自定义词表',
      entries: [{ term: 'resilient', definition: '自定义释义：能屈能伸的', phonetic: 'custom' }],
    });

    const custom = lookupWord('resilient');
    assert.equal(custom.entries[0].dictionaryName, '自定义词表');
    assert.equal(custom.entries[0].definition, '自定义释义：能屈能伸的');

    const customDict = listDictionaries().find((dict) => dict.name === '自定义词表');
    assert.ok(customDict);
    deleteDictionary(customDict!.id);

    const builtin = lookupWord('resilient');
    assert.match(builtin.entries[0].dictionaryName, new RegExp(ZH_CORE_DICTIONARY_NAME));
  });

  it('内置词典可以停用，但不能删除', () => {
    assert.throws(() => deleteDictionary(ZH_CORE_DICTIONARY_ID), /不能删除/);
    assert.throws(() => deleteDictionary(PHRASE_DICTIONARY_ID), /不能删除/);
    assert.throws(() => deleteDictionary(WORDNET_DICTIONARY_ID), /不能删除/);
  });

  it('未收录词返回空结果而不是报错', () => {
    const result = lookupWord('zzzz-not-a-real-word-qqq');
    assert.equal(result.entries.length, 0);
  });
});
