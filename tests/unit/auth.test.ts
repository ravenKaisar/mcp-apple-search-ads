import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountManager } from '../../src/apple-search-ads/accounts.js';
import {
  AccountTokenManager,
  createClientSecret,
  OAUTH_AUDIENCE,
  OAuthTokenClient,
} from '../../src/apple-search-ads/auth.js';
import { AccountNotFoundError, AuthenticationError } from '../../src/apple-search-ads/errors.js';
import { parseAccountsDocument } from '../../src/config/loader.js';
import { SecretScrubber } from '../../src/utils/redact.js';
import {
  FakeApple,
  jsonResponse,
  networkError,
  TEST_TOKEN_URL,
  textResponse,
} from '../helpers/fake-apple.js';
import { generateEs256KeyPair } from '../helpers/keys.js';
import { ACCOUNT_A, makeTestAccounts, makeTestKeys, ManualClock } from '../helpers/runtime.js';

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>,
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s!, 'base64url'),
  };
}

function setup(options: { clock?: ManualClock; maxRetries?: number } = {}) {
  const keys = makeTestKeys();
  const loaded = makeTestAccounts(keys);
  const fake = new FakeApple();
  const clock = options.clock ?? new ManualClock();
  const scrubber = new SecretScrubber();
  const sleeps: number[] = [];
  const client = new OAuthTokenClient({
    tokenUrl: TEST_TOKEN_URL,
    fetch: fake.fetch,
    clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    timeoutMs: 1000,
    maxRetries: options.maxRetries ?? 2,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 40,
    clientSecretTtlSeconds: 3600,
    random: () => 0.5,
    scrubber,
  });
  const manager = new AccountManager(loaded.accounts, {
    tokenClient: client,
    clock,
    refreshSkewSeconds: 60,
    scrubber,
  });
  return { keys, loaded, fake, clock, client, manager, scrubber, sleeps };
}

