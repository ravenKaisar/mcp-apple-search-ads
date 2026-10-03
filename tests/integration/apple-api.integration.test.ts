/**
 * Integration tests: real configuration loading (accounts.json on disk, default Apple URLs), real fetch,
 * real MCP server over an in-memory MCP transport, with Apple's HTTP endpoints mocked by MSW.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import { loadAppConfig } from '../../src/config/env.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { JsonLogger } from '../../src/utils/logger.js';
import { sampleApiArgs, successFixture } from '../helpers/fixtures.js';
import { generateEs256KeyPair } from '../helpers/keys.js';
import { ACCOUNT_A, ACCOUNT_B } from '../helpers/runtime.js';
import { createAppleMock } from './msw-apple.js';

const mock = createAppleMock();
let runtime: Runtime;
let client: Client;
const logs: string[] = [];
const keyA = generateEs256KeyPair();
const keyB = generateEs256KeyPair();

beforeAll(async () => {
  mock.server.listen({ onUnhandledRequest: 'error' });
  const dir = mkdtempSync(join(tmpdir(), 'asa-int-'));
  writeFileSync(join(dir, 'key-b.pem'), keyB.privateKeyPem, { mode: 0o600 });
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify({
      accounts: [
        { ...ACCOUNT_A, privateKey: keyA.privateKeyPem },
        { ...ACCOUNT_B, privateKeyPath: 'key-b.pem' },
      ],
    }),
    { mode: 0o600 },
  );
  const config = loadAppConfig({
    ACCOUNTS_CONFIG: join(dir, 'accounts.json'),
    RETRY_BASE_DELAY_MS: '1',
    RETRY_MAX_DELAY_MS: '5',
    MAX_RETRIES: '2',
  });
  runtime = createRuntime(config, { logger: new JsonLogger({ level: 'debug', sink: (l) => logs.push(l) }) });
  const server = runtime.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'integration', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterEach(() => mock.reset());

afterAll(async () => {
  await client.close();
  mock.server.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: result.structuredContent as Record<string, any> };
}

describe('integration: every GET endpoint through MCP -> client -> mocked Apple', () => {
  it.each(ENDPOINTS.map((e) => [e.toolName, e] as const))(
    '%s returns the realistic fixture',
    async (toolName, endpoint) => {
      const result = await call(toolName, { account_id: 'account-a', ...sampleApiArgs(endpoint) });
      expect(result.isError, JSON.stringify(result.body)).toBe(false);
      expect(result.body.data).toEqual(successFixture(toolName));
      expect(result.body.meta.request_id).toBe('req-fixture');
      expect(mock.state.requests.at(-1)?.method).toBe('GET');
    },
  );

  it('never sent a non-GET request to the Apple Ads APIs', () => {
    expect(mock.state.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('integration: pagination', () => {
  it('fetch_all walks 1000-record pages (v5 maximum) and stops at the total', async () => {
    mock.state.datasets.set(
      'v5_get_all_campaigns',
      Array.from({ length: 2345 }, (_, id) => ({ id })),
    );
    const result = await call('v5_get_all_campaigns', {
      account_id: 'account-a',
      fetch_all: true,
      max_records: 5000,
    });
    expect(result.body.data).toHaveLength(2345);
    expect(result.body.pagination).toMatchObject({
      pages_fetched: 3,
      total: 2345,
      truncated: false,
      limit: 1000,
    });
    expect(mock.state.requests.map((r) => r.url.searchParams.get('offset'))).toEqual(['0', '1000', '2000']);
    expect(mock.state.requests.map((r) => r.url.searchParams.get('limit'))).toEqual(['1000', '1000', '1000']);
  });

  it('fetch_all respects the default max_records safety limit', async () => {
    mock.state.datasets.set(
      'v5_get_all_campaigns',
      Array.from({ length: 50_000 }, (_, id) => ({ id })),
    );
    const result = await call('v5_get_all_campaigns', { account_id: 'account-a', fetch_all: true });
    expect(result.body.data).toHaveLength(1000);
    expect(result.body.pagination).toMatchObject({
      truncated: true,
      truncated_reason: 'max_records',
      next_offset: 1000,
    });
  });

  it('platform pageSize pagination works for search_geo', async () => {
    mock.state.datasets.set(
      'platform_search_geo_locations',
      Array.from({ length: 250 }, (_, i) => ({ id: String(i) })),
    );
    const result = await call('platform_search_geo_locations', {
      account_id: 'account-a',
      supplySource: 'APPSTORE',
      fetch_all: true,
    });
    expect(result.body.data).toHaveLength(250);
    expect(mock.state.requests.map((r) => r.url.searchParams.get('pageSize'))).toEqual(['100', '100', '100']);
  });

  it('single page returns Apple pagination metadata', async () => {
    mock.state.datasets.set(
      'platform_search_apps',
      Array.from({ length: 45 }, (_, i) => ({ adamId: i })),
    );
    const result = await call('platform_search_apps', {
      account_id: 'account-b',
      query: 'away',
      limit: 20,
      offset: 20,
    });
    expect(result.body.pagination).toMatchObject({
      offset: 20,
      limit: 20,
      total: 45,
      has_more: true,
      next_offset: 40,
    });
  });
});

describe('integration: errors, retries and authentication', () => {
  it('retries 429 with Retry-After and succeeds', async () => {
    let n = 0;
    mock.state.overrides.set('v5_get_campaign', () =>
      ++n === 1
        ? HttpResponse.json({ error: { errors: [] } }, { status: 429, headers: { 'Retry-After': '0' } })
        : undefined,
    );
    const result = await call('v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    expect(result.isError).toBe(false);
    expect(n).toBe(2);
  });

  it('refreshes an access token Apple no longer accepts', async () => {
    await call('platform_get_me', { account_id: 'account-a' });
    mock.state.issued.set(ACCOUNT_A.clientId, []); // Apple "revokes" all tokens for account A
    const result = await call('platform_get_me', { account_id: 'account-a' });
    expect(result.isError).toBe(false);
    expect(mock.state.tokenRequests.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces Apple 404 errors with details', async () => {
    mock.state.overrides.set('platform_get_product_page', () =>
      HttpResponse.json(
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
        { status: 404 },
      ),
    );
    const result = await call('platform_get_product_page', {
      account_id: 'account-a',
      productPageId: '133fc807-d4d5-4c77-92ae-1d6ffdf0c7dc',
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatchObject({
      type: 'APPLE_SEARCH_ADS_API_ERROR',
      status: 404,
      code: 'ENTITY_NOT_FOUND',
    });
  });

  it('maps network failures', async () => {
    mock.state.overrides.set('v5_get_ad', () => HttpResponse.error());
    const result = await call('v5_get_ad', {
      account_id: 'account-a',
      campaignId: '1',
      adgroupId: '2',
      adId: '3',
    });
    expect(result.isError).toBe(true);
    expect(result.body.error.type).toBe('NETWORK_ERROR');
  });

  it('maps malformed JSON', async () => {
    mock.state.overrides.set('v5_get_creative', () => new HttpResponse('{"data": ', { status: 200 }));
    const result = await call('v5_get_creative', { account_id: 'account-a', creativeId: '1' });
    expect(result.body.error.type).toBe('MALFORMED_RESPONSE');
  });

  it('reports invalid credentials as AUTHENTICATION_ERROR', async () => {
    mock.state.tokenOverride = () => HttpResponse.json({ error: 'invalid_client' }, { status: 400 });
    const result = await call('v5_get_user_acl', { account_id: 'account-b' });
    // account-b may already hold a cached token from earlier tests; force a fresh account context
    if (!result.isError) {
      runtime.accounts.invalidateAccessToken('account-b');
      const retry = await call('v5_get_user_acl', { account_id: 'account-b' });
      expect(retry.body.error).toMatchObject({ type: 'AUTHENTICATION_ERROR', code: 'invalid_client' });
    } else {
      expect(result.body.error).toMatchObject({ type: 'AUTHENTICATION_ERROR', code: 'invalid_client' });
    }
  });

  it('isolates accounts: each request carries its own account token and context', async () => {
    await call('v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    await call('v5_get_campaign', { account_id: 'account-b', campaignId: '1' });
    const [a, b] = mock.state.requests.slice(-2);
    expect(a!.headers.get('authorization')).toContain(ACCOUNT_A.clientId);
    expect(a!.headers.get('x-ap-context')).toBe(`orgId=${ACCOUNT_A.orgId}`);
    expect(b!.headers.get('authorization')).toContain(ACCOUNT_B.clientId);
    expect(b!.headers.get('x-ap-context')).toBe(`orgId=${ACCOUNT_B.orgId}`);
  });

  it('logs contain request events but no credentials', () => {
    const text = logs.join('\n');
    expect(text).toContain('apple_api_request');
    expect(text).not.toContain('msw_SEARCHADS');
    expect(text).not.toContain('PRIVATE KEY');
  });
});
