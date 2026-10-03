import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpTransportConfig } from '../config/env.js';
import type { Runtime } from '../runtime.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';

export interface RunningHttpServer {
  server: Server;
  /** Base URL, e.g. http://127.0.0.1:8080 */
  url: string;
  port: number;
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text).toString(),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text) as unknown;
}

function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // keep timing roughly constant
    return false;
  }
  return timingSafeEqual(a, b);
}

function isAuthorized(req: IncomingMessage, config: HttpTransportConfig): boolean {
  if (!config.authToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] !== undefined && tokensMatch(config.authToken, match[1]);
}

/**
 * Streamable HTTP transport (stateless JSON mode). Each POST /mcp gets a fresh MCP server/transport
 * pair; accounts, token caches and the Apple client are shared through the runtime.
 *
 * Endpoints:
 *   POST /mcp     MCP JSON-RPC (optionally protected by MCP_AUTH_TOKEN bearer auth)
 *   GET  /health  {"status":"ok"} - liveness for Docker / orchestrators; never exposes configuration
 */
export function startHttpServer(
  runtime: Runtime,
  config: HttpTransportConfig = runtime.config.http,
): Promise<RunningHttpServer> {
  const logger = runtime.logger.child({ component: 'http-transport' });

  if (
    !config.authToken &&
    config.host !== '127.0.0.1' &&
    config.host !== 'localhost' &&
    config.host !== '::1'
  ) {
    logger.warn('http_auth_disabled', {
      message:
        'MCP_AUTH_TOKEN is not set; anyone who can reach this port can query Apple Ads data. Set MCP_AUTH_TOKEN or restrict network access.',
    });
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!isAuthorized(req, config)) {
      jsonRpcError(res, 401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    if (req.method !== 'POST') {
      // Stateless mode: no server-initiated SSE stream (GET) and no sessions to delete (DELETE).
      jsonRpcError(res, 405, -32000, 'Method not allowed.', { Allow: 'POST' });
      return;
    }

    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxBodyBytes) {
      // Close the connection so a half-read body can never poison a reused keep-alive socket.
      jsonRpcError(res, 413, -32600, 'Request body too large', { Connection: 'close' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, config.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        jsonRpcError(res, 413, -32600, 'Request body too large', { Connection: 'close' });
      } else {
        jsonRpcError(res, 400, -32700, 'Parse error: request body must be valid JSON');
      }
      return;
    }

    const server = runtime.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(config.allowedHosts
        ? { allowedHosts: config.allowedHosts, enableDnsRebindingProtection: true }
        : {}),
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error('http_request_failed', { error });
      jsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      const url = `http://${host}:${address.port}`;
      logger.info('http_server_started', { host: config.host, port: address.port, mcp_path: MCP_PATH });
      resolve({
        server,
        url,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
