/**
 * Rate limiting — STUB.
 *
 * This is an in-process token bucket. On Vercel each function instance has its own memory
 * and instances come and go, so the effective limit is "per instance, until it is recycled",
 * which is not a limit. It is here so that (a) every endpoint already has the call site, and
 * (b) local development behaves like production will.
 *
 * Before anything is public this must move to shared state (Upstash, Neon, or Vercel's own
 * firewall rules). Two separate limits are wanted and neither exists yet:
 *   - per client IP, to stop a scraper,
 *   - per outbound RPC read, because the public node allows ~20 tokens / 10 s / IP and
 *     Vercel egress addresses are shared with other tenants. The CachingChainReader reduces
 *     that pressure; it does not bound it.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export interface RateLimitOptions {
  /** Bucket capacity. */
  burst: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export const DEFAULT_LIMITS = {
  read: { burst: 60, refillPerSecond: 1 },
  write: { burst: 10, refillPerSecond: 0.2 },
  signature: { burst: 5, refillPerSecond: 0.1 },
} as const satisfies Record<string, RateLimitOptions>;

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;

export function rateLimit(
  key: string,
  options: RateLimitOptions,
  nowMs: number = Date.now(),
): RateLimitResult {
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear(); // crude, and fine for a stub
    bucket = { tokens: options.burst, updatedAtMs: nowMs };
    buckets.set(key, bucket);
  }
  const elapsedSec = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
  bucket.tokens = Math.min(options.burst, bucket.tokens + elapsedSec * options.refillPerSecond);
  bucket.updatedAtMs = nowMs;

  if (bucket.tokens < 1) {
    const waitSec = (1 - bucket.tokens) / options.refillPerSecond;
    return { allowed: false, remaining: 0, resetAtMs: nowMs + waitSec * 1000 };
  }
  bucket.tokens -= 1;
  return {
    allowed: true,
    remaining: Math.floor(bucket.tokens),
    resetAtMs: nowMs + (1 / options.refillPerSecond) * 1000,
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}
