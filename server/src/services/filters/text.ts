import { createHash } from 'node:crypto';

/**
 * 文本归一化工具。
 *
 * 这里全是纯函数：不碰数据库、不读设置，方便复用与单独验证。
 * 归一化结果会被持久化到 articles 表（url_normalized / title_normalized /
 * content_fingerprint），所以同一份内容必须永远算出同一个值——一旦改动算法，
 * 老数据就会和新数据对不上，只能靠回溯重判来刷新。
 */

/** 常见的投放/追踪参数：同一篇文章带不同 utm 就是不同 URL，不剪掉会大量漏判。 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'source',
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * 归一化 URL：host 小写、剪掉追踪参数、参数按 key 排序、去默认端口与末尾斜杠、丢弃 hash。
 * 解析失败返回 null——宁可不去重，也不要拿一个坏字符串去和全库比。
 */
export function normalizeUrl(url: string): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // mailto:、javascript: 之类解析成功但没有主机名，不能参与去重。
  if (!parsed.hostname) return null;

  // URL 构造器已经会把 80/443 折算成空端口，这里只处理非默认端口。
  const port = parsed.port ? `:${parsed.port}` : '';

  const params = [...parsed.searchParams.entries()].filter(([key]) => !isTrackingParam(key));
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const query = params.length
    ? `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`
    : '';

  // 尾部斜杠只影响写法不影响内容；根路径本身也要收成空串。
  const path = parsed.pathname.replace(/\/+$/, '');

  return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${port}${path}${query}`;
}

/**
 * 归一化标题：NFKC 摊平全角/兼容字符 → 小写 → 标点与空白折叠成单个空格。
 * 标题里常见的「【】」「—」「｜」都是排版噪声，先把它们抹平才好比较。
 */
export function normalizeTitle(title: string): string {
  return (title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\s]+/gu, ' ')
    .trim();
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '"',
  rdquo: '"',
  mdash: '-',
  hellip: ' ',
};

function decodeCodePoint(value: number, fallback: string): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16), ' '),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => decodeCodePoint(Number(dec), ' '))
    .replace(/&([a-z0-9]+);/gi, (_, name: string) => ENTITIES[name.toLowerCase()] ?? ' ');
}

/** 正文太少时任何指纹都没有区分度，直接用阈值挡掉。 */
const MIN_FINGERPRINT_LENGTH = 80;
/** 3-gram：二元组太容易撞，四元以上对改标题的转载又不敏感。 */
const SHINGLE_SIZE = 3;

function shinglesOf(tokens: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i += 1) {
    result.push(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return result;
}

/** 中文没有空格，按空白切只能得到一个 token，退回字符级 3-gram 才能算出有效指纹。 */
function charShinglesOf(text: string): string[] {
  const compact = text.replace(/\s+/g, '');
  const result: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= compact.length; i += 1) {
    result.push(compact.slice(i, i + SHINGLE_SIZE));
  }
  return result;
}

function hashTo64Bits(shingle: string): bigint {
  const digest = createHash('sha1').update(shingle).digest();
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) | BigInt(digest[i]);
  }
  return value;
}

/**
 * 内容指纹（64 位 SimHash，16 位十六进制）。
 * 同一篇稿件被不同站点转载时正文几乎一致，SimHash 对少量增删不敏感，
 * 比逐字比较更实用。文本不足 80 字符返回 null。
 */
export function contentFingerprint(html: string): string | null {
  const text = stripHtml(html ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < MIN_FINGERPRINT_LENGTH) return null;

  const tokens = text.split(' ').filter((token) => token.length >= 2 && !/^\d+$/.test(token));
  const shingles = tokens.length >= SHINGLE_SIZE ? shinglesOf(tokens) : charShinglesOf(text);
  if (shingles.length === 0) return null;

  const weights = new Array<number>(64).fill(0);
  for (const shingle of shingles) {
    const hash = hashTo64Bits(shingle);
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] += (hash >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint.toString(16).padStart(16, '0');
}

const HEX64 = /^[0-9a-f]{16}$/i;

function parseHex64(value: string): bigint | null {
  if (!HEX64.test(value)) return null;
  return BigInt(`0x${value}`);
}

function popcount(value: bigint): number {
  let count = 0;
  let remaining = value;
  while (remaining > 0n) {
    count += Number(remaining & 1n);
    remaining >>= 1n;
  }
  return count;
}

/** 两个 16 位 hex 指纹的相似度（0~1）；任一侧格式不合法按「完全不相似」处理。 */
export function hammingSimilarity(a: string, b: string): number {
  const left = parseHex64(a ?? '');
  const right = parseHex64(b ?? '');
  if (left === null || right === null) return 0;
  return 1 - popcount(left ^ right) / 64;
}

/**
 * 把 64 位指纹切成 4 段 16 位，用于 LSH 分带查候选。
 *
 * 直接把整个指纹丢进 SQL 做相等比较只能抓到逐字相同的转载；
 * 分带之后「任一段相同」都算候选，再由 `hammingSimilarity` 精确判定。
 */
export function fingerprintBands(fingerprint: string): string[] {
  if (!HEX64.test(fingerprint ?? '')) return [];
  return [
    fingerprint.slice(0, 4),
    fingerprint.slice(4, 8),
    fingerprint.slice(8, 12),
    fingerprint.slice(12, 16),
  ];
}
