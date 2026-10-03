/**
 * E2E over Streamable HTTP: spawned compiled server in HTTP mode + mock Apple API + MCP HTTP client.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import { sampleApiArgs, successFixture } from '../helpers/fixtures.js';
import { assertBuilt, ENTRYPOINT, freePort, serverEnv, waitFor, writeAccountsConfig } from './helpers.js';
import { createMockAppleApi } from './mock-apple-api.mjs';

const AUTH_TOKEN = 'e2e-test-token-0123456789abcdef';
const mock = createMockAppleApi();
let child: ChildProcess;
let baseUrl: string;
let client: Client;
let stderr = '';
let stdout = '';

beforeAll(async () => {
  assertBuilt();
  const mockUrl = await mock.listen();
  const accounts = writeAccountsConfig();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [ENTRYPOINT, '--transport', 'http'], {
    env: serverEnv(mockUrl, accounts.path, {
      HOST: '127.0.0.1',
      PORT: String(port),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
  await waitFor(async () => (await fetch(`${baseUrl}/health`)).ok);
  client = new Client({ name: 'e2e-http', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  child?.kill('SIGTERM');
  await mock.close();
});

describe('HTTP transport (e2e)', () => {
  it('GET /health returns {"status":"ok"} and nothing else', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('requires the bearer token on /mcp', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
  });

  it('rejects GET/DELETE on /mcp (stateless), unknown paths, bad JSON and oversized bodies', async () => {
    const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
    expect((await fetch(`${baseUrl}/mcp`, { headers })).status).toBe(405);
    expect((await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers })).status).toBe(405);
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: '{not json' })).status).toBe(400);
    const big = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: 'x'.repeat(2 * 1024 * 1024),
    }).catch(() => undefined);
    if (big) expect(big.status).toBe(413);
  });

  it('lists every tool', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(ENDPOINTS.length + 1);
  });

  it.each(ENDPOINTS.map((e) => [e.toolName, e] as const))(
    '%s works end to end over HTTP',
    async (toolName, endpoint) => {
      const result = await client.callTool({
        name: toolName,
        arguments: { account_id: 'account-b', ...sampleApiArgs(endpoint) },
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
      expect((result.structuredContent as { data: unknown }).data).toEqual(successFixture(toolName));
    },
  );

  it('only GET requests reached the Apple Ads APIs', () => {
    const api = mock.requests.filter((r) => r.kind === 'api');
    expect(api.length).toBeGreaterThanOrEqual(ENDPOINTS.length);
    expect(api.every((r) => r.method === 'GET')).toBe(true);
  });

  it('writes logs to stderr only', () => {
    expect(stdout).toBe('');
    expect(stderr).toContain('http_server_started');
    expect(stderr).not.toContain(AUTH_TOKEN);
    expect(stderr).not.toContain('PRIVATE KEY');
  });
});
