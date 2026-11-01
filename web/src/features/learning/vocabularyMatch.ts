/**
 * 生词在正文中的匹配。
 *
 * 生词本里存的是用户收藏时选中的那个形态（多半是原形，也可能恰好是 running / studies），
 * 而正文里出现的往往是别的形态。只用「原样字符串相等」去比对，等于用户收藏了
 * `resilient` 之后，下一次看到 `resilience` 之外的 `resilient` 才有标记——换个复数、
 * 所有格、时态就全都不认了。所以这里为每个词条生成一组**词形变体**再匹配：
 *
 * - 复数 / 第三人称单数：+s、+es、y→ies、f→ves，外加一张不规则复数表；
 * - 所有格：+'s、+'（正文里的 words' 会命中 words）；
 * - 规则动词：+ed、y→ied、双写、+ing、去 e、ie→ying；
 * - 比较级 / 最高级：+er/+est（含双写与 y→i）；
 * - 反向兜底：收藏的本身是变形（running / studies / went）时，先还原成原形再展开，
 *   这样正文里出现 `run`、`runs`、`ran` 都能认出来。
 *
 * 只做「规则 + 常见不规则」的保守推导，宁可少推一点，也不要让 `us` 去命中 `uses`。
 */
import { normalizeVocabularyTerm } from '../../lib/englishLearning';

export interface VocabularyMatch {
  start: number;
  end: number;
  /** 词条在生词本里的原始写法，用来定位条目。 */
  term: string;
}

