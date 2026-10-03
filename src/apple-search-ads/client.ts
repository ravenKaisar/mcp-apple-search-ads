import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { type Clock, type Sleep, sleep as defaultSleep, systemClock } from '../utils/time.js';
import { API_FAMILIES, type ApiFamilyId } from './apis.js';
import type { AuthenticationProvider } from './auth.js';
import type { EndpointDefinition, QueryValue } from './endpoints/index.js';
import {
  AppError,
  AppleSearchAdsApiError,
  MalformedResponseError,
  NetworkError,
  RateLimitError,
  ValidationError,
} from './errors.js';
import {
  ALLOWED_HTTP_METHOD,
  type GetOnlyHttpClient,
  type HttpResponse,
  type RateLimitHeaders,
} from './http.js';
import { collectPages, type Page, type PageRequest, type PaginationOutcome } from './pagination.js';
import { RateLimitTracker } from './rate-limit.js';
import { computeBackoffMs, isRetryableNetworkError, parseRetryAfterMs, RETRYABLE_STATUSES } from './retry.js';

export interface EndpointCall {
  accountId: string;
  /** Value for `X-AP-Context` (orgId for v5, adAccountId for Platform). Required when the endpoint needs it. */
  context?: string;
  pathParams: Readonly<Record<string, string>>;
  query: Readonly<Record<string, QueryValue | undefined>>;
  signal?: AbortSignal;
}

export interface ApiResult {
  status: number;
  body: unknown;
  requestId: string | undefined;
  rateLimit: RateLimitHeaders;
  attempts: number;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Longest Retry-After / RateLimit-Reset the client will wait for before giving up. */
  maxRetryAfterMs: number;
}

export interface AppleSearchAdsClientOptions {
  http: GetOnlyHttpClient;
  auth: AuthenticationProvider;
  baseUrls: Readonly<Record<ApiFamilyId, string>>;
  retry: RetryPolicy;
  rateLimits?: RateLimitTracker;
  logger?: Logger;
  clock?: Clock;
  sleep?: Sleep;
  random?: () => number;
  userAgent?: string;
}

const CONTEXT_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT = /[/\\?#%\s\u0000-\u001f\u007f]/;

/** Rejects any path segment value that could alter the URL structure. */
export function assertSafePathSegment(name: string, value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    UNSAFE_SEGMENT.test(value) ||
    value.length > 256
  ) {
    throw new ValidationError(`Invalid value for path parameter "${name}"`, [
      { path: name, message: 'contains characters that are not allowed in an identifier' },
    ]);
  }
}

function statusMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Apple Ads API rejected the request as invalid (400)';
    case 401:
      return 'Authentication failed (401): Apple rejected the access token';
    case 403:
      return 'Forbidden (403): the API user is not allowed to access this resource, org or ad account';
    case 404:
      return 'Not found (404): Apple could not find the requested resource';
    case 409:
      return 'Conflict (409)';
    case 429:
      return 'Rate limit exceeded (429)';
    case 500:
    case 502:
    case 503:
    case 504:
      return `Apple Ads API server error (${status})`;
    default:
      return `Apple Ads API request failed (HTTP ${status})`;
  }
}

/**
 * Read-only Apple Ads API client. Independent of MCP: it knows endpoint definitions, accounts' tokens,
 * retries, rate limits and error mapping, and it can only ever send GET requests (via GetOnlyHttpClient).
 */
export class AppleSearchAdsClient {
  readonly #http: GetOnlyHttpClient;
  readonly #auth: AuthenticationProvider;
  readonly #baseUrls: Readonly<Record<ApiFamilyId, string>>;
  readonly #retry: RetryPolicy;
  readonly #rateLimits: RateLimitTracker;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #userAgent: string;

  constructor(options: AppleSearchAdsClientOptions) {
    this.#http = options.http;
    this.#auth = options.auth;
    this.#baseUrls = options.baseUrls;
    this.#retry = options.retry;
    this.#rateLimits = options.rateLimits ?? new RateLimitTracker();
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#userAgent = options.userAgent ?? 'apple-search-ads-mcp';
  }

