import { describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers/fake-apple.js';
import { ACCOUNT_A, ACCOUNT_B, callTool, makeTestRuntime } from '../helpers/runtime.js';

function jwtPayload(body: string | undefined): Record<string, unknown> {
  const secret = new URLSearchParams(body).get('client_secret')!;
  return JSON.parse(Buffer.from(secret.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
}

describe('account isolation', () => {
  it('account-a requests use account-a credentials; account-b requests use account-b credentials', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: {} });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-b', campaignId: '1' });

    const [tokenA, tokenB] = fake.tokenRequests.map((r) => jwtPayload(r.body));
    expect(tokenA).toMatchObject({ sub: ACCOUNT_A.clientId, iss: ACCOUNT_A.teamId });
    expect(tokenB).toMatchObject({ sub: ACCOUNT_B.clientId, iss: ACCOUNT_B.teamId });

    const [reqA, reqB] = fake.apiRequests;
    expect(reqA!.headers.get('authorization')).toBe(`Bearer ${fake.lastToken(ACCOUNT_A.clientId)}`);
    expect(reqA!.headers.get('x-ap-context')).toBe(`orgId=${ACCOUNT_A.orgId}`);
    expect(reqB!.headers.get('authorization')).toBe(`Bearer ${fake.lastToken(ACCOUNT_B.clientId)}`);
    expect(reqB!.headers.get('x-ap-context')).toBe(`orgId=${ACCOUNT_B.orgId}`);
  });

  it("account A can never use account B's token, even under concurrency", async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = async (req) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return jsonResponse(200, { result: { auth: req.headers.get('authorization') } });
    };
    const calls = Array.from({ length: 40 }, (_, i) => {
      const accountId = i % 2 === 0 ? 'account-a' : 'account-b';
      return callTool(runtime, 'platform_get_campaign', { account_id: accountId, id: String(i + 1) }).then(
        (o) => ({
          accountId,
          o,
        }),
      );
    });
    const results = await Promise.all(calls);
    expect(fake.tokenRequests).toHaveLength(2); // one token per account, single-flight
    const tokenA = fake.lastToken(ACCOUNT_A.clientId)!;
    const tokenB = fake.lastToken(ACCOUNT_B.clientId)!;
    expect(tokenA).not.toBe(tokenB);
    for (const request of fake.apiRequests) {
      const id = Number(request.url.pathname.split('/').pop());
      const expectedAccount = (id - 1) % 2 === 0 ? 'a' : 'b';
      expect(request.headers.get('authorization')).toBe(
        `Bearer ${expectedAccount === 'a' ? tokenA : tokenB}`,
      );
      expect(request.headers.get('x-ap-context')).toBe(
        `adAccountId=${expectedAccount === 'a' ? ACCOUNT_A.adAccountId : ACCOUNT_B.adAccountId}`,
      );
    }
    expect(
      results.every((r) => r.o.ok && (r.o.payload as { account_id: string }).account_id === r.accountId),
    ).toBe(true);
  });

  it('a rejected token for one account does not affect the other', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: {} });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-b', campaignId: '1' });
    const tokenB = fake.lastToken(ACCOUNT_B.clientId);

    let first = true;
    fake.apiHandler = (req) => {
      if (first && req.headers.get('authorization')?.includes(ACCOUNT_A.clientId)) {
        first = false;
        return jsonResponse(401, {});
      }
      return jsonResponse(200, { data: {} });
    };
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-b', campaignId: '1' });
    expect(fake.issuedTokens.get(ACCOUNT_A.clientId)).toHaveLength(2);
    expect(fake.issuedTokens.get(ACCOUNT_B.clientId)).toEqual([tokenB]);
  });

  it('explicit org_id overrides only affect that call', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: {} });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1', org_id: '999' });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    expect(fake.apiRequests.map((r) => r.headers.get('x-ap-context'))).toEqual([
      'orgId=999',
      `orgId=${ACCOUNT_A.orgId}`,
    ]);
    expect(new Set(fake.apiRequests.map((r) => r.headers.get('authorization'))).size).toBe(1);
  });
});
