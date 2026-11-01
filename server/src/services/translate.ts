import { JSDOM } from 'jsdom';
import type { StoredArticleContent } from '../domain/articles';
import { getArticleContent, saveTitleTranslation, saveBodyTranslation } from '../domain/articles';
import { getFeed } from '../domain/feeds';
import { getSettings, resolveAiRuntime } from '../domain/settings';
import { writeLog } from '../domain/logs';
import { chatStream, chatComplete, extractJson } from './ai';
import {
  BODY_TRANSLATION_SYSTEM_PROMPT,
  DEFAULT_ENGLISH_LEARNING_PROMPT,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
  DEFAULT_WORD_DETAIL_PROMPT,
  resolvePromptOrDefault,
  withConciseSuffix,
} from './prompts';
import {
  ENGLISH_LEARNING_MAX_SELECTED_CHARS,
  ENGLISH_LEARNING_MAX_SENTENCES,
  ENGLISH_LEARNING_MAX_SENTENCE_CHARS,
  ENGLISH_LEARNING_MAX_OUTPUT_TOKENS,
  WORD_DETAIL_MAX_OUTPUT_TOKENS,
  truncateForPrompt,
  truncateLearningContext,
} from '../lib/englishLearning';
import { htmlToText, truncate } from '../lib/utils';
import { NotFoundError, ValidationError } from '../http/envelope';

/**
 * 中文原文再翻成中文没有意义：既多花 token，结果还比原文差。
 * 这里只做「要不要翻」的判定，正文分段过滤（extractSegments）仍保持原样，
 * 避免同一件事有两套标准。
 */

/** 正文里 CJK 字符（相对 CJK + 拉丁字母）占比超过这个值，就当作中文原文。 */
const CJK_RATIO_THRESHOLD = 0.4;
/** 抽样上限：只取开头这么多字，长文没必要全量统计。 */
const LANGUAGE_SAMPLE_CHARS = 4_000;

interface LanguageSample {
  sourceLanguage: string | null;
  contentHtml: string | null;
  contentFullHtml?: string | null;
}

function normalizeLanguageTag(raw: string | null | undefined): string | null {
  const tag = raw?.trim().toLowerCase();
  return tag ? tag : null;
}

/**
 * zh 系语言标记分两类：大陆/新马/显式简体不用翻，港澳台/显式繁体要翻（繁转简）。
 * 不带细分的中文（`zh`）按简体处理：现有解析层就只产出 `zh`。
 */
function classifyChinese(tag: string): 'simplified' | 'traditional' | null {
  if (!tag.startsWith('zh')) return null;
  if (tag.includes('hant') || tag.includes('-tw') || tag.includes('-hk') || tag.includes('-mo')) {
    return 'traditional';
  }
  return 'simplified';
}

function cjkRatio(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  const total = cjk + latin;
  // 纯标点/数字/表情的正文没法统计占比，交给调用方按「可翻」处理。
  return total === 0 ? 0 : cjk / total;
}

/** 判断这段内容是否值得送去「翻译成中文」。 */
export function isTranslatableTarget(sample: LanguageSample): boolean {
  const tag = normalizeLanguageTag(sample.sourceLanguage);
  if (tag) {
    const kind = classifyChinese(tag);
    if (kind === 'simplified') return false;
    if (kind === 'traditional') return true;
    // 已经明确是别的语种（en / ja / ko / ru…）就直接可翻。
    // 不能再退回「汉字占比」判断：日文长文里汉字比例同样很高，会被误判成中文原文。
    return true;
  }

  const text = htmlToText(sample.contentFullHtml || sample.contentHtml || '').slice(0, LANGUAGE_SAMPLE_CHARS);
  if (!text) return true;
  return cjkRatio(text) <= CJK_RATIO_THRESHOLD;
}

/** 中文原文与播客（音视频）内容都不该再送模型，这里统一给出面向用户的中文提示。 */
function assertTranslatable(article: StoredArticleContent, sampleHtml: string): void {
  // 播客页面的「正文」只是节目简介，音视频本身没法翻，直接挡在入口。
  if (getFeed(article.feedId)?.isPodcast) {
    throw new ValidationError('这是播客（音视频）内容，没有可翻译的正文');
  }
  if (!isTranslatableTarget({ sourceLanguage: article.sourceLanguage, contentHtml: sampleHtml })) {
    throw new ValidationError('这篇是中文原文，不需要翻译');
  }
}

