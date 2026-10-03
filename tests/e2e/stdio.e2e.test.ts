/**
 * E2E over stdio: MCP client -> (spawned) compiled server -> account manager -> OAuth -> GET-only client
 * -> mock Apple HTTP server -> response -> MCP client.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import { sampleApiArgs, successFixture } from '../helpers/fixtures.js';
import { ACCOUNT_A } from '../helpers/runtime.js';
import { assertBuilt, ENTRYPOINT, serverEnv, writeAccountsConfig } from './helpers.js';
import { createMockAppleApi } from './mock-apple-api.mjs';

const mock = createMockAppleApi();
let client: Client;
let transport: StdioClientTransport;
const stderrChunks: string[] = [];
const protocolErrors: Error[] = [];
let privateKeys: string[] = [];

beforeAll(async () => {
  assertBuilt();
  const mockUrl = await mock.listen();
  const accounts = writeAccountsConfig();
  privateKeys = accounts.privateKeys;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRYPOINT, '--transport', 'stdio'],
    env: serverEnv(mockUrl, accounts.path),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
  client = new Client({ name: 'e2e-stdio', version: '1.0.0' });
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await mock.close();
});

describe('stdio transport (e2e)', () => {
  it('initializes and lists every tool', async () => {
    expect(client.getServerVersion()?.name).toBe('apple-search-ads-mcp');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['list_accounts', ...ENDPOINTS.map((e) => e.toolName)].sort(),
    );
  });

  it('list_accounts returns accounts without credentials', async () => {
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    const text = JSON.stringify(result);
    expect(result.structuredContent).toMatchObject({ accounts: [{ id: 'account-a' }, { id: 'account-b' }] });
    for (const key of privateKeys) expect(text).not.toContain(key.split('\n')[1]);
    expect(text).not.toContain(ACCOUNT_A.clientId);
  });

  it.each(ENDPOINTS.map((e) => [e.toolName, e] as const))(
    '%s works end to end',
    async (toolName, endpoint) => {
      const result = await client.callTool({
        name: toolName,
        arguments: { account_id: 'account-a', ...sampleApiArgs(endpoint) },
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
      expect((result.structuredContent as { data: unknown }).data).toEqual(successFixture(toolName));
      const last = mock.requests.filter((r) => r.kind === 'api').at(-1)!;
      expect(last.method).toBe('GET');
      expect(last.tool).toBe(toolName);
    },
  );

  it('returns structured errors for invalid input and unknown accounts', async () => {
    const invalid = await client.callTool({
      name: 'v5_get_campaign',
      arguments: { account_id: 'account-a', campaignId: '../me' },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
    const unknown = await client.callTool({ name: 'v5_get_me_details', arguments: { account_id: 'nope' } });
    expect(unknown.structuredContent).toMatchObject({ error: { type: 'ACCOUNT_NOT_FOUND' } });
  });

  it('only GET requests reached the Apple Ads APIs, with per-account context', () => {
    const api = mock.requests.filter((r) => r.kind === 'api');
    expect(api.length).toBeGreaterThanOrEqual(ENDPOINTS.length);
    expect(api.every((r) => r.method === 'GET')).toBe(true);
    expect(mock.requests.filter((r) => r.kind === 'token').every((r) => r.method === 'POST')).toBe(true);
    expect(api.every((r) => r.clientId === ACCOUNT_A.clientId)).toBe(true);
  });

  it('keeps stdout clean (protocol only) and logs JSON to stderr without secrets', () => {
    expect(protocolErrors).toEqual([]);
    const lines = stderrChunks
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const logText = lines.join('\n');
    expect(logText).toContain('"event":"apple_api_request"');
    expect(logText).not.toContain('Bearer ');
    expect(logText).not.toContain('PRIVATE KEY');
  });
});
