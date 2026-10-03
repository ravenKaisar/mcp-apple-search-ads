import { sign } from 'node:crypto';
import { z } from 'zod';
import type { AccountCredentials } from '../config/loader.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { SecretScrubber } from '../utils/redact.js';
import { type Clock, type Sleep, sleep as defaultSleep, systemClock } from '../utils/time.js';
import { AuthenticationError } from './errors.js';
import { classifyNetworkError, computeBackoffMs } from './retry.js';

/**
 * Apple Search Ads / Apple Ads authentication (OAuth 2.0 client-credentials).
 *
 * Per Apple's "Implementing OAuth for the Apple Search Ads API" / "...for the Apple Ads Platform API":
 *   1. Build a client secret: an ES256 JWT, header {alg: ES256, kid: keyId},
 *      claims {iss: teamId, sub: clientId, aud: https://appleid.apple.com, iat, exp <= iat + 180 days}.
 *   2. POST https://appleid.apple.com/auth/oauth2/token
 *      (application/x-www-form-urlencoded: grant_type=client_credentials, client_id, client_secret,
 *      scope=searchadsorg) -> { access_token, token_type: "Bearer", expires_in: 3600 }.
 *   3. Send `Authorization: Bearer <access_token>` on API calls.
 *
 * NOTE: the token exchange in step 2 is the ONLY non-GET request this server ever sends. It targets the
 * fixed Apple ID token endpoint (never an Apple Ads API URL), is not reachable from any MCP tool, and
 * is required by Apple's authentication specification.
 */

export const OAUTH_AUDIENCE = 'https://appleid.apple.com';
export const OAUTH_SCOPE = 'searchadsorg';
export const OAUTH_GRANT_TYPE = 'client_credentials';

/** Resolves bearer tokens for configured accounts. */
export interface AuthenticationProvider {
  getAccessToken(accountId: string, signal?: AbortSignal): Promise<string>;
  /**
   * Drops a cached token after Apple rejected it (HTTP 401). When `rejectedToken` is given, the cache
   * is only cleared if it still holds that token, so concurrent refreshes are not thrown away.
   */
  invalidateAccessToken(accountId: string, rejectedToken?: string): void;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Creates the ES256-signed client secret JWT for the OAuth token request. */
export function createClientSecret(
  credentials: AccountCredentials,
  options: { nowSeconds: number; ttlSeconds: number },
): string {
  const header = { alg: 'ES256', kid: credentials.keyId };
  const payload = {
    sub: credentials.clientId,
    aud: OAUTH_AUDIENCE,
    iat: options.nowSeconds,
    exp: options.nowSeconds + options.ttlSeconds,
    iss: credentials.teamId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // ES256 JWS signatures are the raw 64-byte r||s concatenation (IEEE P1363), not DER.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: credentials.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer', 'token_type must be Bearer'),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().optional(),
});

export interface IssuedToken {
  accessToken: string;
  expiresInSeconds: number;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OAuthTokenClientOptions {
  tokenUrl: string;
  fetch?: FetchLike;
  clock?: Clock;
  sleep?: Sleep;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  clientSecretTtlSeconds: number;
  logger?: Logger;
  scrubber?: SecretScrubber;
  random?: () => number;
}

/** Exchanges a signed client secret for an access token at Apple's OAuth endpoint. */
export class OAuthTokenClient {
  readonly #options: Required<Omit<OAuthTokenClientOptions, 'scrubber'>> & { scrubber?: SecretScrubber };

  constructor(options: OAuthTokenClientOptions) {
    // Explicit `undefined` values must not override the defaults.
    this.#options = {
      ...options,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      clock: options.clock ?? systemClock,
      sleep: options.sleep ?? defaultSleep,
      logger: options.logger ?? silentLogger,
      random: options.random ?? Math.random,
    };
  }

  async requestToken(
    accountId: string,
    credentials: AccountCredentials,
    signal?: AbortSignal,
  ): Promise<IssuedToken> {
    const { maxRetries, logger } = this.#options;
    let attempt = 0;
    for (;;) {
      try {
        return await this.#requestOnce(accountId, credentials, signal);
      } catch (error) {
        const retryable = error instanceof RetryableTokenError;
        if (!retryable || attempt >= maxRetries || signal?.aborted) {
          if (error instanceof RetryableTokenError) throw error.toAuthenticationError();
          throw error;
        }
        const delay = computeBackoffMs(attempt, {
          baseDelayMs: this.#options.retryBaseDelayMs,
          maxDelayMs: this.#options.retryMaxDelayMs,
          random: this.#options.random,
        });
        logger.warn('oauth_token_retry', { account_id: accountId, attempt: attempt + 1, delay_ms: delay });
        await this.#options.sleep(delay, signal);
        attempt += 1;
      }
    }
  }

