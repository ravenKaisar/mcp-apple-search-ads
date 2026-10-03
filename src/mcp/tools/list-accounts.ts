import { z } from 'zod';
import { parseToolArgs, runTool, toToolJsonSchema } from './execute.js';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition, type ToolDependencies } from './types.js';

export const LIST_ACCOUNTS_TOOL = 'list_accounts';

/** Lists configured accounts without exposing any credential material. */
export function createListAccountsTool(deps: ToolDependencies): ToolDefinition {
  const schema = z.object({}).strict();
  return {
    name: LIST_ACCOUNTS_TOOL,
    title: 'List configured Apple Search Ads accounts',
    description:
      'Lists the Apple Search Ads accounts configured on this server (id, name, enabled APIs, default org_id / ad_account_id). ' +
      'Use an account id as account_id for every other tool. Never returns credentials.',
    inputSchema: schema,
    jsonSchema: toToolJsonSchema(schema),
    annotations: { title: 'List accounts', ...READ_ONLY_ANNOTATIONS, openWorldHint: false },
    execute: (rawArgs) =>
      runTool(LIST_ACCOUNTS_TOOL, deps, () => {
        parseToolArgs(schema, rawArgs, LIST_ACCOUNTS_TOOL);
        return Promise.resolve({ accounts: deps.accounts.list() });
      }),
  };
}
