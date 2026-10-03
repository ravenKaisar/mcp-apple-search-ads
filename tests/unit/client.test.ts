import { describe, expect, it } from 'vitest';
import { assertSafePathSegment } from '../../src/apple-search-ads/client.js';
import { getEndpointByTool } from '../../src/apple-search-ads/endpoints/index.js';
import {
  AppleSearchAdsApiError,
  type NetworkError,
  RateLimitError,
  ValidationError,
} from '../../src/apple-search-ads/errors.js';
import { errorFixture } from '../helpers/fixtures.js';
import { jsonResponse, networkError, TEST_BASE_URLS } from '../helpers/fake-apple.js';
import { ACCOUNT_A, makeTestRuntime } from '../helpers/runtime.js';

const v5Campaign = getEndpointByTool('v5_get_campaign')!;
const v5Campaigns = getEndpointByTool('v5_get_all_campaigns')!;
const platformApps = getEndpointByTool('platform_search_apps')!;
const v5Countries = getEndpointByTool('v5_get_supported_countries_or_regions')!;
const v5Acl = getEndpointByTool('v5_get_user_acl')!;
const platformCampaign = getEndpointByTool('platform_get_campaign')!;

const call = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'account-a',
  context: ACCOUNT_A.orgId,
  pathParams: { campaignId: '542370642' },
  query: {},
  ...overrides,
});

describe('AppleSearchAdsClient URL building', () => {
  const { runtime } = makeTestRuntime();
  const client = runtime.client;

  it('substitutes and encodes path params', () => {
    expect(client.buildUrl(v5Campaign, { campaignId: '542370642' }, {}).href).toBe(
      `${TEST_BASE_URLS['campaign-management-v5']}/campaigns/542370642`,
    );
  });

  it('serializes csv arrays, repeated arrays, booleans and numbers', () => {
    expect(client.buildUrl(v5Campaigns, {}, { limit: 50, offset: 100, fields: ['id', 'name'] }).search).toBe(
      '?limit=50&offset=100&fields=id%2Cname',
    );
    expect(
      client.buildUrl(
        platformApps,
        {},
        { query: 'Away Finder', storeFronts: ['US', 'GB'], returnOwnedApps: true },
      ).search,
    ).toBe('?query=Away+Finder&storeFronts=US&storeFronts=GB&returnOwnedApps=true');
    expect(client.buildUrl(v5Countries, {}, { countriesOrRegions: ['US', 'MX'] }).search).toBe(
      '?countriesOrRegions=US%2CMX',
    );
  });

  it('omits undefined query values and rejects unknown query params', () => {
    expect(client.buildUrl(v5Campaigns, {}, { limit: undefined }).search).toBe('');
    expect(() => client.buildUrl(v5Campaigns, {}, { method: 'POST' })).toThrow(ValidationError);
  });

  it.each(['..', '.', '../acls', '1/2', '1?x=1', '1#f', '%2e%2e', 'a b', '1\r\n', ''])(
    'rejects unsafe path segment %j',
    (value) => {
      expect(() => assertSafePathSegment('campaignId', value)).toThrow(ValidationError);
      expect(() => client.buildUrl(v5Campaign, { campaignId: value }, {})).toThrow(ValidationError);
    },
  );

  it('rejects missing path params', () => {
    expect(() => client.buildUrl(v5Campaign, {}, {})).toThrow(ValidationError);
  });
});

