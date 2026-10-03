import { API_FAMILY_IDS } from '../../src/apple-search-ads/apis.js';
import type { AppConfig } from '../../src/config/env.js';
import { type LoadedAccounts, parseAccountsDocument } from '../../src/config/loader.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { JsonLogger, type Logger } from '../../src/utils/logger.js';
import type { Clock } from '../../src/utils/time.js';
import { FakeApple, TEST_BASE_URLS, TEST_TOKEN_URL } from './fake-apple.js';
import { generateEs256KeyPair, type TestKeyPair } from './keys.js';

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: 'stdio',
    accountsConfigPath: '/nonexistent/accounts.json',
    logLevel: 'silent',
    requestTimeoutMs: 2_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 4,
    maxRetryAfterMs: 60_000,
    enabledApis: [...API_FAMILY_IDS],
    baseUrls: { ...TEST_BASE_URLS },
    oauthTokenUrl: TEST_TOKEN_URL,
    allowInsecureEndpoints: false,
    clientSecretTtlSeconds: 3600,
    tokenRefreshSkewSeconds: 60,
    pagination: { defaultMaxPages: 10, maxPagesLimit: 100, defaultMaxRecords: 1000, maxRecordsLimit: 10_000 },
    http: {
      host: '127.0.0.1',
      port: 0,
      authToken: undefined,
      allowedHosts: undefined,
      maxBodyBytes: 1024 * 1024,
    },
    ...overrides,
  };
}

export interface TestAccountKeys {
  a: TestKeyPair;
  b: TestKeyPair;
}

export const ACCOUNT_A = {
  id: 'account-a',
  name: 'Account A',
  clientId: 'SEARCHADS.client-a-0000',
  teamId: 'SEARCHADS.team-a-0000',
  keyId: 'key-a',
  orgId: '1111111',
  adAccountId: '2222222',
};

export const ACCOUNT_B = {
  id: 'account-b',
  name: 'Account B',
  clientId: 'SEARCHADS.client-b-0000',
  teamId: 'SEARCHADS.team-b-0000',
  keyId: 'key-b',
  orgId: '3333333',
  adAccountId: '4444444',
};

export function makeTestKeys(): TestAccountKeys {
  return { a: generateEs256KeyPair(), b: generateEs256KeyPair() };
}

export function makeTestAccounts(
  keys: TestAccountKeys = makeTestKeys(),
  extra: Record<string, unknown>[] = [],
): LoadedAccounts {
  return parseAccountsDocument({
    accounts: [
      { ...ACCOUNT_A, privateKey: keys.a.privateKeyPem },
      { ...ACCOUNT_B, privateKey: keys.b.privateKeyPem },
      ...extra,
    ],
  });
}

export interface TestRuntime {
  runtime: Runtime;
  fake: FakeApple;
  keys: TestAccountKeys;
  sleeps: number[];
  logs: string[];
}

export function makeTestRuntime(
  options: {
    config?: Partial<AppConfig>;
    accounts?: LoadedAccounts;
    keys?: TestAccountKeys;
    clock?: Clock;
    logger?: Logger;
  } = {},
): TestRuntime {
  const keys = options.keys ?? makeTestKeys();
  const fake = new FakeApple();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const logger = options.logger ?? new JsonLogger({ level: 'debug', sink: (line) => logs.push(line) });
  const runtime = createRuntime(makeTestConfig(options.config), {
    accounts: options.accounts ?? makeTestAccounts(keys),
    fetch: fake.fetch,
    logger,
    clock: options.clock,
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { runtime, fake, keys, sleeps, logs };
}

/** Executes a tool by name and returns its outcome. */
export async function callTool(runtime: Runtime, name: string, args: unknown) {
  const tool = runtime.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(args, {});
}

export class ManualClock implements Clock {
  constructor(public current = Date.UTC(2026, 9, 3, 12, 0, 0)) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