export interface SummaryInput {
  articleId: string;
  signal?: AbortSignal;
}

/** 摘要输入统一走纯文本，避免把整页 HTML 标签也算进 token。 */
export function buildSummarySource(articleId: string, max = 14_000): { text: string; title: string } {
  const article = getArticleContent(articleId);
  if (!article) throw new NotFoundError('文章不存在');
  const html = article.contentFullHtml || article.contentHtml || article.summary || '';
  const text = truncate(htmlToText(html), max);
  if (!text) throw new Error('这篇文章没有可用的正文内容，请先抓取全文');
  return { text, title: article.title };
}

export async function* streamArticleSummary(input: SummaryInput): AsyncGenerator<string> {
  const settings = getSettings();
  const cfg = resolveAiRuntime('summary');
  const { text, title } = buildSummarySource(input.articleId);

  const systemPrompt = withConciseSuffix(
    resolvePromptOrDefault(settings.ai.summaryPrompt, DEFAULT_SUMMARY_PROMPT),
    true,
  );

  yield* chatStream(
    cfg,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `标题：${title}\n\n正文：\n${text}` },
    ],
    { temperature: 0.2, signal: input.signal, timeoutMs: 180_000 },
  );
}

export async function translateArticleTitle(articleId: string, signal?: AbortSignal): Promise<string> {
  const article = getArticleContent(articleId);
  if (!article) throw new NotFoundError('文章不存在');
  // 标题的语言判定跟正文分开做：有些源标题是英文、正文是中文。
  assertTranslatable(article, article.title);
  const settings = getSettings();
  const cfg = resolveAiRuntime('translation');
  const prompt = resolvePromptOrDefault(settings.ai.translationPrompt, DEFAULT_TRANSLATION_PROMPT);

  const result = await chatComplete(
    cfg,
    [
      { role: 'system', content: `${prompt}\n只输出译文本身，不要引号、不要解释。` },
      { role: 'user', content: article.title },
    ],
    { temperature: 0.1, timeoutMs: 60_000, signal },
  );

  const cleaned = result.trim().replace(/^["“]|["”]$/g, '');
  saveTitleTranslation(articleId, cleaned);
  return cleaned;
}

/**
 * 哪些段落值得送去翻译。
 *
 * 这个判定必须由「切分」和「回填」共用：两边标准不一致时，回填用的序号就会和
 * 分段的 id 错位一格，译文整篇前移，把真实段落覆盖掉。文字判定用 \p{L}
 * 而不是只认拉丁与汉字，否则韩文、俄文、阿拉伯文正文会被判成「没有可翻译的段落」。
 */
function isTranslatableBlock(text: string): boolean {
  return text.length >= 2 && /\p{L}/u.test(text);
}

const TRANSLATABLE_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td';

export interface BodySegment {
  id: number;
  text: string;
}

export function extractSegments(html: string): { segments: BodySegment[]; dom: JSDOM | null } {
  const dom = new JSDOM(`<body>${html}</body>`);
  const blocks = [...dom.window.document.body.querySelectorAll(TRANSLATABLE_SELECTOR)];

  const segments: BodySegment[] = [];
  for (const block of blocks) {
    // 只翻译没有可翻译子块的最内层节点，避免同一段文字被父节点重复计入。
    if (block.querySelector(TRANSLATABLE_SELECTOR)) continue;
    const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!isTranslatableBlock(text)) continue;
    segments.push({ id: segments.length + 1, text: truncate(text, 3000) });
  }

  return { segments, dom };
}

export interface BodyTranslationProgress {
  translated: Array<{ id: number; text: string }>;
}

export interface BodyTranslationResult {
  zhHtml: string;
  bilingualHtml: string;
  totalSegments: number;
  translatedSegments: number;
}

const BATCH_SIZE = 8;

