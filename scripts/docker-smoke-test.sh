#!/usr/bin/env bash
# Docker smoke test: builds the image, runs it against the mock Apple API and verifies
#   - the container becomes healthy (HEALTHCHECK -> GET /health)
#   - GET /health returns {"status":"ok"}
#   - the process runs as a non-root user
#   - no credentials are baked into the image
#   - MCP over HTTP works end to end (initialize, tools/list, list_accounts, a GET tool via the mock API)
#   - bearer auth is enforced
#
# Usage: scripts/docker-smoke-test.sh            (builds apple-search-ads-mcp:smoke)
#        SKIP_BUILD=1 IMAGE=my/image:tag scripts/docker-smoke-test.sh
#        DOCKER_BUILD_ARGS="--build-arg NODE_IMAGE=..." scripts/docker-smoke-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-apple-search-ads-mcp:smoke}"
NAME="asa-mcp-smoke-$$"
TOKEN="smoke-test-token-$(date +%s)-0123456789"
WORK="$(mktemp -d)"
MOCK_PID=""

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -n 40 >&2 || true
  exit 1
}

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building $IMAGE"
  # shellcheck disable=SC2086
  docker build ${DOCKER_BUILD_ARGS:-} -t "$IMAGE" "$ROOT"
fi

echo "==> Checking that no credentials are baked into the image"
docker run --rm --entrypoint node "$IMAGE" -e "
  const fs = require('node:fs');
  if (fs.existsSync('/app/config/accounts.json')) { console.error('accounts.json present in image'); process.exit(1); }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
  const bad = walk('/app').filter((f) => /\.(pem|p8)$/.test(f) || /accounts\.json$/.test(f));
  if (bad.length) { console.error('credential-like files:', bad); process.exit(1); }
" || fail "credentials found in image"

echo "==> Checking the runtime user is not root"
UID_IN_IMAGE="$(docker run --rm --entrypoint node "$IMAGE" -e 'process.stdout.write(String(process.getuid()))')"
[[ "$UID_IN_IMAGE" != "0" ]] || fail "container runs as root"

echo "==> Generating a throwaway account with a fresh P-256 key"
node -e "
  const { generateKeyPairSync } = require('node:crypto');
  const fs = require('node:fs');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync('$WORK/accounts.json', JSON.stringify({ accounts: [{
    id: 'smoke', name: 'Smoke test', clientId: 'SEARCHADS.smoke-client', teamId: 'SEARCHADS.smoke-team',
    keyId: 'smoke-key', orgId: '40669820', adAccountId: '123456789',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }] }));
"
chmod 0644 "$WORK/accounts.json"

echo "==> Starting the mock Apple API"
node "$ROOT/tests/e2e/mock-apple-api.mjs" --host 0.0.0.0 --port 0 >"$WORK/mock.url" &
MOCK_PID=$!
for _ in $(seq 1 50); do [[ -s "$WORK/mock.url" ]] && break; sleep 0.1; done
MOCK_PORT="$(sed -E 's#.*:([0-9]+)$#\1#' "$WORK/mock.url")"
[[ -n "$MOCK_PORT" ]] || fail "mock API did not start"
MOCK="http://host.docker.internal:${MOCK_PORT}"

echo "==> Starting the container"
docker run -d --name "$NAME" \
  --add-host=host.docker.internal:host-gateway \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  --health-interval=2s --health-start-period=2s --health-retries=10 \
  -p 127.0.0.1::8080 \
  -v "$WORK/accounts.json:/app/config/accounts.json:ro" \
  -e MCP_AUTH_TOKEN="$TOKEN" \
  -e APPLE_ADS_V5_BASE_URL="$MOCK/api/v5" \
  -e APPLE_ADS_PLATFORM_BASE_URL="$MOCK/v1" \
  -e APPLE_OAUTH_TOKEN_URL="$MOCK/oauth2/token" \
  -e ALLOW_INSECURE_ENDPOINTS=true \
  "$IMAGE" >/dev/null

PORT="$(docker port "$NAME" 8080/tcp | head -n1 | sed -E 's#.*:([0-9]+)$#\1#')"
BASE="http://127.0.0.1:${PORT}"

echo "==> Waiting for the Docker health check"
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$NAME")"
  [[ "$STATUS" == "healthy" ]] && break
  [[ "$(docker inspect --format '{{.State.Running}}' "$NAME")" == "true" ]] || fail "container exited"
  sleep 1
done
[[ "$STATUS" == "healthy" ]] || fail "container never became healthy (status: $STATUS)"

echo "==> Verifying /health, auth and MCP over HTTP"
BASE="$BASE" TOKEN="$TOKEN" node --input-type=module -e "
  const base = process.env.BASE;
  const auth = { authorization: 'Bearer ' + process.env.TOKEN };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const assert = (cond, msg) => { if (!cond) { console.error('assertion failed: ' + msg); process.exit(1); } };
  const rpc = async (method, params, extra = auth) => {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
  };

  const health = await fetch(base + '/health');
  assert(health.status === 200, 'health status');
  assert(JSON.stringify(await health.json()) === '{\"status\":\"ok\"}', 'health body');

  assert((await rpc('tools/list', {}, {})).status === 401, 'auth is enforced');

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert(init.status === 200 && init.body.result.serverInfo.name === 'apple-search-ads-mcp', 'initialize');

  const tools = await rpc('tools/list', {});
  assert(tools.body.result.tools.length === 55, 'tool count is ' + tools.body.result.tools.length);

  const accounts = await rpc('tools/call', { name: 'list_accounts', arguments: {} });
  const accountsText = JSON.stringify(accounts.body);
  assert(accounts.body.result.structuredContent.accounts[0].id === 'smoke', 'list_accounts');
  assert(!accountsText.includes('PRIVATE KEY') && !accountsText.includes('SEARCHADS.smoke-client'), 'no credentials');

  for (const [name, args] of [
    ['v5_get_campaign', { campaignId: '542370642' }],
    ['platform_get_campaign', { id: '444555681' }],
    ['v5_get_all_campaigns', { fetch_all: true }],
  ]) {
    const call = await rpc('tools/call', { name, arguments: { account_id: 'smoke', ...args } });
    assert(call.status === 200 && !call.body.result.isError, name + ': ' + JSON.stringify(call.body));
  }
  console.log('MCP checks passed');
"

echo "==> Verifying the mock only received GET requests from the container"
node -e "
  fetch('http://127.0.0.1:${MOCK_PORT}/__requests').then((r) => r.json()).then((reqs) => {
    const api = reqs.filter((r) => r.kind === 'api');
    if (api.length === 0 || api.some((r) => r.method !== 'GET')) { console.error(api); process.exit(1); }
  });
" || fail "non-GET request reached the API"

echo "==> Verifying logs go to stderr as JSON and contain no secrets"
docker logs "$NAME" >"$WORK/stdout.log" 2>"$WORK/stderr.log"
[[ ! -s "$WORK/stdout.log" ]] || fail "unexpected stdout output in HTTP mode"
grep -q '"event":"http_server_started"' "$WORK/stderr.log" || fail "missing startup log"
if grep -q -e "$TOKEN" -e 'PRIVATE KEY' -e 'Bearer mock_' "$WORK/stderr.log"; then fail "secret found in logs"; fi

echo "PASS: Docker smoke test"
