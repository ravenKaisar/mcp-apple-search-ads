/**
 * MSW handlers emulating Apple's OAuth endpoint and both Apple Ads APIs at their REAL production URLs.
 * Tests run the production configuration (default base URLs) while MSW intercepts every request, and
 * any unexpected request fails the test (onUnhandledRequest: 'error').
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { API_FAMILIES } from '../../src/apple-search-ads/apis.js';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import { DEFAULT_OAUTH_TOKEN_URL } from '../../src/config/env.js';
import { successFixture } from '../helpers/fixtures.js';

export interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
}

export interface AppleMockState {
  requests: CapturedRequest[];
  tokenRequests: CapturedRequest[];
  issued: Map<string, string[]>;
  /** Overrides keyed by tool name; return undefined to fall through to the fixture. */
  overrides: Map<string, (request: CapturedRequest) => Response | Promise<Response> | undefined>;
  /** Large synthetic datasets for paginated list endpoints, keyed by tool name. */
  datasets: Map<string, unknown[]>;
  tokenOverride?: (request: CapturedRequest) => Response | undefined;
}

export function createAppleMock() {
  const state: AppleMockState = {
    requests: [],
    tokenRequests: [],
    issued: new Map(),
    overrides: new Map(),
    datasets: new Map(),
  };
  let counter = 0;

  const tokenHandler = http.post(DEFAULT_OAUTH_TOKEN_URL, async ({ request }) => {
    const body = await request.text();
    const captured = { method: request.method, url: new URL(request.url), headers: request.headers, body };
    state.tokenRequests.push(captured);
    const override = state.tokenOverride?.(captured);
    if (override) return override;
    const params = new URLSearchParams(body);
    if (params.get('grant_type') !== 'client_credentials' || params.get('scope') !== 'searchadsorg') {
      return HttpResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if ((params.get('client_secret') ?? '').split('.').length !== 3) {
      return HttpResponse.json({ error: 'invalid_client' }, { status: 400 });
    }
    const clientId = params.get('client_id') ?? '';
    counter += 1;
    const token = `msw_${clientId}_${counter}_${'z'.repeat(20)}`;
    state.issued.set(clientId, [...(state.issued.get(clientId) ?? []), token]);
    return HttpResponse.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'searchadsorg',
    });
  });

  const apiHandlers: HttpHandler[] = ENDPOINTS.map((endpoint) => {
    const base = API_FAMILIES[endpoint.api].defaultBaseUrl;
    const pattern = base + endpoint.path.replace(/\{([A-Za-z]+)\}/g, ':$1');
    return http.get(pattern, async ({ request }) => {
      const captured = { method: request.method, url: new URL(request.url), headers: request.headers };
      state.requests.push(captured);
      const auth = request.headers.get('authorization') ?? '';
      const known = [...state.issued.values()].flat();
      if (!auth.startsWith('Bearer ') || !known.includes(auth.slice(7))) {
        return HttpResponse.json(
          { error: { code: 'unauthorized', message: 'Invalid token' } },
          { status: 401 },
        );
      }
      if (endpoint.requiresContext && !request.headers.get('x-ap-context')) {
        return HttpResponse.json(
          { error: { code: 'bad_request', message: 'X-AP-Context missing' } },
          { status: 400 },
        );
      }
      const override = state.overrides.get(endpoint.toolName);
      const overridden = override ? await override(captured) : undefined;
      if (overridden) return overridden;

      const dataset = state.datasets.get(endpoint.toolName);
      if (dataset && endpoint.pagination) {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(
          url.searchParams.get(endpoint.pagination.limitParam) ?? endpoint.pagination.defaultPageSize,
        );
        const page = dataset.slice(offset, offset + limit);
        return HttpResponse.json(
          endpoint.api === 'platform-v1'
            ? { result: page, pagination: { offset, pageSize: limit, totalCount: dataset.length } }
            : {
                data: page,
                pagination: { totalResults: dataset.length, startIndex: offset, itemsPerPage: limit },
                error: null,
              },
          { headers: { 'x-request-id': `req-${offset}` } },
        );
      }
      return HttpResponse.json(successFixture(endpoint.toolName) as Record<string, unknown>, {
        headers: { 'x-request-id': 'req-fixture' },
      });
    });
  });

  // Any non-GET call to the Apple Ads APIs is recorded (and must never happen).
  const mutationTrap = (base: string) =>
    http.all(`${base}/*`, ({ request }) => {
      state.requests.push({ method: request.method, url: new URL(request.url), headers: request.headers });
      return HttpResponse.json({ error: 'mutation attempted' }, { status: 405 });
    });

  const server = setupServer(
    tokenHandler,
    ...apiHandlers,
    mutationTrap(API_FAMILIES['campaign-management-v5'].defaultBaseUrl),
    mutationTrap(API_FAMILIES['platform-v1'].defaultBaseUrl),
  );
  return {
    server,
    state,
    reset() {
      state.requests.length = 0;
      state.tokenRequests.length = 0;
      state.overrides.clear();
      state.datasets.clear();
      state.tokenOverride = undefined;
    },
  };
}
