# Security

## Read-only guarantee

**This server intentionally supports only Apple Search Ads GET/read-only APIs. Mutation APIs are not implemented.**

It is enforced in layers, each covered by tests (`tests/security/get-only.test.ts`, `tests/unit/http-client.test.ts`,
`tests/unit/registry.test.ts`, `tests/unit/api-coverage.test.ts`):

1. **No mutation endpoints exist.** The registry only contains the 54 documented GET endpoints. `EndpointDefinition.method`
   has the literal type `'GET'`, and `validateRegistry()` rejects anything else at startup.
2. **No generic request tool.** Each tool maps to exactly one fixed Apple path template. No tool accepts a method,
   URL, path, headers or body; unknown arguments are rejected by strict schemas.
3. **GET-only HTTP client.** `GetOnlyHttpClient.request()` throws `UnsupportedOperationError` unless
   `method === 'GET'` (POST, PUT, PATCH, DELETE, HEAD, OPTIONS, lowercase variants…), refuses request bodies, refuses
   URLs outside the configured Apple base URLs (and URLs with embedded credentials), and disables redirects.
4. **Static check.** A test scans `src/` and fails if any file other than the OAuth client sets a non-GET method.
5. **Inventory check.** `docs/api-coverage.json` lists the 120 excluded non-GET endpoints; a test fails if any of them
   appears in the registry.

The single non-GET request the process sends is the OAuth 2.0 token exchange
(`POST https://appleid.apple.com/auth/oauth2/token`), required by Apple's authentication specification. It does not
touch the Apple Ads APIs, its URL is fixed configuration, and no tool can reach it.

Excluded by design even though they only read data: Apple's report endpoints (all `POST`), impression-share report
creation (`POST /custom-reports`), and every `/find` and `/query` endpoint.

## Credentials

- Private keys, client secrets (JWTs), access tokens and Authorization headers are **never** returned by tools or
  resources and never logged.
  - `AccountCredentials` keeps signing material in private fields; `JSON.stringify`/`util.inspect` print
    `[REDACTED CREDENTIALS]`. `list_accounts` returns only id, name, description, enabled APIs and default
    org/ad-account ids.
  - The logger deep-redacts sensitive keys (`private_key`, `access_token`, `authorization`, `client_secret`, `token`,
    `password`, …) and secret-looking values (PEM blocks, `Bearer …`, JWT-shaped strings, `client_secret=`/`access_token=`
    query params).
  - A `SecretScrubber` knows every private key, client secret and access token the process has used and removes them
    from **every** tool payload (success and error), so even an upstream response that echoed a credential cannot
    leak it.
- Client secrets are short-lived (1 hour by default, `CLIENT_SECRET_TTL_SECONDS`) and sent in the form body, never in
  a URL.
- Credentials are loaded from the accounts file at runtime; nothing is baked into source or the Docker image
  (`.gitignore` and `.dockerignore` exclude `config/accounts.json`, `*.pem`, `*.p8`, `.env*`).
- The server warns when the accounts file or a key file is world-readable.

## Account isolation

- `account_id` is validated (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) and looked up in an in-memory map. It is never used
  to build file paths, so values like `../../other-account` cannot read files; they return `ACCOUNT_NOT_FOUND` /
  `VALIDATION_ERROR` before any network call.
- Each account has its own `AccountTokenManager`, constructed with only that account's credentials. Tokens are cached
  per account, refreshed per account, and invalidated per account. Tests run 40 concurrent mixed-account calls and
  assert every request carried its own account's token and context.
- Rate-limit state is tracked per account and API family.

## Input validation

- Strict schemas: unknown parameters are rejected; enums, integer ranges and page sizes are enforced.
- Every value placed in a URL path matches a strict pattern (numeric id, UUID, opaque id, `EntityType.id.txn`) and
  is additionally checked for `.`/`..`, `/`, `\`, `%`, `?`, `#`, whitespace and control characters, then
  percent-encoded.
- `org_id` / `ad_account_id` must match `^[A-Za-z0-9_-]{1,64}$` (no header injection).
- Free-text queries reject control characters and are URL-encoded (no query smuggling).
- Integers above 2^53 must be passed as strings, avoiding silent precision loss on Apple's int64 ids.

## HTTP transport

- `MCP_AUTH_TOKEN` enables bearer auth on `/mcp` (constant-time comparison). The server logs a warning when bound to
  a non-loopback address without it.
- `GET /health` returns only `{"status":"ok"}`.
- Optional DNS-rebinding protection with `MCP_ALLOWED_HOSTS`; request body limit (`HTTP_MAX_BODY_BYTES`, oversized
  requests get `413` and the connection is closed); stateless mode (no sessions to hijack).
- Run behind TLS for anything beyond localhost / a private network.

## Container

Non-root `node` user, root-owned read-only application files, no package managers in the runtime image, works with
`--read-only`, `--cap-drop ALL` and `no-new-privileges`.

## Reporting

Please report vulnerabilities privately to the maintainers rather than in a public issue.
