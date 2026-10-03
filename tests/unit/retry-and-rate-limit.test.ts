import { describe, expect, it } from 'vitest';
import { RateLimitTracker } from '../../src/apple-search-ads/rate-limit.js';
import {
  classifyNetworkError,
  computeBackoffMs,
  isRetryableNetworkError,
  parseRetryAfterMs,
  parseSecondsHeader,
} from '../../src/apple-search-ads/retry.js';
import { networkError } from '../helpers/fake-apple.js';

describe('computeBackoffMs', () => {
  it('doubles from the base delay and caps at the maximum (Apple: 2s, 4s, 8s, 16s)', () => {
    const opts = { baseDelayMs: 2000, maxDelayMs: 16_000, random: () => 0.5 };
    expect([0, 1, 2, 3, 4, 5].map((a) => computeBackoffMs(a, opts))).toEqual([
      2000, 4000, 8000, 16_000, 16_000, 16_000,
    ]);
  });

  it('applies bounded jitter', () => {
    const low = computeBackoffMs(1, { baseDelayMs: 1000, maxDelayMs: 10_000, random: () => 0 });
    const high = computeBackoffMs(1, { baseDelayMs: 1000, maxDelayMs: 10_000, random: () => 1 });
    expect(low).toBe(1600);
    expect(high).toBe(2400);
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0);
  it.each([
    ['5', 5000],
    ['0', 0],
    ['1.5', 1500],
    [' 30 ', 30_000],
  ])('parses delta-seconds %j', (value, expected) => {
    expect(parseRetryAfterMs(value, now)).toBe(expected);
  });

  it('parses HTTP-dates', () => {
    expect(parseRetryAfterMs(new Date(now + 7000).toUTCString(), now)).toBe(7000);
    expect(parseRetryAfterMs(new Date(now - 7000).toUTCString(), now)).toBe(0);
  });

  it.each([undefined, null, '', 'soon', '-3'])('returns undefined for %j', (value) => {
    expect(parseRetryAfterMs(value, now)).toBeUndefined();
  });

  it('parses integer-seconds headers', () => {
    expect(parseSecondsHeader('37')).toBe(37);
    expect(parseSecondsHeader('x')).toBeUndefined();
    expect(parseSecondsHeader(null)).toBeUndefined();
  });
});

describe('network error classification', () => {
  it('classifies timeouts, resets, DNS and refusals', () => {
    expect(classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyNetworkError(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe('aborted');
    expect(classifyNetworkError(networkError('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
    expect(classifyNetworkError(networkError('ECONNRESET'))).toBe('connection_reset');
    expect(classifyNetworkError(networkError('UND_ERR_SOCKET'))).toBe('connection_reset');
    expect(classifyNetworkError(networkError('ENOTFOUND'))).toBe('dns');
    expect(classifyNetworkError(networkError('ECONNREFUSED'))).toBe('connection_refused');
    expect(classifyNetworkError('weird')).toBe('other');
  });

  it('does not retry permanent DNS failures or aborts', () => {
    expect(isRetryableNetworkError(networkError('ENOTFOUND'), 'dns')).toBe(false);
    expect(isRetryableNetworkError(networkError('EAI_AGAIN'), 'dns')).toBe(true);
    expect(isRetryableNetworkError(undefined, 'aborted')).toBe(false);
    expect(isRetryableNetworkError(undefined, 'timeout')).toBe(true);
    expect(isRetryableNetworkError(undefined, 'connection_reset')).toBe(true);
  });
});

describe('RateLimitTracker', () => {
  it('asks callers to wait when the window is exhausted, until it resets', () => {
    const tracker = new RateLimitTracker();
    const now = 1_000_000;
    tracker.update('a:platform-v1', { limit: 100, remaining: 0, resetSeconds: 10 }, now);
    expect(tracker.delayBeforeNextRequest('a:platform-v1', now)).toBe(10_000);
    expect(tracker.delayBeforeNextRequest('a:platform-v1', now + 4000)).toBe(6000);
    expect(tracker.delayBeforeNextRequest('a:platform-v1', now + 10_000)).toBe(0);
    expect(tracker.snapshot('a:platform-v1')).toBeUndefined();
  });

  it('does not wait while requests remain or when headers are missing', () => {
    const tracker = new RateLimitTracker();
    tracker.update('k', { remaining: 3, resetSeconds: 10 }, 0);
    expect(tracker.delayBeforeNextRequest('k', 0)).toBe(0);
    tracker.update('other', {}, 0);
    expect(tracker.delayBeforeNextRequest('other', 0)).toBe(0);
  });

  it('keeps state per key (account isolation)', () => {
    const tracker = new RateLimitTracker();
    tracker.update('account-a:platform-v1', { remaining: 0, resetSeconds: 5 }, 0);
    expect(tracker.delayBeforeNextRequest('account-b:platform-v1', 0)).toBe(0);
  });
});
