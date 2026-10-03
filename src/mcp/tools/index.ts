import type { ApiFamilyId } from '../../apple-search-ads/apis.js';
import { endpointsForApis } from '../../apple-search-ads/endpoints/index.js';
import { createEndpointTool } from './endpoint-tool.js';
import { createListAccountsTool } from './list-accounts.js';
import type { ToolDefinition, ToolDependencies } from './types.js';

export type { ToolDefinition, ToolDependencies, ToolOutcome } from './types.js';
export { LIST_ACCOUNTS_TOOL } from './list-accounts.js';

/**
 * Builds every MCP tool: `list_accounts` plus one tool per registered Apple Ads GET endpoint of the
 * enabled API families. There is deliberately no generic "request" tool.
 */
export function buildTools(deps: ToolDependencies, enabledApis: readonly ApiFamilyId[]): ToolDefinition[] {
  return [
    createListAccountsTool(deps),
    ...endpointsForApis(enabledApis).map((e) => createEndpointTool(e, deps)),
  ];
}
