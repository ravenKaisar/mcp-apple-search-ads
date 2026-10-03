import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from './apple-search-ads/accounts.js';
import { type FetchLike, OAuthTokenClient } from './apple-search-ads/auth.js';
import { AppleSearchAdsClient } from './apple-search-ads/client.js';
import { GetOnlyHttpClient } from './apple-search-ads/http.js';
import { RateLimitTracker } from './apple-search-ads/rate-limit.js';
import type { AppConfig } from './config/env.js';
import { type LoadedAccounts, loadAccountsFile } from './config/loader.js';
import { createMcpServer } from './mcp/server.js';
import { buildTools, type ToolDefinition } from './mcp/tools/index.js';
import { JsonLogger, type Logger } from './utils/logger.js';
import { SecretScrubber } from './utils/redact.js';
import { type Clock, type Sleep, systemClock } from './utils/time.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  accounts: AccountManager;
  client: AppleSearchAdsClient;
  scrubber: SecretScrubber;
  tools: readonly ToolDefinition[];
  /** Creates a new MCP server instance sharing this runtime's accounts, token caches and client. */
  createServer(): McpServer;
}

export interface RuntimeOptions {
  /** Pre-loaded accounts (tests); defaults to loading config.accountsConfigPath. */
  accounts?: LoadedAccounts;
  logger?: Logger;
  /** fetch used for Apple API calls (tests inject mocks). */
  fetch?: FetchLike;
  /** fetch used for the OAuth token endpoint; defaults to `fetch`. */
  tokenFetch?: FetchLike;
  clock?: Clock;
  sleep?: Sleep;
  random?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Wires configuration, accounts, authentication, the GET-only client and MCP tools together. */
export function createRuntime(config: AppConfig, options: RuntimeOptions = {}): Runtime {
  const logger = options.logger ?? new JsonLogger({ level: config.logLevel });
  const clock = options.clock ?? systemClock;
  const scrubber = new SecretScrubber();

  const loaded =
    options.accounts ?? loadAccountsFile(config.accountsConfigPath, { env: options.env, logger });
  for (const secret of loaded.secretMaterial) scrubber.register(secret);

  const tokenClient = new OAuthTokenClient({
    tokenUrl: config.oauthTokenUrl,
    fetch: options.tokenFetch ?? options.fetch,
    clock,
    sleep: options.sleep,
    random: options.random,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs,
    clientSecretTtlSeconds: config.clientSecretTtlSeconds,
    logger: logger.child({ component: 'oauth' }),
    scrubber,
  });

  const accounts = new AccountManager(loaded.accounts, {
    tokenClient,
    clock,
    refreshSkewSeconds: config.tokenRefreshSkewSeconds,
    scrubber,
  });

  const http = new GetOnlyHttpClient({
    allowedBaseUrls: config.enabledApis.map((api) => config.baseUrls[api]),
    timeoutMs: config.requestTimeoutMs,
    fetch: options.fetch,
    logger: logger.child({ component: 'http' }),
    clock,
  });

  const client = new AppleSearchAdsClient({
    http,
    auth: accounts,
    baseUrls: config.baseUrls,
    retry: {
      maxRetries: config.maxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      maxRetryAfterMs: config.maxRetryAfterMs,
    },
    rateLimits: new RateLimitTracker(),
    logger: logger.child({ component: 'apple-api' }),
    clock,
    sleep: options.sleep,
    random: options.random,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
  });

  const tools = buildTools(
    { accounts, client, pagination: config.pagination, scrubber, logger: logger.child({ component: 'mcp' }) },
    config.enabledApis,
  );

  logger.info('runtime_ready', {
    accounts: accounts.size,
    tools: tools.length,
    enabled_apis: config.enabledApis,
  });

  return {
    config,
    logger,
    accounts,
    client,
    scrubber,
    tools,
    createServer: () => createMcpServer({ tools, accounts, enabledApis: config.enabledApis }),
  };
}
