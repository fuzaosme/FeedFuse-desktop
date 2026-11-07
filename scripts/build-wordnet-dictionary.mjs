#!/usr/bin/env node
/**
 * 把 Open English WordNet 的 JSON 导出构建成内置词库。
 *
 * 输入（解压后的 english-wordnet-2025-plus-json.zip）：
 *   entries-*.json     词条索引：{ "lemma": { "n": { pronunciation, sense: [{ synset }] } } }
 *   noun.*.json 等     同义词集：{ "00001740-n": { definition: [], example: [], members: [] } }
 * 输出（按首字母分片，查词时只加载命中的那一片）：
 *   server/assets/builtin/index.json   总量与分片统计
 *   server/assets/builtin/<key>.json   该首字母下的全部词条
 *
 * 为什么不直接原样喂给应用：
 *   1. WordNet 是「词条 → 同义词集」的两文件映射，查词要两次跳转，运行期没这个必要；
 *   2. 一个词多条释义，而 dictionary_entries / 内置词典结构是「一词一条，释义多行」；
 *   3. 原文件 80MB，去掉 hypernym / ili / frames 等查词用不上的字段后小一个数量级。
 *
 * 用法：
 * 默认**只输出 WordNet 自己的英英释义**：中文释义是独立的一本内置词典（`en-zh.json`），
 * 两本在查词时合成，不在构建期合并——用户要能单独关掉其中一本。
 * 想让产物自带中文，加 `--merge-legacy`。
 *
 *   unzip -q english-wordnet-2025-plus-json.zip -d /tmp/wn
 *   node scripts/build-wordnet-dictionary.mjs --src /tmp/wn [--merge-legacy] [--stats]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_DEFAULT = '/tmp/wn';
const LEGACY_PATH = join(ROOT, 'server/assets/en-zh.json');
const OUT_DIR = join(ROOT, 'server/assets/builtin');

/** 释义取舍：名词动辄十几个义项，全收只会让 JSON 膨胀、界面也读不完。 */
const MAX_SENSES_PER_POS = 4;
const MAX_LINES_PER_ENTRY = 8;
const MAX_DEFINITION_CHARS = 220;

/** 词性顺序固定：先给实词顺序，查词界面依次展示时不会名词跑到前面又被动词打断。 */
const POS_ORDER = ['n', 'v', 'a', 's', 'r'];
const POS_LABEL = { n: 'n.', v: 'v.', a: 'adj.', s: 'adj.', r: 'adv.' };
/** 词形推导只需要粗粒度词性：形容词与形容词卫星合并成 a。 */
const POS_CODE = { n: 'n', v: 'v', a: 'a', s: 'a', r: 'r' };
/** WordNet 的 entries 里偶见 "n-1" 这类带编号的键，取主干。 */
const basePos = (key) => key.replace(/-\d+$/, '');

