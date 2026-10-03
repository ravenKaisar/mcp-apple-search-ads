import { describe, expect, it, vi } from 'vitest';
import {
  MalformedResponseError,
  NetworkError,
  UnsupportedOperationError,
} from '../../src/apple-search-ads/errors.js';
import { assertGetOnly, GetOnlyHttpClient } from '../../src/apple-search-ads/http.js';
import {
  hangingResponse,
  jsonResponse,
  networkError,
  TEST_BASE_URLS,
  textResponse,
} from '../helpers/fake-apple.js';

const BASE = TEST_BASE_URLS['campaign-management-v5'];

function client(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>, timeoutMs = 1000) {
  return new GetOnlyHttpClient({
    allowedBaseUrls: [BASE, TEST_BASE_URLS['platform-v1']],
    timeoutMs,
    fetch: fetchImpl,
  });
}

const get = (path = '/campaigns') => ({ method: 'GET' as const, url: new URL(BASE + path), headers: {} });

describe('GetOnlyHttpClient', () => {
  it('sends GET with redirect: error and returns parsed JSON plus metadata', async () => {
    const fetchSpy = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse(
        200,
        { data: [] },
        {
          'x-request-id': 'req-123',
          'ratelimit-limit': '100',
          'ratelimit-remaining': '7',
          'ratelimit-reset': '30',
        },
      ),
    );
    const response = await client(fetchSpy).request({ ...get(), headers: { Accept: 'application/json' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
    expect(response.requestId).toBe('req-123');
    expect(response.rateLimit).toEqual({ limit: 100, remaining: 7, resetSeconds: 30 });
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.body).toBeUndefined();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', 'Get', ''])(
    'refuses method %j before any network call',
    async (method) => {
      const fetchSpy = vi.fn();
      await expect(client(fetchSpy).request({ ...get(), method: method as 'GET' })).rejects.toBeInstanceOf(
        UnsupportedOperationError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('assertGetOnly rejects non-strings', () => {
    expect(() => assertGetOnly(undefined)).toThrow(UnsupportedOperationError);
    expect(() => assertGetOnly({ toString: () => 'GET' })).toThrow(UnsupportedOperationError);
    expect(() => assertGetOnly('GET')).not.toThrow();
  });

  it('refuses a request body', async () => {
    const fetchSpy = vi.fn();
    await expect(
      client(fetchSpy).request({ ...get(), body: '{}' } as unknown as ReturnType<typeof get>),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example/api/v5/campaigns',
    'https://api.searchads.test.example/api/v6/campaigns',
    'https://api.searchads.test.example.evil.example/api/v5/campaigns',
    'https://user:pass@api.searchads.test.example/api/v5/campaigns',
  ])('refuses URLs outside the allow-list: %s', async (url) => {
    const fetchSpy = vi.fn();
    await expect(
      client(fetchSpy).request({ method: 'GET', url: new URL(url), headers: {} }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a timeout to NetworkError(timeout)', async () => {
    const error = await client((_i, init) => hangingResponse(init), 30)
      .request(get())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe('timeout');
  });

  it.each([
    ['ECONNRESET', 'connection_reset'],
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'connection_refused'],
    ['EWHATEVER', 'other'],
  ])('maps %s to NetworkError(%s)', async (code, kind) => {
    const error = await client(() => Promise.reject(networkError(code)))
      .request(get())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe(kind);
  });

  it('reports client cancellation as aborted', async () => {
    const controller = new AbortController();
    const promise = client((_i, init) => hangingResponse(init)).request({
      ...get(),
      signal: controller.signal,
    });
    controller.abort();
    const error = await promise.catch((e: unknown) => e);
    expect((error as NetworkError).kind).toBe('aborted');
  });

  it('rejects malformed JSON on success responses', async () => {
    await expect(client(async () => textResponse(200, '{"data": [')).request(get())).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
    await expect(
      client(async () => textResponse(200, '"just a string"')).request(get()),
    ).rejects.toBeInstanceOf(MalformedResponseError);
    await expect(client(async () => textResponse(200, '42')).request(get())).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
  });

  it('tolerates empty and non-JSON error bodies', async () => {
    const empty = await client(async () => new Response(null, { status: 204 })).request(get());
    expect(empty.body).toBeNull();
    const html = await client(async () => textResponse(502, '<html>bad gateway</html>')).request(get());
    expect(html.status).toBe(502);
    expect(html.body).toBeUndefined();
  });

  it('rejects oversized responses based on content-length', async () => {
    await expect(
      client(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-length': String(60 * 1024 * 1024) } }),
      ).request(get()),
    ).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it('requires at least one allowed base URL', () => {
    expect(() => new GetOnlyHttpClient({ allowedBaseUrls: [], timeoutMs: 1 })).toThrow();
  });
});