export interface VocabularyMatcher {
  /** 文本里所有生词命中，按偏移升序，互不重叠。 */
  scan(text: string): VocabularyMatch[];
  /** 参与匹配的词条数，0 时 scan 直接返回空数组。 */
  readonly size: number;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/**
 * 功能词不参与变形：`to` 加 s 变 `tos`、`up` 变 `ups` 只会制造噪音，
 * 同时词组变形要跳过它们去找真正的实词（look **forward** to）。
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'as', 'than', 'then', 'so', 'not', 'no', 'yes',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'about', 'over',
  'under', 'after', 'before', 'between', 'through', 'during', 'against', 'without', 'within',
  'up', 'down', 'out', 'off', 'away', 'back', 'again', 'very', 'too', 'also', 'just', 'only',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'there', 'here', 'who', 'what',
  'which', 'when', 'where', 'why', 'how', 'all', 'any', 'some', 'each', 'every', 'both', 'more',
  'most', 'much', 'many', 'few', 'less', 'least', 'one', 'two', 'three', 'first', 'second',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had',
]);

/** 不规则动词：原形 → 其它形态（含三单与现在分词，方便一次展开）。 */
const IRREGULAR_VERBS: Record<string, string[]> = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
  bear: ['bore', 'borne', 'born', 'bears', 'bearing'],
  beat: ['beaten', 'beats', 'beating'],
  become: ['became', 'becomes', 'becoming'],
  begin: ['began', 'begun', 'begins', 'beginning'],
  bend: ['bent', 'bends', 'bending'],
  bet: ['bets', 'betting'],
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

/** 以 s 结尾但不是复数的词：剥掉 -s 会得到另一个真实单词，必须跳过。 */
const NOT_PLURAL = new Set([
  'news', 'series', 'species', 'means', 'physics', 'mathematics', 'economics', 'politics',
  'ethics', 'statistics', 'gymnastics', 'athletics', 'measles', 'diabetes', 'headquarters',
  'scissors', 'trousers', 'clothes', 'always', 'perhaps', 'across', 'unless', 'whereas',
  'towards', 'afterwards', 'besides', 'indeed',
]);

let reverseVerb: Map<string, string> | null = null;
let reversePlural: Map<string, string> | null = null;

function irregularReverse(): { verb: Map<string, string>; plural: Map<string, string> } {
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

function isConsonant(char: string): boolean {
  return char >= 'a' && char <= 'z' && !VOWELS.has(char);
}

function vowelGroups(word: string): number {
  return (word.match(/[aeiouy]+/g) ?? []).length;
}

/** 词尾是否「辅音-元音-辅音」，且该辅音值得双写（stop → stopped，但 play → played）。 */
function doublesFinal(word: string): boolean {
  if (word.length < 3) return false;
  const last = word.at(-1)!;
  const prev = word.at(-2)!;
  const prev2 = word.at(-3)!;
  if (!isConsonant(last) || 'wxy'.includes(last)) return false;
  if (!VOWELS.has(prev)) return false;
  if (VOWELS.has(prev2)) {
    // quit / quiz 里的 qu 是一个辅音，u 不发音
    return prev2 === 'u' && word.at(-4) === 'q';
  }
  return true;
}

/**
 * 双写规则本身只看拼写，重音判断不了（visit 不双写、admit 双写）。
 * 多音节时两种写法都收：宁可多一类候选，也不要漏掉用户真正遇到的那个。
 */
function doublingCandidates(word: string): string[] {
  if (!doublesFinal(word)) return [];
  return vowelGroups(word) <= 1 ? [word + word.at(-1)] : [word + word.at(-1), word];
}

function addPlural(word: string, out: Set<string>): void {
  if (IRREGULAR_PLURALS[word]) {
    out.add(IRREGULAR_PLURALS[word]);
    return;
  }
  if (/[sxz]$/.test(word) || /(ch|sh)$/.test(word)) {
    out.add(`${word}es`);
  } else if (/[^aeiou]y$/.test(word)) {
    out.add(`${word.slice(0, -1)}ies`);
  } else if (/fe$/.test(word)) {
    out.add(`${word.slice(0, -2)}ves`);
    out.add(`${word}s`);
  } else if (/f$/.test(word)) {
    out.add(`${word.slice(0, -1)}ves`);
    out.add(`${word}s`);
  } else if (/o$/.test(word)) {
    // potato → potatoes 但 photo → photos，两种都收。
    out.add(`${word}es`);
    out.add(`${word}s`);
  } else {
    out.add(`${word}s`);
  }
}

function addPast(word: string, out: Set<string>): void {
  if (word.endsWith('e')) {
    out.add(`${word}d`);
  } else if (/[^aeiou]y$/.test(word)) {
    out.add(`${word.slice(0, -1)}ied`);
    out.add(`${word}ed`);
  } else {
    for (const stem of doublingCandidates(word)) out.add(`${stem}ed`);
    if (!doublesFinal(word)) out.add(`${word}ed`);
  }
}

function addProgressive(word: string, out: Set<string>): void {
  if (word.endsWith('ie')) {
    out.add(`${word.slice(0, -2)}ying`);
  } else if (word.endsWith('e') && !/(ee|ye|oe)$/.test(word)) {
    out.add(`${word.slice(0, -1)}ing`);
    out.add(`${word}ing`);
  } else {
    for (const stem of doublingCandidates(word)) out.add(`${stem}ing`);
    if (!doublesFinal(word)) out.add(`${word}ing`);
  }
}

function addComparison(word: string, out: Set<string>): void {
  const bases: string[] = [];
  if (/[^aeiou]y$/.test(word)) {
    bases.push(`${word.slice(0, -1)}i`);
  } else if (word.endsWith('e')) {
    bases.push(word);
    bases.push(word.slice(0, -1));
  } else {
    bases.push(...doublingCandidates(word));
    if (!doublesFinal(word)) bases.push(word);
  }
  for (const base of bases) {
    out.add(`${base}er`);
    out.add(`${base}est`);
  }
}

/**
 * 生成一个单词的全部候选形态（都是小写、无连字符的键）。
 *
 * 只对纯字母词做变形：带数字、下划线、撇号的词（AI、e-mail、it's）原样匹配即可，
 * 硬变形只会产生永远匹配不到的垃圾键。
 */
function inflectWord(word: string): Set<string> {
  const out = new Set<string>([word]);
  if (!/^[a-z]+$/.test(word) || word.length < 2) return out;
  const irregular = IRREGULAR_VERBS[word];
  if (irregular) {
    for (const form of irregular) out.add(form);
  }
  if (FUNCTION_WORDS.has(word) && !irregular) return out;

  addPlural(word, out);
  addPast(word, out);
  addProgressive(word, out);
  if (word.length >= 4) addComparison(word, out);
  // 所有格：word's / words'
  out.add(`${word}'s`);
  for (const plural of [...out]) out.add(`${plural}'`);

  // 拼写有重复字母的词（refer → referred）由 doublingCandidates 兜住；
  // -c 结尾还要补一个 -ck-（picnic → picnicked），英语里只有这一种例外写法。
  if (/c$/.test(word)) {
    out.add(`${word}ked`);
    out.add(`${word}king`);
  }
  return out;
}

/**
 * 反向推导：从一个变形猜出可能的原形。
 *
 * 这一步是为了「用户收藏的是变形」的情况——收藏了 `running`，正文里出现 `run`
 * 也应当标记。候选会有多个（boxes → boxe / box），全部收下即可，多收不会误伤，
 * 因为最终还要和词条本身的语义对上。
 */
function lemmas(word: string): Set<string> {
  const out = new Set<string>([word]);
  if (!/^[a-z]+$/.test(word) || word.length < 3) return out;
  const add = (candidate: string) => {
    if (candidate.length >= 2) out.add(candidate);
  };
  const { verb, plural } = irregularReverse();
  if (verb.has(word)) add(verb.get(word)!);
  if (plural.has(word)) add(plural.get(word)!);
  // news / means / physics 这些以 s 结尾的「单数」：任何剥离都会得到另一个真词，直接不拆。
  if (NOT_PLURAL.has(word)) return out;

  if (word.endsWith('ies') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  } else if (word.endsWith('s') && !/(ss|us|is)$/.test(word) && !NOT_PLURAL.has(word)) {
    add(word.slice(0, -1));
  }

  if (word.endsWith('ied') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ed') && word.length > 3) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
    // stopped → stop / planned → plan
    if (word.at(-3) === word.at(-4)) add(word.slice(0, -3));
  }

  if (word.endsWith('ying') && word.length > 5) {
    add(`${word.slice(0, -4)}ie`);
    add(`${word.slice(0, -4)}y`);
  } else if (word.endsWith('ing') && word.length > 4) {
    add(word.slice(0, -3));
    add(`${word.slice(0, -3)}e`);
    // running → run / sitting → sit
    if (word.at(-4) === word.at(-5)) add(word.slice(0, -4));
  }

  if (word.endsWith('iest') && word.length > 5) add(`${word.slice(0, -4)}y`);
  else if (word.endsWith('ier') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('est') && word.length > 4) {
    add(word.slice(0, -3));
    add(word.slice(0, -2));
  }
  if (word.endsWith('er') && word.length > 3) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
    if (word.at(-3) === word.at(-4)) add(word.slice(0, -3));
  }
  for (const candidate of [...out]) {
    if (/[^aeiou]i$/.test(candidate)) add(`${candidate.slice(0, -1)}y`);
  }
  return out;
}

/**
 * 比较用的键：大小写、全半角、撇号与连字符统一。
 * 连字符与空格等价（well-being = well being），撇号则保留（it's 不能拆成 it s）。
 */
export function vocabularyMatchKey(text: string): string {
  return normalizeVocabularyTerm(text)
    .replace(/[\u2010-\u2014]/g, '-')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 词组只变第一个实词：look forward to → looks forward to / looked forward to。 */
function expandTerm(key: string): Set<string> {
  const words = key.split(' ').filter(Boolean);
  if (!words.length) return new Set();
  const out = new Set<string>();
  const target = words.length === 1 ? 0 : Math.max(0, words.findIndex((word) => !FUNCTION_WORDS.has(word)));
  const head = words[target];
  const heads = new Set<string>([head]);
  for (const form of inflectWord(head)) heads.add(form);
  // 先把可能已经变形的词还原成原形，再展开一次：running → run → runs / ran / running。
  for (const candidate of lemmas(head)) heads.add(candidate);
  for (const candidate of [...heads]) {
    for (const form of inflectWord(candidate)) heads.add(form);
  }
  for (const form of heads) {
    const copy = words.slice();
    copy[target] = form;
    out.add(copy.join(' '));
  }
  out.add(key);
  return out;
}

const TOKEN_PATTERN = /[\p{L}\p{N}\p{M}_]+(?:['’‘][\p{L}\p{N}\p{M}_]+)*/gu;

interface Token {
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(text))) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

const JOINER_PATTERN = /^[\s\-‐‑–—]*$/;

export function createVocabularyMatcher(terms: readonly string[]): VocabularyMatcher {
  const surfaces = new Map<string, string>();
  const exact: Array<{ key: string; term: string }> = [];
  for (const term of terms) {
    const key = vocabularyMatchKey(term);
    if (!key) continue;
    exact.push({ key, term });
  }
  // 精确形态优先登记：同一个键同时是「某词条原文」和「另一词条的变体」时，按原文算。
  for (const item of exact) if (!surfaces.has(item.key)) surfaces.set(item.key, item.term);
  for (const item of exact) {
    for (const form of expandTerm(item.key)) {
      if (!surfaces.has(form)) surfaces.set(form, item.term);
    }
  }

  let maxWords = 1;
  for (const key of surfaces.keys()) {
    const count = key.split(' ').length;
    if (count > maxWords) maxWords = Math.min(count, 6);
  }

  return {
    size: surfaces.size,
    scan(text: string): VocabularyMatch[] {
      if (!text || !surfaces.size) return [];
      const tokens = tokenize(text);
      // 词与词之间只允许空白和连字符：否则 "give. Up" 这种跨句拼接会被当成词组。
      const gaps = tokens.slice(0, -1).map((token, index) => text.slice(token.end, tokens[index + 1].start));
      const matches: VocabularyMatch[] = [];
      let index = 0;
      while (index < tokens.length) {
        let found: { term: string; length: number } | null = null;
        const maxLength = Math.min(maxWords, tokens.length - index);
        for (let length = maxLength; length >= 1; length -= 1) {
          let joined = true;
          for (let offset = 0; offset < length - 1; offset += 1) {
            if (!JOINER_PATTERN.test(gaps[index + offset])) {
              joined = false;
              break;
            }
          }
          if (!joined) continue;
          const start = tokens[index].start;
          const end = tokens[index + length - 1].end;
          const term = surfaces.get(vocabularyMatchKey(text.slice(start, end)));
          if (term) {
            found = { term, length };
            break;
          }
        }
        if (found) {
          matches.push({
            start: tokens[index].start,
            end: tokens[index + found.length - 1].end,
            term: found.term,
          });
          index += found.length;
        } else {
          index += 1;
        }
      }
      return matches;
    },
  };
}