describe('client secret (ES256 JWT)', () => {
  it('has Apple-specified header and claims and a valid ES256 signature', () => {
    const key = generateEs256KeyPair();
    const { accounts } = parseAccountsDocument({
      accounts: [{ ...ACCOUNT_A, privateKey: key.privateKeyPem }],
    });
    const now = 1_790_000_000;
    const jwt = createClientSecret(accounts[0]!.credentials, { nowSeconds: now, ttlSeconds: 3600 });
    const { header, payload, signingInput, signature } = decodeJwt(jwt);
    expect(header).toEqual({ alg: 'ES256', kid: ACCOUNT_A.keyId });
    expect(payload).toEqual({
      sub: ACCOUNT_A.clientId,
      aud: OAUTH_AUDIENCE,
      iat: now,
      exp: now + 3600,
      iss: ACCOUNT_A.teamId,
    });
    expect(signature).toHaveLength(64); // raw r||s, not DER
    expect(
      verify(
        'sha256',
        Buffer.from(signingInput),
        { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });
});

describe('OAuth token exchange and caching', () => {
  it('requests a token with the documented form parameters (valid authentication)', async () => {
    const { fake, manager, keys } = setup();
    const token = await manager.getAccessToken('account-a');
    expect(token).toBe(fake.lastToken(ACCOUNT_A.clientId));
    expect(fake.tokenRequests).toHaveLength(1);
    const request = fake.tokenRequests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url.href).toBe(TEST_TOKEN_URL);
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(request.body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe('searchadsorg');
    expect(params.get('client_id')).toBe(ACCOUNT_A.clientId);
    const { payload, signingInput, signature } = decodeJwt(params.get('client_secret')!);
    expect(payload.sub).toBe(ACCOUNT_A.clientId);
    expect(
      verify(
        'sha256',
        Buffer.from(signingInput),
        { key: keys.a.publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
    // The secret is never placed in the URL.
    expect(request.url.search).toBe('');
  });

  it('caches a valid token and reuses it', async () => {
    const { fake, manager } = setup();
    const first = await manager.getAccessToken('account-a');
    const second = await manager.getAccessToken('account-a');
    expect(second).toBe(first);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it('refreshes an expired token automatically (expired token / token refresh)', async () => {
    const { fake, manager, clock } = setup();
    const first = await manager.getAccessToken('account-a');
    clock.advance(3600 * 1000 - 61 * 1000); // still inside lifetime minus skew
    expect(await manager.getAccessToken('account-a')).toBe(first);
    clock.advance(2 * 1000); // now within the 60s refresh skew
    const refreshed = await manager.getAccessToken('account-a');
    expect(refreshed).not.toBe(first);
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('uses expires_in from Apple and never a skew larger than half the lifetime', async () => {
    const { fake, manager, clock } = setup();
    fake.expiresIn = 60;
    const first = await manager.getAccessToken('account-a');
    clock.advance(29_000);
    expect(await manager.getAccessToken('account-a')).toBe(first);
    clock.advance(2_000);
    expect(await manager.getAccessToken('account-a')).not.toBe(first);
  });

  it('deduplicates concurrent refreshes (single flight)', async () => {
    const { fake, manager } = setup();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => manager.getAccessToken('account-a')));
    expect(new Set(tokens).size).toBe(1);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it('invalidates only the rejected token', async () => {
    const { fake, manager } = setup();
    const first = await manager.getAccessToken('account-a');
    manager.invalidateAccessToken('account-a', 'some-other-token');
    expect(await manager.getAccessToken('account-a')).toBe(first);
    manager.invalidateAccessToken('account-a', first);
    expect(await manager.getAccessToken('account-a')).not.toBe(first);
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it('fails cleanly on invalid credentials (HTTP 400 invalid_client) without retrying', async () => {
    const { fake, manager } = setup();
    fake.tokenHandler = () => jsonResponse(400, { error: 'invalid_client' });
    const error = await manager.getAccessToken('account-a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe('invalid_client');
    expect((error as AuthenticationError).status).toBe(400);
    expect(fake.tokenRequests).toHaveLength(1);
    expect((error as AuthenticationError).toPayload().error.type).toBe('AUTHENTICATION_ERROR');
  });

  it('retries authentication API failures (5xx) and then reports them', async () => {
    const { fake, manager, sleeps } = setup({ maxRetries: 2 });
    fake.tokenHandler = () => textResponse(503, 'unavailable');
    const error = await manager.getAccessToken('account-a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).status).toBe(503);
    expect(fake.tokenRequests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('recovers when the token endpoint fails transiently', async () => {
    const { fake, manager } = setup();
    let calls = 0;
    fake.tokenHandler = (req) => {
      calls += 1;
      if (calls === 1) throw networkError('ECONNRESET');
      return fake.issueToken(req);
    };
    await expect(manager.getAccessToken('account-a')).resolves.toMatch(/^tok_/);
    expect(calls).toBe(2);
  });

  it('reports network failures of the token endpoint as authentication errors', async () => {
    const { fake, manager } = setup({ maxRetries: 0 });
    fake.tokenHandler = () => {
      throw networkError('ENOTFOUND');
    };
    const error = await manager.getAccessToken('account-a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).message).toContain('dns');
  });

  it.each([
    ['non-JSON body', () => textResponse(200, '<html>oops</html>')],
    ['missing access_token', () => jsonResponse(200, { token_type: 'Bearer', expires_in: 3600 })],
    [
      'wrong token_type',
      () => jsonResponse(200, { access_token: 'abc', token_type: 'mac', expires_in: 3600 }),
    ],
    [
      'invalid expires_in',
      () => jsonResponse(200, { access_token: 'abc', token_type: 'Bearer', expires_in: -5 }),
    ],
  ])('rejects a malformed token response (%s)', async (_label, handler) => {
    const { fake, manager } = setup();
    fake.tokenHandler = handler;
    await expect(manager.getAccessToken('account-a')).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects unknown accounts before contacting Apple', async () => {
    const { fake, manager } = setup();
    await expect(manager.getAccessToken('nope')).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(manager.getAccessToken('../../other-account')).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('registers issued tokens and client secrets with the scrubber', async () => {
    const { fake, manager, scrubber } = setup();
    const token = await manager.getAccessToken('account-a');
    const secret = new URLSearchParams(fake.tokenRequests[0]!.body).get('client_secret')!;
    expect(scrubber.scrub(`token=${token} secret=${secret}`)).not.toContain(token);
    expect(scrubber.scrub(`secret=${secret}`)).not.toContain(secret);
  });

  it('never includes credentials in authentication errors', async () => {
    const { fake, manager, keys } = setup();
    fake.tokenHandler = () => jsonResponse(401, { error: 'invalid_client', error_description: 'bad' });
    const error = (await manager.getAccessToken('account-a').catch((e: unknown) => e)) as AuthenticationError;
    const text = JSON.stringify(error.toPayload()) + error.message;
    expect(text).not.toContain(ACCOUNT_A.clientId);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(keys.a.privateKeyPem.split('\n')[1]!);
  });

  it('AccountTokenManager serializes without the token', async () => {
    const { client, loaded } = setup();
    const tm = new AccountTokenManager({
      accountId: 'account-a',
      credentials: loaded.accounts[0]!.credentials,
      client,
      refreshSkewSeconds: 60,
    });
    const token = await tm.getAccessToken();
    expect(JSON.stringify(tm)).not.toContain(token);
    expect(tm.hasValidToken()).toBe(true);
  });
});

describe('OAuthTokenClient defaults', () => {
  it('falls back to real defaults when options are explicitly undefined (regression)', async () => {
    const client = new OAuthTokenClient({
      tokenUrl: 'http://127.0.0.1:1/auth/oauth2/token', // nothing listens on port 1: connection refused
      fetch: undefined,
      sleep: undefined,
      clock: undefined,
      logger: undefined,
      random: undefined,
      timeoutMs: 2000,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
      clientSecretTtlSeconds: 60,
    });
    const { accounts } = makeTestAccounts();
    const error = await client.requestToken('account-a', accounts[0]!.credentials).catch((e: unknown) => e);
    // A TypeError here would mean a default (fetch/sleep/clock) was overridden by `undefined`.
    expect(error).toBeInstanceOf(AuthenticationError);
  });
});
