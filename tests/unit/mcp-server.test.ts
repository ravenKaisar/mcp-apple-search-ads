import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import { ACCOUNTS_RESOURCE_URI, ENDPOINTS_RESOURCE_URI } from '../../src/mcp/resources/index.js';
import { SERVER_NAME, SERVER_VERSION } from '../../src/version.js';
import { jsonResponse } from '../helpers/fake-apple.js';
import { makeTestRuntime } from '../helpers/runtime.js';
import packageJson from '../../package.json' with { type: 'json' };

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect() {
  const ctx = makeTestRuntime();
  const server = ctx.runtime.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return { ...ctx, client };
}

describe('MCP server (in-memory transport)', () => {
  it('reports server info and instructions', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(client.getInstructions()).toContain('list_accounts');
    expect(SERVER_VERSION).toBe(packageJson.version);
  });

  it('lists every tool with strict schemas and read-only annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(ENDPOINTS.length + 1);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description).toBeTruthy();
    }
    const getCampaign = tools.find((t) => t.name === 'v5_get_campaign')!;
    expect(getCampaign.inputSchema.required).toEqual(expect.arrayContaining(['account_id', 'campaignId']));
    expect(getCampaign.description).toContain('GET /campaigns/{campaignId}');
    expect(getCampaign.description).toContain('2027-01-26');
  });

  it('calls a tool end-to-end and returns structured + text content', async () => {
    const { client, fake } = await connect();
    fake.apiHandler = () => jsonResponse(200, { data: { id: 1, name: 'x' }, pagination: null, error: null });
    const result = await client.callTool({
      name: 'v5_get_campaign',
      arguments: { account_id: 'account-a', campaignId: '1' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ account_id: 'account-a', data: { data: { id: 1 } } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it('returns validation errors as structured tool errors', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'v5_get_campaign', arguments: { account_id: 'account-a' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { type: 'VALIDATION_ERROR' } });
  });

  it('rejects unknown tools with a protocol error', async () => {
    const { client } = await connect();
    await expect(
      client.callTool({ name: 'request', arguments: { method: 'POST', url: '/campaigns' } }),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('exposes accounts and endpoint resources without credentials', async () => {
    const { client, keys } = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(
      [ACCOUNTS_RESOURCE_URI, ENDPOINTS_RESOURCE_URI].sort(),
    );
    const accounts = await client.readResource({ uri: ACCOUNTS_RESOURCE_URI });
    const accountsText = (accounts.contents[0] as { text: string }).text;
    expect(JSON.parse(accountsText).accounts).toHaveLength(2);
    expect(accountsText).not.toContain('PRIVATE KEY');
    expect(accountsText).not.toContain(keys.a.privateKeyPem.split('\n')[1]!);
    const endpoints = JSON.parse(
      ((await client.readResource({ uri: ENDPOINTS_RESOURCE_URI })).contents[0] as { text: string }).text,
    );
    expect(endpoints.read_only).toBe(true);
    expect(endpoints.endpoints).toHaveLength(ENDPOINTS.length);
    expect(endpoints.endpoints.every((e: { method: string }) => e.method === 'GET')).toBe(true);
  });
});