/** 正文翻译：分批请求模型，边翻边回传，最后一次性产出双语 HTML。 */
export async function* streamBodyTranslation(
  articleId: string,
  signal?: AbortSignal,
): AsyncGenerator<BodyTranslationProgress | BodyTranslationResult> {
  const article = getArticleContent(articleId);
  if (!article) throw new NotFoundError('文章不存在');

  const html = article.contentFullHtml || article.contentHtml || '';
  if (!html) throw new Error('这篇文章没有可用的正文内容，请先抓取全文');

  // 语种判定放在分段之前：中文原文直接失败，连一句都不发给模型。
  assertTranslatable(article, html);

  const { segments, dom } = extractSegments(html);
  if (!dom) throw new Error('正文结构无法解析');

  if (segments.length === 0) throw new Error('正文中没有可翻译的段落');

  const settings = getSettings();
  const cfg = resolveAiRuntime('translation');
  const prompt = resolvePromptOrDefault(settings.ai.translationPrompt, DEFAULT_TRANSLATION_PROMPT);

  const translations = new Map<number, string>();
  const streamedSoFar: Array<{ id: number; text: string }> = [];

  for (let offset = 0; offset < segments.length; offset += BATCH_SIZE) {
    const batch = segments.slice(offset, offset + BATCH_SIZE);
    const payload = JSON.stringify(batch.map((segment) => ({ id: segment.id, text: segment.text })));

    try {
      const raw = await chatComplete(
        cfg,
        [
          {
            role: 'system',
            content: `${BODY_TRANSLATION_SYSTEM_PROMPT}\n\n${prompt}`,
          },
          { role: 'user', content: payload },
        ],
        { temperature: 0.1, timeoutMs: 120_000, signal },
      );

      const parsed = extractJson<Array<{ id: number; text: string }> | { segments: Array<{ id: number; text: string }> }>(
        raw,
      );
      const items = Array.isArray(parsed) ? parsed : parsed?.segments ?? [];
      for (const item of items) {
        if (typeof item?.id !== 'number' || typeof item?.text !== 'string') continue;
        const value = item.text.trim();
        if (!value) continue;
        translations.set(item.id, value);
        streamedSoFar.push({ id: item.id, text: value });
      }
      yield { translated: streamedSoFar };
    } catch (err) {
      writeLog({
        level: 'warning',
        category: 'ai_translate',
        message: '正文翻译批次失败，已跳过该批次',
        source: 'services/translate',
        details: err instanceof Error ? err.message : String(err),
        context: { articleId, offset, size: batch.length },
      });
    }
  }

  if (translations.size === 0) {
    throw new Error('翻译没有返回可用结果，请检查 AI 配置后重试');
  }

  const { zhHtml, bilingualHtml } = applyTranslations(html, translations);
  dom.window.close();

  saveBodyTranslation(articleId, { zhHtml, bilingualHtml });

  // 结果必须 yield 出去：`for await` 只接收 yield 的值，生成器的 return 会被丢弃，
  // 路由就永远发不出 done 事件（前端会一直停在「翻译中」，译文也不显示）。
  yield {
    zhHtml,
    bilingualHtml,
    totalSegments: segments.length,
    translatedSegments: translations.size,
  };
}

/**
 * 把译文回填进正文，同时产出「仅译文」与「双语」两份 HTML。
 *
 * 独立成纯函数有两个原因：这条映射最容易错位（分段与回填的筛选标准必须完全一致），
 * 抽出来才能在单测里卡住；另外它也是唯一需要碰 DOM 的地方，好定位。
 */