describe('AppleSearchAdsClient requests', () => {
  it('sends Authorization and X-AP-Context: orgId for v5', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: { id: 1 } });
    const result = await runtime.client.get(v5Campaign, call());
    expect(result.body).toEqual({ data: { id: 1 } });
    const request = fake.apiRequests[0]!;
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe(`Bearer ${fake.lastToken(ACCOUNT_A.clientId)}`);
    expect(request.headers.get('x-ap-context')).toBe(`orgId=${ACCOUNT_A.orgId}`);
    expect(request.headers.get('accept')).toBe('application/json');
    expect(request.headers.get('user-agent')).toMatch(/^apple-search-ads-mcp\//);
  });

  it('sends X-AP-Context: adAccountId for the Platform API', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { result: {} });
    await runtime.client.get(
      platformCampaign,
      call({ context: ACCOUNT_A.adAccountId, pathParams: { id: '1' } }),
    );
    expect(fake.apiRequests[0]!.headers.get('x-ap-context')).toBe(`adAccountId=${ACCOUNT_A.adAccountId}`);
  });

  it('omits X-AP-Context for endpoints that do not need it', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: [] });
    await runtime.client.get(v5Acl, call({ context: undefined, pathParams: {} }));
    expect(fake.apiRequests[0]!.headers.has('x-ap-context')).toBe(false);
  });

  it.each([undefined, '', 'orgId=1; evil', '1\r\nX-Evil: 1'])(
    'rejects missing/unsafe context %j',
    async (context) => {
      const { runtime, fake } = makeTestRuntime();
      await expect(runtime.client.get(v5Campaign, call({ context }))).rejects.toBeInstanceOf(ValidationError);
      expect(fake.apiRequests).toHaveLength(0);
    },
  );

  it('refreshes the token once on 401 and retries', async () => {
    const { runtime, fake } = makeTestRuntime();
    let n = 0;
    fake.apiHandler = () =>
      ++n === 1
        ? jsonResponse(401, errorFixture('campaign-management-v5', 401))
        : jsonResponse(200, { data: {} });
    const result = await runtime.client.get(v5Campaign, call());
    expect(result.status).toBe(200);
    expect(fake.tokenRequests).toHaveLength(2);
    const [first, second] = fake.apiRequests;
    expect(first!.headers.get('authorization')).not.toBe(second!.headers.get('authorization'));
  });

  it('gives up after a second 401', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(401, errorFixture('campaign-management-v5', 401, 'token expired'));
    const error = (await runtime.client
      .get(v5Campaign, call())
      .catch((e: unknown) => e)) as AppleSearchAdsApiError;
    expect(error).toBeInstanceOf(AppleSearchAdsApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('token expired');
    expect(fake.apiRequests).toHaveLength(2);
  });

  it('retries 429 honouring Retry-After', async () => {
    const { runtime, fake, sleeps } = makeTestRuntime();
    let n = 0;
    fake.apiHandler = () =>
      ++n === 1
        ? jsonResponse(429, errorFixture('platform-v1', 429), { 'retry-after': '3' })
        : jsonResponse(200, { result: {} });
    await runtime.client.get(platformCampaign, call({ context: '1', pathParams: { id: '1' } }));
    expect(sleeps).toEqual([3000]);
  });

  it('falls back to RateLimit-Reset when Retry-After is absent', async () => {
    const { runtime, fake, sleeps } = makeTestRuntime();
    let n = 0;
    fake.apiHandler = () =>
      ++n === 1
        ? jsonResponse(429, errorFixture('platform-v1', 429), {
            'ratelimit-remaining': '0',
            'ratelimit-reset': '2',
          })
        : jsonResponse(200, { result: {} });
    await runtime.client.get(platformCampaign, call({ context: '1', pathParams: { id: '1' } }));
    expect(sleeps[0]).toBe(2000);
  });

  it('fails fast with RateLimitError when Retry-After exceeds the configured maximum', async () => {
    const { runtime, fake, sleeps } = makeTestRuntime({ config: { maxRetryAfterMs: 1000 } });
    fake.apiHandler = () =>
      jsonResponse(429, errorFixture('campaign-management-v5', 429), { 'retry-after': '120' });
    const error = (await runtime.client.get(v5Campaign, call()).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.toPayload().error).toMatchObject({
      type: 'RATE_LIMIT_ERROR',
      status: 429,
      retry_after_seconds: 120,
    });
    expect(sleeps).toEqual([]);
  });

  it('reports RateLimitError once retries are exhausted', async () => {
    const { runtime, fake } = makeTestRuntime({ config: { maxRetries: 2 } });
    fake.apiHandler = () =>
      jsonResponse(429, errorFixture('campaign-management-v5', 429), { 'retry-after': '0' });
    await expect(runtime.client.get(v5Campaign, call())).rejects.toBeInstanceOf(RateLimitError);
    expect(fake.apiRequests).toHaveLength(3);
  });

  it.each([500, 502, 503, 504])('retries %i with backoff and succeeds', async (status) => {
    const { runtime, fake, sleeps } = makeTestRuntime();
    let n = 0;
    fake.apiHandler = () => (++n < 3 ? jsonResponse(status, {}) : jsonResponse(200, { data: {} }));
    const result = await runtime.client.get(v5Campaign, call());
    expect(result.attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it.each([400, 403, 404, 409])('does not retry %i', async (status) => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(status, errorFixture('campaign-management-v5', status));
    const error = (await runtime.client
      .get(v5Campaign, call())
      .catch((e: unknown) => e)) as AppleSearchAdsApiError;
    expect(error.status).toBe(status);
    expect(fake.apiRequests).toHaveLength(1);
  });

  it('retries transient network errors but not permanent DNS failures', async () => {
    const { runtime, fake } = makeTestRuntime();
    let n = 0;
    fake.apiHandler = () => {
      n += 1;
      if (n === 1) throw networkError('ECONNRESET');
      return jsonResponse(200, { data: {} });
    };
    await expect(runtime.client.get(v5Campaign, call())).resolves.toMatchObject({ status: 200 });

    const dns = makeTestRuntime();
    dns.fake.apiHandler = () => {
      throw networkError('ENOTFOUND');
    };
    const error = (await dns.runtime.client.get(v5Campaign, call()).catch((e: unknown) => e)) as NetworkError;
    expect(error.kind).toBe('dns');
    expect(dns.fake.apiRequests).toHaveLength(1);
  });

  it('maps Apple v5 and Platform error envelopes into details', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () =>
      jsonResponse(400, {
        data: null,
        pagination: null,
        error: {
          errors: [{ messageCode: 'INVALID_ATTRIBUTE_TYPE', message: 'bad id', field: 'campaignId' }],
        },
      });
    const v5Error = (await runtime.client
      .get(v5Campaign, call())
      .catch((e: unknown) => e)) as AppleSearchAdsApiError;
    expect(v5Error.toPayload().error).toEqual({
      type: 'APPLE_SEARCH_ADS_API_ERROR',
      status: 400,
      message: 'Apple Ads API rejected the request as invalid (400): bad id',
      code: 'INVALID_ATTRIBUTE_TYPE',
      details: [{ code: 'INVALID_ATTRIBUTE_TYPE', message: 'bad id', field: 'campaignId' }],
    });

    fake.apiHandler = () =>
      jsonResponse(
        404,
        {
          error: {
            code: 'ENTITY_NOT_FOUND',
            message: 'Product page not found',
            details: [
              {
                code: 'RESOURCE_NOT_FOUND_ENTITY',
                message: 'Product page not found',
                info: { field: 'productPageId' },
              },
            ],
          },
        },
        { 'x-request-id': 'abc-123' },
      );
    const pfError = (await runtime.client
      .get(platformCampaign, call({ context: '1', pathParams: { id: '1' } }))
      .catch((e: unknown) => e)) as AppleSearchAdsApiError;
    expect(pfError.toPayload().error).toMatchObject({
      status: 404,
      code: 'ENTITY_NOT_FOUND',
      request_id: 'abc-123',
      details: [{ code: 'RESOURCE_NOT_FOUND_ENTITY', field: 'productPageId' }],
    });
  });

  it('waits proactively when RateLimit-Remaining reaches 0', async () => {
    const { runtime, fake, sleeps } = makeTestRuntime();
    fake.apiHandler = () =>
      jsonResponse(
        200,
        { result: {} },
        { 'ratelimit-limit': '10', 'ratelimit-remaining': '0', 'ratelimit-reset': '5' },
      );
    const c = call({ context: '1', pathParams: { id: '1' } });
    await runtime.client.get(platformCampaign, c);
    expect(sleeps).toEqual([]);
    await runtime.client.get(platformCampaign, c);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(4000);
  });

  it('fetchPage/getAll extract items and totals from both envelopes', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = (req) => {
      const offset = Number(req.url.searchParams.get('offset'));
      const limit = Number(req.url.searchParams.get('limit'));
      const all = Array.from({ length: 7 }, (_, i) => ({ id: i }));
      return jsonResponse(200, {
        data: all.slice(offset, offset + limit),
        pagination: { totalResults: 7, startIndex: offset, itemsPerPage: limit },
        error: null,
      });
    };
    const { items, outcome } = await runtime.client.getAll(v5Campaigns, call({ pathParams: {} }), {
      startOffset: 0,
      pageSize: 3,
      maxPages: 10,
      maxRecords: 100,
    });
    expect(items).toHaveLength(7);
    expect(outcome.pagesFetched).toBe(3);
  });
});
