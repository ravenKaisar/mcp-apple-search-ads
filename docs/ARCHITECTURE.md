# Architecture

```text
               MCP client (Claude Desktop / Claude Code / Codex / remote agent)
                         |                                   |
                       stdio                        Streamable HTTP (POST /mcp)
                 transport/stdio.ts                   transport/http.ts  (+ GET /health, bearer auth)
                         |                                   |
                         +-------------- mcp/server.ts ------+
                                 tools/ (list_accounts + 54 endpoint tools)
                                 schemas/ (strict zod -> JSON Schema), resources/
                                              |
                       +----------------------+-----------------------+
                       |                                              |
          apple-search-ads/accounts.ts                   apple-search-ads/client.ts
          AccountManager (AuthenticationProvider)        AppleSearchAdsClient
            one AccountTokenManager per account            URL building from the endpoint registry
            (auth.ts: ES256 JWT + OAuth token client)      retries, 401 refresh, rate limits, errors
                       |                                              |
                POST appleid.apple.com token          apple-search-ads/http.ts  GetOnlyHttpClient
                (only non-GET request)                  method === 'GET' or throw; URL allow-list
                                                                      |
                                              Apple Ads APIs: v5 (api.searchads.apple.com/api/v5)
                                                              Platform (api.ads.apple.com/v1)
```

## Layers

| Layer                                            | Files                    | Knows about MCP?                    |
| ------------------------------------------------ | ------------------------ | ----------------------------------- |
| Transports                                       | `src/transport/*`        | yes                                 |
| MCP server, tools, schemas, resources            | `src/mcp/*`              | yes                                 |
| Apple client, auth, accounts, pagination, errors | `src/apple-search-ads/*` | **no** (unit-testable in isolation) |
| Configuration                                    | `src/config/*`           | no                                  |
| Utilities (logger, redaction, clock)             | `src/utils/*`            | no                                  |

`src/runtime.ts` wires everything; `src/index.ts` is the CLI.

## Endpoint registry

Every Apple GET endpoint is a declarative `EndpointDefinition` (`src/apple-search-ads/endpoints/`):

```ts
{
  id: 'v5.getAdGroup',
  toolName: 'v5_get_ad_group',
  api: 'campaign-management-v5',
  category: 'Ad Groups',
  title: 'Get an Ad Group',                  // Apple's doc title
  description: '…',                          // MCP tool description
  method: 'GET',                             // literal type: nothing else compiles
  path: '/campaigns/{campaignId}/adgroups/{adgroupId}',
  pathParams: { campaignId, adgroupId },     // ParamSpec: zod schema + description
  queryParams: { fields: v5FieldsParam() },
  requiresContext: true,                     // X-AP-Context header
  pagination: undefined,                     // or an OffsetPaginationSpec
  docSlug: 'get-an-ad-group',
  responseType: 'AdGroupResponse',
}
```

From this single definition the server derives: the MCP tool (name, description, strict input schema, handler),
the request URL (placeholders are validated and percent-encoded), the `X-AP-Context` header, query
serialization (`csv` or repeated), pagination, and the `apple-ads://endpoints` resource.
`validateRegistry()` runs at import time and rejects non-GET methods, duplicate names/routes, mismatched path
params, path traversal in templates and undeclared pagination params.

Apple parameter names are kept verbatim (`campaignId`, `adgroupId`, `countrycode`, `pageSize`…); MCP-level controls
use snake_case (`account_id`, `org_id`, `ad_account_id`, `fetch_all`, `max_pages`, `max_records`).

## Accounts and authentication

- `config/loader.ts` validates the accounts file (strict schema, unique case-insensitive ids, exactly one key
  source, EC P-256 key) and wraps signing material in `AccountCredentials` (private fields, redacting
  `toJSON`/`inspect`).
- `AccountManager` implements `AuthenticationProvider { getAccessToken(accountId), invalidateAccessToken(accountId, token?) }`
  and owns one `AccountTokenManager` per account, constructed with that account's credentials only — tokens cannot
  cross accounts.
- `AccountTokenManager` caches the token until `expires_in − skew`, de-duplicates concurrent refreshes
  (single-flight), and is invalidated by the client on HTTP 401 (one transparent retry).
- `OAuthTokenClient` builds the ES256 client secret (`createClientSecret`) and performs the token exchange with
  retries on 5xx/network errors. Issued tokens and secrets are registered with the `SecretScrubber`.

## Request pipeline (`AppleSearchAdsClient.get`)

1. Build URL from the registry path; reject unsafe segments (`..`, `/`, `%`, whitespace, control chars).
2. Proactive wait if `RateLimit-Remaining` hit 0 (Platform API headers), bounded by `MAX_RETRY_AFTER_SECONDS`.
3. Get the account's token; send `GET` through `GetOnlyHttpClient` (timeout, `redirect: 'error'`, URL allow-list).
4. 2xx → return parsed JSON (malformed/primitive JSON → `MALFORMED_RESPONSE`).
5. 401 → invalidate that token, refresh once, retry.
6. 429 → wait `Retry-After` (or `RateLimit-Reset`, or backoff) and retry; longer than allowed → `RATE_LIMIT_ERROR`.
7. 500/502/503/504 and transient network errors → exponential backoff with jitter, up to `MAX_RETRIES`.
8. Anything else → `APPLE_SEARCH_ADS_API_ERROR` with Apple's error details (v5 `messageCode`/`field`, Platform
   `code`/`details`) and the request id when Apple sends one.

## Pagination

`pagination.ts` provides `paginatePages` (async generator of pages), `paginate` (records) and `collectPages`.
All paginated Apple GET endpoints are offset-based (`limit` or `pageSize` + `offset`). Iteration stops when the data
set is exhausted (using Apple's total when available, otherwise a short page), or at `max_pages` / `max_records`
(defaults 10 / 1,000; hard caps 100 / 10,000, configurable). The final request is shrunk to the remaining record
budget. The page-request abstraction allows a cursor strategy to be added later; no Apple GET endpoint uses cursors
today.

## Responses and errors

Successful tools return `{ account_id, api, tool, data, pagination?, meta? }` where `data` is Apple's body untouched
(or the collected records for `fetch_all`). Errors are `{ error: { type, message, status?, request_id?, code?,
retry_after_seconds?, details? } }`. Every payload passes through the `SecretScrubber` before leaving the process.

## Adding a GET endpoint

1. Add the endpoint to `docs/api-coverage.json` (`endpoints[]`) from Apple's documentation.
2. Add an `EndpointDefinition` to `endpoints/campaign-management-v5.ts` or `endpoints/platform-v1.ts`, reusing the
   helpers in `endpoints/params.ts`.
3. Add a realistic 200 body to `tests/fixtures/apple-responses.json` (and a sample id in
   `tests/helpers/fixtures.ts` if it introduces a new path parameter name).
4. `npm run docs:coverage && npm test`.

The parameterized suites pick the endpoint up automatically (client matrix, tool matrix, integration, e2e, coverage
checks). If Apple ships a new API family, add an `ApiFamily` in `apis.ts` (base URL, context header, envelope
readers) and a new registry file.
