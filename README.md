# Apple Search Ads MCP Server (read-only)

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that gives MCP clients
(Claude Desktop, Claude Code, Codex, Cursor and others) **read-only** access to Apple's advertising APIs, for
**multiple Apple Search Ads accounts**, over **stdio** or **Streamable HTTP** (Docker-ready).

> **This server intentionally supports only Apple Search Ads GET/read-only APIs. Mutation APIs are not implemented.**
> Report-generation APIs and other endpoints that Apple only exposes through `POST` (including read-style
> `/find` and `/query` calls) are intentionally excluded too.

## What it covers

Apple currently documents two advertising APIs, and this server covers **every GET endpoint of both**
(54 endpoints, verified against Apple's official documentation on 2026-10-03):

| API                                               | Base URL                                 | Status                                     | GET endpoints | MCP tool prefix |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------------------ | ------------: | --------------- |
| Apple Search Ads **Campaign Management API v5**   | `https://api.searchads.apple.com/api/v5` | Deprecated by Apple, **sunset 2027-01-26** |            30 | `v5_`           |
| **Apple Ads Platform API v1** (released Aug 2026) | `https://api.ads.apple.com/v1`           | Current                                    |            24 | `platform_`     |

The full inventory, including the 120 intentionally excluded non-GET endpoints, is in
[docs/API-COVERAGE.md](docs/API-COVERAGE.md) (machine-readable: [docs/api-coverage.json](docs/api-coverage.json)).
Set `ENABLED_APIS=platform` to drop the v5 tools after Apple's sunset date.

### MCP tools (55)

`list_accounts`, plus one tool per Apple GET endpoint:

**Campaign Management API v5** — `v5_get_user_acl`, `v5_get_me_details`, `v5_search_apps`, `v5_get_app_details`,
`v5_get_localized_app_details`, `v5_get_campaign`, `v5_get_all_campaigns`, `v5_get_budget_order`,
`v5_get_all_budget_orders`, `v5_get_ad_group`, `v5_get_all_ad_groups`, `v5_get_targeting_keyword`,
`v5_get_all_targeting_keywords`, `v5_get_campaign_negative_keyword`, `v5_get_all_campaign_negative_keywords`,
`v5_get_ad_group_negative_keyword`, `v5_get_all_ad_group_negative_keywords`, `v5_search_geolocations`, `v5_get_ad`,
`v5_get_all_ads`, `v5_get_ad_creative_rejection_reason`, `v5_get_creative`, `v5_get_all_creatives`,
`v5_get_product_pages`, `v5_get_product_page`, `v5_get_product_page_locales`, `v5_get_supported_countries_or_regions`,
`v5_get_app_preview_device_sizes`, `v5_get_impression_share_report`, `v5_get_all_impression_share_reports`

**Apple Ads Platform API v1** — `platform_get_me`, `platform_get_user_acls`, `platform_get_org`,
`platform_get_ad_account`, `platform_get_advertiser_resources`, `platform_search_apps`, `platform_get_app_details`,
`platform_get_app_rejection_reason`, `platform_get_brand`, `platform_get_business_category`,
`platform_get_location_group`, `platform_get_location`, `platform_get_campaign`,
`platform_get_campaign_legacy_app_limited_status_reasons`, `platform_get_ad_group`, `platform_search_geo_locations`,
`platform_get_keyword`, `platform_get_negative_keyword`, `platform_get_ad`, `platform_get_creative`,
`platform_get_asset`, `platform_get_product_page`, `platform_get_budget_order`, `platform_get_change_history_detail`

There is deliberately **no** generic `request(method, url, body)` tool. MCP resources `apple-ads://accounts` and
`apple-ads://endpoints` describe the configured accounts and the implemented endpoints.

> **What you can't do with GET only.** Apple exposes reports (spend, keyword and search-term reports), impression-share
> report creation, "find"/"query" listing with filters, and every Platform API list (campaigns, ad groups, keywords,
> ads, creatives, budget orders, insights, recommendations, suggestions, change-history search) **only through POST**.
> Those are listed as excluded in [docs/API-COVERAGE.md](docs/API-COVERAGE.md). With the Platform API you can read any
> entity whose id you know; with v5 you can also list entities via the GET list endpoints.

## Quick start

```bash
npm ci
npm run build
cp config/accounts.example.json config/accounts.json   # fill in real credentials, then: chmod 600 config/accounts.json
ACCOUNTS_CONFIG=config/accounts.json npm run start:stdio
```

Requires Node.js 22+.

## Authentication

Each account uses Apple's OAuth 2.0 client-credentials flow (same for both APIs):

1. In Apple Ads, invite an **API user**, generate a P-256 key (`openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem`),
   upload the public key, and note the **clientId**, **teamId** and **keyId**.
2. The server signs an **ES256 client-secret JWT** (`iss`=teamId, `sub`=clientId, `aud`=`https://appleid.apple.com`,
   `kid`=keyId, 1-hour lifetime by default; Apple allows up to 180 days), exchanges it at
   `POST https://appleid.apple.com/auth/oauth2/token` (`scope=searchadsorg`) for a 1-hour access token, caches it
   per account, refreshes it 60 s before expiry, and refreshes once more if Apple returns 401.
3. Requests carry `Authorization: Bearer …` and `X-AP-Context: orgId=…` (v5) or `X-AP-Context: adAccountId=…`
   (Platform API).

The OAuth token exchange is the only non-GET request the server ever makes; it goes to the fixed Apple ID token
endpoint and is not reachable from any tool. See [docs/SECURITY.md](docs/SECURITY.md).

## Multiple accounts

Accounts live in a JSON file (`ACCOUNTS_CONFIG`). Every tool takes an `account_id`:

```json
{
  "accounts": [
    {
      "id": "production",
      "name": "Production",
      "clientId": "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "teamId": "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "keyId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----",
      "orgId": "1234567",
      "adAccountId": "123456789"
    },
    {
      "id": "staging",
      "name": "Staging",
      "clientId": "SEARCHADS.…",
      "teamId": "SEARCHADS.…",
      "keyId": "…",
      "privateKeyPath": "../secrets/staging.pem",
      "orgId": "7654321",
      "apis": ["campaign-management-v5"]
    }
  ]
}
```

- Exactly one of `privateKey`, `privateKeyPath` (relative to the config file) or `privateKeyEnv` (name of an
  environment variable) per account.
- `orgId` / `adAccountId` are optional defaults; tools accept `org_id` / `ad_account_id` to override them. Discover
  them with `v5_get_user_acl` and `platform_get_user_acls`.
- `apis` optionally restricts an account to one API family.
- Each account gets its own isolated token cache; credentials are never returned by any tool or written to logs.

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Usage examples

```text
list_accounts {}
v5_get_all_campaigns { "account_id": "production" }
v5_get_all_campaigns { "account_id": "production", "fetch_all": true, "max_records": 5000 }
v5_get_ad_group { "account_id": "production", "campaignId": "542370642", "adgroupId": "542317095" }
platform_get_user_acls { "account_id": "production" }
platform_get_campaign { "account_id": "production", "ad_account_id": "123456789", "id": "444555681" }
platform_search_geo_locations { "account_id": "production", "supplySource": "APPSTORE", "query": "San Francisco", "entity": "Locality" }
```

Responses keep Apple's payload unchanged under `data` and add metadata:

```json
{
  "account_id": "production",
  "api": "campaign-management-v5",
  "tool": "v5_get_all_campaigns",
  "data": {
    "data": [{ "id": 542370539, "name": "…" }],
    "pagination": { "totalResults": 250, "startIndex": 0, "itemsPerPage": 20 },
    "error": null
  },
  "pagination": {
    "mode": "single_page",
    "offset": 0,
    "limit": 20,
    "total": 250,
    "records_returned": 20,
    "has_more": true,
    "next_offset": 20
  },
  "meta": { "request_id": "…" }
}
```

With `fetch_all: true`, `data` is the array of records collected across pages (bounded by `max_pages` /
`max_records`, default 10 pages / 1,000 records), and `pagination.truncated` tells you if a limit stopped it.

Errors share one shape:

```json
{
  "error": {
    "type": "APPLE_SEARCH_ADS_API_ERROR",
    "status": 401,
    "message": "Authentication failed (401): …",
    "request_id": "…"
  }
}
```

Types: `CONFIGURATION_ERROR`, `ACCOUNT_NOT_FOUND`, `AUTHENTICATION_ERROR`, `APPLE_SEARCH_ADS_API_ERROR`,
`RATE_LIMIT_ERROR`, `VALIDATION_ERROR`, `UNSUPPORTED_OPERATION`, `NETWORK_ERROR`, `MALFORMED_RESPONSE`,
`INTERNAL_ERROR`. 429 responses are retried with `Retry-After` (or `RateLimit-Reset`), 5xx and transient network
errors with exponential backoff (Apple's 2/4/8/16 s guidance).

## Running over stdio

```bash
npm run start:stdio            # = node dist/index.js --transport stdio
```

stdout carries only MCP messages; all logs are JSON lines on stderr.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "apple-search-ads": {
      "command": "node",
      "args": ["/absolute/path/to/apple-search-ads-mcp/dist/index.js", "--transport", "stdio"],
      "env": { "ACCOUNTS_CONFIG": "/absolute/path/to/accounts.json" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add apple-search-ads -e ACCOUNTS_CONFIG=/absolute/path/to/accounts.json \
  -- node /absolute/path/to/apple-search-ads-mcp/dist/index.js --transport stdio
# or, against the HTTP server:
claude mcp add --transport http apple-search-ads http://localhost:8080/mcp --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.apple-search-ads]
command = "node"
args = ["/absolute/path/to/apple-search-ads-mcp/dist/index.js", "--transport", "stdio"]
env = { ACCOUNTS_CONFIG = "/absolute/path/to/accounts.json" }
```

### Cursor / VS Code (`.cursor/mcp.json`, `.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "apple-search-ads": {
      "command": "node",
      "args": ["/absolute/path/to/apple-search-ads-mcp/dist/index.js", "--transport", "stdio"],
      "env": { "ACCOUNTS_CONFIG": "/absolute/path/to/accounts.json" }
    }
  }
}
```

Remote clients that speak Streamable HTTP use `http://<host>:8080/mcp` with the header
`Authorization: Bearer <MCP_AUTH_TOKEN>`.

## Running over HTTP

```bash
MCP_AUTH_TOKEN=$(openssl rand -hex 32) ACCOUNTS_CONFIG=config/accounts.json PORT=8080 HOST=127.0.0.1 npm run start:http
curl http://127.0.0.1:8080/health     # {"status":"ok"}
```

- `POST /mcp` — MCP Streamable HTTP (stateless, JSON responses), bearer-protected when `MCP_AUTH_TOKEN` is set.
- `GET /health` — liveness; never exposes configuration.

## Docker

```bash
docker build -t apple-search-ads-mcp .
docker run -p 8080:8080 \
  -v ./config/accounts.json:/app/config/accounts.json:ro \
  -e ACCOUNTS_CONFIG=/app/config/accounts.json \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  apple-search-ads-mcp
# or
MCP_AUTH_TOKEN=$(openssl rand -hex 32) docker compose up -d --build
```

Multi-stage build, Alpine runtime, non-root `node` user, `HEALTHCHECK` on `/health`, no credentials in the image.

**Published images:** every push to `main` that passes CI is pushed to GHCR as
`ghcr.io/<owner>/<repo>:latest` and `:sha-<commit>` (linux/amd64 + linux/arm64). `npm run docker:publish` does the
same from your machine. The image also runs as a stdio server: `docker run -i --rm -v …/accounts.json:/app/config/accounts.json:ro ghcr.io/<owner>/<repo>:latest --transport stdio`.
Details: [docs/DOCKER.md](docs/DOCKER.md).

## Testing

```bash
npm run lint && npm run typecheck
npm run test:unit          # unit + security: every GET endpoint × 17 scenarios, every tool × 9 scenarios
npm run test:integration   # MSW-mocked Apple APIs at their real URLs, through the MCP protocol
npm run test:e2e           # builds, then drives the compiled server over stdio and HTTP against a mock Apple API
npm run test:coverage
npm run docker:test        # docker build + smoke test (health, non-root, no baked creds, MCP over HTTP)
```

No test ever calls Apple. See [docs/TESTING.md](docs/TESTING.md).

## Configuration (environment)

| Variable          | Default                | Purpose                                                     |
| ----------------- | ---------------------- | ----------------------------------------------------------- |
| `ACCOUNTS_CONFIG` | `config/accounts.json` | Accounts/credentials JSON file                              |
| `MCP_TRANSPORT`   | `stdio`                | `stdio` or `http` (CLI `--transport` wins)                  |
| `HOST` / `PORT`   | `0.0.0.0` / `8080`     | HTTP bind address                                           |
| `MCP_AUTH_TOKEN`  | –                      | Bearer token required on `/mcp` (≥16 chars)                 |
| `LOG_LEVEL`       | `info`                 | `debug`, `info`, `warn`, `error`, `silent`                  |
| `REQUEST_TIMEOUT` | `30000`                | Per-request timeout (ms)                                    |
| `ENABLED_APIS`    | both                   | `campaign-management-v5` (`v5`), `platform-v1` (`platform`) |

All variables: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and [.env.example](.env.example).

## Project layout

```text
src/
├── index.ts                  CLI entry (stdio | http)
├── runtime.ts                wires config → accounts → auth → GET-only client → MCP tools
├── apple-search-ads/         Apple client, independent of MCP
│   ├── apis.ts               API families (base URLs, context header, envelopes)
│   ├── auth.ts               ES256 client secret, OAuth token client, per-account token cache
│   ├── accounts.ts           AccountManager (AuthenticationProvider, isolation)
│   ├── http.ts               GetOnlyHttpClient (method guard, URL allow-list, timeouts, parsing)
│   ├── client.ts             AppleSearchAdsClient (URL building, retries, 401 refresh, error mapping)
│   ├── pagination.ts         paginate / paginatePages / collectPages
│   ├── rate-limit.ts, retry.ts, errors.ts
│   └── endpoints/            declarative GET endpoint registry (v5 + Platform)
├── mcp/                      server, tools (one per endpoint + list_accounts), schemas, resources
├── transport/                stdio.ts, http.ts
├── config/                   env.ts, loader.ts (accounts JSON)
└── utils/                    logger.ts, redact.ts, time.ts
tests/{unit,security,integration,e2e,fixtures,helpers}
docs/{API-COVERAGE.md,api-coverage.json,ARCHITECTURE.md,CONFIGURATION.md,DOCKER.md,TESTING.md,SECURITY.md}
```

Adding a newly documented GET endpoint is a registry entry plus an inventory entry and a fixture — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-get-endpoint).

## License

MIT
