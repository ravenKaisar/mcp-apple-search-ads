/**
 * Per-tool MCP tests. For EVERY endpoint tool: valid input, missing required parameter, invalid
 * parameter, unknown account, successful Apple response, Apple API error, authentication failure,
 * pagination, and that no sensitive information is returned.
 */
import { describe, expect, it } from 'vitest';
import { API_FAMILIES } from '../../src/apple-search-ads/apis.js';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import {
  errorFixture,
  expectedPath,
  requiredParamNames,
  sampleApiArgs,
  successFixture,
} from '../helpers/fixtures.js';
import { jsonResponse, TEST_BASE_URLS } from '../helpers/fake-apple.js';
import { ACCOUNT_A, callTool, makeTestAccounts, makeTestKeys, makeTestRuntime } from '../helpers/runtime.js';

function payloadText(outcome: { payload: unknown }): string {
  return JSON.stringify(outcome.payload);
}

describe('tool registry', () => {
  it('exposes list_accounts plus one tool per GET endpoint', () => {
    const { runtime } = makeTestRuntime();
    expect(runtime.tools.map((t) => t.name).sort()).toEqual(
      ['list_accounts', ...ENDPOINTS.map((e) => e.toolName)].sort(),
    );
  });

  it('only registers tools for enabled API families', () => {
    const { runtime } = makeTestRuntime({ config: { enabledApis: ['platform-v1'] } });
    expect(runtime.tools.every((t) => t.name === 'list_accounts' || t.name.startsWith('platform_'))).toBe(
      true,
    );
  });

  it('every tool is annotated read-only and advertises a strict JSON schema', () => {
    const { runtime } = makeTestRuntime();
    for (const tool of runtime.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.jsonSchema.type).toBe('object');
      expect(tool.jsonSchema.additionalProperties).toBe(false);
      if (tool.name !== 'list_accounts') {
        expect(tool.jsonSchema.required).toContain('account_id');
      }
    }
  });
});

