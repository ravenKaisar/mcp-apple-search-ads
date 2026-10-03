#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AppError } from './apple-search-ads/errors.js';
import { loadAppConfig, TRANSPORTS, type TransportKind } from './config/env.js';
import { createRuntime } from './runtime.js';
import { startHttpServer } from './transport/http.js';
import { startStdioServer } from './transport/stdio.js';
import { JsonLogger } from './utils/logger.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}
Read-only MCP server for the Apple Search Ads / Apple Ads APIs (GET endpoints only).

Usage: ${SERVER_NAME} [--transport stdio|http]

Environment: ACCOUNTS_CONFIG, MCP_TRANSPORT, HOST, PORT, LOG_LEVEL, REQUEST_TIMEOUT, ENABLED_APIS, MCP_AUTH_TOKEN, ...
See docs/CONFIGURATION.md.`;

function writeStderr(line: string): void {
  process.stderr.write(line + '\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
  });
  if (values.help) {
    writeStderr(USAGE);
    return;
  }
  if (values.version) {
    writeStderr(SERVER_VERSION);
    return;
  }
  let transport: TransportKind | undefined;
  if (values.transport !== undefined) {
    if (!(TRANSPORTS as readonly string[]).includes(values.transport)) {
      writeStderr(`Unknown transport "${values.transport}". Use one of: ${TRANSPORTS.join(', ')}`);
      process.exitCode = 2;
      return;
    }
    transport = values.transport as TransportKind;
  }

  const config = loadAppConfig(process.env, { transport });
  const logger = new JsonLogger({ level: config.logLevel });
  const runtime = createRuntime(config, { logger });

  if (config.transport === 'http') {
    const running = await startHttpServer(runtime);
    const shutdown = (signal: string) => {
      logger.info('shutdown', { signal });
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    const running = await startStdioServer(runtime);
    const shutdown = () => {
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}

main().catch((error: unknown) => {
  const logger = new JsonLogger({ level: 'error' });
  if (error instanceof AppError) {
    logger.error('startup_failed', { ...error.toPayload() });
  } else {
    logger.error('startup_failed', { error });
  }
  process.exit(1);
});