  /** Builds the request URL from the endpoint's path template, percent-encoding every path value. */
  buildUrl(
    endpoint: EndpointDefinition,
    pathParams: Readonly<Record<string, string>>,
    query: Readonly<Record<string, QueryValue | undefined>>,
  ): URL {
    const path = endpoint.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
      const value = pathParams[name];
      if (typeof value !== 'string') {
        throw new ValidationError(`Missing path parameter "${name}"`, [
          { path: name, message: 'is required' },
        ]);
      }
      assertSafePathSegment(name, value);
      return encodeURIComponent(value);
    });

    const url = new URL(this.#baseUrls[endpoint.api] + path);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (!(name in endpoint.queryParams)) {
        throw new ValidationError(`Unknown query parameter "${name}"`, [
          { path: name, message: 'is not supported' },
        ]);
      }
      const spec = endpoint.queryParams[name];
      if (Array.isArray(value)) {
        if (spec?.serialize === 'repeat') {
          for (const item of value as readonly string[]) url.searchParams.append(name, item);
        } else {
          url.searchParams.set(name, (value as readonly string[]).join(','));
        }
      } else {
        url.searchParams.set(name, String(value));
      }
    }
    return url;
  }

  /** Performs one logical GET (with retries, token refresh and rate-limit handling). */
  async get(endpoint: EndpointDefinition, call: EndpointCall): Promise<ApiResult> {
    const family = API_FAMILIES[endpoint.api];
    const url = this.buildUrl(endpoint, call.pathParams, call.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.#userAgent,
    };
    if (endpoint.requiresContext) {
      if (!call.context || !CONTEXT_VALUE.test(call.context)) {
        throw new ValidationError(`${family.contextInputName} is required for ${endpoint.toolName}`, [
          { path: family.contextInputName, message: 'is required (or configure a default on the account)' },
        ]);
      }
      headers['X-AP-Context'] = `${family.contextHeaderKey}=${call.context}`;
    }

    const rateKey = `${call.accountId}:${endpoint.api}`;
    const log = this.#logger.child({
      account_id: call.accountId,
      api: endpoint.api,
      endpoint: endpoint.path,
    });
    let attempt = 0;
    let refreshedToken = false;

    for (;;) {
      const proactiveDelay = this.#rateLimits.delayBeforeNextRequest(rateKey, this.#clock.now());
      if (proactiveDelay > 0) {
        if (proactiveDelay > this.#retry.maxRetryAfterMs) {
          throw new RateLimitError('Rate limit window exhausted; retry later', {
            retryAfterSeconds: Math.ceil(proactiveDelay / 1000),
          });
        }
        log.info('apple_api_rate_limit_wait', { delay_ms: proactiveDelay });
        await this.#sleep(proactiveDelay, call.signal);
      }

      const token = await this.#auth.getAccessToken(call.accountId, call.signal);
      const started = this.#clock.now();
      let response: HttpResponse;
      try {
        response = await this.#http.request({
          method: ALLOWED_HTTP_METHOD,
          url,
          headers: { ...headers, Authorization: `Bearer ${token}` },
          signal: call.signal,
        });
      } catch (error) {
        if (
          error instanceof NetworkError &&
          isRetryableNetworkError(error.cause, error.kind) &&
          attempt < this.#retry.maxRetries
        ) {
          const delay = this.#backoff(attempt);
          log.warn('apple_api_network_retry', { kind: error.kind, attempt: attempt + 1, delay_ms: delay });
          await this.#sleep(delay, call.signal);
          attempt += 1;
          continue;
        }
        if (error instanceof AppError) {
          log.warn('apple_api_request_failed', { error_type: error.type, attempt: attempt + 1 });
        }
        throw error;
      }

      this.#rateLimits.update(rateKey, response.rateLimit, this.#clock.now());
      log.info('apple_api_request', {
        method: ALLOWED_HTTP_METHOD,
        status: response.status,
        duration_ms: this.#clock.now() - started,
        attempt: attempt + 1,
        request_id: response.requestId,
      });

      if (response.status >= 200 && response.status < 300) {
        return {
          status: response.status,
          body: response.body,
          requestId: response.requestId,
          rateLimit: response.rateLimit,
          attempts: attempt + 1,
        };
      }

      if (response.status === 401 && !refreshedToken) {
        // The cached token may have been revoked or expired early: fetch a fresh one once.
        this.#auth.invalidateAccessToken(call.accountId, token);
        refreshedToken = true;
        log.warn('apple_api_token_rejected_refreshing');
        continue;
      }

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.#retry.maxRetries) {
        const delay = this.#retryDelay(response, attempt);
        if (delay === undefined) {
          throw this.#toError(endpoint.api, response);
        }
        log.warn('apple_api_retry', { status: response.status, attempt: attempt + 1, delay_ms: delay });
        await this.#sleep(delay, call.signal);
        attempt += 1;
        continue;
      }

      throw this.#toError(endpoint.api, response);
    }
  }

  /** Fetches one page of a paginated endpoint and extracts its items. */
  async fetchPage(
    endpoint: EndpointDefinition,
    call: EndpointCall,
    request: PageRequest,
  ): Promise<Page<unknown> & { result: ApiResult }> {
    const pagination = endpoint.pagination;
    if (!pagination) throw new ValidationError(`${endpoint.toolName} is not paginated`);
    const family = API_FAMILIES[endpoint.api];
    const result = await this.get(endpoint, {
      ...call,
      query: {
        ...call.query,
        [pagination.offsetParam]: request.offset,
        [pagination.limitParam]: request.limit,
      },
    });
    const items = family.readItems(result.body);
    if (items === undefined) {
      if (
        result.body === null ||
        (typeof result.body === 'object' && Object.keys(result.body).length === 0)
      ) {
        return { items: [], total: 0, request, result };
      }
      throw new MalformedResponseError('Apple Ads API list response did not contain an item array', {
        status: result.status,
        requestId: result.requestId,
      });
    }
    return { items, total: family.readTotal(result.body), request, result };
  }

  /** Fetches successive pages within the given safety limits. */
  async getAll(
    endpoint: EndpointDefinition,
    call: EndpointCall,
    options: { startOffset: number; pageSize: number; maxPages: number; maxRecords: number },
  ): Promise<{ items: unknown[]; outcome: PaginationOutcome; lastResult: ApiResult | undefined }> {
    let lastResult: ApiResult | undefined;
    const { items, outcome } = await collectPages(
      async (request) => {
        const page = await this.fetchPage(endpoint, call, request);
        lastResult = page.result;
        return page;
      },
      { ...options, signal: call.signal },
    );
    return { items, outcome, lastResult };
  }

  #backoff(attempt: number): number {
    return computeBackoffMs(attempt, {
      baseDelayMs: this.#retry.baseDelayMs,
      maxDelayMs: this.#retry.maxDelayMs,
      random: this.#random,
    });
  }

  /** Delay before retrying, or undefined when the server asks us to wait longer than allowed. */
  #retryDelay(response: HttpResponse, attempt: number): number | undefined {
    if (response.status !== 429) return this.#backoff(attempt);
    const retryAfter = parseRetryAfterMs(response.retryAfter, this.#clock.now());
    const reset =
      response.rateLimit.resetSeconds !== undefined ? response.rateLimit.resetSeconds * 1000 : undefined;
    const requested = retryAfter ?? reset;
    if (requested === undefined) return this.#backoff(attempt);
    if (requested > this.#retry.maxRetryAfterMs) return undefined;
    return requested;
  }

  #toError(api: ApiFamilyId, response: HttpResponse): AppleSearchAdsApiError {
    const parsed = API_FAMILIES[api].readError(response.body);
    const base = statusMessage(response.status);
    const message = parsed.message ? `${base}: ${parsed.message}` : base;
    if (response.status === 429) {
      const retryAfterMs =
        parseRetryAfterMs(response.retryAfter, this.#clock.now()) ??
        (response.rateLimit.resetSeconds !== undefined ? response.rateLimit.resetSeconds * 1000 : undefined);
      return new RateLimitError(message, {
        requestId: response.requestId,
        retryAfterSeconds: retryAfterMs !== undefined ? Math.ceil(retryAfterMs / 1000) : undefined,
        details: parsed.details,
      });
    }
    return new AppleSearchAdsApiError(message, {
      status: response.status,
      requestId: response.requestId,
      details: parsed.details,
      code: parsed.code,
    });
  }
}
