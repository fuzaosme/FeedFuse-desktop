/**
 * 划词解析单测：一次选区只出一个查询目标，词典未收录后才用左右相邻词扩词。
 *
 * 和 vocabularyMatch 一样放在 web 包下，由 server 的 tsx 统一跑（`pnpm test`）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countEnglishWords } from '../src/lib/englishLearning';
import {
  completeLearningSelection,
  resolveLookupPlan,
  resolveSelectionMode,
  type SelectionPiece,
} from '../src/features/learning/lookupTerms';
import type { LearningSelection } from '../src/features/learning/selection';

function piece(context: string, selected: string): SelectionPiece {
  const start = context.indexOf(selected);
  if (start < 0) throw new Error(`selection "${selected}" not found in "${context}"`);
  return { text: selected, context, start, end: start + selected.length };
}

function selection(context: string, selected = context): LearningSelection {
  return {
    pieces: [piece(context, selected)],
    selectedText: selected,
    wordCount: countEnglishWords(selected),
    sentences: [context],
    rect: { left: 0, right: 10, top: 0, bottom: 10 },
  };
}

describe('划词解析', () => {
  it('单个词补全后查整词，左右各补一个相邻实词作为候选', () => {
    assert.deepEqual(resolveLookupPlan([piece('a resilient person', 'resilien')]), {
      term: 'resilient',
      expandedTerms: ['resilient person'],
    });
  });

  it('撑到边上的胶水词不参与查询，也不会拼进词条', () => {
    assert.deepEqual(resolveLookupPlan([piece('the resilient person', 'he resilien')]), {
      term: 'resilient',
      expandedTerms: ['resilient person'],
    });
  });

  it('完整选中的胶水词照常查询', () => {
    assert.deepEqual(resolveLookupPlan([piece('that matters', 'that')]), {
      term: 'that',
      expandedTerms: ['that matters'],
    });
  });

  it('2～4 个词作为整词组查询，不拆成多张卡片', () => {
    assert.deepEqual(resolveLookupPlan([piece('Chinese company', 'Chinese company')]), {
      term: 'Chinese company',
      expandedTerms: [],
    });
    assert.equal(resolveSelectionMode(selection('one two three four')), 'word');
  });

  it('超过 4 个词或完整句子直接交给 AI，单个词始终查词典', () => {
    assert.equal(resolveSelectionMode(selection('one two three four five')), 'sentence');
    assert.equal(resolveSelectionMode(selection('Go now.')), 'sentence');
    assert.equal(resolveSelectionMode(selection('Hello.', 'Hello')), 'word');
  });

  it('跨标点的多词选区不再硬拼词组，直接交给 AI', () => {
    const value = selection('arguing, that');
    assert.equal(resolveSelectionMode(value), 'sentence');
    assert.deepEqual(resolveLookupPlan(value.pieces), { term: '', expandedTerms: [] });
  });

  it('给 AI 的选区会去掉只擦到一点的胶水词', () => {
    const result = completeLearningSelection(selection('the resilient person', 'he resilien'));
    assert.equal(result.selectedText, 'resilient');
    assert.equal(result.wordCount, 1);
  });
});