  async #requestOnce(
    accountId: string,
    credentials: AccountCredentials,
    signal?: AbortSignal,
  ): Promise<IssuedToken> {
    const { clock, timeoutMs, tokenUrl, logger } = this.#options;
    const nowSeconds = Math.floor(clock.now() / 1000);
    const clientSecret = createClientSecret(credentials, {
      nowSeconds,
      ttlSeconds: this.#options.clientSecretTtlSeconds,
    });
    this.#options.scrubber?.register(clientSecret);

    const body = new URLSearchParams({
      grant_type: OAUTH_GRANT_TYPE,
      client_id: credentials.clientId,
      client_secret: clientSecret,
      scope: OAUTH_SCOPE,
    });

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const started = clock.now();
    let response: Response;
    try {
      response = await this.#options.fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: combined,
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new AuthenticationError('Token request was cancelled', { cause: error });
      }
      const kind = timeoutSignal.aborted ? 'timeout' : classifyNetworkError(error);
      logger.warn('oauth_token_network_error', { account_id: accountId, kind });
      throw new RetryableTokenError(
        `Could not reach the Apple OAuth token endpoint (${kind})`,
        undefined,
        kind,
      );
    }

    const text = await response.text().catch(() => '');
    logger.info('oauth_token_response', {
      account_id: accountId,
      status: response.status,
      duration_ms: clock.now() - started,
    });

    if (response.status >= 500) {
      throw new RetryableTokenError(
        `Apple OAuth token endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }
    if (!response.ok) {
      const code = parseOAuthErrorCode(text);
      throw new AuthenticationError(
        `Apple rejected the credentials for account "${accountId}"` +
          (code ? ` (${code})` : ` (HTTP ${response.status})`) +
          '. Check clientId, teamId, keyId and privateKey.',
        { status: response.status, code },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AuthenticationError('Apple OAuth token endpoint returned a malformed (non-JSON) response', {
        status: response.status,
      });
    }
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AuthenticationError('Apple OAuth token endpoint returned an unexpected response shape', {
        status: response.status,
      });
    }
    this.#options.scrubber?.register(parsed.data.access_token);
    return { accessToken: parsed.data.access_token, expiresInSeconds: parsed.data.expires_in };
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AuthenticationError('Token request was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AuthenticationError('Token request was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function parseOAuthErrorCode(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === 'object' && 'error' in json) {
      const code = json.error;
      if (typeof code === 'string' && /^[a-z_]{1,64}$/i.test(code)) return code;
    }
  } catch {
    // ignore
  }
  return undefined;
}

class RetryableTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind?: string,
  ) {
    super(message);
  }

  toAuthenticationError(): AuthenticationError {
    return new AuthenticationError(this.message, {
      status: this.status,
      code: this.kind?.toUpperCase(),
    });
  }
}

interface CachedToken {
  value: string;
  /** Epoch ms after which the token must not be used. */
  refreshAt: number;
}

/**
 * Per-account token cache with single-flight refresh. Each instance is bound to exactly one account's
 * credentials, so a token can never be issued for or reused by a different account.
 */
export class AccountTokenManager {
  readonly #accountId: string;
  readonly #credentials: AccountCredentials;
  readonly #client: OAuthTokenClient;
  readonly #clock: Clock;
  readonly #skewMs: number;
  readonly #scrubber: SecretScrubber | undefined;
  #cached: CachedToken | undefined;
  #inflight: Promise<string> | undefined;

  constructor(options: {
    accountId: string;
    credentials: AccountCredentials;
    client: OAuthTokenClient;
    clock?: Clock;
    refreshSkewSeconds: number;
    scrubber?: SecretScrubber;
  }) {
    this.#accountId = options.accountId;
    this.#credentials = options.credentials;
    this.#client = options.client;
    this.#clock = options.clock ?? systemClock;
    this.#skewMs = options.refreshSkewSeconds * 1000;
    this.#scrubber = options.scrubber;
  }

  get accountId(): string {
    return this.#accountId;
  }

  /** True when a cached token exists and is still considered fresh. */
  hasValidToken(): boolean {
    return this.#cached !== undefined && this.#clock.now() < this.#cached.refreshAt;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.#cached && this.#clock.now() < this.#cached.refreshAt) {
      return this.#cached.value;
    }
    if (!this.#inflight) {
      // The shared refresh is bounded by the request timeout only; one caller cancelling must not
      // fail every other caller waiting on the same refresh.
      this.#inflight = this.#refresh().finally(() => {
        this.#inflight = undefined;
      });
    }
    return raceWithAbort(this.#inflight, signal);
  }

  invalidate(rejectedToken?: string): void {
    if (rejectedToken === undefined || this.#cached?.value === rejectedToken) {
      if (this.#cached) this.#scrubber?.register(this.#cached.value);
      this.#cached = undefined;
    }
  }

  async #refresh(): Promise<string> {
    const issued = await this.#client.requestToken(this.#accountId, this.#credentials);
    const lifetimeMs = issued.expiresInSeconds * 1000;
    // Refresh early by the configured skew, but never use a skew larger than half the lifetime.
    const skew = Math.min(this.#skewMs, Math.floor(lifetimeMs / 2));
    this.#cached = { value: issued.accessToken, refreshAt: this.#clock.now() + lifetimeMs - skew };
    return issued.accessToken;
  }

  toJSON(): Record<string, unknown> {
    return { accountId: this.#accountId, hasToken: this.#cached !== undefined };
  }
}
