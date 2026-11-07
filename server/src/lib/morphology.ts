/**
 * 词形还原：把一个「选中时看到的形态」还原成词典里的词头。
 *
 * 为什么不能像生词标记那样「正反两向都展开」：
 * 标记是拿已知词条去正文里找，多生成几个形态最多是标记少了；
 * 而查词是从一个未知形态猜词头，猜错就是给用户一个**别的词**的释义——
 * `us` 猜成 `use`、`news` 猜成 `new`、`better` 猜成 `bet`，每一个都是可见的错误。
 *
 * 所以这里的策略是「广撒网 + 严格验证」：
 *   1. 每条候选都带**词性要求**：`-ed` / `-ing` 推出来的原形必须是动词，
 *      `-er` / `-est` 必须是形容词。非动词不接受动词类变形（"非动词的抽象"）。
 *   2. 候选按可信度打分：不规则表 > 复数/三单 > 过去式 > 进行时 > 比较级。
 *      英语里 -s 同时是复数与三单、-ed 同时是过去式与过去分词，规则本身分不清，
 *      只能靠排序让更常见的解释先被验证。
 *   3. 候选最终还要在词典里**真的存在**才算数（由调用方 probe 完成）。
 *      这一步才是把 `harder → hard` 与 `harder → harde` 区分开的关键。
 *
 * 与 web/src/features/learning/vocabularyMatch.ts 的不规则表保持同步：
 * 那边负责「词头 → 形态」，这边负责「形态 → 词头」，两张表必须一致。
 */

export type PartOfSpeech = 'n' | 'v' | 'a' | 'r';

export interface LemmaCandidate {
  lemma: string;
  /** 原形必须有的词性之一；空集合表示「不限」（不规则表已经确定词性时仍会填）。 */
  pos: ReadonlySet<PartOfSpeech>;
  /** 命中的是哪条规则，只用于调试与单测。 */
  rule: string;
  /** 越小越可信，调用方按升序验证。 */
  score: number;
}

const V = new Set<PartOfSpeech>(['v']);
const N = new Set<PartOfSpeech>(['n']);
const NV = new Set<PartOfSpeech>(['n', 'v']);
const A = new Set<PartOfSpeech>(['a']);

