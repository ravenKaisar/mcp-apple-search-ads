import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../src/config/env.js';
import { AccountsFileSchema } from '../../src/config/loader.js';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('shipped examples', () => {
  it('config/accounts.example.json matches the accounts schema', () => {
    const result = AccountsFileSchema.safeParse(JSON.parse(read('config/accounts.example.json')));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('config/accounts.example.json contains no real key material', () => {
    expect(read('config/accounts.example.json')).toContain('REPLACE_WITH_YOUR_P256_PRIVATE_KEY');
  });

  it('.env.example only uses supported variables with valid values', () => {
    const env: Record<string, string> = {};
    for (const line of read('.env.example').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]!] = match[2]!;
    }
    expect(Object.keys(env).length).toBeGreaterThan(10);
    expect(() => loadAppConfig(env)).not.toThrow();
  });
});
