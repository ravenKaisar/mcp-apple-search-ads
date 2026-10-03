import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/apple-search-ads/errors.js';
import { DEFAULT_OAUTH_TOKEN_URL, loadAppConfig } from '../../src/config/env.js';

describe('loadAppConfig (environment variables)', () => {
  it('applies documented defaults', () => {
    const config = loadAppConfig({});
    expect(config.transport).toBe('stdio');
    expect(config.http.host).toBe('0.0.0.0');
    expect(config.http.port).toBe(8080);
    expect(config.accountsConfigPath).toBe('config/accounts.json');
    expect(config.logLevel).toBe('info');
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.enabledApis).toEqual(['campaign-management-v5', 'platform-v1']);
    expect(config.baseUrls['campaign-management-v5']).toBe('https://api.searchads.apple.com/api/v5');
    expect(config.baseUrls['platform-v1']).toBe('https://api.ads.apple.com/v1');
    expect(config.oauthTokenUrl).toBe(DEFAULT_OAUTH_TOKEN_URL);
    expect(config.http.authToken).toBeUndefined();
    expect(config.pagination).toEqual({
      defaultMaxPages: 10,
      maxPagesLimit: 100,
      defaultMaxRecords: 1000,
      maxRecordsLimit: 10_000,
    });
  });

  it('reads PORT, HOST, ACCOUNTS_CONFIG, LOG_LEVEL and REQUEST_TIMEOUT', () => {
    const config = loadAppConfig({
      PORT: '9090',
      HOST: '127.0.0.1',
      ACCOUNTS_CONFIG: '/app/config/accounts.json',
      LOG_LEVEL: 'debug',
      REQUEST_TIMEOUT: '5000',
      MCP_TRANSPORT: 'http',
    });
    expect(config.http.port).toBe(9090);
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.accountsConfigPath).toBe('/app/config/accounts.json');
    expect(config.logLevel).toBe('debug');
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.transport).toBe('http');
  });

  it('lets the CLI transport override MCP_TRANSPORT', () => {
    expect(loadAppConfig({ MCP_TRANSPORT: 'http' }, { transport: 'stdio' }).transport).toBe('stdio');
  });

  it('treats empty variables as unset', () => {
    expect(loadAppConfig({ PORT: '', LOG_LEVEL: '  ' }).http.port).toBe(8080);
  });

  it('accepts ENABLED_APIS aliases and de-duplicates', () => {
    expect(loadAppConfig({ ENABLED_APIS: 'platform' }).enabledApis).toEqual(['platform-v1']);
    expect(loadAppConfig({ ENABLED_APIS: 'v5, campaign-management-v5' }).enabledApis).toEqual([
      'campaign-management-v5',
    ]);
  });

  it.each([
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    [{ REQUEST_TIMEOUT: '-1' }, 'REQUEST_TIMEOUT'],
    [{ ENABLED_APIS: 'v4' }, 'ENABLED_APIS'],
    [{ MCP_TRANSPORT: 'websocket' }, 'MCP_TRANSPORT'],
    [{ MCP_AUTH_TOKEN: 'short' }, 'MCP_AUTH_TOKEN'],
    [{ APPLE_ADS_V5_BASE_URL: 'not a url' }, 'APPLE_ADS_V5_BASE_URL'],
  ])('rejects invalid value %j', (env, name) => {
    try {
      loadAppConfig(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.join('\n')).toContain(name);
    }
  });

  it('requires https for Apple endpoints unless ALLOW_INSECURE_ENDPOINTS=true', () => {
    expect(() => loadAppConfig({ APPLE_OAUTH_TOKEN_URL: 'http://127.0.0.1:9/token' })).toThrow(
      ConfigurationError,
    );
    const config = loadAppConfig({
      APPLE_OAUTH_TOKEN_URL: 'http://127.0.0.1:9/token',
      APPLE_ADS_V5_BASE_URL: 'http://127.0.0.1:9/api/v5/',
      ALLOW_INSECURE_ENDPOINTS: 'true',
    });
    expect(config.oauthTokenUrl).toBe('http://127.0.0.1:9/token');
    expect(config.baseUrls['campaign-management-v5']).toBe('http://127.0.0.1:9/api/v5');
  });

  it('rejects inconsistent pagination and retry limits', () => {
    expect(() => loadAppConfig({ PAGINATION_DEFAULT_MAX_PAGES: '50', PAGINATION_MAX_PAGES: '10' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadAppConfig({ RETRY_BASE_DELAY_MS: '5000', RETRY_MAX_DELAY_MS: '100' })).toThrow(
      ConfigurationError,
    );
  });

  it('parses MCP_ALLOWED_HOSTS and MCP_AUTH_TOKEN', () => {
    const config = loadAppConfig({
      MCP_ALLOWED_HOSTS: 'localhost:8080, mcp.internal ,',
      MCP_AUTH_TOKEN: 'x'.repeat(32),
    });
    expect(config.http.allowedHosts).toEqual(['localhost:8080', 'mcp.internal']);
    expect(config.http.authToken).toBe('x'.repeat(32));
  });

  it('caps the client secret lifetime at 180 days', () => {
    expect(() => loadAppConfig({ CLIENT_SECRET_TTL_SECONDS: String(181 * 24 * 3600) })).toThrow(
      ConfigurationError,
    );
    expect(loadAppConfig({ CLIENT_SECRET_TTL_SECONDS: String(180 * 24 * 3600) }).clientSecretTtlSeconds).toBe(
      180 * 24 * 3600,
    );
  });
});