/** 不规则动词：原形 → 其它形态。 */
const IRREGULAR_VERBS: Record<string, string[]> = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
  bear: ['bore', 'borne', 'born', 'bears', 'bearing'],
  beat: ['beaten', 'beats', 'beating'],
  become: ['became', 'becomes', 'becoming'],
  begin: ['began', 'begun', 'begins', 'beginning'],
  bend: ['bent', 'bends', 'bending'],
  bind: ['bound', 'binds', 'binding'],
  bite: ['bit', 'bitten', 'bites', 'biting'],
  bleed: ['bled', 'bleeds', 'bleeding'],
  blow: ['blew', 'blown', 'blows', 'blowing'],
  break: ['broke', 'broken', 'breaks', 'breaking'],
  breed: ['bred', 'breeds', 'breeding'],
  bring: ['brought', 'brings', 'bringing'],
  build: ['built', 'builds', 'building'],
  burn: ['burnt', 'burns', 'burning'],
  buy: ['bought', 'buys', 'buying'],
  catch: ['caught', 'catches', 'catching'],
  choose: ['chose', 'chosen', 'chooses', 'choosing'],
  come: ['came', 'comes', 'coming'],
  cost: ['costs', 'costing'],
  cut: ['cuts', 'cutting'],
  deal: ['dealt', 'deals', 'dealing'],
  dig: ['dug', 'digs', 'digging'],
  draw: ['drew', 'drawn', 'draws', 'drawing'],
  dream: ['dreamt', 'dreams', 'dreaming'],
  drink: ['drank', 'drunk', 'drinks', 'drinking'],
  drive: ['drove', 'driven', 'drives', 'driving'],
  eat: ['ate', 'eaten', 'eats', 'eating'],
  fall: ['fell', 'fallen', 'falls', 'falling'],
  feed: ['fed', 'feeds', 'feeding'],
  feel: ['felt', 'feels', 'feeling'],
  fight: ['fought', 'fights', 'fighting'],
  find: ['found', 'finds', 'finding'],
  flee: ['fled', 'flees', 'fleeing'],
  fly: ['flew', 'flown', 'flies', 'flying'],
  forbid: ['forbade', 'forbidden', 'forbids', 'forbidding'],
  forget: ['forgot', 'forgotten', 'forgets', 'forgetting'],
  forgive: ['forgave', 'forgiven', 'forgives', 'forgiving'],
  freeze: ['froze', 'frozen', 'freezes', 'freezing'],
  get: ['got', 'gotten', 'gets', 'getting'],
  give: ['gave', 'given', 'gives', 'giving'],
  go: ['went', 'gone', 'goes', 'going'],
  grow: ['grew', 'grown', 'grows', 'growing'],
  hang: ['hung', 'hangs', 'hanging'],
  have: ['has', 'had', 'having'],
  hear: ['heard', 'hears', 'hearing'],
  hide: ['hid', 'hidden', 'hides', 'hiding'],
  hit: ['hits', 'hitting'],
  hold: ['held', 'holds', 'holding'],
  hurt: ['hurts', 'hurting'],
  keep: ['kept', 'keeps', 'keeping'],
  kneel: ['knelt', 'kneels', 'kneeling'],
  know: ['knew', 'known', 'knows', 'knowing'],
  lay: ['laid', 'lays', 'laying'],
  lead: ['led', 'leads', 'leading'],
  lean: ['leant', 'leans', 'leaning'],
  leap: ['leapt', 'leaps', 'leaping'],
  learn: ['learnt', 'learns', 'learning'],
  leave: ['left', 'leaves', 'leaving'],
  lend: ['lent', 'lends', 'lending'],
  let: ['lets', 'letting'],
  lie: ['lay', 'lain', 'lies', 'lying'],
  light: ['lit', 'lights', 'lighting'],
  lose: ['lost', 'loses', 'losing'],
  make: ['made', 'makes', 'making'],
  mean: ['meant', 'means', 'meaning'],
  meet: ['met', 'meets', 'meeting'],
  pay: ['paid', 'pays', 'paying'],
  prove: ['proven', 'proves', 'proving'],
  put: ['puts', 'putting'],
  quit: ['quits', 'quitting'],
  read: ['reads', 'reading'],
  ride: ['rode', 'ridden', 'rides', 'riding'],
  ring: ['rang', 'rung', 'rings', 'ringing'],
  rise: ['rose', 'risen', 'rises', 'rising'],
  run: ['ran', 'runs', 'running'],
  say: ['said', 'says', 'saying'],
  see: ['saw', 'seen', 'sees', 'seeing'],
  seek: ['sought', 'seeks', 'seeking'],
  sell: ['sold', 'sells', 'selling'],
  send: ['sent', 'sends', 'sending'],
  set: ['sets', 'setting'],
  shake: ['shook', 'shaken', 'shakes', 'shaking'],
  shed: ['sheds', 'shedding'],
  shine: ['shone', 'shines', 'shining'],
  shoot: ['shot', 'shoots', 'shooting'],
  show: ['shown', 'shows', 'showing'],
  shrink: ['shrank', 'shrunk', 'shrinks', 'shrinking'],
  shut: ['shuts', 'shutting'],
  sing: ['sang', 'sung', 'sings', 'singing'],
  sink: ['sank', 'sunk', 'sinks', 'sinking'],
  sit: ['sat', 'sits', 'sitting'],
  sleep: ['slept', 'sleeps', 'sleeping'],
  slide: ['slid', 'slides', 'sliding'],
  speak: ['spoke', 'spoken', 'speaks', 'speaking'],
  speed: ['sped', 'speeds', 'speeding'],
  spend: ['spent', 'spends', 'spending'],
  spin: ['spun', 'spins', 'spinning'],
  spit: ['spat', 'spits', 'spitting'],
  split: ['splits', 'splitting'],
  spread: ['spreads', 'spreading'],
  spring: ['sprang', 'sprung', 'springs', 'springing'],
  stand: ['stood', 'stands', 'standing'],
  steal: ['stole', 'stolen', 'steals', 'stealing'],
  stick: ['stuck', 'sticks', 'sticking'],
  sting: ['stung', 'stings', 'stinging'],
  strike: ['struck', 'strikes', 'striking'],
  swear: ['swore', 'sworn', 'swears', 'swearing'],
  sweep: ['swept', 'sweeps', 'sweeping'],
  swim: ['swam', 'swum', 'swims', 'swimming'],
  swing: ['swung', 'swings', 'swinging'],
  take: ['took', 'taken', 'takes', 'taking'],
  teach: ['taught', 'teaches', 'teaching'],
  tear: ['tore', 'torn', 'tears', 'tearing'],
  tell: ['told', 'tells', 'telling'],
  think: ['thought', 'thinks', 'thinking'],
  throw: ['threw', 'thrown', 'throws', 'throwing'],
  understand: ['understood', 'understands', 'understanding'],
  wake: ['woke', 'woken', 'wakes', 'waking'],
  wear: ['wore', 'worn', 'wears', 'wearing'],
  weave: ['wove', 'woven', 'weaves', 'weaving'],
  weep: ['wept', 'weeps', 'weeping'],
  win: ['won', 'wins', 'winning'],
  wind: ['wound', 'winds', 'winding'],
  withdraw: ['withdrew', 'withdrawn', 'withdraws', 'withdrawing'],
  write: ['wrote', 'written', 'writes', 'writing'],
};

