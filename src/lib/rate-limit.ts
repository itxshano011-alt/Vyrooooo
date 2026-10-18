import { rateLimited } from "./api-errors";

/**
 * In-memory sliding-window rate limiter.
 *
 * Keyed by user id when the caller is authenticated, falling back to the
 * client IP for anonymous routes (username availability checks). State lives
 * in the server process memory: it is per-instance, not shared across
 * replicas. That is acceptable for abuse-throttling at VYRO's scale; a
 * Redis/Upstash-backed limiter should replace this if the app is ever
 * deployed with multiple server instances.
 *
 * Buckets are pruned lazily on each check and on a 60s interval timer, so
 * memory stays proportional to the number of recently active keys.
 */

export interface LimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max allowed requests per window per key. */
  max: number;
}

export interface RateLimiter {
  readonly windowMs: number;
  readonly max: number;
  check(key: string): { allowed: boolean; retryAfterMs: number };
}

function createLimiter({ windowMs, max }: LimiterOptions): RateLimiter {
  const buckets = new Map<string, number[]>();

  const prune = (now: number) => {
    for (const [key, timestamps] of buckets) {
      while (timestamps.length > 0 && timestamps[0]! <= now - windowMs) {
        timestamps.shift();
      }
      if (timestamps.length === 0) buckets.delete(key);
    }
  };

  // Periodic cleanup so idle keys do not accumulate forever. In a
  // serverless environment the timer simply never fires for long; pruning
  // also happens lazily on every check.
  setInterval(() => prune(Date.now()), 60_000);

  return {
    windowMs,
    max,
    check(key: string) {
      const now = Date.now();
      let timestamps = buckets.get(key);
      if (!timestamps) {
        timestamps = [];
        buckets.set(key, timestamps);
      }
      while (timestamps.length > 0 && timestamps[0]! <= now - windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= max) {
        const retryAfterMs = timestamps[0]! + windowMs - now;
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
      }
      timestamps.push(now);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Exported limiters, one per abuse surface.
// ---------------------------------------------------------------------------

/** Sensitive account operations (username checks, account deletion). */
export const authLimiter = createLimiter({ windowMs: 10 * 60_000, max: 30 });
/** Signed upload URL issuance. */
export const uploadLimiter = createLimiter({ windowMs: 60 * 60_000, max: 30 });
/** Comment creation. */
export const commentLimiter = createLimiter({ windowMs: 60_000, max: 10 });
/** Follow/unfollow actions. */
export const followLimiter = createLimiter({ windowMs: 60_000, max: 30 });
/** Chat message sending. */
export const messageLimiter = createLimiter({ windowMs: 60_000, max: 40 });
/** Like/unlike actions. */
export const likeLimiter = createLimiter({ windowMs: 60_000, max: 60 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort client IP for anonymous rate-limit keys. */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

/**
 * Rate-limit key: the authenticated user's id when known, otherwise the
 * client IP. Callers pass the user id (or null) they already resolved.
 */
export function rateLimitKey(userId: string | null, request: Request): string {
  return userId ? `user:${userId}` : `ip:${getClientIp(request)}`;
}

/**
 * Check a limiter and throw a 429 ApiError when the budget is exhausted.
 * Call after authentication (so the key is the user id) and after input
 * validation (so malformed requests do not burn budget).
 */
export function enforceRateLimit(
  limiter: RateLimiter,
  key: string
): void {
  const result = limiter.check(key);
  if (!result.allowed) {
    throw rateLimited(result.retryAfterMs);
  }
}
