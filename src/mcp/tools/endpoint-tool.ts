import { z } from 'zod';
import { API_FAMILIES } from '../../apple-search-ads/apis.js';
import type { ApiResult, EndpointCall } from '../../apple-search-ads/client.js';
import {
  endpointDocUrl,
  type EndpointDefinition,
  type QueryValue,
} from '../../apple-search-ads/endpoints/index.js';
import { ConfigurationError, ValidationError } from '../../apple-search-ads/errors.js';
import type { RateLimitHeaders } from '../../apple-search-ads/http.js';
import {
  accountIdSchema,
  adAccountIdSchema,
  orgIdSchema,
  paginationControlShape,
} from '../schemas/common.js';
import { parseToolArgs, runTool, toToolJsonSchema } from './execute.js';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition, type ToolDependencies } from './types.js';

const CONTROL_KEYS = new Set([
  'account_id',
  'org_id',
  'ad_account_id',
  'fetch_all',
  'max_pages',
  'max_records',
]);

/** Builds the strict input schema for an endpoint tool. */
export function buildEndpointInputSchema(
  endpoint: EndpointDefinition,
  limits: ToolDependencies['pagination'],
): z.ZodObject {
  const family = API_FAMILIES[endpoint.api];
  const shape: Record<string, z.ZodType> = { account_id: accountIdSchema };
  if (endpoint.requiresContext) {
    shape[family.contextInputName] = (
      family.contextInputName === 'org_id' ? orgIdSchema : adAccountIdSchema
    ).optional();
  }
  for (const [name, spec] of Object.entries(endpoint.pathParams)) {
    shape[name] = spec.schema.describe(spec.description);
  }
  for (const [name, spec] of Object.entries(endpoint.queryParams)) {
    const described = spec.schema.describe(spec.description);
    shape[name] = spec.required ? described : described.optional();
  }
  if (endpoint.pagination?.supportsFetchAll) {
    Object.assign(shape, paginationControlShape(limits));
  }
  return z.object(shape).strict();
}

function buildDescription(endpoint: EndpointDefinition): string {
  const family = API_FAMILIES[endpoint.api];
  const lines = [
    `[${family.displayName}] ${endpoint.description}`,
    `Apple endpoint: GET ${endpoint.path} ("${endpoint.title}"). Read-only.`,
  ];
  if (endpoint.requiresContext) {
    lines.push(
      `Uses ${family.contextInputName} (X-AP-Context: ${family.contextHeaderKey}=...) - defaults to the account's configured value.`,
    );
  }
  if (endpoint.pagination?.supportsFetchAll) {
    lines.push(
      'Paginated: returns one page by default; set fetch_all=true (bounded by max_pages/max_records) to follow pages.',
    );
  }
  if (family.deprecation) lines.push(family.deprecation);
  lines.push(`Docs: ${endpointDocUrl(endpoint)}`);
  return lines.join('\n');
}

