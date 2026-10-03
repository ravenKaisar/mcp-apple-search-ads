import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AccountManager } from '../apple-search-ads/accounts.js';
import type { ApiFamilyId } from '../apple-search-ads/apis.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { registerResources } from './resources/index.js';
import type { ToolDefinition, ToolOutcome } from './tools/index.js';

const INSTRUCTIONS = `Read-only access to Apple Search Ads / Apple Ads.
- Call list_accounts first; pass its id as account_id to every other tool.
- v5_* tools use the Campaign Management API v5 (deprecated by Apple, sunset 2027-01-26) and need org_id (X-AP-Context orgId) unless the account has a default. Discover org ids with v5_get_user_acl.
- platform_* tools use the Apple Ads Platform API v1 and need ad_account_id unless the account has a default. Discover ad accounts with platform_get_user_acls.
- List tools return one page by default; set fetch_all=true to follow pagination (bounded by max_pages / max_records).
- This server cannot create, update or delete anything, and cannot run report-generation or other POST-based queries.`;

/** Converts a transport-agnostic tool outcome into an MCP CallToolResult. */
export function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
    structuredContent: outcome.payload as unknown as Record<string, unknown>,
    ...(outcome.ok ? {} : { isError: true }),
  };
}

export interface McpServerDependencies {
  tools: readonly ToolDefinition[];
  accounts: AccountManager;
  enabledApis: readonly ApiFamilyId[];
}

/**
 * Creates an MCP server exposing the given tools and resources. Tool listing and invocation are
 * handled with explicit request handlers so that every tool advertises a strict JSON schema and
 * every error (including argument validation) uses the same structured error payload.
 */
export function createMcpServer(deps: McpServerDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: INSTRUCTIONS,
    },
  );
  const byName = new Map(deps.tools.map((tool) => [tool.name, tool]));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: deps.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.jsonSchema as { type: 'object'; [key: string]: unknown },
      annotations: tool.annotations,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name.slice(0, 64)}`);
    }
    const outcome = await tool.execute(request.params.arguments ?? {}, { signal: extra.signal });
    return toCallToolResult(outcome);
  });

  registerResources(server, { accounts: deps.accounts, enabledApis: deps.enabledApis });
  return server;
}
