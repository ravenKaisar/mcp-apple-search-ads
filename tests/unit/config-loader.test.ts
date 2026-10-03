import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/apple-search-ads/errors.js';
import { loadAccountsFile, parseAccountsDocument, parseEs256PrivateKey } from '../../src/config/loader.js';
import {
  generateEs256KeyPair,
  generateP384PrivateKeyPem,
  generateRsaPrivateKeyPem,
  type TestKeyPair,
} from '../helpers/keys.js';

let key: TestKeyPair;
beforeAll(() => {
  key = generateEs256KeyPair();
});

const base = () => ({
  id: 'production',
  name: 'Production',
  clientId: 'SEARCHADS.11111111-2222-3333-4444-555555555555',
  teamId: 'SEARCHADS.11111111-2222-3333-4444-555555555555',
  keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
});

function expectConfigError(fn: () => unknown, fragment: string): void {
  try {
    fn();
    expect.unreachable('expected ConfigurationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    const e = error as ConfigurationError;
    expect([e.message, ...e.issues].join('\n')).toContain(fragment);
  }
}

describe('accounts configuration loader', () => {
  it('loads multiple accounts with inline keys and optional defaults', () => {
    const { accounts } = parseAccountsDocument({
      accounts: [
        { ...base(), privateKey: key.privateKeyPem, orgId: 40669820, adAccountId: '123456789' },
        {
          ...base(),
          id: 'staging',
          name: 'Staging',
          privateKey: key.privateKeySec1Pem,
          apis: ['platform-v1'],
        },
      ],
    });
    expect(accounts.map((a) => a.id)).toEqual(['production', 'staging']);
    expect(accounts[0]?.orgId).toBe('40669820');
    expect(accounts[0]?.adAccountId).toBe('123456789');
    expect(accounts[0]?.apis).toEqual(['campaign-management-v5', 'platform-v1']);
    expect(accounts[1]?.apis).toEqual(['platform-v1']);
    expect(accounts[0]?.credentials.privateKey.asymmetricKeyType).toBe('ec');
  });

  it('accepts keys stored on one line with escaped \\n sequences', () => {
    const escaped = key.privateKeyPem.trim().replace(/\n/g, '\\n');
    const { accounts } = parseAccountsDocument({ accounts: [{ ...base(), privateKey: escaped }] });
    expect(accounts).toHaveLength(1);
  });

  it('accepts openssl ecparam output that includes an EC PARAMETERS block', () => {
    const withParams = `-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n${key.privateKeySec1Pem}`;
    expect(
      parseAccountsDocument({ accounts: [{ ...base(), privateKey: withParams }] }).accounts,
    ).toHaveLength(1);
  });

  it('reads privateKeyPath relative to the config file and privateKeyEnv from the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asa-mcp-'));
    writeFileSync(join(dir, 'key.pem'), key.privateKeyPem, { mode: 0o600 });
    writeFileSync(
      join(dir, 'accounts.json'),
      JSON.stringify({
        accounts: [
          { ...base(), privateKeyPath: 'key.pem' },
          { ...base(), id: 'from-env', privateKeyEnv: 'TEST_ASA_KEY' },
        ],
      }),
      { mode: 0o600 },
    );
    const { accounts, secretMaterial } = loadAccountsFile(join(dir, 'accounts.json'), {
      env: { TEST_ASA_KEY: key.privateKeyPem },
    });
    expect(accounts.map((a) => a.id)).toEqual(['production', 'from-env']);
    expect(secretMaterial.join('\n')).toContain('PRIVATE KEY');
  });

  it('reports a missing config file and invalid JSON', () => {
    expectConfigError(() => loadAccountsFile('/definitely/not/here.json'), 'not found');
    const dir = mkdtempSync(join(tmpdir(), 'asa-mcp-'));
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    expectConfigError(() => loadAccountsFile(join(dir, 'bad.json')), 'not valid JSON');
  });

  it.each([
    [{}, 'accounts'],
    [{ accounts: [] }, 'at least one account'],
    [{ accounts: [{ ...base() }] }, 'exactly one of privateKey'],
    [{ accounts: [{ ...base(), privateKey: 'x', privateKeyPath: 'y' }] }, 'exactly one of privateKey'],
    [{ accounts: [{ ...base(), clientId: '' }] }, 'clientId'],
    [{ accounts: [{ name: 'x', clientId: 'a', teamId: 'b', keyId: 'c', privateKey: 'k' }] }, 'id'],
    [{ accounts: [{ ...base(), teamId: undefined, privateKey: 'k' }] }, 'teamId'],
    [{ accounts: [{ ...base(), keyId: undefined, privateKey: 'k' }] }, 'keyId'],
    [{ accounts: [{ ...base(), privateKey: 'k', unexpected: true }] }, 'unexpected'],
    [{ accounts: [{ ...base(), privateKey: 'k', apis: ['v4'] }] }, 'apis'],
    [{ accounts: [{ ...base(), privateKey: 'k', orgId: 'abc' }] }, 'orgId'],
    [{ accounts: [{ ...base(), id: '../../other-account', privateKey: 'k' }] }, 'id'],
    [{ accounts: [{ ...base(), id: 'has space', privateKey: 'k' }] }, 'id'],
  ])('rejects invalid document %#', (document, fragment) => {
    expectConfigError(() => parseAccountsDocument(document), fragment);
  });

  it('rejects duplicate account ids case-insensitively', () => {
    expectConfigError(
      () =>
        parseAccountsDocument({
          accounts: [
            { ...base(), privateKey: key.privateKeyPem },
            { ...base(), id: 'PRODUCTION', privateKey: key.privateKeyPem },
          ],
        }),
      'duplicate account id',
    );
  });

  it('rejects malformed, non-EC and wrong-curve private keys without echoing key material', () => {
    const malformed = '-----BEGIN PRIVATE KEY-----\nTUFMRk9STUVE\n-----END PRIVATE KEY-----';
    expectConfigError(() => parseEs256PrivateKey(malformed, 'account "x"'), 'malformed');
    expectConfigError(() => parseEs256PrivateKey('not a pem at all', 'account "x"'), 'not a PEM');
    expectConfigError(
      () => parseEs256PrivateKey(generateRsaPrivateKeyPem(), 'account "x"'),
      'elliptic-curve',
    );
    expectConfigError(() => parseEs256PrivateKey(generateP384PrivateKeyPem(), 'account "x"'), 'P-256');
    try {
      parseEs256PrivateKey(malformed, 'account "x"');
    } catch (error) {
      expect(JSON.stringify((error as ConfigurationError).toPayload())).not.toContain('TUFMRk9STUVE');
    }
  });

  it('reports unreadable privateKeyPath and unset privateKeyEnv', () => {
    expectConfigError(
      () => parseAccountsDocument({ accounts: [{ ...base(), privateKeyPath: '/no/such/key.pem' }] }),
      'privateKeyPath could not be read',
    );
    expectConfigError(
      () => parseAccountsDocument({ accounts: [{ ...base(), privateKeyEnv: 'NOPE_NOT_SET' }] }, { env: {} }),
      'NOPE_NOT_SET',
    );
  });

  it('never serializes credentials', () => {
    const { accounts } = parseAccountsDocument({ accounts: [{ ...base(), privateKey: key.privateKeyPem }] });
    const account = accounts[0]!;
    const serialized =
      JSON.stringify(account) + inspect(account, { depth: 10 }) + String(account.credentials);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain(base().clientId);
    expect(serialized).not.toContain(base().keyId);
    expect(serialized).toContain('REDACTED');
  });
});
