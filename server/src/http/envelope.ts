import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorMessage } from '../lib/utils';

export class AppError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  readonly fields?: Record<string, string>;

  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode = 500,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export class ValidationError extends AppError {
  constructor(message = '请求参数不合法', fields?: Record<string, string>) {
    super('validation_error', message, 400, fields);
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super('not_found', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = '资源已存在', fields?: Record<string, string>) {
    super('conflict', message, 409, fields);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未授权的本地访问') {
    super('unauthorized', message, 401);
  }
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true, data }, status);
}

export function fail(c: Context, err: unknown) {
  if (err instanceof AppError) {
    const error: ApiErrorBody = { code: err.code, message: err.message };
    if (err.fields) error.fields = err.fields;
    return c.json({ ok: false, error }, err.status);
  }

  console.error('[api] unhandled error', err);
  return c.json(
    {
      ok: false,
      error: {
        code: 'internal_error',
        message: '服务暂时不可用，请稍后重试',
        detail: errorMessage(err),
      },
    },
    // 本地单用户场景下把真实原因带出去，排查明显更省事。
    500,
  );
}

/** 统一包裹路由处理函数，省掉每个 handler 里重复的 try/catch。 */
export function handle<T extends Context>(fn: (c: T) => Promise<Response> | Response) {
  return async (c: T): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      return fail(c, err);
    }
  };
}
