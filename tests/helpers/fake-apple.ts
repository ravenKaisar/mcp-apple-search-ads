import type { FetchLike } from '../../src/apple-search-ads/auth.js';

export const TEST_TOKEN_URL = 'https://appleid.test.example/auth/oauth2/token';
export const TEST_BASE_URLS = {
  'campaign-management-v5': 'https://api.searchads.test.example/api/v5',
  'platform-v1': 'https://api.ads.test.example/v1',
} as const;

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

/** Creates an error shaped like undici's `TypeError: fetch failed` with a system error cause. */
export function networkError(code: string): Error {
  const cause = Object.assign(new Error(`${code} simulated`), { code });
  return new TypeError('fetch failed', { cause });
}

/** A fetch that only settles when its AbortSignal fires (simulates a hung connection). */
export function hangingResponse(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
      {
        once: true,
      },
    );
  });
}

/**
 * Programmable in-memory Apple: an OAuth token endpoint plus both Ads APIs. Records every request.
 */
export class FakeApple {
  readonly tokenRequests: RecordedRequest[] = [];
  readonly apiRequests: RecordedRequest[] = [];
  /** Tokens issued per client_id, in order. */
  readonly issuedTokens = new Map<string, string[]>();
  expiresIn = 3600;
  tokenHandler: Handler | undefined;
  apiHandler: Handler = () => jsonResponse(200, { data: {} });
  #counter = 0;

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.href);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body,
      signal: init?.signal ?? undefined,
    };
    if (url.href.startsWith(TEST_TOKEN_URL)) {
      this.tokenRequests.push(request);
      return this.tokenHandler ? this.tokenHandler(request) : this.issueToken(request);
    }
    this.apiRequests.push(request);
    return this.apiHandler(request);
  };

  issueToken(request: RecordedRequest): Response {
    const params = new URLSearchParams(request.body ?? '');
    const clientId = params.get('client_id') ?? 'unknown';
    this.#counter += 1;
    const token = `tok_${clientId}_${this.#counter}_${'x'.repeat(24)}`;
    const list = this.issuedTokens.get(clientId) ?? [];
    list.push(token);
    this.issuedTokens.set(clientId, list);
    return jsonResponse(200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      scope: 'searchadsorg',
    });
  }

  /** The last token issued for a client id. */
  lastToken(clientId: string): string | undefined {
    const list = this.issuedTokens.get(clientId);
    return list?.[list.length - 1];
  }

  reset(): void {
    this.tokenRequests.length = 0;
    this.apiRequests.length = 0;
    this.issuedTokens.clear();
  }
}