function parseArgs(argv) {
  const args = { src: SRC_DEFAULT, legacy: false, stats: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--src') args.src = argv[++index];
    else if (arg === '--merge-legacy') args.legacy = true;
    else if (arg === '--stats') args.stats = true;
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadSynsets(src) {
  const synsets = new Map();
  for (const name of readdirSync(src)) {
    if (!/^(noun|verb|adj|adv)\..*\.json$/.test(name)) continue;
    const data = readJson(join(src, name));
    for (const [id, value] of Object.entries(data)) {
      const definition = (value.definition ?? []).filter((line) => typeof line === 'string' && line.trim());
      if (!definition.length) continue;
      synsets.set(id, {
        definition,
        example: (value.example ?? []).filter((line) => typeof line === 'string' && line.trim()),
        pos: value.partOfSpeech ?? 'n',
      });
    }
  }
  return synsets;
}

function loadEntries(src) {
  const entries = [];
  for (const name of readdirSync(src)) {
    if (!name.startsWith('entries-') || !name.endsWith('.json')) continue;
    entries.push(readJson(join(src, name)));
  }
  return entries;
}

/** GB 优先，其次 US：精读场景里英式音标更常见于国内教材，缺了再退回美音。 */
function pickPronunciation(blocks) {
  for (const variety of ['GB', 'US']) {
    for (const block of blocks) {
      for (const item of block.pronunciation ?? []) {
        if (item?.variety === variety && typeof item.value === 'string' && item.value.trim()) {
          return item.value.trim();
        }
      }
    }
  }
  for (const block of blocks) {
    for (const item of block.pronunciation ?? []) {
      if (typeof item.value === 'string' && item.value.trim()) return item.value.trim();
    }
  }
  return null;
}

/** 释义行：`n. a score in baseball`，例句用破折号接在后面。 */
function formatSense(label, synset) {
  let text = synset.definition[0].replace(/\s+/g, ' ').trim();
  if (text.length > MAX_DEFINITION_CHARS) text = `${text.slice(0, MAX_DEFINITION_CHARS)}…`;
  const example = synset.example[0]?.replace(/\s+/g, ' ').trim();
  const line = `${label} ${text}`;
  return example ? `${line} — ${example}` : line;
}

function buildEntry(block, synsets) {
  const lines = [];
  const seen = new Set();
  const posList = [];
  for (const pos of POS_ORDER) {
    const info = block[pos];
    if (!info) continue;
    posList.push(POS_CODE[pos]);
    const label = POS_LABEL[pos] ?? `${pos}.`;
    let perPos = 0;
    for (const sense of info.sense ?? []) {
      if (perPos >= MAX_SENSES_PER_POS || lines.length >= MAX_LINES_PER_ENTRY) break;
      const synset = synsets.get(sense?.synset);
      if (!synset) continue;
      const line = formatSense(label, synset);
      // 同一词条内重复释义（不同同义词集给出同样的解释）只留一条。
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      perPos += 1;
    }
  }
  const phonetics = Object.entries(block)
    .filter(([key]) => POS_ORDER.includes(basePos(key)))
    .map(([, info]) => info);
  return { lines, pos: joinPos(posList), phonetic: pickPronunciation(phonetics) };
}

/** 词性压成一个字符串（"nv"）：查词时只需要判断「是不是动词」，没必要存数组。 */
function joinPos(list) {
  return [...new Set(list)].sort().join('');
}

/**
 * 只有旧词库、没有 WordNet 数据的条目（缩写、专名、带领域标签的俗语），
 * 词性从释义行的前缀里捡：ECDICT 的 "n." / "vt." / "ad." 就是词性标记。
 */
const LINE_POS = {
  n: 'n', v: 'v', vt: 'v', vi: 'v', a: 'a', adj: 'a', s: 'a', ad: 'r', adv: 'r', r: 'r',
};

function posFromLines(lines) {
  const found = [];
  for (const line of lines) {
    const match = /^\s*\[?([a-z]{1,3})[.\]]/.exec(line);
    if (!match) continue;
    const pos = LINE_POS[match[1]];
    if (pos) found.push(pos);
  }
  return joinPos(found);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = resolve(args.src);
  if (!existsSync(join(src, 'frames.json')) && !existsSync(join(src, 'entries-a.json'))) {
    throw new Error(`没找到 WordNet JSON：${src}（先 unzip english-wordnet-*.zip 到该目录）`);
  }

  const synsets = loadSynsets(src);
  const entryFiles = loadEntries(src);
  const legacy = args.legacy && existsSync(LEGACY_PATH) ? readJson(LEGACY_PATH) : null;

  /** @type {Record<string, { phonetic?: string, pos?: string, meanings: string[] }>} */
  const out = {};
  /** 同一个键撞车时（US / us），保留原本就是小写的那个词条：查词永远走小写归一化。 */
  const originalCase = new Map();
  let single = 0;
  let multi = 0;
  let phonetics = 0;
  let lines = 0;

  for (const file of entryFiles) {
    for (const [lemma, block] of Object.entries(file)) {
      const term = lemma.trim();
      if (!term || term.length > 64) continue;
      const built = buildEntry(block, synsets);
      if (!built.lines.length) continue;

      // 中文释义放最前：这是「眼睛先看到什么」的问题，英英释义是补充。
      // 也要按小写回查旧词库：WordNet 里只有 "US"（美国），而读者看到的小写 us 是代词，
      // 旧词库那条才是真正要给的释义。
      const legacyEntry = legacy?.[term] ?? legacy?.[term.toLowerCase()];
      const chinese = legacyEntry?.meanings ?? [];
      const phonetic = built.phonetic ?? legacyEntry?.phonetic ?? null;
      const meanings = [...new Set([...chinese, ...built.lines])].slice(0, MAX_LINES_PER_ENTRY + 2);
      const pos = built.pos || posFromLines(meanings);

      const key = term.toLowerCase();
      const previous = originalCase.get(key);
      // 已经存了小写词条 → 用旧的；已有的是大写词条（US）而新来的是小写（us） → 用小写覆盖。
      if (previous !== undefined && (previous === previous.toLowerCase() || term !== key)) continue;
      originalCase.set(key, term);

      out[key] = {
        ...(phonetic ? { phonetic } : {}),
        ...(pos ? { pos } : {}),
        meanings,
      };
      if (phonetic) phonetics += 1;
      if (term.includes(' ')) multi += 1;
      else single += 1;
      lines += meanings.length;
    }
  }

  // 旧词库里有、WordNet 里没有的词（缩写、专名、带标签的俗语）不能因为换源就消失。
  let legacyOnly = 0;
  for (const [term, value] of Object.entries(legacy ?? {})) {
    const key = term.toLowerCase();
    if (out[key]) continue;
    if (!Array.isArray(value.meanings) || !value.meanings.length) continue;
    const pos = posFromLines(value.meanings);
    out[key] = {
      ...(value.phonetic ? { phonetic: value.phonetic } : {}),
      ...(pos ? { pos } : {}),
      meanings: value.meanings,
    };
    originalCase.set(key, key);
    legacyOnly += 1;
    if (value.phonetic) phonetics += 1;
  }

  const keys = Object.keys(out).sort();

  // 分片：a-z 各一片，其余（数字、符号、非拉丁）归到 _ 片。
  // 单文件 22MB 意味着每次启动都要 JSON.parse 一次并常驻两百兆堆，而一次查词只用得到一个首字母。
  const shards = new Map();
  for (const key of keys) {
    const first = key[0];
    const bucket = /^[a-z0-9]$/.test(first) ? first : '_';
    let shard = shards.get(bucket);
    if (!shard) {
      shard = {};
      shards.set(bucket, shard);
    }
    shard[key] = out[key];
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  const index = {};
  for (const [bucket, shard] of [...shards].sort(([a], [b]) => a.localeCompare(b))) {
    const json = JSON.stringify(shard);
    bytes += json.length;
    writeFileSync(join(OUT_DIR, `${bucket}.json`), json);
    index[bucket] = Object.keys(shard).length;
  }
  writeFileSync(
    join(OUT_DIR, 'index.json'),
    JSON.stringify({
      version: 1,
      source: 'Open English WordNet 2025',
      generatedAt: new Date().toISOString().slice(0, 10),
      count: keys.length,
      shards: index,
    }),
  );

  const stats = {
    entries: keys.length,
    singleWord: single,
    multiWord: multi,
    legacyOnly,
    withPhonetic: phonetics,
    meaningLines: lines,
    shards: shards.size,
    bytes,
    sourceSynsets: synsets.size,
    legacyMerged: Boolean(legacy),
  };
  console.log(JSON.stringify(stats, null, 2));
  if (args.stats) {
    for (const key of ['run', 'study', 'resilient', 'good']) {
      console.log(key, '→', JSON.stringify(out[key]));
    }
  }
}

main();
