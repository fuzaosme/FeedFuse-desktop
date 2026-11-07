#!/usr/bin/env node
/**
 * 把 Akiyama-sama/english-phrases 的 JSON 构建成内置词组词典。
 *
 * 输入（仓库 output/englishPhrase.json）：
 *   [{ phrase, translations: [{ tran, sentence, sCN }] }, ...]
 * 输出：
 *   server/assets/phrases.json → { "phrase": { meanings: [...] } }
 *
 * 释义与例句都是 LLM 生成的，质量参差（偶尔 tran 里放的是整句翻译），
 * 所以这里只做「去重 + 截断」，不做语义判断：宁可多一行，也不把用户看不懂的中文砍掉。
 *
 * 用法：
 *   git clone --depth 1 https://github.com/Akiyama-sama/english-phrases /tmp/english-phrases
 *   node scripts/build-phrase-dictionary.mjs --src /tmp/english-phrases/output/englishPhrase.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_DEFAULT = '/tmp/english-phrases/output/englishPhrase.json';
const OUT_PATH = join(ROOT, 'server/assets/phrases.json');

const MAX_GLOSSES = 4;
const MAX_EXAMPLES = 2;
/**
 * 词数上限与查词侧一致（`lookupTerms.ts` 的阈值）：
 * 超过 4 个词的表达会直接交给 AI，留在词组词典里只是死数据。
 */
const MAX_PHRASE_WORDS = 4;

const args = process.argv.slice(2);
const srcIndex = args.indexOf('--src');
const src = resolve(srcIndex >= 0 ? args[srcIndex + 1] : SRC_DEFAULT);
if (!existsSync(src)) {
  throw new Error(`没找到 englishPhrase.json：${src}`);
}

const raw = JSON.parse(readFileSync(src, 'utf8'));
if (!Array.isArray(raw)) throw new Error('englishPhrase.json 顶层应当是数组');

const entries = {};
let skipped = 0;
let glossCount = 0;

for (const item of raw) {
  const phrase = String(item?.phrase ?? '').trim();
  if (!phrase) {
    skipped += 1;
    continue;
  }
  const translations = Array.isArray(item.translations) ? item.translations : [];

  const glosses = [];
  const examples = [];
  for (const translation of translations) {
    // 注意：仓库 README 说 tran 是释义、sCN 是例句翻译，实际数据正好相反。
    // 以数据为准——sCN 是短语的中文释义（"中断，停止"），tran 是例句的中文翻译。
    const gloss = String(translation?.sCN ?? '').trim();
    if (gloss && !glosses.includes(gloss)) glosses.push(gloss);
    const sentence = String(translation?.sentence ?? '').trim();
    const sentenceCn = String(translation?.tran ?? '').trim();
    if (!sentence) continue;
    const line = sentenceCn ? `例：${sentence} — ${sentenceCn}` : `例：${sentence}`;
    if (!examples.includes(line)) examples.push(line);
  }
  if (!glosses.length) {
    skipped += 1;
    continue;
  }

  const key = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  const words = key.split(' ').filter(Boolean).length;
  // 单词条（"accuse…of…" 这类带省略号、或 all-rounder 这类连字符词）归核心词库，不进词组库。
  if (words < 2 || words > MAX_PHRASE_WORDS) {
    skipped += 1;
    continue;
  }
  entries[key] = {
    meanings: [...glosses.slice(0, MAX_GLOSSES), ...examples.slice(0, MAX_EXAMPLES)],
  };
  glossCount += Math.min(glosses.length, MAX_GLOSSES);
}

const payload = {
  version: 1,
  source: 'Akiyama-sama/english-phrases (CC BY-SA 4.0)',
  generatedAt: new Date().toISOString().slice(0, 10),
  count: Object.keys(entries).length,
  entries,
};
const json = JSON.stringify(payload);
writeFileSync(OUT_PATH, json);
console.log(
  JSON.stringify(
    {
      phrases: Object.keys(entries).length,
      skipped,
      glossCount,
      maxPhraseWords: MAX_PHRASE_WORDS,
      bytes: json.length,
    },
    null,
    2,
  ),
);