/** 不规则复数：原形 → 复数。 */
const IRREGULAR_PLURALS: Record<string, string> = {
  man: 'men', woman: 'women', child: 'children', person: 'people', foot: 'feet', tooth: 'teeth',
  goose: 'geese', mouse: 'mice', louse: 'lice', ox: 'oxen', die: 'dice', criterion: 'criteria',
  phenomenon: 'phenomena', analysis: 'analyses', basis: 'bases', crisis: 'crises', thesis: 'theses',
  hypothesis: 'hypotheses', diagnosis: 'diagnoses', datum: 'data', medium: 'media',
  curriculum: 'curricula', bacterium: 'bacteria', cactus: 'cacti', focus: 'foci', fungus: 'fungi',
  nucleus: 'nuclei', stimulus: 'stimuli', syllabus: 'syllabi', index: 'indices', matrix: 'matrices',
  vertex: 'vertices', appendix: 'appendices', leaf: 'leaves', life: 'lives', wife: 'wives',
  knife: 'knives', wolf: 'wolves', half: 'halves', shelf: 'shelves', thief: 'thieves',
  loaf: 'loaves', calf: 'calves', self: 'selves', scarf: 'scarves', sheaf: 'sheaves',
};

/** 不规则比较级：变形 → [原形, 词性]。副词（well）与形容词（good）会给同一形态，全部列出。 */
const IRREGULAR_DEGREES: Record<string, Array<[string, PartOfSpeech]>> = {
  better: [['good', 'a'], ['well', 'r']],
  best: [['good', 'a'], ['well', 'r']],
  worse: [['bad', 'a'], ['ill', 'a']],
  worst: [['bad', 'a'], ['ill', 'a']],
  further: [['far', 'a']],
  furthest: [['far', 'a']],
  farther: [['far', 'a']],
  farthest: [['far', 'a']],
  elder: [['old', 'a']],
  eldest: [['old', 'a']],
  less: [['little', 'a']],
  least: [['little', 'a']],
  more: [['much', 'a']],
  most: [['much', 'a']],
};

/** 以 s 结尾但不是复数的词：剥掉 -s 会得到另一个真实单词，不拆。 */
const NOT_PLURAL = new Set([
  'news', 'series', 'species', 'means', 'physics', 'mathematics', 'economics', 'politics',
  'ethics', 'statistics', 'gymnastics', 'athletics', 'measles', 'diabetes', 'headquarters',
  'scissors', 'trousers', 'clothes', 'always', 'perhaps', 'across', 'unless', 'whereas',
  'towards', 'afterwards', 'besides', 'indeed', 'yes', 'this', 'his', 'its', 'thus', 'us', 'as',
  'is', 'was', 'has', 'does', 'goes',
]);

