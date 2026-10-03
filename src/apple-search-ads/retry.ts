import type { NetworkErrorKind } from './errors.js';

/** HTTP statuses that are safe to retry for GET requests. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}

/**
 * Exponential backoff (base * 2^attempt, capped) with +/-20% jitter. Apple's guidance is to wait
 * 2s, 4s, 8s, 16s and stop growing at the cap.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  const jitter = exponential * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.min(options.maxDelayMs, Math.round(exponential + jitter)));
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }
  // HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT"); bare numbers like "-3" are not dates.
  if (!/^[A-Za-z]{3},/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/** Parses an integer-seconds header such as `RateLimit-Reset`. */
export function parseSecondsHeader(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

/** Maps low-level fetch/undici failures to a stable network error kind. */
export function classifyNetworkError(error: unknown): NetworkErrorKind {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return error.name === 'TimeoutError' ? 'timeout' : 'aborted';
  }
  const code = errorCode(error);
  switch (code) {
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'timeout';
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
    case 'UND_ERR_CLOSED':
      return 'connection_reset';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'EAI_FAIL':
      return 'dns';
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'connection_refused';
    default:
      return 'other';
  }
}

/** Whether a network failure is worth retrying. Permanent DNS failures (ENOTFOUND) are not. */
export function isRetryableNetworkError(error: unknown, kind: NetworkErrorKind): boolean {
  if (kind === 'aborted') return false;
  if (kind === 'dns') return errorCode(error) === 'EAI_AGAIN';
  return true;
}
