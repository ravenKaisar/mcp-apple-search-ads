import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { type Clock, systemClock } from '../utils/time.js';
import type { FetchLike } from './auth.js';
import { MalformedResponseError, NetworkError, UnsupportedOperationError } from './errors.js';
import { classifyNetworkError } from './retry.js';

/**
 * The single HTTP method this client can send. The type is a literal so that TypeScript rejects
 * any other method at compile time; `assertGetOnly` rejects it again at runtime.
 */
export const ALLOWED_HTTP_METHOD = 'GET' as const;
export type AllowedHttpMethod = typeof ALLOWED_HTTP_METHOD;

/** Methods that mutate state (or could) and are therefore always refused. */
export const FORBIDDEN_HTTP_METHODS = [
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
] as const;

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
export const REQUEST_ID_HEADERS = ['x-request-id', 'x-apple-request-uuid', 'apple-request-id'] as const;

/** Hard runtime guard: only GET may ever be sent to the Apple Ads APIs. */
export function assertGetOnly(method: unknown): asserts method is AllowedHttpMethod {
  if (method !== ALLOWED_HTTP_METHOD) {
    throw new UnsupportedOperationError(
      `Only GET requests are supported; refusing to send ${typeof method === 'string' ? method.slice(0, 16) : 'non-string'} request. ` +
        'This server is strictly read-only.',
    );
  }
}

export interface GetRequest {
  method: AllowedHttpMethod;
  url: URL;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface RateLimitHeaders {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body; `null` for an empty body; `undefined` if an error body was not JSON. */
  body: unknown;
  requestId: string | undefined;
  retryAfter: string | undefined;
  rateLimit: RateLimitHeaders;
}

function toInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * Minimal HTTP client that can ONLY perform GET requests against an allow-list of base URLs.
 * It performs one attempt; retries, authentication and error mapping live in AppleSearchAdsClient.
 */
export class GetOnlyHttpClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #allowedBaseUrls: readonly string[];
  readonly #logger: Logger;
  readonly #clock: Clock;

  constructor(options: {
    allowedBaseUrls: readonly string[];
    timeoutMs: number;
    fetch?: FetchLike;
    logger?: Logger;
    clock?: Clock;
  }) {
    if (options.allowedBaseUrls.length === 0) {
      throw new Error('GetOnlyHttpClient requires at least one allowed base URL');
    }
    this.#allowedBaseUrls = options.allowedBaseUrls.map((u) => u.replace(/\/+$/, '') + '/');
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? systemClock;
  }

  /** Throws unless the URL is under one of the configured Apple API base URLs. */
  assertAllowedUrl(url: URL): void {
    if (url.username || url.password) {
      throw new UnsupportedOperationError('URLs with embedded credentials are not allowed');
    }
    const href = url.href;
    if (!this.#allowedBaseUrls.some((base) => href.startsWith(base))) {
      throw new UnsupportedOperationError(
        'Refusing to call a URL outside the configured Apple Ads API base URLs',
      );
    }
  }

  async request(request: GetRequest): Promise<HttpResponse> {
    // Runtime guards (defence in depth; the type system already enforces both).
    assertGetOnly(request.method);
    if ('body' in request && (request as { body?: unknown }).body !== undefined) {
      throw new UnsupportedOperationError('GET requests must not carry a body');
    }
    this.assertAllowedUrl(request.url);

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.#fetch(request.url, {
        method: ALLOWED_HTTP_METHOD,
        headers: request.headers,
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new NetworkError('Request was cancelled by the client', 'aborted', { cause: error });
      }
      const kind = timeoutSignal.aborted ? 'timeout' : classifyNetworkError(error);
      throw new NetworkError(describeNetworkError(kind, this.#timeoutMs), kind, { cause: error });
    }

    const requestId = REQUEST_ID_HEADERS.map((h) => response.headers.get(h)).find((v) => v) ?? undefined;
    const rateLimit: RateLimitHeaders = {
      limit: toInt(response.headers.get('ratelimit-limit')),
      remaining: toInt(response.headers.get('ratelimit-remaining')),
      resetSeconds: toInt(response.headers.get('ratelimit-reset')),
    };

    const declaredLength = toInt(response.headers.get('content-length'));
    if (declaredLength !== undefined && declaredLength > MAX_RESPONSE_BYTES) {
      throw new MalformedResponseError('Response body exceeds the maximum allowed size', {
        status: response.status,
        requestId,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const kind = timeoutSignal.aborted ? 'timeout' : classifyNetworkError(error);
      throw new NetworkError(describeNetworkError(kind, this.#timeoutMs), kind, { cause: error });
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new MalformedResponseError('Response body exceeds the maximum allowed size', {
        status: response.status,
        requestId,
      });
    }

    let body: unknown = null;
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          this.#logger.warn('apple_api_malformed_response', {
            status: response.status,
            content_type: response.headers.get('content-type') ?? undefined,
            length: text.length,
          });
          throw new MalformedResponseError('Apple Ads API returned a response that is not valid JSON', {
            status: response.status,
            requestId,
            cause: error,
          });
        }
        body = undefined;
      }
    }
    if (response.ok && body !== null && typeof body !== 'object') {
      throw new MalformedResponseError(
        'Apple Ads API returned an unexpected JSON value (expected an object)',
        {
          status: response.status,
          requestId,
        },
      );
    }

    return {
      status: response.status,
      body,
      requestId,
      retryAfter: response.headers.get('retry-after') ?? undefined,
      rateLimit,
    };
  }

  /** Time source used for request duration logging. */
  now(): number {
    return this.#clock.now();
  }
}

function describeNetworkError(kind: string, timeoutMs: number): string {
  switch (kind) {
    case 'timeout':
      return `Request to the Apple Ads API timed out after ${timeoutMs} ms`;
    case 'connection_reset':
      return 'Connection to the Apple Ads API was reset';
    case 'dns':
      return 'Could not resolve the Apple Ads API host (DNS failure)';
    case 'connection_refused':
      return 'Connection to the Apple Ads API was refused';
    default:
      return 'Network error while calling the Apple Ads API';
  }
}