function rateLimitMeta(rateLimit: RateLimitHeaders | undefined): Record<string, number> | undefined {
  if (!rateLimit) return undefined;
  const out: Record<string, number> = {};
  if (rateLimit.limit !== undefined) out.limit = rateLimit.limit;
  if (rateLimit.remaining !== undefined) out.remaining = rateLimit.remaining;
  if (rateLimit.resetSeconds !== undefined) out.reset_seconds = rateLimit.resetSeconds;
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildMeta(result: ApiResult | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const meta: Record<string, unknown> = {};
  if (result.requestId) meta.request_id = result.requestId;
  const rl = rateLimitMeta(result.rateLimit);
  if (rl) meta.rate_limit = rl;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Creates the MCP tool for one Apple Ads GET endpoint. */
export function createEndpointTool(endpoint: EndpointDefinition, deps: ToolDependencies): ToolDefinition {
  const family = API_FAMILIES[endpoint.api];
  const schema = buildEndpointInputSchema(endpoint, deps.pagination);
  const pagination = endpoint.pagination;

  return {
    name: endpoint.toolName,
    title: `${endpoint.title} (${endpoint.api === 'platform-v1' ? 'Platform API' : 'Campaign Mgmt API v5'})`,
    description: buildDescription(endpoint),
    inputSchema: schema,
    jsonSchema: toToolJsonSchema(schema),
    annotations: { title: endpoint.title, ...READ_ONLY_ANNOTATIONS },
    endpointId: endpoint.id,
    execute: (rawArgs, context) =>
      runTool(endpoint.toolName, deps, async () => {
        const args = parseToolArgs<Record<string, unknown>>(schema, rawArgs, endpoint.toolName);
        const crossFieldIssues = endpoint.validate?.(args) ?? [];
        if (crossFieldIssues.length > 0) {
          throw new ValidationError(`Invalid arguments for ${endpoint.toolName}`, crossFieldIssues);
        }

        const accountId = args.account_id as string;
        const account = deps.accounts.get(accountId);
        if (!account.apis.includes(endpoint.api)) {
          throw new ConfigurationError(
            `Account "${account.id}" is not enabled for the ${family.displayName}`,
          );
        }

        let contextValue: string | undefined;
        if (endpoint.requiresContext) {
          const override = args[family.contextInputName] as string | undefined;
          contextValue =
            override ?? (family.contextHeaderKey === 'orgId' ? account.orgId : account.adAccountId);
          if (!contextValue) {
            throw new ValidationError(`${family.contextInputName} is required for ${endpoint.toolName}`, [
              {
                path: family.contextInputName,
                message: `pass ${family.contextInputName} or configure "${family.contextHeaderKey}" for account "${account.id}"`,
              },
            ]);
          }
        }

        const pathParams: Record<string, string> = {};
        for (const name of Object.keys(endpoint.pathParams)) pathParams[name] = String(args[name]);
        const query: Record<string, QueryValue | undefined> = {};
        for (const name of Object.keys(endpoint.queryParams)) {
          if (!CONTROL_KEYS.has(name)) query[name] = args[name] as QueryValue | undefined;
        }

        const call: EndpointCall = {
          accountId: account.id,
          context: contextValue,
          pathParams,
          query,
          signal: context.signal,
        };
        const base = { account_id: account.id, api: endpoint.api, tool: endpoint.toolName };

        if (pagination && args.fetch_all === true) {
          const startOffset = (args[pagination.offsetParam] as number | undefined) ?? 0;
          const pageSize = (args[pagination.limitParam] as number | undefined) ?? pagination.fetchAllPageSize;
          const maxPages = (args.max_pages as number | undefined) ?? deps.pagination.defaultMaxPages;
          const maxRecords = (args.max_records as number | undefined) ?? deps.pagination.defaultMaxRecords;
          const { items, outcome, lastResult } = await deps.client.getAll(
            endpoint,
            {
              ...call,
              query: { ...query, [pagination.offsetParam]: undefined, [pagination.limitParam]: undefined },
            },
            { startOffset, pageSize, maxPages, maxRecords },
          );
          const meta = buildMeta(lastResult);
          return {
            ...base,
            data: items,
            pagination: {
              mode: 'fetch_all',
              offset: startOffset,
              limit: pageSize,
              ...(outcome.total !== undefined ? { total: outcome.total } : {}),
              pages_fetched: outcome.pagesFetched,
              records_returned: outcome.recordsReturned,
              has_more: outcome.nextOffset !== undefined,
              ...(outcome.nextOffset !== undefined ? { next_offset: outcome.nextOffset } : {}),
              truncated: outcome.truncated,
              ...(outcome.truncatedReason ? { truncated_reason: outcome.truncatedReason } : {}),
            },
            ...(meta ? { meta } : {}),
          };
        }

        const result = await deps.client.get(endpoint, call);
        const meta = buildMeta(result);
        const payload: Record<string, unknown> = { ...base, data: result.body };
        if (pagination) {
          const offset = (args[pagination.offsetParam] as number | undefined) ?? 0;
          const limit = (args[pagination.limitParam] as number | undefined) ?? pagination.defaultPageSize;
          const items = family.readItems(result.body);
          const total = family.readTotal(result.body);
          const returned = items?.length ?? 0;
          const hasMore = total !== undefined ? offset + returned < total : returned >= limit && returned > 0;
          payload.pagination = {
            mode: 'single_page',
            offset,
            limit,
            ...(total !== undefined ? { total } : {}),
            records_returned: returned,
            has_more: hasMore,
            ...(hasMore ? { next_offset: offset + returned } : {}),
          };
        }
        if (meta) payload.meta = meta;
        return payload;
      }),
  };
}
