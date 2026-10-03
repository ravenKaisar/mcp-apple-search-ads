import { describe, expect, it } from 'vitest';
import { AccountNotFoundError } from '../../src/apple-search-ads/errors.js';
import { jsonResponse } from '../helpers/fake-apple.js';
import { callTool, makeTestRuntime } from '../helpers/runtime.js';

const MALICIOUS_ACCOUNT_IDS = [
  '../../other-account',
  '../account-b',
  '..',
  'account-a/../account-b',
  'account-a\\..\\account-b',
  '%2e%2e%2faccount-b',
  '/etc/passwd',
  'C:\\Windows\\win.ini',
  'account-a\n',
  'account-a\u0000',
  '__proto__',
  'constructor',
  'toString',
  'a'.repeat(5000),
  '',
  ' account-a',
];

describe('malicious input', () => {
  it.each(MALICIOUS_ACCOUNT_IDS.map((v) => [JSON.stringify(v).slice(0, 40), v]))(
    'account_id %s is rejected without any Apple or file access',
    async (_label, accountId) => {
      const { runtime, fake } = makeTestRuntime();
      const outcome = await callTool(runtime, 'v5_get_campaign', { account_id: accountId, campaignId: '1' });
      expect(outcome.ok).toBe(false);
      expect((outcome.payload as { error: { type: string } }).error.type).toMatch(
        /^(ACCOUNT_NOT_FOUND|VALIDATION_ERROR)$/,
      );
      expect(fake.tokenRequests).toHaveLength(0);
      expect(fake.apiRequests).toHaveLength(0);
      expect(() => runtime.accounts.get(accountId)).toThrow(AccountNotFoundError);
    },
  );

  it('echoed account ids are sanitized and truncated in error messages', () => {
    const { runtime } = makeTestRuntime();
    const error = (() => {
      try {
        runtime.accounts.get(`evil\r\ninjected-${'x'.repeat(200)}`);
      } catch (e) {
        return e as AccountNotFoundError;
      }
      return undefined;
    })();
    expect(error?.message).not.toContain('\n');
    expect(error!.message.length).toBeLessThan(200);
  });

  it.each([
    '../acls',
    '..',
    '1/2',
    '1?admin=true',
    '1#frag',
    '%2e%2e%2f',
    '1%00',
    ' 1',
    '1 OR 1=1',
    '１２３',
  ])('path parameter %j cannot escape the endpoint path', async (value) => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { result: {} });
    for (const [tool, param] of [
      ['v5_get_campaign', 'campaignId'],
      ['platform_get_campaign', 'id'],
      ['platform_get_change_history_detail', 'detailId'],
      ['v5_get_product_page', 'productPageId'],
    ] as const) {
      const args: Record<string, unknown> = { account_id: 'account-a', [param]: value };
      if (tool === 'v5_get_product_page') args.adamId = '1';
      const outcome = await callTool(runtime, tool, args);
      expect(outcome.ok, `${tool} ${param}=${value}`).toBe(false);
    }
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('query strings cannot smuggle extra parameters', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: [] });
    await callTool(runtime, 'v5_search_apps', {
      account_id: 'account-a',
      query: 'trip&returnOwnedApps=true&limit=1000',
    });
    const url = fake.apiRequests[0]!.url;
    expect(url.searchParams.get('query')).toBe('trip&returnOwnedApps=true&limit=1000');
    expect(url.searchParams.has('returnOwnedApps')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.pathname).toMatch(/\/search\/apps$/);
  });

  it('control characters in free text are rejected', async () => {
    const { runtime, fake } = makeTestRuntime();
    const outcome = await callTool(runtime, 'v5_search_apps', {
      account_id: 'account-a',
      query: 'trip\r\nX-Evil: 1',
    });
    expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    expect(fake.apiRequests).toHaveLength(0);
  });

  it('prototype pollution payloads are ignored', async () => {
    const { runtime, fake } = makeTestRuntime();
    const args = JSON.parse(
      '{"account_id":"account-a","campaignId":"1","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const outcome = await callTool(runtime, 'v5_get_campaign', args);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(outcome.ok === false || fake.apiRequests.length === 1).toBe(true);
  });

  it('numbers beyond 2^53 must be strings (no silent precision loss)', async () => {
    const { runtime } = makeTestRuntime();
    const outcome = await callTool(runtime, 'platform_get_brand', {
      account_id: 'account-a',
      id: 9151314442816847872,
    });
    expect(outcome.payload).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
  });
});
