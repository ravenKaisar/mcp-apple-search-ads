import { describe, expect, it } from 'vitest';
import { getEndpointByTool } from '../../src/apple-search-ads/endpoints/index.js';
import { JsonLogger } from '../../src/utils/logger.js';
import { isSensitiveKey, REDACTED, redact, redactString, SecretScrubber } from '../../src/utils/redact.js';
import { jsonResponse } from '../helpers/fake-apple.js';
import { ACCOUNT_A, callTool, makeTestRuntime } from '../helpers/runtime.js';

describe('redaction', () => {
  it.each([
    'privateKey',
    'private_key',
    'PRIVATE-KEY',
    'access_token',
    'accessToken',
    'authorization',
    'Authorization',
    'client_secret',
    'clientSecret',
    'token',
    'password',
    'apiKey',
    'cookie',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['account_id', 'campaignId', 'name', 'status', 'endpoint'])(
    'does not treat %s as sensitive',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it('masks sensitive keys deeply, including arrays and errors, and handles cycles', () => {
    const value: Record<string, unknown> = {
      account_id: 'production',
      nested: { private_key: 'abc', list: [{ access_token: 'xyz' }] },
      headers: { Authorization: 'Bearer abc.def.ghi' },
      error: Object.assign(new Error('failed with Bearer secret-token-value'), { code: 'E1' }),
    };
    value.self = value;
    const out = redact(value) as Record<string, any>;
    expect(out.account_id).toBe('production');
    expect(out.nested.private_key).toBe(REDACTED);
    expect(out.nested.list[0].access_token).toBe(REDACTED);
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.error).toEqual({ name: 'Error', message: `failed with Bearer ${REDACTED}`, code: 'E1' });
    expect(out.self).toBe('[Circular]');
  });

  it('masks secret-looking values inside strings', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----';
    const jwt = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImsifQ.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    const text = `key=${pem} jwt=${jwt} url=https://x/token?client_secret=abc123&access_token=def456 auth=Bearer zzz`;
    const out = redactString(text);
    expect(out).not.toContain('MIGHAgEA');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('def456');
    expect(out).not.toContain('zzz');
  });

  it('SecretScrubber removes registered secrets, re-wrapped PEM bodies and JSON-escaped forms', () => {
    const scrubber = new SecretScrubber();
    const pem =
      '-----BEGIN PRIVATE KEY-----\nAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ\nKKKKLLLLMMMMNNNN\n-----END PRIVATE KEY-----';
    scrubber.register(pem);
    scrubber.register('opaque-access-token-1234567890');
    scrubber.register('short');
    expect(scrubber.scrub('x opaque-access-token-1234567890 y')).toBe(`x ${REDACTED} y`);
    expect(scrubber.scrub(JSON.stringify({ k: pem }))).not.toContain('AAAABBBB');
    expect(scrubber.scrub('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNN')).toBe(REDACTED);
    expect(scrubber.scrub('short')).toBe('short');
    const value = { a: ['opaque-access-token-1234567890'], 'opaque-access-token-1234567890': 1 };
    expect(scrubber.scrubValue(value)).toEqual({ a: [REDACTED], [REDACTED]: 1 });
    scrubber.unregister('opaque-access-token-1234567890');
    expect(scrubber.scrub('opaque-access-token-1234567890')).toBe('opaque-access-token-1234567890');
  });
});

describe('JsonLogger', () => {
  it('writes structured JSON lines with level filtering and child bindings', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ level: 'info', sink: (l) => lines.push(l), clock: () => new Date(0) });
    logger.debug('hidden');
    logger.child({ account_id: 'production' }).info('apple_api_request', { endpoint: '/campaigns' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'info',
      event: 'apple_api_request',
      account_id: 'production',
      endpoint: '/campaigns',
    });
  });

  it('masks sensitive fields automatically', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ sink: (l) => lines.push(l) });
    logger.info('x', {
      private_key: 'k',
      access_token: 't',
      authorization_header: 'Bearer t',
      client_secret: 's',
    });
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.private_key).toBe(REDACTED);
    expect(record.access_token).toBe(REDACTED);
    expect(record.authorization_header).toBe(REDACTED);
    expect(record.client_secret).toBe(REDACTED);
  });

  it('silent level writes nothing', () => {
    const lines: string[] = [];
    new JsonLogger({ level: 'silent', sink: (l) => lines.push(l) }).error('x');
    expect(lines).toHaveLength(0);
  });

  it('defaults to stderr, never stdout', () => {
    const writes: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    let stdoutWrites = 0;
    const fakeOut = (chunk: string) => {
      stdoutWrites += 1;
      return originalOut(chunk);
    };
    const fakeErr = (chunk: string) => {
      writes.push(String(chunk));
      return true;
    };
    process.stdout.write = fakeOut;
    process.stderr.write = fakeErr;
    try {
      new JsonLogger().info('to_stderr');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    expect(stdoutWrites).toBe(0);
    expect(writes.join('')).toContain('to_stderr');
  });

  it('request logging never contains tokens, keys or authorization headers', async () => {
    const { runtime, fake, logs, keys } = makeTestRuntime();
    fake.apiHandler = () => jsonResponse(200, { data: {} });
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    fake.apiHandler = () => jsonResponse(500, {});
    await callTool(runtime, 'v5_get_campaign', { account_id: 'account-a', campaignId: '1' });
    const all = logs.join('\n');
    expect(all).toContain('apple_api_request');
    expect(all).toContain('"account_id":"account-a"');
    expect(all).toContain(getEndpointByTool('v5_get_campaign')!.path);
    const token = fake.lastToken(ACCOUNT_A.clientId)!;
    expect(all).not.toContain(token);
    expect(all).not.toContain('Bearer ');
    expect(all).not.toContain(keys.a.privateKeyPem.split('\n')[1]!);
    expect(all).not.toContain(new URLSearchParams(fake.tokenRequests[0]!.body).get('client_secret')!);
  });
});
