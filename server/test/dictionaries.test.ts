import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { openDb } from '../src/db/sqlite';
import {
  deleteDictionary,
  importDictionary,
  listDictionaries,
  lookupWord,
} from '../src/domain/dictionaries';
import {
  BUILTIN_DICTIONARY_ID,
  BUILTIN_DICTIONARY_NAME,
  loadBuiltinDictionary,
} from '../src/domain/builtinDictionary';

/**
 * 查词是英语精读的主路径：内置词典必须在没有导入任何词典时就能命中，
 * 用户导入的词典则要优先于内置词典。
 */
describe('内置核心词库', () => {
  before(() => {
    openDb(':memory:');
  });

  it('默认词典随应用分发，能直接查到常见词', () => {
    const entries = loadBuiltinDictionary();
    assert.ok(entries.size > 28_000, `内置词典条目过少：${entries.size}`);

    const result = lookupWord('Resilient');
    assert.equal(result.term, 'Resilient');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].dictionaryName, BUILTIN_DICTIONARY_NAME);
    assert.ok(result.entries[0].definition.includes('弹'));
    assert.ok(result.entries[0].phonetic);
  });

  it('带连字符/所有格的写法都按候选归一化命中', () => {
    assert.equal(lookupWord('well-being').entries.length, 1);
    assert.equal(lookupWord("day's").entries.length, 1);
  });

  it('词典列表里内置词典排第一，且标记为 builtin', () => {
    const [first] = listDictionaries();
    assert.equal(first.id, BUILTIN_DICTIONARY_ID);
    assert.equal(first.builtin, true);
    assert.ok(first.entryCount > 28_000);
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
    assert.equal(builtin.entries[0].dictionaryName, BUILTIN_DICTIONARY_NAME);
  });

  it('内置词典不能被删除或停用', () => {
    assert.throws(() => deleteDictionary(BUILTIN_DICTIONARY_ID), /不能删除/);
  });

  it('未收录词返回空结果而不是报错', () => {
    const result = lookupWord('zzzz-not-a-real-word-qqq');
    assert.equal(result.entries.length, 0);
  });
});
