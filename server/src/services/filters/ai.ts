import { resolveAiRuntime } from '../../domain/settings';
import { htmlToText, truncate } from '../../lib/utils';
import { chatComplete } from '../ai';

export type AiVerdict = 'filter' | 'allow';

export interface AiJudgeInput {
  title: string;
  text: string;
}

/** 只输出一个词，8 个 token 足够；给多了反而会让模型开始解释理由，解析成本上升。 */
const MAX_OUTPUT_TOKENS = 8;
const TIMEOUT_MS = 30_000;
/** 过滤判断看开头就够，长正文只会抬高成本，还会稀释用户提示词的权重。 */
const MAX_BODY_CHARS = 4000;

const SYSTEM_PROMPT = '你是内容过滤器，只输出 FILTER 或 ALLOW 其中一个词';

/**
 * AI 语义过滤：让模型按用户自定义的提示词判断「这篇文章值不值得留」。
 *
 * 与摘要共用同一套 AI 运行时配置，用户不必再填一遍地址和 Key。
 * 输出既不是 FILTER 也不是 ALLOW 时直接抛错：调用方会把状态记成 error 并保留文章，
 * 绝对不能因为一次模型抽风就把文章藏起来。
 */
export async function judgeArticle(input: AiJudgeInput, prompt: string): Promise<AiVerdict> {
  const cfg = resolveAiRuntime('summary');
  const body = truncate(htmlToText(input.text), MAX_BODY_CHARS);

  const answer = await chatComplete(
    cfg,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `过滤要求：${prompt.trim()}`,
          '',
          `标题：${input.title}`,
          '',
          `正文：\n${body}`,
        ].join('\n'),
      },
    ],
    { temperature: 0, maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS },
  );

  const verdict = answer.toUpperCase();
  if (verdict.includes('FILTER')) return 'filter';
  if (verdict.includes('ALLOW')) return 'allow';
  throw new Error(`AI 过滤判定返回了无法识别的结果：${answer.trim().slice(0, 40) || '(空)'}`);
}