describe('list_accounts', () => {
  it('lists accounts without credentials', async () => {
    const { runtime, keys } = makeTestRuntime();
    const outcome = await callTool(runtime, 'list_accounts', {});
    expect(outcome).toEqual({
      ok: true,
      payload: {
        accounts: [
          {
            id: 'account-a',
            name: 'Account A',
            apis: ['campaign-management-v5', 'platform-v1'],
            default_org_id: ACCOUNT_A.orgId,
            default_ad_account_id: ACCOUNT_A.adAccountId,
          },
          {
            id: 'account-b',
            name: 'Account B',
            apis: ['campaign-management-v5', 'platform-v1'],
            default_org_id: '3333333',
            default_ad_account_id: '4444444',
          },
        ],
      },
    });
    const text = payloadText(outcome);
    for (const secret of [keys.a.privateKeyPem, ACCOUNT_A.clientId, ACCOUNT_A.teamId, ACCOUNT_A.keyId]) {
      expect(text).not.toContain(secret);
    }
  });

  it('rejects unexpected arguments', async () => {
    const { runtime } = makeTestRuntime();
    const outcome = await callTool(runtime, 'list_accounts', { include_secrets: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
  });
});

describe.each(ENDPOINTS.map((e) => [e.toolName, e] as const))('tool %s', (toolName, endpoint) => {
  const family = API_FAMILIES[endpoint.api];
  const validArgs = () => ({ account_id: 'account-a', ...sampleApiArgs(endpoint) });

  it('valid input: calls the correct Apple GET endpoint and returns structured JSON', async () => {
    const { runtime, fake } = makeTestRuntime();
    const fixture = successFixture(toolName);
    fake.apiHandler = () => jsonResponse(200, fixture, { 'x-request-id': 'req-1' });
    const outcome = await callTool(runtime, toolName, validArgs());
    expect(outcome.ok).toBe(true);
    expect(outcome.payload).toMatchObject({
      account_id: 'account-a',
      api: endpoint.api,
      tool: toolName,
      data: fixture,
    });
    expect((outcome.payload as { meta?: { request_id?: string } }).meta?.request_id).toBe('req-1');
    expect(fake.apiRequests).toHaveLength(1);
    const request = fake.apiRequests[0]!;
    expect(request.method).toBe('GET');
    expect(request.url.origin + request.url.pathname).toBe(
      TEST_BASE_URLS[endpoint.api] + expectedPath(endpoint, sampleApiArgs(endpoint)),
    );
    if (endpoint.requiresContext) {
      const expected = family.contextHeaderKey === 'orgId' ? ACCOUNT_A.orgId : ACCOUNT_A.adAccountId;
      expect(request.headers.get('x-ap-context')).toBe(`${family.contextHeaderKey}=${expected}`);
    } else {
      expect(request.headers.has('x-ap-context')).toBe(false);
    }
  });

  it('missing required parameter: rejected before any Apple call', async () => {
    const { runtime, fake } = makeTestRuntime();
    const required = requiredParamNames(endpoint);
    const target = required[0] ?? 'account_id';
    const args: Record<string, unknown> = validArgs();
    delete args[target];
    const outcome = await callTool(runtime, toolName, args);
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    expect(payloadText(outcome)).toContain(target);
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('invalid parameter: wrong types, unknown keys and path traversal are rejected', async () => {
    const { runtime, fake } = makeTestRuntime();
    const unknownKey = await callTool(runtime, toolName, { ...validArgs(), method: 'POST' });
    expect(unknownKey.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    expect(payloadText(unknownKey)).toContain('method');

    const firstPath = Object.keys(endpoint.pathParams)[0];
    if (firstPath) {
      for (const bad of ['../acls', '1/../../me', '%2e%2e', '', 12.5, -1, true]) {
        const outcome = await callTool(runtime, toolName, { ...validArgs(), [firstPath]: bad });
        expect(outcome.ok, `value ${String(bad)}`).toBe(false);
        expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
      }
    }
    const enumParam = Object.entries(endpoint.queryParams).find(
      ([, spec]) => spec.schema.def.type === 'enum',
    );
    if (enumParam) {
      const outcome = await callTool(runtime, toolName, {
        ...validArgs(),
        [enumParam[0]]: 'NOT_A_VALID_VALUE',
      });
      expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    }
    if (endpoint.pagination) {
      const outcome = await callTool(runtime, toolName, {
        ...validArgs(),
        [endpoint.pagination.limitParam]: endpoint.pagination.maxPageSize + 1,
      });
      expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
      const negative = await callTool(runtime, toolName, { ...validArgs(), offset: -1 });
      expect(negative.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    }
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('unknown account: rejected without contacting Apple', async () => {
    const { runtime, fake } = makeTestRuntime();
    for (const accountId of ['does-not-exist', '../../other-account', 'ACCOUNT-A']) {
      const outcome = await callTool(runtime, toolName, { ...validArgs(), account_id: accountId });
      expect(outcome.ok).toBe(false);
      expect((outcome.payload as { error: { type: string } }).error.type).toMatch(
        /ACCOUNT_NOT_FOUND|VALIDATION_ERROR/,
      );
    }
    expect(fake.tokenRequests).toHaveLength(0);
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('Apple API error: returned as a structured error payload', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () =>
      jsonResponse(403, errorFixture(endpoint.api, 403, 'no access'), { 'x-request-id': 'rid-9' });
    const outcome = await callTool(runtime, toolName, validArgs());
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toMatchObject({
      error: { type: 'APPLE_SEARCH_ADS_API_ERROR', status: 403, request_id: 'rid-9' },
    });
    expect(payloadText(outcome)).toContain('no access');
  });

  it('authentication failure: reported as AUTHENTICATION_ERROR without credentials', async () => {
    const { runtime, fake, keys } = makeTestRuntime();
    fake.tokenHandler = () => jsonResponse(401, { error: 'invalid_client' });
    const outcome = await callTool(runtime, toolName, validArgs());
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toMatchObject({
      error: { type: 'AUTHENTICATION_ERROR', code: 'invalid_client' },
    });
    expect(payloadText(outcome)).not.toContain(keys.a.privateKeyPem.split('\n')[1]!);
    expect(fake.apiRequests).toHaveLength(0);
  });

  if (endpoint.pagination?.supportsFetchAll) {
    it('pagination: single page metadata and fetch_all across pages', async () => {
      const pagination = endpoint.pagination!;
      const { runtime, fake } = makeTestRuntime();
      const total = 7;
      fake.apiHandler = (req) => {
        const offset = Number(req.url.searchParams.get(pagination.offsetParam) ?? 0);
        const limit = Number(req.url.searchParams.get(pagination.limitParam) ?? pagination.defaultPageSize);
        const items = Array.from({ length: total }, (_, i) => ({ id: i })).slice(offset, offset + limit);
        return jsonResponse(
          200,
          endpoint.api === 'platform-v1'
            ? { result: items, pagination: { offset, pageSize: limit, totalCount: total } }
            : {
                data: items,
                pagination: { totalResults: total, startIndex: offset, itemsPerPage: limit },
                error: null,
              },
        );
      };

      const single = await callTool(runtime, toolName, {
        ...validArgs(),
        [pagination.limitParam]: 3,
        offset: 3,
      });
      expect(single.payload).toMatchObject({
        pagination: {
          mode: 'single_page',
          offset: 3,
          limit: 3,
          total: 7,
          records_returned: 3,
          has_more: true,
          next_offset: 6,
        },
      });
      expect(fake.apiRequests.at(-1)!.url.searchParams.get(pagination.limitParam)).toBe('3');

      fake.reset();
      const all = await callTool(runtime, toolName, {
        ...validArgs(),
        [pagination.limitParam]: 3,
        fetch_all: true,
      });
      expect(all.ok).toBe(true);
      expect((all.payload as { data: unknown[] }).data).toHaveLength(7);
      expect(all.payload).toMatchObject({
        pagination: {
          mode: 'fetch_all',
          pages_fetched: 3,
          records_returned: 7,
          total: 7,
          truncated: false,
          has_more: false,
        },
      });
      expect(fake.apiRequests.map((r) => r.url.searchParams.get('offset'))).toEqual(['0', '3', '6']);
      expect(fake.apiRequests.every((r) => r.method === 'GET')).toBe(true);

      fake.reset();
      const capped = await callTool(runtime, toolName, {
        ...validArgs(),
        [pagination.limitParam]: 2,
        fetch_all: true,
        max_pages: 2,
      });
      expect(capped.payload).toMatchObject({
        pagination: { truncated: true, truncated_reason: 'max_pages', next_offset: 4, records_returned: 4 },
      });

      const tooMany = await callTool(runtime, toolName, {
        ...validArgs(),
        fetch_all: true,
        max_records: 10_000_000,
      });
      expect(tooMany.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    });
  } else {
    it('pagination: not offered (fetch_all is rejected)', async () => {
      const { runtime } = makeTestRuntime();
      const outcome = await callTool(runtime, toolName, { ...validArgs(), fetch_all: true });
      expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    });
  }

  it('sensitive information is never returned, even if Apple echoes it', async () => {
    const { runtime, fake, keys } = makeTestRuntime();
    fake.apiHandler = (req) =>
      jsonResponse(200, {
        ...(successFixture(toolName) as object),
        echoedAuthorization: req.headers.get('authorization'),
        echoedToken: req.headers.get('authorization')?.replace('Bearer ', ''),
        leakedKey: keys.a.privateKeyPem,
      });
    const outcome = await callTool(runtime, toolName, validArgs());
    expect(outcome.ok).toBe(true);
    const text = payloadText(outcome);
    const token = fake.lastToken(ACCOUNT_A.clientId)!;
    expect(text).not.toContain(token);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(keys.a.privateKeyPem.split('\n')[1]!);
    expect(text).not.toContain(new URLSearchParams(fake.tokenRequests[0]!.body).get('client_secret')!);
    expect(text).toContain('[REDACTED]');
  });

  if (endpoint.requiresContext) {
    it(`context: ${family.contextInputName} overrides the account default and is required without one`, async () => {
      const { runtime, fake } = makeTestRuntime();
      fake.apiHandler = () => jsonResponse(200, successFixture(toolName));
      await callTool(runtime, toolName, { ...validArgs(), [family.contextInputName]: '987654' });
      expect(fake.apiRequests[0]!.headers.get('x-ap-context')).toBe(`${family.contextHeaderKey}=987654`);
    });
  }
});

describe('context resolution and API enablement', () => {
  const keys = makeTestKeys();
  const accounts = makeTestAccounts(keys, [
    {
      id: 'no-defaults',
      name: 'No defaults',
      clientId: 'SEARCHADS.c-nodefaults',
      teamId: 'SEARCHADS.t-nodefaults',
      keyId: 'k-nd',
      privateKey: keys.a.privateKeyPem,
    },
    {
      id: 'platform-only',
      name: 'Platform only',
      clientId: 'SEARCHADS.c-platform',
      teamId: 'SEARCHADS.t-platform',
      keyId: 'k-p',
      privateKey: keys.b.privateKeyPem,
      apis: ['platform-v1'],
      adAccountId: '55',
    },
  ]);

  it.each([
    ['v5_get_campaign', { campaignId: '1' }, 'org_id'],
    ['platform_get_campaign', { id: '1' }, 'ad_account_id'],
  ])('%s requires %s when the account has no default', async (tool, args, param) => {
    const { runtime, fake } = makeTestRuntime({ accounts, keys });
    const outcome = await callTool(runtime, tool, { account_id: 'no-defaults', ...args });
    expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(outcome.payload)).toContain(param);
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('endpoints without a context work for accounts without defaults', async () => {
    const { runtime, fake } = makeTestRuntime({ accounts, keys });
    fake.apiHandler = () => jsonResponse(200, { data: [] });
    const outcome = await callTool(runtime, 'v5_get_user_acl', { account_id: 'no-defaults' });
    expect(outcome.ok).toBe(true);
  });

  it('refuses API families that are not enabled for the account', async () => {
    const { runtime, fake } = makeTestRuntime({ accounts, keys });
    const outcome = await callTool(runtime, 'v5_get_campaign', {
      account_id: 'platform-only',
      campaignId: '1',
      org_id: '1',
    });
    expect(outcome.payload).toMatchObject({ error: { type: 'CONFIGURATION_ERROR' } });
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('rejects org_id / ad_account_id values that could inject headers', async () => {
    const { runtime, fake } = makeTestRuntime({ accounts, keys });
    for (const bad of ['1\r\nX-Evil: 1', '1;orgId=2', 'abc', '']) {
      const outcome = await callTool(runtime, 'v5_get_campaign', {
        account_id: 'account-a',
        campaignId: '1',
        org_id: bad,
      });
      expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    }
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('enforces the platform_search_apps cross-field rule', async () => {
    const { runtime, fake } = makeTestRuntime({ accounts, keys });
    const outcome = await callTool(runtime, 'platform_search_apps', { account_id: 'account-a' });
    expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    fake.apiHandler = () => jsonResponse(200, { result: [] });
    const owned = await callTool(runtime, 'platform_search_apps', {
      account_id: 'account-a',
      returnOwnedApps: true,
    });
    expect(owned.ok).toBe(true);
  });
});
