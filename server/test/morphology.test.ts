/**
 * 词形还原规则的单测。
 *
 * 这里的断言分两类：
 *   1. 顺序：同一个形态有多个可能原形时，更常见的解释必须排在前面；
 *   2. 词性：`-ed` / `-ing` 只能推出动词，`-er` / `-est` 只能推出形容词。
 * 词性这一条是防止 `better → bet`、`writer → write` 这类错误的唯一闸门，
 * 所以单独测，不依赖词典数据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptsPos, lemmaCandidates, phraseVariants } from '../src/lib/morphology';

function lemmasOf(word: string): string[] {
  return lemmaCandidates(word).map((item) => item.lemma);
}

function posOf(word: string, lemma: string): string {
  const found = lemmaCandidates(word).find((item) => item.lemma === lemma);
  assert.ok(found, `${word} 没有推出 ${lemma}`);
  return [...found.pos].sort().join('');
}

describe('词形还原', () => {
  it('规则复数与第三人称单数', () => {
    assert.ok(lemmasOf('boxes').includes('box'));
    assert.ok(lemmasOf('studies').includes('study'));
    assert.ok(lemmasOf('workers').includes('worker'));
    assert.ok(lemmasOf('leaves').includes('leave'));
  });

  it('规则过去式与进行时', () => {
    assert.ok(lemmasOf('stopped').includes('stop'));
    assert.ok(lemmasOf('admitted').includes('admit'));
    assert.ok(lemmasOf('visited').includes('visit'));
    assert.ok(lemmasOf('cared').includes('care'));
    assert.ok(lemmasOf('running').includes('run'));
    assert.ok(lemmasOf('making').includes('make'));
    assert.ok(lemmasOf('lying').includes('lie'));
    assert.ok(lemmasOf('panicked').includes('panic'));
  });

  it('不规则表优先于词尾规则', () => {
    // better 走比较级不规则表得到 good / well，而不是被 -er 规则拆成 bet。
    const better = lemmasOf('better');
    assert.equal(better[0], 'good');
    assert.ok(better.includes('well'));
    assert.ok(better.indexOf('bet') > better.indexOf('good'));

    assert.ok(lemmasOf('children').includes('child'));
    assert.ok(lemmasOf('people').includes('person'));
    assert.ok(lemmasOf('went').includes('go'));
    assert.ok(lemmasOf('written').includes('write'));
  });

  it('动词类规则要求原形是动词，比较级要求是形容词', () => {
    assert.equal(posOf('stopped', 'stop'), 'v');
    assert.equal(posOf('running', 'run'), 'v');
    assert.equal(posOf('happier', 'happy'), 'a');
    assert.equal(posOf('boxes', 'box'), 'nv');
  });

  it('功能词与以 s 结尾的「单数」不拆', () => {
    assert.deepEqual(lemmasOf('us'), []);
    assert.deepEqual(lemmasOf('news'), []);
    assert.deepEqual(lemmasOf('this'), []);
    assert.deepEqual(lemmasOf('as'), []);
  });

  it('词性放行规则：未知词性一律放行，已知词性必须相交', () => {
    assert.equal(acceptsPos('', new Set(['v'])), true);
    assert.equal(acceptsPos('nv', new Set(['v'])), true);
    assert.equal(acceptsPos('n', new Set(['v'])), false);
    assert.equal(acceptsPos('anr', new Set(['a'])), true);
    assert.equal(acceptsPos('', new Set()), true);
  });

  it('非字母词不做推导', () => {
    assert.deepEqual(lemmasOf('e-mail'), []);
    assert.deepEqual(lemmasOf('v2.0'), []);
    assert.deepEqual(lemmasOf('AI'), []);
  });

  it('所有格先剥掉再分析', () => {
    assert.ok(lemmasOf("teacher's").includes('teacher'));
    assert.ok(lemmasOf("studies'").includes('studies'));
  });

  it('词组只替换一个位置，且跳过功能词', () => {
    const variants = phraseVariants('looked forward to');
    assert.ok(variants.includes('look forward to'));
    // to 是功能词，不该被当成变形目标。
    assert.ok(!variants.includes('looked forward too'));
  });
});