let reverseVerb: Map<string, string> | null = null;
let reversePlural: Map<string, string> | null = null;

function reverseTables(): { verb: Map<string, string>; plural: Map<string, string> } {
  if (!reverseVerb || !reversePlural) {
    reverseVerb = new Map();
    for (const [lemma, forms] of Object.entries(IRREGULAR_VERBS)) {
      for (const form of forms) if (!reverseVerb.has(form)) reverseVerb.set(form, lemma);
    }
    reversePlural = new Map();
    for (const [lemma, plural] of Object.entries(IRREGULAR_PLURALS)) {
      if (!reversePlural.has(plural)) reversePlural.set(plural, lemma);
    }
  }
  return { verb: reverseVerb, plural: reversePlural };
}

const APOSTROPHE_S = /['’‘]s$/;
const TRAILING_APOSTROPHE = /['’‘]$/;

/**
 * 生成全部候选词头，按可信度升序（score 越小越先试）。
 *
 * 只处理纯字母词：带数字、下划线、空格的东西不做变形推导，
 * 那些是缩写、文件名、代码标识符，猜词头只会猜出噪音。
 */
export function lemmaCandidates(surface: string): LemmaCandidate[] {
  const word = surface.trim().toLowerCase();
  if (!/^[a-z']+$/.test(word)) return [];

  const candidates: LemmaCandidate[] = [];
  const push = (lemma: string, pos: ReadonlySet<PartOfSpeech>, rule: string, score: number) => {
    if (lemma.length < 2 || lemma === word) return;
    if (!/^[a-z]+$/.test(lemma)) return;
    if (candidates.some((item) => item.lemma === lemma && item.score <= score)) return;
    candidates.push({ lemma, pos, rule, score });
  };

  // 所有格：word's / words' —— 先剥掉再继续分析，teacher's → teacher，students' → students。
  // 注意尾部 s' 只该去掉撇号：剥成 "studie" 就再也推不出 study 了。
  if (APOSTROPHE_S.test(word) || TRAILING_APOSTROPHE.test(word)) {
    const bare = word.replace(APOSTROPHE_S, '').replace(TRAILING_APOSTROPHE, '');
    if (bare.length >= 2) {
      candidates.push({ lemma: bare, pos: new Set(), rule: 'possessive', score: 10 });
      for (const item of lemmaCandidates(bare)) push(item.lemma, item.pos, item.rule, item.score + 10);
    }
    return candidates;
  }

  const { verb, plural } = reverseTables();

  // 1. 不规则表：命中就是确定答案，优先级最高。
  if (verb.has(word)) push(verb.get(word)!, V, 'irregular-verb', 100);
  if (plural.has(word)) push(plural.get(word)!, N, 'irregular-plural', 101);
  for (const [lemma, pos] of IRREGULAR_DEGREES[word] ?? []) {
    push(lemma, new Set([pos]), 'irregular-degree', 102);
  }

  if (NOT_PLURAL.has(word)) return sort(candidates);

  // 2. 复数 / 第三人称单数：-ies → y，-es → 去 es 或去 s，-s → 去 s。
  if (word.length > 4 && word.endsWith('ies')) {
    push(`${word.slice(0, -3)}y`, NV, 'plural-ies', 200);
  }
  if (word.length > 3 && word.endsWith('es')) {
    // axes → axis、crises → crisis、analyses → analysis：希腊/拉丁来源的 -is 名词。
    push(`${word.slice(0, -2)}is`, N, 'plural-es-is', 205);
    push(word.slice(0, -2), NV, 'plural-es', 210);
    push(word.slice(0, -1), NV, 'plural-es-s', 211);
  } else if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) {
    push(word.slice(0, -1), NV, 'plural-s', 220);
  }

  // 3. 过去式 / 过去分词：只对动词成立。
  if (word.length > 4 && word.endsWith('ied')) {
    push(`${word.slice(0, -3)}y`, V, 'past-ied', 300);
  }
  if (word.length > 3 && word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    // stopped → stop，admitted → admit：末尾双写要退回一个。
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1), V, 'past-double', 301);
    push(stem, V, 'past-ed', 302);
    // loved → love，cared → care：原形本来就以 e 结尾。
    push(word.slice(0, -1), V, 'past-e', 303);
  }
  // picnic → picnicked：-c 结尾加 -ked。
  if (word.length > 4 && word.endsWith('cked')) {
    push(word.slice(0, -3), V, 'past-ck', 304);
  }

  // 4. 现在分词：只对动词成立。
  if (word.length > 5 && word.endsWith('ying')) {
    push(`${word.slice(0, -4)}ie`, V, 'ing-ie', 400);
    push(`${word.slice(0, -4)}y`, V, 'ing-y', 401);
  }
  if (word.length > 4 && word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1), V, 'ing-double', 402);
    push(stem, V, 'ing', 403);
    // making → make，coping → cope：原形以 e 结尾的，加 ing 时丢了 e。
    push(`${stem}e`, V, 'ing-e', 404);
  }

  // 5. 比较级 / 最高级：只对形容词成立。
  if (word.length > 5 && word.endsWith('iest')) push(`${word.slice(0, -4)}y`, A, 'est-iest', 500);
  if (word.length > 4 && word.endsWith('ier')) push(`${word.slice(0, -3)}y`, A, 'er-ier', 501);
  if (word.length > 5 && word.endsWith('est')) {
    const stem = word.slice(0, -3);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1), A, 'est-double', 502);
    push(stem, A, 'est', 503);
    push(`${stem}e`, A, 'est-e', 504);
  }
  if (word.length > 4 && word.endsWith('er')) {
    const stem = word.slice(0, -2);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1), A, 'er-double', 505);
    push(stem, A, 'er', 506);
    push(`${stem}e`, A, 'er-e', 507);
    // bigger → big 之外还有 writer → write（-er 也是施动名词后缀），
    // 但只有前者是形容词，后者靠词性验证自然会被拒掉。
  }

  return sort(candidates);
}

