import type { RateLimitHeaders } from './http.js';

interface RateLimitState {
  limit?: number;
  remaining: number;
  /** Epoch ms at which the window resets. */
  resetAt: number;
}

/**
 * Tracks Apple's `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers (Platform API)
 * per account + API family, so the client can pause proactively instead of hitting HTTP 429.
 * Apple's guidance: "check RateLimit-Remaining before each request; if low, wait RateLimit-Reset seconds".
 */
export class RateLimitTracker {
  readonly #state = new Map<string, RateLimitState>();
  readonly #threshold: number;

  constructor(options: { threshold?: number } = {}) {
    this.#threshold = options.threshold ?? 0;
  }

  update(key: string, headers: RateLimitHeaders, nowMs: number): void {
    if (headers.remaining === undefined || headers.resetSeconds === undefined) return;
    this.#state.set(key, {
      limit: headers.limit,
      remaining: headers.remaining,
      resetAt: nowMs + headers.resetSeconds * 1000,
    });
  }

  /** Milliseconds to wait before the next request for `key` (0 when no wait is needed). */
  delayBeforeNextRequest(key: string, nowMs: number): number {
    const state = this.#state.get(key);
    if (!state) return 0;
    if (nowMs >= state.resetAt) {
      this.#state.delete(key);
      return 0;
    }
    return state.remaining <= this.#threshold ? state.resetAt - nowMs : 0;
  }

  snapshot(key: string): Readonly<RateLimitState> | undefined {
    return this.#state.get(key);
  }
}
