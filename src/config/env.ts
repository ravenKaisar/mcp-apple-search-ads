import { z } from 'zod';
import { API_FAMILIES, API_FAMILY_IDS, type ApiFamilyId } from '../apple-search-ads/apis.js';
import { ConfigurationError } from '../apple-search-ads/errors.js';
import { LOG_LEVELS, type LogLevel } from '../utils/logger.js';

export const TRANSPORTS = ['stdio', 'http'] as const;
export type TransportKind = (typeof TRANSPORTS)[number];

export const DEFAULT_OAUTH_TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';
/** Apple caps client-secret JWT lifetime at 180 days. */
export const MAX_CLIENT_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface PaginationLimits {
  defaultMaxPages: number;
  maxPagesLimit: number;
  defaultMaxRecords: number;
  maxRecordsLimit: number;
}

export interface HttpTransportConfig {
  host: string;
  port: number;
  /** Optional bearer token required on /mcp requests. */
  authToken: string | undefined;
  /** Optional Host header allow-list (DNS-rebinding protection). */
  allowedHosts: string[] | undefined;
  maxBodyBytes: number;
}

export interface AppConfig {
  transport: TransportKind;
  accountsConfigPath: string;
  logLevel: LogLevel;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxRetryAfterMs: number;
  enabledApis: ApiFamilyId[];
  baseUrls: Record<ApiFamilyId, string>;
  oauthTokenUrl: string;
  allowInsecureEndpoints: boolean;
  clientSecretTtlSeconds: number;
  tokenRefreshSkewSeconds: number;
  pagination: PaginationLimits;
  http: HttpTransportConfig;
}

const intFromEnv = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const boolFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const API_ALIASES: Record<string, ApiFamilyId> = {
  'campaign-management-v5': 'campaign-management-v5',
  v5: 'campaign-management-v5',
  'platform-v1': 'platform-v1',
  platform: 'platform-v1',
};

const enabledApisFromEnv = z.string().transform((raw, ctx) => {
  const values = raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  const out = new Set<ApiFamilyId>();
  for (const value of values) {
    const id = API_ALIASES[value];
    if (!id) {
      ctx.addIssue({
        code: 'custom',
        message: `unknown API "${value}" (allowed: ${API_FAMILY_IDS.join(', ')})`,
      });
      return z.NEVER;
    }
    out.add(id);
  }
  if (out.size === 0) {
    ctx.addIssue({ code: 'custom', message: 'at least one API must be enabled' });
    return z.NEVER;
  }
  return [...out];
});

const EnvSchema = z.object({
  MCP_TRANSPORT: z.enum(TRANSPORTS).optional(),
  HOST: z.string().trim().min(1).optional(),
  PORT: intFromEnv(0, 65535).optional(),
  ACCOUNTS_CONFIG: z.string().trim().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  REQUEST_TIMEOUT: intFromEnv(100, 600_000).optional(),
  MAX_RETRIES: intFromEnv(0, 10).optional(),
  RETRY_BASE_DELAY_MS: intFromEnv(0, 60_000).optional(),
  RETRY_MAX_DELAY_MS: intFromEnv(0, 300_000).optional(),
  MAX_RETRY_AFTER_SECONDS: intFromEnv(0, 3600).optional(),
  ENABLED_APIS: enabledApisFromEnv.optional(),
  APPLE_ADS_V5_BASE_URL: z.url().optional(),
  APPLE_ADS_PLATFORM_BASE_URL: z.url().optional(),
  APPLE_OAUTH_TOKEN_URL: z.url().optional(),
  ALLOW_INSECURE_ENDPOINTS: boolFromEnv.optional(),
  CLIENT_SECRET_TTL_SECONDS: intFromEnv(60, MAX_CLIENT_SECRET_TTL_SECONDS).optional(),
  TOKEN_REFRESH_SKEW_SECONDS: intFromEnv(0, 1800).optional(),
  PAGINATION_DEFAULT_MAX_PAGES: intFromEnv(1, 1000).optional(),
  PAGINATION_MAX_PAGES: intFromEnv(1, 1000).optional(),
  PAGINATION_DEFAULT_MAX_RECORDS: intFromEnv(1, 1_000_000).optional(),
  PAGINATION_MAX_RECORDS: intFromEnv(1, 1_000_000).optional(),
  MCP_AUTH_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  HTTP_MAX_BODY_BYTES: intFromEnv(1024, 10 * 1024 * 1024).optional(),
});

function emptyToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  return out;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Builds the runtime configuration from environment variables. Secrets are never read from here
 * except MCP_AUTH_TOKEN (the optional HTTP bearer token); Apple credentials come from the accounts file.
 */
export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { transport?: TransportKind } = {},
): AppConfig {
  const parsed = EnvSchema.safeParse(emptyToUndefined(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigurationError('Invalid environment configuration', issues);
  }
  const e = parsed.data;
  const allowInsecure = e.ALLOW_INSECURE_ENDPOINTS ?? false;

  const baseUrls: Record<ApiFamilyId, string> = {
    'campaign-management-v5': normalizeBaseUrl(
      e.APPLE_ADS_V5_BASE_URL ?? API_FAMILIES['campaign-management-v5'].defaultBaseUrl,
    ),
    'platform-v1': normalizeBaseUrl(
      e.APPLE_ADS_PLATFORM_BASE_URL ?? API_FAMILIES['platform-v1'].defaultBaseUrl,
    ),
  };
  const oauthTokenUrl = e.APPLE_OAUTH_TOKEN_URL ?? DEFAULT_OAUTH_TOKEN_URL;

  const issues: string[] = [];
  for (const [name, url] of [
    ['APPLE_ADS_V5_BASE_URL', baseUrls['campaign-management-v5']],
    ['APPLE_ADS_PLATFORM_BASE_URL', baseUrls['platform-v1']],
    ['APPLE_OAUTH_TOKEN_URL', oauthTokenUrl],
  ] as const) {
    const protocol = new URL(url).protocol;
    if (protocol !== 'https:' && !(allowInsecure && protocol === 'http:')) {
      issues.push(`${name}: must use https (set ALLOW_INSECURE_ENDPOINTS=true only for local testing)`);
    }
  }

  const maxPagesLimit = e.PAGINATION_MAX_PAGES ?? 100;
  const maxRecordsLimit = e.PAGINATION_MAX_RECORDS ?? 10_000;
  const defaultMaxPages = e.PAGINATION_DEFAULT_MAX_PAGES ?? 10;
  const defaultMaxRecords = e.PAGINATION_DEFAULT_MAX_RECORDS ?? 1_000;
  if (defaultMaxPages > maxPagesLimit) {
    issues.push('PAGINATION_DEFAULT_MAX_PAGES: must not exceed PAGINATION_MAX_PAGES');
  }
  if (defaultMaxRecords > maxRecordsLimit) {
    issues.push('PAGINATION_DEFAULT_MAX_RECORDS: must not exceed PAGINATION_MAX_RECORDS');
  }
  const retryBase = e.RETRY_BASE_DELAY_MS ?? 1_000;
  const retryMax = e.RETRY_MAX_DELAY_MS ?? 16_000;
  if (retryBase > retryMax) issues.push('RETRY_BASE_DELAY_MS: must not exceed RETRY_MAX_DELAY_MS');

  if (issues.length > 0) {
    throw new ConfigurationError('Invalid environment configuration', issues);
  }

  const allowedHosts = e.MCP_ALLOWED_HOSTS?.split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  return {
    transport: overrides.transport ?? e.MCP_TRANSPORT ?? 'stdio',
    accountsConfigPath: e.ACCOUNTS_CONFIG ?? 'config/accounts.json',
    logLevel: e.LOG_LEVEL ?? 'info',
    requestTimeoutMs: e.REQUEST_TIMEOUT ?? 30_000,
    maxRetries: e.MAX_RETRIES ?? 3,
    retryBaseDelayMs: retryBase,
    retryMaxDelayMs: retryMax,
    maxRetryAfterMs: (e.MAX_RETRY_AFTER_SECONDS ?? 60) * 1000,
    enabledApis: e.ENABLED_APIS ?? [...API_FAMILY_IDS],
    baseUrls,
    oauthTokenUrl,
    allowInsecureEndpoints: allowInsecure,
    clientSecretTtlSeconds: e.CLIENT_SECRET_TTL_SECONDS ?? 3600,
    tokenRefreshSkewSeconds: e.TOKEN_REFRESH_SKEW_SECONDS ?? 60,
    pagination: { defaultMaxPages, maxPagesLimit, defaultMaxRecords, maxRecordsLimit },
    http: {
      host: e.HOST ?? '0.0.0.0',
      port: e.PORT ?? 8080,
      authToken: e.MCP_AUTH_TOKEN,
      allowedHosts: allowedHosts && allowedHosts.length > 0 ? allowedHosts : undefined,
      maxBodyBytes: e.HTTP_MAX_BODY_BYTES ?? 1024 * 1024,
    },
  };
}
