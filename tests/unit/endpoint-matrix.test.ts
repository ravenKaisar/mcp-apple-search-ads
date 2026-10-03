/**
 * Per-endpoint API tests. For EVERY registered Apple Ads GET endpoint this verifies, at the Apple client
 * layer (independent of MCP): the exact GET request, success (200), empty 200, 400, 401, 403, 404, 429,
 * 500, timeout, connection reset, DNS failure and malformed JSON.
 */
import { describe, expect, it } from 'vitest';
import { API_FAMILIES } from '../../src/apple-search-ads/apis.js';
import type { EndpointCall } from '../../src/apple-search-ads/client.js';
import { ENDPOINTS, type EndpointDefinition } from '../../src/apple-search-ads/endpoints/index.js';
import {
  AppleSearchAdsApiError,
  MalformedResponseError,
  NetworkError,
  RateLimitError,
} from '../../src/apple-search-ads/errors.js';
import {
  emptyFixture,
  errorFixture,
  expectedPath,
  sampleApiArgs,
  successFixture,
} from '../helpers/fixtures.js';
import {
  hangingResponse,
  jsonResponse,
  networkError,
  TEST_BASE_URLS,
  textResponse,
} from '../helpers/fake-apple.js';
import { ACCOUNT_A, makeTestRuntime } from '../helpers/runtime.js';

function buildCall(endpoint: EndpointDefinition): EndpointCall {
  const args = sampleApiArgs(endpoint);
  const pathParams: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(args)) {
    if (name in endpoint.pathParams) pathParams[name] = String(value);
    else query[name] = String(value);
  }
  const context = endpoint.requiresContext
    ? API_FAMILIES[endpoint.api].contextHeaderKey === 'orgId'
      ? ACCOUNT_A.orgId
      : ACCOUNT_A.adAccountId
    : undefined;
  return { accountId: 'account-a', context, pathParams, query };
}

describe.each(ENDPOINTS.map((e) => [e.toolName, e] as const))('endpoint %s', (_name, endpoint) => {
  const statusError = async (status: number, headers: Record<string, string> = {}) => {
    const { runtime, fake } = makeTestRuntime({ config: { maxRetries: 0 } });
    fake.apiHandler = () =>
      jsonResponse(status, errorFixture(endpoint.api, status, `failure ${status}`), headers);
    const error = await runtime.client.get(endpoint, buildCall(endpoint)).catch((e: unknown) => e);
    return { error, fake };
  };

  it('200: sends exactly one GET to the documented path and returns the body', async () => {
    const { runtime, fake } = makeTestRuntime();
    const fixture = successFixture(endpoint.toolName);
    fake.apiHandler = () => jsonResponse(200, fixture);
    const call = buildCall(endpoint);
    const result = await runtime.client.get(endpoint, call);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(fixture);
    expect(fake.apiRequests).toHaveLength(1);
    const request = fake.apiRequests[0]!;
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(request.url.origin + request.url.pathname).toBe(
      TEST_BASE_URLS[endpoint.api] + expectedPath(endpoint, { ...call.pathParams }),
    );
    expect(request.headers.get('authorization')).toMatch(/^Bearer tok_/);
    expect(request.headers.has('x-ap-context')).toBe(endpoint.requiresContext);
    for (const [name, value] of Object.entries(call.query)) {
      expect(request.url.searchParams.get(name)).toBe(value);
    }
  });

  it('200 with empty data: returns the empty envelope unchanged', async () => {
    const { runtime, fake } = makeTestRuntime();
    const empty = emptyFixture(endpoint);
    fake.apiHandler = () => jsonResponse(200, empty);
    await expect(runtime.client.get(endpoint, buildCall(endpoint))).resolves.toMatchObject({
      status: 200,
      body: empty,
    });
  });

  it('200 with an empty body: returns null data', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => new Response('', { status: 200 });
    await expect(runtime.client.get(endpoint, buildCall(endpoint))).resolves.toMatchObject({ body: null });
  });

  it.each([400, 401, 403, 404, 409, 500])(
    '%i: raises AppleSearchAdsApiError with Apple details',
    async (status) => {
      const { error } = await statusError(status);
      expect(error).toBeInstanceOf(AppleSearchAdsApiError);
      const payload = (error as AppleSearchAdsApiError).toPayload().error;
      expect(payload.type).toBe('APPLE_SEARCH_ADS_API_ERROR');
      expect(payload.status).toBe(status);
      expect(payload.message).toContain(`failure ${status}`);
    },
  );

  it('401: refreshes the token exactly once before failing', async () => {
    const { error, fake } = await statusError(401);
    expect((error as AppleSearchAdsApiError).status).toBe(401);
    expect(fake.apiRequests).toHaveLength(2);
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('429: raises RateLimitError with retry_after_seconds', async () => {
    const { error } = await statusError(429, { 'retry-after': '30' });
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).toPayload().error).toMatchObject({
      type: 'RATE_LIMIT_ERROR',
      status: 429,
      retry_after_seconds: 30,
    });
  });

  it('500: is retried before failing', async () => {
    const { runtime, fake } = makeTestRuntime({ config: { maxRetries: 2 } });
    fake.apiHandler = () => jsonResponse(500, errorFixture(endpoint.api, 500));
    await expect(runtime.client.get(endpoint, buildCall(endpoint))).rejects.toMatchObject({ status: 500 });
    expect(fake.apiRequests).toHaveLength(3);
  });

  it('network: timeout', async () => {
    const { runtime, fake } = makeTestRuntime({ config: { maxRetries: 0, requestTimeoutMs: 30 } });
    fake.apiHandler = (req) => hangingResponse({ signal: req.signal });
    const error = await runtime.client.get(endpoint, buildCall(endpoint)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe('timeout');
    expect((error as NetworkError).toPayload().error).toMatchObject({
      type: 'NETWORK_ERROR',
      code: 'TIMEOUT',
    });
  });

  it('network: connection reset', async () => {
    const { runtime, fake } = makeTestRuntime({ config: { maxRetries: 0 } });
    fake.apiHandler = () => {
      throw networkError('ECONNRESET');
    };
    const error = await runtime.client.get(endpoint, buildCall(endpoint)).catch((e: unknown) => e);
    expect((error as NetworkError).kind).toBe('connection_reset');
    expect((error as NetworkError).toPayload().error).toMatchObject({
      type: 'NETWORK_ERROR',
      code: 'CONNECTION_RESET',
    });
  });

  it('network: DNS failure', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => {
      throw networkError('ENOTFOUND');
    };
    const error = await runtime.client.get(endpoint, buildCall(endpoint)).catch((e: unknown) => e);
    expect((error as NetworkError).kind).toBe('dns');
    expect(fake.apiRequests).toHaveLength(1);
  });

  it('malformed response: invalid JSON is reported safely', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => textResponse(200, '{"data": [ {"id": 1}, ');
    const error = await runtime.client.get(endpoint, buildCall(endpoint)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect((error as MalformedResponseError).toPayload().error.type).toBe('MALFORMED_RESPONSE');
  });

  it('malformed response: unexpected JSON value is reported safely', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => textResponse(200, 'true');
    await expect(runtime.client.get(endpoint, buildCall(endpoint))).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
  });
});
