// Standalone mock of Apple's OAuth endpoint and both Apple Ads APIs, used by the e2e tests and the
// Docker smoke test. Routes come from docs/api-coverage.json; bodies from tests/fixtures.
//
//   node tests/e2e/mock-apple-api.mjs [--port 0] [--host 127.0.0.1]
//
// Endpoints:
//   POST /oauth2/token          OAuth client-credentials token endpoint
//   GET  /api/v5/...            Campaign Management API v5
//   GET  /v1/...                Apple Ads Platform API v1
//   GET  /__requests            recorded requests (no credentials)
//   POST /__reset               clear recorded requests
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const root = new URL('../../', import.meta.url);
const inventory = JSON.parse(readFileSync(new URL('docs/api-coverage.json', root), 'utf8'));
const fixtures = JSON.parse(readFileSync(new URL('tests/fixtures/apple-responses.json', root), 'utf8'));

const PREFIX = { 'campaign-management-v5': '/api/v5', 'platform-v1': '/v1' };

const escapeRegex = (text) => text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const routes = inventory.endpoints.map((endpoint) => ({
  endpoint,
  regex: new RegExp(
    `^${escapeRegex(PREFIX[endpoint.api])}${endpoint.path
      .split(/\{[A-Za-z]+\}/)
      .map(escapeRegex)
      .join('([^/]+)')}$`,
  ),
}));

export function createMockAppleApi() {
  const requests = [];
  const tokens = new Map();
  let counter = 0;

  const send = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/__requests') return send(res, 200, requests);
    if (url.pathname === '/__reset' && req.method === 'POST') {
      requests.length = 0;
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/oauth2/token') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      requests.push({
        kind: 'token',
        method: req.method,
        path: url.pathname,
        clientId: params.get('client_id'),
      });
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
        return send(res, 400, { error: 'invalid_request' });
      }
      if (params.get('grant_type') !== 'client_credentials' || params.get('scope') !== 'searchadsorg') {
        return send(res, 400, { error: 'invalid_request' });
      }
      const secret = params.get('client_secret') ?? '';
      const [header] = secret.split('.');
      let alg;
      try {
        alg = JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).alg;
      } catch {
        alg = undefined;
      }
      if (secret.split('.').length !== 3 || alg !== 'ES256')
        return send(res, 400, { error: 'invalid_client' });
      counter += 1;
      const token = `mock_${counter}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      tokens.set(token, params.get('client_id'));
      return send(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'searchadsorg',
      });
    }

    const apiPrefix = Object.values(PREFIX).find((p) => url.pathname.startsWith(p + '/'));
    if (!apiPrefix) return send(res, 404, { error: 'not_found' });

    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const record = {
      kind: 'api',
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      context: req.headers['x-ap-context'] ?? null,
      clientId: tokens.get(token) ?? null,
    };
    requests.push(record);

    if (req.method !== 'GET') return send(res, 405, { error: 'mutations are not allowed' });
    if (!tokens.has(token)) {
      return send(res, 401, { error: { code: 'unauthorized', message: 'Invalid or expired token' } });
    }
    const match = routes.find((r) => r.regex.test(url.pathname));
    if (!match) return send(res, 404, { error: { code: 'not_found', message: 'No such endpoint' } });
    const { endpoint } = match;
    record.tool = endpoint.mcpTool;
    if (endpoint.contextHeader && !String(record.context ?? '').startsWith(`${endpoint.contextHeader}=`)) {
      return send(res, 400, { error: { code: 'bad_request', message: 'X-AP-Context missing or wrong' } });
    }
    const headers = { 'x-request-id': `mock-${requests.length}` };
    if (endpoint.api === 'platform-v1') {
      Object.assign(headers, {
        'ratelimit-limit': '100',
        'ratelimit-remaining': '99',
        'ratelimit-reset': '60',
      });
    }
    return send(res, 200, fixtures[endpoint.mcpTool], headers);
  });

  return {
    server,
    requests,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { port: { type: 'string', default: '0' }, host: { type: 'string', default: '127.0.0.1' } },
  });
  const mock = createMockAppleApi();
  const url = await mock.listen(Number(values.port), values.host);
  process.stdout.write(`${url}\n`);
  process.on('SIGTERM', () => void mock.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));
}
