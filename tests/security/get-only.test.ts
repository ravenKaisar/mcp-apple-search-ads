/**
 * Security boundary: the server can only ever send GET requests to the Apple Ads APIs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ENDPOINTS } from '../../src/apple-search-ads/endpoints/index.js';
import { UnsupportedOperationError } from '../../src/apple-search-ads/errors.js';
import { GetOnlyHttpClient } from '../../src/apple-search-ads/http.js';
import { sampleApiArgs, successFixture } from '../helpers/fixtures.js';
import { jsonResponse, TEST_BASE_URLS, TEST_TOKEN_URL } from '../helpers/fake-apple.js';
import { callTool, makeTestRuntime } from '../helpers/runtime.js';

const SRC = new URL('../../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('GET-only security boundary', () => {
  const http = () => {
    const fetchSpy = vi.fn();
    const client = new GetOnlyHttpClient({
      allowedBaseUrls: Object.values(TEST_BASE_URLS),
      timeoutMs: 1000,
      fetch: fetchSpy,
    });
    return { client, fetchSpy };
  };

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s requests cannot be executed', async (method) => {
    const { client, fetchSpy } = http();
    await expect(
      client.request({
        method: method as 'GET',
        url: new URL(`${TEST_BASE_URLS['campaign-management-v5']}/campaigns`),
        headers: {},
      }),
    ).rejects.toThrow(UnsupportedOperationError);
    await expect(
      client.request({
        method: method as 'GET',
        url: new URL(`${TEST_BASE_URLS['campaign-management-v5']}/campaigns`),
        headers: {},
      }),
    ).rejects.toThrow('Only GET requests are supported');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('every registered endpoint is GET', () => {
    expect(ENDPOINTS.map((e) => e.method)).toEqual(ENDPOINTS.map(() => 'GET'));
  });

  it('calling every tool only ever sends GET to the Apple Ads APIs (POST only to the OAuth token endpoint)', async () => {
    const { runtime, fake } = makeTestRuntime();
    fake.apiHandler = (req) => {
      const tool = ENDPOINTS.find((e) => req.url.href.startsWith(TEST_BASE_URLS[e.api]));
      return jsonResponse(200, tool ? successFixture(ENDPOINTS[0]!.toolName) : {});
    };
    for (const endpoint of ENDPOINTS) {
      const outcome = await callTool(runtime, endpoint.toolName, {
        account_id: 'account-a',
        ...sampleApiArgs(endpoint),
      });
      expect(outcome.ok, endpoint.toolName).toBe(true);
    }
    expect(fake.apiRequests).toHaveLength(ENDPOINTS.length);
    expect(new Set(fake.apiRequests.map((r) => r.method))).toEqual(new Set(['GET']));
    expect(fake.apiRequests.every((r) => r.body === undefined)).toBe(true);
    expect(fake.tokenRequests.every((r) => r.method === 'POST' && r.url.href === TEST_TOKEN_URL)).toBe(true);
  });

  it('no MCP tool lets a caller choose the HTTP method, URL, headers or body', () => {
    const { runtime } = makeTestRuntime();
    const forbidden = [
      'method',
      'url',
      'uri',
      'body',
      'headers',
      'header',
      'path',
      'endpoint',
      'http_method',
      'data',
      'payload',
    ];
    for (const tool of runtime.tools) {
      const properties = Object.keys(
        (tool.jsonSchema.properties as Record<string, unknown> | undefined) ?? {},
      );
      for (const name of forbidden) expect(properties, tool.name).not.toContain(name);
      expect(tool.name).not.toMatch(
        /(^|_)(request|raw|http|fetch|post|put|patch|delete|create|update|remove|apply|dismiss|upload)(_|$)/,
      );
    }
  });

  it('source code only issues a non-GET request in the OAuth token client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      for (const [index, line] of text.split('\n').entries()) {
        if (
          /method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i.test(line) &&
          rel !== join('apple-search-ads', 'auth.ts')
        ) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    const auth = readFileSync(join(SRC, 'apple-search-ads', 'auth.ts'), 'utf8');
    expect(auth.match(/method:\s*'POST'/g)).toHaveLength(1);
    // The token POST goes only to the configured OAuth token URL.
    expect(auth).toContain('this.#options.fetch(tokenUrl, {');
  });

  it('there is no generic request tool or arbitrary URL path', () => {
    const { runtime } = makeTestRuntime();
    expect(runtime.tools.find((t) => t.name === 'request')).toBeUndefined();
    expect(runtime.tools).toHaveLength(ENDPOINTS.length + 1);
  });
});
