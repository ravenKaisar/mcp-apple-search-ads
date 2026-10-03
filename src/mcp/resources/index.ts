import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../../apple-search-ads/accounts.js';
import { API_FAMILIES, type ApiFamilyId } from '../../apple-search-ads/apis.js';
import { endpointDocUrl, endpointsForApis } from '../../apple-search-ads/endpoints/index.js';

export const ACCOUNTS_RESOURCE_URI = 'apple-ads://accounts';
export const ENDPOINTS_RESOURCE_URI = 'apple-ads://endpoints';

/** Machine-readable list of implemented endpoints (derived from the registry). */
export function describeEndpoints(enabledApis: readonly ApiFamilyId[]) {
  return {
    read_only: true,
    note: 'This MCP server only supports Apple Search Ads / Apple Ads GET APIs. Mutation APIs and read-style POST APIs (/find, /query, report generation) are intentionally excluded.',
    apis: enabledApis.map((id) => ({
      id,
      name: API_FAMILIES[id].displayName,
      version: API_FAMILIES[id].version,
      ...(API_FAMILIES[id].deprecation ? { deprecation: API_FAMILIES[id].deprecation } : {}),
    })),
    endpoints: endpointsForApis(enabledApis).map((e) => ({
      tool: e.toolName,
      api: e.api,
      category: e.category,
      title: e.title,
      method: e.method,
      path: e.path,
      requires_context: e.requiresContext,
      paginated: e.pagination !== undefined,
      docs: endpointDocUrl(e),
    })),
  };
}

export function registerResources(
  server: McpServer,
  deps: { accounts: AccountManager; enabledApis: readonly ApiFamilyId[] },
): void {
  server.registerResource(
    'accounts',
    ACCOUNTS_RESOURCE_URI,
    {
      title: 'Configured accounts',
      description:
        'Configured Apple Search Ads accounts (ids, names, enabled APIs). Never contains credentials.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ accounts: deps.accounts.list() }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'endpoints',
    ENDPOINTS_RESOURCE_URI,
    {
      title: 'Implemented Apple Ads GET endpoints',
      description: 'Every Apple Ads GET endpoint exposed by this server and the MCP tool that calls it.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(describeEndpoints(deps.enabledApis), null, 2),
        },
      ],
    }),
  );
}
