# Configuration

Configuration has two parts: **environment variables** (runtime behaviour) and the **accounts JSON file**
(Apple credentials). Secrets never come from source code; the only secret read from the environment is the optional
`MCP_AUTH_TOKEN` (and per-account keys if you choose `privateKeyEnv`).

## Accounts file (`ACCOUNTS_CONFIG`)

```json
{
  "accounts": [
    {
      "id": "production",
      "name": "Production",
      "description": "optional",
      "clientId": "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "teamId": "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "keyId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----",
      "orgId": "1234567",
      "adAccountId": "123456789",
      "apis": ["campaign-management-v5", "platform-v1"]
    }
  ]
}
```

| Field            | Required | Description                                                                                                                   |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`             | yes      | Value clients pass as `account_id`. `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, unique (case-insensitive). Never used as a file path. |
| `name`           | yes      | Display name returned by `list_accounts`.                                                                                     |
| `description`    | no       | Returned by `list_accounts`.                                                                                                  |
| `clientId`       | yes      | Apple API client id (`SEARCHADS.…`). JWT `sub`.                                                                               |
| `teamId`         | yes      | Apple team id (`SEARCHADS.…`). JWT `iss`.                                                                                     |
| `keyId`          | yes      | Id of the uploaded public key. JWT header `kid`.                                                                              |
| `privateKey`     | one of   | PEM (PKCS#8 `BEGIN PRIVATE KEY` or SEC1 `BEGIN EC PRIVATE KEY`), P-256 only. Literal `\n` sequences are accepted.             |
| `privateKeyPath` | one of   | Path to the PEM file, relative to the accounts file's directory.                                                              |
| `privateKeyEnv`  | one of   | Name of an environment variable holding the PEM.                                                                              |
| `orgId`          | no       | Default `X-AP-Context: orgId=` for `v5_*` tools (override per call with `org_id`).                                            |
| `adAccountId`    | no       | Default `X-AP-Context: adAccountId=` for `platform_*` tools (override with `ad_account_id`).                                  |
| `apis`           | no       | Restrict the account to `campaign-management-v5` and/or `platform-v1` (default: both).                                        |

Validation happens at startup: unknown keys, missing fields, duplicate ids, unreadable key files, malformed PEMs,
non-EC keys and non-P-256 curves all stop the server with a `CONFIGURATION_ERROR` that never echoes key material.
The server warns when the accounts file or a key file is world-readable.

**Adding an account** is just another object in `accounts`; restart the server to load it.

### Getting the values

1. Apple Ads → Account Settings → User Management: invite a user with the **API** role (e.g. API Account Read Only).
2. Sign in as that user → Account Settings → API: upload a public key created with
   `openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem && openssl ec -in private-key.pem -pubout -out public-key.pem`.
3. Copy `clientId`, `teamId` and `keyId` from the API page.
4. After starting the server, call `v5_get_user_acl` (org ids) and `platform_get_user_acls` (ad account ids) to fill
   `orgId` / `adAccountId`.

## Environment variables

| Variable                         | Default                                       | Description                                                                                                           |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`                  | `stdio`                                       | `stdio` or `http`. `--transport` on the CLI overrides it.                                                             |
| `HOST`                           | `0.0.0.0`                                     | HTTP bind address. Use `127.0.0.1` for local-only.                                                                    |
| `PORT`                           | `8080`                                        | HTTP port (`0` = random).                                                                                             |
| `ACCOUNTS_CONFIG`                | `config/accounts.json`                        | Path to the accounts file.                                                                                            |
| `LOG_LEVEL`                      | `info`                                        | `debug`, `info`, `warn`, `error`, `silent`. Logs are JSON lines on **stderr**.                                        |
| `REQUEST_TIMEOUT`                | `30000`                                       | Timeout per HTTP request to Apple, in ms (100–600000).                                                                |
| `ENABLED_APIS`                   | `campaign-management-v5,platform-v1`          | Which API families get tools. Aliases: `v5`, `platform`.                                                              |
| `MAX_RETRIES`                    | `3`                                           | Retries for 429, 500/502/503/504 and transient network errors (0–10).                                                 |
| `RETRY_BASE_DELAY_MS`            | `1000`                                        | First backoff delay; doubles each attempt with ±20% jitter.                                                           |
| `RETRY_MAX_DELAY_MS`             | `16000`                                       | Backoff cap (Apple recommends 16 s).                                                                                  |
| `MAX_RETRY_AFTER_SECONDS`        | `60`                                          | Longest `Retry-After`/`RateLimit-Reset` the server will wait; longer → `RATE_LIMIT_ERROR` with `retry_after_seconds`. |
| `PAGINATION_DEFAULT_MAX_PAGES`   | `10`                                          | `fetch_all` default page budget.                                                                                      |
| `PAGINATION_MAX_PAGES`           | `100`                                         | Upper bound clients may request via `max_pages`.                                                                      |
| `PAGINATION_DEFAULT_MAX_RECORDS` | `1000`                                        | `fetch_all` default record budget.                                                                                    |
| `PAGINATION_MAX_RECORDS`         | `10000`                                       | Upper bound clients may request via `max_records`.                                                                    |
| `MCP_AUTH_TOKEN`                 | –                                             | If set (≥16 chars), `POST /mcp` requires `Authorization: Bearer <token>`. Strongly recommended for HTTP.              |
| `MCP_ALLOWED_HOSTS`              | –                                             | Comma-separated Host header allow-list; enables DNS-rebinding protection.                                             |
| `HTTP_MAX_BODY_BYTES`            | `1048576`                                     | Maximum MCP request body.                                                                                             |
| `CLIENT_SECRET_TTL_SECONDS`      | `3600`                                        | Lifetime of the ES256 client-secret JWT (max 180 days). Short is safer.                                               |
| `TOKEN_REFRESH_SKEW_SECONDS`     | `60`                                          | Refresh access tokens this long before they expire.                                                                   |
| `APPLE_ADS_V5_BASE_URL`          | `https://api.searchads.apple.com/api/v5`      | Override for testing.                                                                                                 |
| `APPLE_ADS_PLATFORM_BASE_URL`    | `https://api.ads.apple.com/v1`                | Override for testing.                                                                                                 |
| `APPLE_OAUTH_TOKEN_URL`          | `https://appleid.apple.com/auth/oauth2/token` | Override for testing.                                                                                                 |
| `ALLOW_INSECURE_ENDPOINTS`       | `false`                                       | Allow `http://` overrides above (local mocks only).                                                                   |

Invalid values stop the server with a `CONFIGURATION_ERROR` listing every problem. See [.env.example](../.env.example).
