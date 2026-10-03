import { API_FAMILIES, type ApiFamilyId } from '../apis.js';
import { CAMPAIGN_MANAGEMENT_V5_ENDPOINTS } from './campaign-management-v5.js';
import { PLATFORM_V1_ENDPOINTS } from './platform-v1.js';
import type { EndpointDefinition } from './types.js';

export type {
  EndpointDefinition,
  OffsetPaginationSpec,
  PaginationSpec,
  ParamSpec,
  QueryValue,
} from './types.js';

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Extracts `{param}` placeholder names from a path template. */
export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/**
 * Validates the registry at module load. Any mistake (non-GET method, duplicate tool, mismatched path
 * parameters, wrong prefix) fails fast at startup and in the unit tests.
 */
export function validateRegistry(endpoints: readonly EndpointDefinition[]): void {
  const toolNames = new Set<string>();
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const endpoint of endpoints) {
    const where = `endpoint ${endpoint.id}`;
    if ((endpoint.method as string) !== 'GET') {
      throw new Error(`${where}: only GET endpoints may be registered (got ${String(endpoint.method)})`);
    }
    if (ids.has(endpoint.id)) throw new Error(`${where}: duplicate id`);
    ids.add(endpoint.id);
    if (toolNames.has(endpoint.toolName))
      throw new Error(`${where}: duplicate tool name ${endpoint.toolName}`);
    toolNames.add(endpoint.toolName);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(endpoint.toolName)) {
      throw new Error(`${where}: invalid tool name ${endpoint.toolName}`);
    }
    const prefix = API_FAMILIES[endpoint.api].toolPrefix;
    if (!endpoint.toolName.startsWith(prefix)) {
      throw new Error(`${where}: tool name must start with ${prefix}`);
    }
    if (!endpoint.path.startsWith('/') || endpoint.path.includes('..') || endpoint.path.includes('?')) {
      throw new Error(`${where}: invalid path template ${endpoint.path}`);
    }
    const route = `${endpoint.api} ${endpoint.method} ${endpoint.path}`;
    if (routes.has(route)) throw new Error(`${where}: duplicate route ${route}`);
    routes.add(route);

    const placeholders = pathPlaceholders(endpoint.path).sort();
    const declared = Object.keys(endpoint.pathParams).sort();
    if (placeholders.join(',') !== declared.join(',')) {
      throw new Error(`${where}: path params [${declared.join(', ')}] do not match path ${endpoint.path}`);
    }
    for (const name of Object.keys(endpoint.queryParams)) {
      if (name in endpoint.pathParams) throw new Error(`${where}: ${name} is both a path and a query param`);
    }
    const pagination = endpoint.pagination;
    if (pagination) {
      if (
        !(pagination.limitParam in endpoint.queryParams) ||
        !(pagination.offsetParam in endpoint.queryParams)
      ) {
        throw new Error(`${where}: pagination params must be declared as query params`);
      }
      if (pagination.fetchAllPageSize > pagination.maxPageSize) {
        throw new Error(`${where}: fetchAllPageSize exceeds maxPageSize`);
      }
    }
  }
}

/** The complete registry of implemented Apple Ads GET endpoints. */
export const ENDPOINTS: readonly EndpointDefinition[] = Object.freeze([
  ...CAMPAIGN_MANAGEMENT_V5_ENDPOINTS,
  ...PLATFORM_V1_ENDPOINTS,
]);

validateRegistry(ENDPOINTS);

const BY_TOOL = new Map(ENDPOINTS.map((e) => [e.toolName, e]));
const BY_ID = new Map(ENDPOINTS.map((e) => [e.id, e]));

export function getEndpointByTool(toolName: string): EndpointDefinition | undefined {
  return BY_TOOL.get(toolName);
}

export function getEndpointById(id: string): EndpointDefinition | undefined {
  return BY_ID.get(id);
}

export function endpointsForApis(apis: readonly ApiFamilyId[]): EndpointDefinition[] {
  const enabled = new Set(apis);
  return ENDPOINTS.filter((e) => enabled.has(e.api));
}

export function endpointDocUrl(endpoint: EndpointDefinition): string {
  return `${API_FAMILIES[endpoint.api].docsBaseUrl}/${endpoint.docSlug}`;
}
