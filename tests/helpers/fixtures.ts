import { readFileSync } from 'node:fs';
import type { ApiFamilyId } from '../../src/apple-search-ads/apis.js';
import { ENDPOINTS, type EndpointDefinition } from '../../src/apple-search-ads/endpoints/index.js';

const raw = JSON.parse(
  readFileSync(new URL('../fixtures/apple-responses.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/** Realistic 200 body for an endpoint (from Apple's documented examples). */
export function successFixture(toolName: string): unknown {
  if (!(toolName in raw)) throw new Error(`missing fixture for ${toolName}`);
  return structuredClone(raw[toolName]);
}

export function allFixtureNames(): string[] {
  return Object.keys(raw).filter((k) => !k.startsWith('$'));
}

/** A "200 with empty data" body in the endpoint's documented envelope. */
export function emptyFixture(endpoint: EndpointDefinition): unknown {
  const isList = Array.isArray(
    (raw[endpoint.toolName] as Record<string, unknown> | undefined)?.[
      endpoint.api === 'platform-v1' ? 'result' : 'data'
    ],
  );
  if (endpoint.api === 'platform-v1') {
    return isList ? { result: [], pagination: { offset: 0, pageSize: 0, totalCount: 0 } } : { result: null };
  }
  return isList
    ? { data: [], pagination: { totalResults: 0, startIndex: 0, itemsPerPage: 0 }, error: null }
    : { data: null, pagination: null, error: null };
}

/** Error body in each API's documented error envelope. */
export function errorFixture(
  api: ApiFamilyId,
  status: number,
  message = `Simulated ${status} error`,
): unknown {
  if (api === 'platform-v1') {
    return {
      error: {
        code:
          status === 404 ? 'ENTITY_NOT_FOUND' : status === 429 ? 'rate_limit_exceeded' : 'VALIDATION_ERROR',
        message,
        details: [{ code: `CODE_${status}`, message, info: { field: 'id' } }],
      },
    };
  }
  return {
    data: null,
    pagination: null,
    error: { errors: [{ messageCode: `CODE_${status}`, message, field: 'campaignId' }] },
  };
}

const PATH_VALUES: Record<string, string> = {
  campaignId: '542370642',
  adgroupId: '542317095',
  keywordId: '542370643',
  adId: '573408745',
  adamId: '427916203',
  boId: '542370539',
  productPageReasonId: '135366',
  creativeId: '94790778',
  productPageId: '45812c9b-c296-43d3-c6a0-c5a02f74bf6e',
  reportId: '7615231',
  rejectionReasonId: '112233445',
  detailId: 'Campaign.444555666.txn_abc123def456',
};

const REQUIRED_QUERY_VALUES: Record<string, Record<string, unknown>> = {
  v5_search_apps: { query: 'Trip' },
  platform_get_advertiser_resources: { resourceType: 'CONTENT_PROVIDER' },
  platform_search_geo_locations: { supplySource: 'APPSTORE' },
  platform_search_apps: { query: 'AwayFinder' },
};

/** Minimal valid Apple parameters (path + required query) for an endpoint, excluding account_id. */
export function sampleApiArgs(endpoint: EndpointDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of Object.keys(endpoint.pathParams)) {
    if (name === 'id') {
      args.id =
        endpoint.toolName === 'platform_get_asset' ? '770e8400-e29b-41d4-a716-446655440002' : '444555681';
    } else {
      const value = PATH_VALUES[name];
      if (!value) throw new Error(`no sample value for path param ${name}`);
      args[name] = value;
    }
  }
  Object.assign(args, REQUIRED_QUERY_VALUES[endpoint.toolName] ?? {});
  return args;
}

/** The URL path (relative to the API base) the sample args must produce. */
export function expectedPath(endpoint: EndpointDefinition, args: Record<string, unknown>): string {
  return endpoint.path.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) =>
    encodeURIComponent(String(args[name])),
  );
}

export function requiredParamNames(endpoint: EndpointDefinition): string[] {
  return [
    ...Object.keys(endpoint.pathParams),
    ...Object.entries(endpoint.queryParams)
      .filter(([, spec]) => spec.required)
      .map(([name]) => name),
  ];
}

export { ENDPOINTS };
