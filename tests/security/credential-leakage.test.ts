import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { jsonResponse, textResponse } from '../helpers/fake-apple.js';
import { ACCOUNT_A, callTool, makeTestRuntime } from '../helpers/runtime.js';

function secretsOf(ctx: ReturnType<typeof makeTestRuntime>): string[] {
  const { keys, fake } = ctx;
  const out = [
    keys.a.privateKeyPem,
    keys.b.privateKeyPem,
    ...keys.a.privateKeyPem.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----')),
    ...keys.b.privateKeyPem.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----')),
  ];
  for (const tokens of fake.issuedTokens.values()) out.push(...tokens);
  for (const req of fake.tokenRequests) out.push(new URLSearchParams(req.body).get('client_secret')!);
  return out;
}

function assertNoSecrets(text: string, secrets: string[]): void {
  for (const secret of secrets) expect(text.includes(secret), `leaked: ${secret.slice(0, 12)}…`).toBe(false);
  expect(text).not.toMatch(/Bearer\s+tok_/);
  expect(text).not.toContain('BEGIN PRIVATE KEY');
}

describe('credential leakage prevention', () => {
  it('private keys, client secrets, access tokens and Authorization headers never appear in tool output', async () => {
    const ctx = makeTestRuntime();
    const { runtime, fake } = ctx;
    fake.apiHandler = (req) =>
      jsonResponse(200, {
        data: {
          headers: Object.fromEntries(req.headers.entries()),
          note: `your token is ${req.headers.get('authorization')}`,
        },
      });
    const outcome = await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    const text = JSON.stringify(outcome.payload);
    assertNoSecrets(text, secretsOf(ctx));
  });

  it('nothing sensitive is returned in error payloads (Apple error bodies echoing credentials)', async () => {
    const ctx = makeTestRuntime();
    const { runtime, fake, keys } = ctx;
    fake.apiHandler = (req) =>
      jsonResponse(400, {
        error: {
          errors: [
            {
              messageCode: 'BAD',
              message: `bad header ${req.headers.get('authorization')} ${keys.a.privateKeyPem}`,
              field: 'x',
            },
          ],
        },
      });
    const outcome = await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    expect(outcome.ok).toBe(false);
    assertNoSecrets(JSON.stringify(outcome.payload), secretsOf(ctx));
  });

  it('authentication failures do not reveal the client secret or key', async () => {
    const ctx = makeTestRuntime();
    ctx.fake.tokenHandler = (req) =>
      textResponse(400, `invalid client_secret=${new URLSearchParams(req.body).get('client_secret')}`);
    const outcome = await callTool(ctx.runtime, 'platform_get_me', { account_id: 'account-a' });
    expect(outcome.payload).toMatchObject({ error: { type: 'AUTHENTICATION_ERROR' } });
    assertNoSecrets(JSON.stringify(outcome.payload), secretsOf(ctx));
  });

  it('list_accounts and runtime objects never expose credentials', async () => {
    const ctx = makeTestRuntime();
    ctx.fake.apiHandler = () => jsonResponse(200, { data: {} });
    await callTool(ctx.runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    const outcome = await callTool(ctx.runtime, 'list_accounts', {});
    const dumps = [
      JSON.stringify(outcome.payload),
      JSON.stringify(ctx.runtime.accounts),
      inspect(ctx.runtime.accounts, { depth: 8 }),
      inspect(ctx.runtime.accounts.get('account-a'), { depth: 8 }),
      JSON.stringify(ctx.runtime.accounts.get('account-a')),
    ].join('\n');
    assertNoSecrets(dumps, secretsOf(ctx));
    expect(dumps).not.toContain(ACCOUNT_A.clientId);
    expect(dumps).not.toContain(ACCOUNT_A.keyId);
  });

  it('logs never contain credentials, even on failures', async () => {
    const ctx = makeTestRuntime();
    let n = 0;
    ctx.fake.apiHandler = () => (++n % 2 ? jsonResponse(401, {}) : jsonResponse(503, {}));
    await callTool(ctx.runtime, 'v5_get_all_campaigns', { account_id: 'account-a', fetch_all: true });
    ctx.fake.tokenHandler = () => jsonResponse(400, { error: 'invalid_client' });
    await callTool(ctx.runtime, 'v5_get_campaign', { account_id: 'account-b', campaignId: '1' });
    assertNoSecrets(ctx.logs.join('\n'), secretsOf(ctx));
  });
});
