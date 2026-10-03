import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Runtime } from '../runtime.js';

/**
 * Runs the MCP server over stdio. stdout carries only MCP JSON-RPC messages; every log line goes to
 * stderr (the logger writes to stderr, and console.log/info/debug are redirected there as a guard).
 */
export async function startStdioServer(runtime: Runtime): Promise<{ close(): Promise<void> }> {
  /* eslint-disable no-console */
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  /* eslint-enable no-console */

  const server = runtime.createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  runtime.logger.info('stdio_server_started');

  const close = async () => {
    await server.close();
  };
  process.stdin.on('end', () => {
    void close().finally(() => process.exit(0));
  });
  return { close };
}
