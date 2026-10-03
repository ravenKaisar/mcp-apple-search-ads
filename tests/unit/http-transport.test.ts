import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/transport/http.js';
import { jsonResponse } from '../helpers/fake-apple.js';
import { makeTestRuntime } from '../helpers/runtime.js';

const running: RunningHttpServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function start(
  http: Partial<{ authToken: string; allowedHosts: string[]; maxBodyBytes: number }> = {},
) {
  const ctx = makeTestRuntime();
  const server = await startHttpServer(ctx.runtime, {
    host: '127.0.0.1',
    port: 0,
    authToken: http.authToken,
    allowedHosts: http.allowedHosts,
    maxBodyBytes: http.maxBodyBytes ?? 1024 * 1024,
  });
  running.push(server);
  return { ...ctx, server };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('HTTP transport', () => {
  it('serves /health without exposing configuration', async () => {
    const { server } = await start({ authToken: 'x'.repeat(32) });
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
    expect((await fetch(`${server.url}/health`, { method: 'POST' })).status).toBe(405);
  });

  it('works without auth when no token is configured', async () => {
    const { server } = await start();
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { serverInfo: { name: 'apple-search-ads-mcp' } } });
  });

  it('enforces bearer auth with constant-time comparison', async () => {
    const token = 'secret-token-0123456789';
    const { server } = await start({ authToken: token });
    const send = (auth?: string) =>
      fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { ...mcpHeaders, ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(initialize),
      });
    expect((await send()).status).toBe(401);
    expect((await send('Bearer nope')).status).toBe(401);
    expect((await send(`Basic ${token}`)).status).toBe(401);
    expect((await send(`Bearer ${token}`)).status).toBe(200);
  });

  it('applies DNS-rebinding protection when MCP_ALLOWED_HOSTS is set', async () => {
    const { server } = await start({ allowedHosts: ['mcp.internal'] });
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(403);
  });

  it('rejects oversized bodies, invalid JSON and unsupported methods', async () => {
    const { server } = await start({ maxBodyBytes: 2048 });
    expect(
      (await fetch(`${server.url}/mcp`, { method: 'POST', headers: mcpHeaders, body: 'x'.repeat(5000) }))
        .status,
    ).toBe(413);
    expect(
      (await fetch(`${server.url}/mcp`, { method: 'POST', headers: mcpHeaders, body: '{' })).status,
    ).toBe(400);
    expect((await fetch(`${server.url}/mcp`)).status).toBe(405);
    expect((await fetch(`${server.url}/other`)).status).toBe(404);
  });

  it('serves full MCP sessions with the SDK client, sharing the token cache across requests', async () => {
    const { server, fake } = await start();
    fake.apiHandler = () => jsonResponse(200, { data: [] });
    const client = new Client({ name: 'unit-http', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    await client.callTool({ name: 'v5_get_user_acl', arguments: { account_id: 'account-a' } });
    await client.callTool({ name: 'v5_get_user_acl', arguments: { account_id: 'account-a' } });
    expect(fake.tokenRequests).toHaveLength(1);
    expect(fake.apiRequests).toHaveLength(2);
    await client.close();
  });
});
