# Docker

The image runs the MCP server with the **HTTP transport** on port 8080.

| Property                    | Value                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Build                       | Multi-stage: `npm ci` + `tsc` in the build stage, `npm prune --omit=dev`                        |
| Multi-arch                  | Build stage runs natively on the builder (`$BUILDPLATFORM`), never under QEMU; see below        |
| Runtime base                | `node:22-alpine` (override with `--build-arg NODE_IMAGE=…`)                                     |
| User                        | `node` (uid 1000), never root; app files are root-owned and read-only to it                     |
| Package managers in runtime | removed (npm, npx, corepack, yarn)                                                              |
| Health check                | `node /app/docker/healthcheck.mjs` → `GET http://127.0.0.1:$PORT/health` every 30 s             |
| Entrypoint                  | `node /app/dist/index.js --transport http`                                                      |
| Credentials                 | **not** in the image; `.dockerignore` excludes `config/accounts.json`, `*.pem`, `*.p8`, `.env*` |

## Build

```bash
docker build -t apple-search-ads-mcp .
```

### Multi-architecture builds

`npm ci` and `tsc` run once on the build machine's own platform (`FROM --platform=$BUILDPLATFORM`), and the
result is copied into each target platform's runtime image. Node 22 must not run under QEMU emulation: building
`linux/arm64` on an amd64 CI runner that way crashes with `qemu: uncaught target signal 4 (Illegal instruction)`.
For the arm64 image, only the runtime stage's shell `rm`/`mkdir` executes under QEMU.

This is only valid while every production dependency is pure JavaScript. `docker/check-pure-js.mjs` runs during the
build and fails it if a native addon (`*.node`, `binding.gyp`, `gypfile: true`) ever appears; at that point build
each platform natively instead (for example on arm64 runners).

## Run

```bash
docker run -d --name apple-search-ads-mcp \
  -p 8080:8080 \
  -v "$PWD/config/accounts.json:/app/config/accounts.json:ro" \
  -e ACCOUNTS_CONFIG=/app/config/accounts.json \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  apple-search-ads-mcp

curl http://localhost:8080/health          # {"status":"ok"}
docker inspect --format '{{.State.Health.Status}}' apple-search-ads-mcp
```

The container user (uid 1000) must be able to read the mounted file: `chmod 640` with a group the container shares,
or `chmod 644` on a host only you control. If `accounts.json` uses `privateKeyPath`, mount the key directory as well
(paths are resolved relative to the accounts file inside the container), or use `privateKeyEnv` with an environment
variable / secret.

### docker compose

```bash
cp config/accounts.example.json config/accounts.json   # fill in
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
docker compose up -d --build
```

`docker-compose.yml` mounts `./config/accounts.json` read-only, runs with a read-only root filesystem, drops all
capabilities and requires `MCP_AUTH_TOKEN`. A commented block shows the Docker secrets alternative
(`ACCOUNTS_CONFIG=/run/secrets/accounts`).

## Published images (GHCR)

CI (`.github/workflows/ci.yml`) publishes the image on every push to `main`, after lint, typecheck, all tests and
the Docker smoke test have passed:

|              |                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Image        | `ghcr.io/<owner>/<repo>` (lower-cased), or the repository variable `APP_IMAGE_NAME`                |
| Tags         | `latest` and `sha-<full commit sha>` (pin deployments to the `sha-` tag)                           |
| Platforms    | `linux/amd64`, `linux/arm64` (runs natively on Apple Silicon)                                      |
| Extras       | SBOM + provenance attestations, OCI labels (source, revision, license), GitHub Actions layer cache |
| Verification | the pushed image is pulled by digest and the smoke test runs against it                            |

Pull requests run the tests and the Docker smoke test but never push.

### Repository settings

The `build` job runs in the `production` environment with `packages: write`. By default it logs in with the
workflow's `GITHUB_TOKEN`; nothing else is required. Optional settings (repository or `production` environment):

| Name                                     | Kind              | Purpose                                                                                                                                |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_IMAGE_NAME`                         | variable          | Override the image name (e.g. `ghcr.io/withloopin/searchads-mcp`)                                                                      |
| `GHCR_USERNAME` / `GHCR_TOKEN`           | secrets           | Push with a PAT (`write:packages`) instead of `GITHUB_TOKEN`, e.g. when the package already exists and isn't linked to this repository |
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | variable / secret | Authenticated `node:22-alpine` pulls (avoids Docker Hub rate limits)                                                                   |

The first push creates the package; it is linked to the repository through the `org.opencontainers.image.source`
label. GHCR packages in an organization start **private**: grant pull access to the people/clusters that need it or
make the package public in the package settings.

### Pushing from your machine

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin   # token with write:packages
npm run docker:publish            # smoke test, then buildx amd64+arm64 push: latest + sha-<HEAD>
DRY_RUN=1 npm run docker:publish  # show the image, tags and buildx command only
```

The image name comes from `APP_IMAGE_NAME` or the GitHub `origin` remote. The script refuses to publish with
uncommitted changes (the `sha-` tag must match the content) unless `ALLOW_DIRTY=1`.

### Running the published image

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin   # only if the package is private

# HTTP
docker run -d -p 8080:8080 \
  -v "$PWD/config/accounts.json:/app/config/accounts.json:ro" \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/<owner>/<repo>:latest
```

The same image works as a **stdio** server for desktop clients (Claude Desktop, Codex, Cursor):

```json
{
  "mcpServers": {
    "apple-search-ads": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/absolute/path/to/accounts.json:/app/config/accounts.json:ro",
        "ghcr.io/<owner>/<repo>:latest",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

## Connecting a client

Streamable HTTP endpoint: `http://<host>:8080/mcp`, header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

```bash
claude mcp add --transport http apple-search-ads http://localhost:8080/mcp --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

Put a TLS-terminating reverse proxy in front of the container for anything beyond localhost or a private network,
and consider `MCP_ALLOWED_HOSTS` for DNS-rebinding protection.

## Environment

Everything in [CONFIGURATION.md](CONFIGURATION.md) applies. Image defaults: `MCP_TRANSPORT=http`, `HOST=0.0.0.0`,
`PORT=8080`, `ACCOUNTS_CONFIG=/app/config/accounts.json`, `LOG_LEVEL=info`, `REQUEST_TIMEOUT=30000`.
Logs are JSON lines on stderr (`docker logs`).

## Smoke test

```bash
npm run docker:test     # = bash scripts/docker-smoke-test.sh
```

Builds the image and verifies: no credential files in the image, non-root runtime uid, the container reaches
`healthy`, `/health` returns exactly `{"status":"ok"}`, bearer auth is enforced, MCP `initialize` / `tools/list`
(55 tools) / `list_accounts` / real GET tools against a mock Apple API (including `fetch_all`), only GET requests
reach the API, nothing is printed to stdout and no secrets appear in the logs. CI runs it on every push and pull
request, and again against the pushed image (by digest) after publishing.
