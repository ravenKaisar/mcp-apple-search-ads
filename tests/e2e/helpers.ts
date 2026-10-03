import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEs256KeyPair } from '../helpers/keys.js';
import { ACCOUNT_A, ACCOUNT_B } from '../helpers/runtime.js';

export const ENTRYPOINT = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export function assertBuilt(): void {
  if (!existsSync(ENTRYPOINT)) {
    throw new Error(
      'dist/index.js not found - run `npm run build` (npm run test:e2e does this automatically)',
    );
  }
}

export function writeAccountsConfig(): { path: string; privateKeys: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'asa-e2e-'));
  const a = generateEs256KeyPair();
  const b = generateEs256KeyPair();
  writeFileSync(join(dir, 'b.pem'), b.privateKeyPem, { mode: 0o600 });
  const path = join(dir, 'accounts.json');
  writeFileSync(
    path,
    JSON.stringify({
      accounts: [
        { ...ACCOUNT_A, privateKey: a.privateKeyPem },
        { ...ACCOUNT_B, privateKeyPath: 'b.pem' },
      ],
    }),
    { mode: 0o600 },
  );
  return { path, privateKeys: [a.privateKeyPem, b.privateKeyPem] };
}

export function serverEnv(
  mockUrl: string,
  accountsPath: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    ACCOUNTS_CONFIG: accountsPath,
    APPLE_ADS_V5_BASE_URL: `${mockUrl}/api/v5`,
    APPLE_ADS_PLATFORM_BASE_URL: `${mockUrl}/v1`,
    APPLE_OAUTH_TOKEN_URL: `${mockUrl}/oauth2/token`,
    ALLOW_INSECURE_ENDPOINTS: 'true',
    LOG_LEVEL: 'info',
    MAX_RETRIES: '1',
    RETRY_BASE_DELAY_MS: '1',
    RETRY_MAX_DELAY_MS: '5',
    ...extra,
  };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // keep waiting
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}