function sort(candidates: LemmaCandidate[]): LemmaCandidate[] {
  // 同一词头保留分数最低的那条（最可信的解释），再整体按分数升序。
  const best = new Map<string, LemmaCandidate>();
  for (const candidate of candidates) {
    const existing = best.get(candidate.lemma);
    if (!existing || candidate.score < existing.score) best.set(candidate.lemma, candidate);
  }
  return [...best.values()].sort((a, b) => a.score - b.score);
}

/**
 * 词典条目的词性是否满足候选的要求。
 * `entryPos` 为空表示词典没存词性（用户导入的词表、短语），此时不做否证——宁可信其有。
 */
export function acceptsPos(entryPos: string, required: ReadonlySet<PartOfSpeech>): boolean {
  if (!required.size) return true;
  if (!entryPos) return true;
  for (const pos of required) if (entryPos.includes(pos)) return true;
  return false;
}

/** 词组里哪些位置值得尝试还原：跳过功能词，最多三个候选位。 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'as', 'than', 'then', 'so', 'not', 'no',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'about', 'over',
  'under', 'after', 'before', 'between', 'through', 'during', 'against', 'without', 'within',
  'up', 'down', 'out', 'off', 'away', 'back', 'again', 'very', 'too', 'also', 'just', 'only',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'there', 'here',
]);

export function isFunctionWord(word: string): boolean {
  return FUNCTION_WORDS.has(word);
}

/**
 * 词组还原：只替换**一个**词，其余原样保留。
 * `looked forward to` → `look forward to`；`was taken aback` 这种双动词的只动第一个能救的就够，
 * 同时替换两个位置会组合爆炸，收益抵不上耗时。
 */
export function phraseVariants(phrase: string, limit = 3): string[] {
  const words = phrase.split(' ');
  if (words.length < 2) return [];
  const variants: string[] = [];
  let positions = 0;
  for (let index = 0; index < words.length && positions < limit; index += 1) {
    const word = words[index];
    if (isFunctionWord(word) || !/^[a-z'’]+$/.test(word)) continue;
    positions += 1;
    for (const candidate of lemmaCandidates(word)) {
      const copy = words.slice();
      copy[index] = candidate.lemma;
      variants.push(copy.join(' '));
      if (variants.length > 24) return variants;
    }
  }
  return variants;
}