export function applyTranslations(
  html: string,
  translations: Map<number, string>,
): { zhHtml: string; bilingualHtml: string } {
  const bilingualDom = new JSDOM(`<body>${html}</body>`);
  const zhDom = new JSDOM(`<body>${html}</body>`);

  try {
    const collectBlocks = (dom: JSDOM) =>
      [...dom.window.document.body.querySelectorAll(TRANSLATABLE_SELECTOR)].filter(
        (block) => !block.querySelector(TRANSLATABLE_SELECTOR),
      );

    let index = 0;
    for (const block of collectBlocks(bilingualDom)) {
      const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
      // 与 extractSegments 用同一个判定，序号才能和 segment.id 一一对应。
      if (!isTranslatableBlock(text)) continue;
      index += 1;
      const translation = translations.get(index);
      if (!translation) continue;
      const doc = bilingualDom.window.document;
      const wrapper = doc.createElement('div');
      wrapper.className = 'ff-translation';
      wrapper.setAttribute('data-ff-translation', String(index));
      wrapper.textContent = translation;
      block.insertAdjacentElement('afterend', wrapper);
    }

    index = 0;
    for (const block of collectBlocks(zhDom)) {
      const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!isTranslatableBlock(text)) continue;
      index += 1;
      const translation = translations.get(index);
      if (!translation) continue;
      block.textContent = translation;
    }

    return {
      bilingualHtml: bilingualDom.window.document.body.innerHTML,
      zhHtml: zhDom.window.document.body.innerHTML,
    };
  } finally {
    bilingualDom.window.close();
    zhDom.window.close();
  }
}

export interface ExplanationInput {
  articleId: string;
  /** 完整选区文本（已由前端补全被截断的单词）。 */
  selectedText: string;
  /** 选区覆盖的完整句子，按原顺序；用于让模型看到完整语境。 */
  sentences: string[];
  /** 选区所在段落的原文；为空时退化为只依据句子讲解。 */
  context?: string;
  signal?: AbortSignal;
}

/** 精读链路统一送给模型的负载：截断到预算内，避免整段长文推高首 token 耗时。 */
function buildLearningPayload(input: {
  selectedText: string;
  sentences: string[];
  context?: string;
  term?: string;
}): string {
  return JSON.stringify({
    ...(input.term ? { term: input.term } : {}),
    selectedText: truncateForPrompt(input.selectedText, ENGLISH_LEARNING_MAX_SELECTED_CHARS),
    sentences: input.sentences
      .slice(0, ENGLISH_LEARNING_MAX_SENTENCES)
      .map((sentence) => truncateForPrompt(sentence, ENGLISH_LEARNING_MAX_SENTENCE_CHARS)),
    context: truncateLearningContext(input.context),
  });
}

/** 英文精读讲解：结合上下文给出译文和关键点（SSE 流式）。 */
export async function* streamSentenceExplanation(input: ExplanationInput): AsyncGenerator<string> {
  const settings = getSettings();
  const cfg = resolveAiRuntime('english');
  const prompt = resolvePromptOrDefault(
    settings.ai.englishLearningPrompt,
    DEFAULT_ENGLISH_LEARNING_PROMPT,
  );

  const article = getArticleContent(input.articleId);

  yield* chatStream(
    cfg,
    [
      {
        role: 'system',
        content: withConciseSuffix(prompt, true),
      },
      {
        role: 'user',
        content: [
          article ? `文章标题：${article.title}` : null,
          buildLearningPayload(input),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    {
      temperature: 0.2,
      maxTokens: ENGLISH_LEARNING_MAX_OUTPUT_TOKENS,
      timeoutMs: 90_000,
      retries: 0,
      signal: input.signal,
    },
  );
}

export interface WordDetailInput {
  articleId: string;
  /** 词卡实际查询/收藏的整词。 */
  term: string;
  selectedText: string;
  sentences: string[];
  context?: string;
  signal?: AbortSignal;
}

/**
 * 单词「详细解释」：词典释义读不懂时的一次性深挖。
 *
 * 固定使用内置提示词，不读取设置里的句子讲解提示词，
 * 避免两种讲解风格互相污染。
 */
export async function* streamWordDetail(input: WordDetailInput): AsyncGenerator<string> {
  const cfg = resolveAiRuntime('english');
  const article = getArticleContent(input.articleId);

  yield* chatStream(
    cfg,
    [
      {
        role: 'system',
        content: withConciseSuffix(DEFAULT_WORD_DETAIL_PROMPT, true),
      },
      {
        role: 'user',
        content: buildLearningPayload(input),
      },
    ],
    {
      temperature: 0.2,
      maxTokens: WORD_DETAIL_MAX_OUTPUT_TOKENS,
      timeoutMs: 90_000,
      retries: 0,
      signal: input.signal,
    },
  );
}
