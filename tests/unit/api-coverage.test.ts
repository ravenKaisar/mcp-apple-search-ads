/**
 * API coverage test. docs/api-coverage.json is the inventory of Apple's documented endpoints (authored
 * from Apple's official docs, independently of the code). This test fails when:
 *   - a required GET endpoint in the inventory is not implemented (or is implemented differently),
 *   - the code implements an endpoint that is not in the inventory,
 *   - an excluded (non-GET) endpoint is implemented,
 *   - docs/API-COVERAGE.md is stale.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS, endpointDocUrl } from '../../src/apple-search-ads/endpoints/index.js';
import { renderCoverageMarkdown, type Inventory } from '../../scripts/coverage-markdown.js';

const inventory = JSON.parse(
  readFileSync(new URL('../../docs/api-coverage.json', import.meta.url), 'utf8'),
) as Inventory & { summary: Record<string, unknown>; policy: { implementedMethods: string[] } };

const route = (api: string, method: string, path: string) => `${api} ${method} ${path}`;

describe('API coverage inventory', () => {
  it('lists only GET endpoints under "endpoints" and only non-GET under "excluded"', () => {
    expect(inventory.policy.implementedMethods).toEqual(['GET']);
    expect(inventory.endpoints.every((e) => e.method === 'GET')).toBe(true);
    expect(inventory.excluded.every((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method))).toBe(true);
  });

  it('every required GET endpoint is implemented by the registry', () => {
    const implemented = new Map(ENDPOINTS.map((e) => [route(e.api, e.method, e.path), e]));
    const missing = inventory.endpoints
      .filter((e) => e.required)
      .filter((e) => !implemented.has(route(e.api, e.method, e.path)))
      .map((e) => `${e.api} ${e.method} ${e.path}`);
    expect(missing).toEqual([]);
  });

  it('every inventory entry is marked implemented and maps to the right MCP tool, docs and params', () => {
    for (const entry of inventory.endpoints) {
      const endpoint = ENDPOINTS.find(
        (e) => route(e.api, e.method, e.path) === route(entry.api, entry.method, entry.path),
      );
      expect(endpoint, entry.id).toBeDefined();
      expect(entry.implemented, entry.id).toBe(true);
      expect(entry.mcpTool, entry.id).toBe(endpoint!.toolName);
      expect(entry.id).toBe(endpoint!.id);
      expect(entry.docUrl).toBe(endpointDocUrl(endpoint!));
      expect(entry.pathParams.map((p) => p.name).sort(), entry.id).toEqual(
        Object.keys(endpoint!.pathParams).sort(),
      );
      expect(entry.queryParams.map((p) => p.name).sort(), entry.id).toEqual(
        Object.keys(endpoint!.queryParams).sort(),
      );
      const requiredQuery = entry.queryParams
        .filter((p) => p.required)
        .map((p) => p.name)
        .sort();
      const registryRequired = Object.entries(endpoint!.queryParams)
        .filter(([, spec]) => spec.required)
        .map(([name]) => name)
        .sort();
      expect(registryRequired, entry.id).toEqual(requiredQuery);
      expect(entry.contextHeader !== null, entry.id).toBe(endpoint!.requiresContext);
    }
  });

  it('the registry implements nothing outside the inventory', () => {
    const documented = new Set(inventory.endpoints.map((e) => route(e.api, e.method, e.path)));
    const extra = ENDPOINTS.filter((e) => !documented.has(route(e.api, e.method, e.path))).map(
      (e) => e.toolName,
    );
    expect(extra).toEqual([]);
  });

  it('no excluded (non-GET) endpoint is implemented', () => {
    const implemented = new Set(ENDPOINTS.map((e) => route(e.api, e.method, e.path)));
    expect(inventory.excluded.filter((e) => implemented.has(route(e.api, e.method, e.path)))).toEqual([]);
  });

  it('has no duplicate routes and a consistent summary', () => {
    const all = [...inventory.endpoints, ...inventory.excluded].map((e) => route(e.api, e.method, e.path));
    expect(new Set(all).size).toBe(all.length);
    expect(inventory.summary.getEndpoints).toBe(inventory.endpoints.length);
    expect(inventory.summary.excludedEndpoints).toBe(inventory.excluded.length);
  });

  it('docs/API-COVERAGE.md is up to date (run `npm run docs:coverage`)', () => {
    const markdown = readFileSync(new URL('../../docs/API-COVERAGE.md', import.meta.url), 'utf8');
    expect(markdown).toBe(renderCoverageMarkdown(inventory));
    for (const e of ENDPOINTS) expect(markdown).toContain(`\`${e.toolName}\``);
  });
});
