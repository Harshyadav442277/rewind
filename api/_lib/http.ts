/**
 * Minimal request/response shapes and JSON helpers.
 *
 * These types are structurally satisfied by Vercel's `VercelRequest`/`VercelResponse`, so
 * handlers written against them deploy unchanged. They are declared locally rather than
 * imported from `@vercel/node` so that `npm run typecheck` and the tests need no Vercel
 * package installed, and so the dev-server adapter can implement them directly.
 */

import { ChainUnavailableError } from '../../server/domain/ports';

export interface ApiRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(chunk?: string): void;
}

export type Handler = (req: ApiRequest, res: ApiResponse) => Promise<void> | void;

export const ERROR_CODES = [
  'bad_request',
  'not_found',
  'conflict',
  'rate_limited',
  'method_not_allowed',
  'unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  method_not_allowed: 405,
  unavailable: 503,
  internal: 500,
};

export function sendJson(res: ApiResponse, status: number, body: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // Chain and order state changes constantly; a cached answer would show a stale refund.
  res.setHeader('cache-control', 'no-store');
  res.status(status).json(body);
}

/**
 * Errors carry a machine code, a human message and an optional `detail`. `message` is written
 * to be shown to a buyer as-is; `detail` is for a developer and may name internal fields.
 */
export function sendError(
  res: ApiResponse,
  code: ErrorCode,
  message: string,
  detail?: string,
): void {
  sendJson(res, STATUS[code], { error: { code, message, ...(detail ? { detail } : {}) } });
}

export function methodNotAllowed(res: ApiResponse, allowed: string[]): void {
  res.setHeader('allow', allowed.join(', '));
  sendError(
    res,
    'method_not_allowed',
    `Use ${allowed.join(' or ')} on this endpoint.`,
    `allowed: ${allowed.join(',')}`,
  );
}

/** Body may already be parsed by the platform, or arrive as a raw string. */
export function readJsonBody(req: ApiRequest): Record<string, unknown> {
  const { body } = req;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new BadRequest('Request body is not valid JSON.');
    }
  }
  if (typeof body === 'object') return body as Record<string, unknown>;
  throw new BadRequest('Request body is not valid JSON.');
}

export class BadRequest extends Error {
  readonly code = 'bad_request' as const;
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BadRequest';
  }
}

export function requireString(
  source: Record<string, unknown>,
  field: string,
  opts: { maxLength?: number } = {},
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`Missing "${field}".`, `${field} must be a non-empty string`);
  }
  const max = opts.maxLength ?? 4096;
  if (value.length > max) {
    throw new BadRequest(`"${field}" is too long.`, `${field} max ${max} characters`);
  }
  return value;
}

export function queryParam(req: ApiRequest, name: string): string | null {
  const value = req.query[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/** Best-effort client identity for the rate limiter. Not trusted for anything else. */
export function clientIp(req: ApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = typeof raw === 'string' ? raw.split(',')[0]?.trim() : undefined;
  return first || req.socket?.remoteAddress || 'unknown';
}

/** Wraps a handler so a thrown error becomes a JSON error rather than a stack trace. */
export function withErrors(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof BadRequest) {
        sendError(res, 'bad_request', err.message, err.detail);
        return;
      }
      if (err instanceof ChainUnavailableError) {
        // "We could not read the chain" is not "the chain disagrees". It never moves an
        // order's state and it is never a 500 — the buyer is told to wait, and polling
        // continues.
        res.setHeader('retry-after', '5');
        sendError(
          res,
          'unavailable',
          'Verification is delayed: the Nimiq node could not be reached. Nothing has been lost; this page keeps checking.',
          err.message,
        );
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      // Logged, not returned: an internal message can leak addresses and ids.
      console.error('[rewind] unhandled error', detail);
      sendError(res, 'internal', 'Something went wrong on our side.');
    }
  };
}
