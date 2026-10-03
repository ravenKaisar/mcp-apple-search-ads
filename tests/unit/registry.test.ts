import { describe, expect, it } from 'vitest';
import { API_FAMILIES } from '../../src/apple-search-ads/apis.js';
import {
  ENDPOINTS,
  endpointDocUrl,
  endpointsForApis,
  getEndpointById,
  getEndpointByTool,
  pathPlaceholders,
  validateRegistry,
  type EndpointDefinition,
} from '../../src/apple-search-ads/endpoints/index.js';
import { allFixtureNames } from '../helpers/fixtures.js';

const sample: EndpointDefinition = getEndpointByTool('v5_get_campaign')!;

describe('endpoint registry', () => {
  it('contains 54 GET endpoints (30 Campaign Management v5 + 24 Platform v1)', () => {
    expect(ENDPOINTS).toHaveLength(54);
    expect(endpointsForApis(['campaign-management-v5'])).toHaveLength(30);
    expect(endpointsForApis(['platform-v1'])).toHaveLength(24);
  });

  it('only contains GET endpoints', () => {
    expect(ENDPOINTS.every((e) => e.method === 'GET')).toBe(true);
  });

  it('has unique ids, tool names and prefixed names', () => {
    expect(new Set(ENDPOINTS.map((e) => e.id)).size).toBe(ENDPOINTS.length);
    expect(new Set(ENDPOINTS.map((e) => e.toolName)).size).toBe(ENDPOINTS.length);
    for (const e of ENDPOINTS) expect(e.toolName.startsWith(API_FAMILIES[e.api].toolPrefix)).toBe(true);
  });

  it('declares exactly the path params that appear in each path', () => {
    for (const e of ENDPOINTS) {
      expect(pathPlaceholders(e.path).sort()).toEqual(Object.keys(e.pathParams).sort());
    }
  });

  it('has a realistic fixture for every endpoint (and no orphan fixtures)', () => {
    expect(allFixtureNames().sort()).toEqual(ENDPOINTS.map((e) => e.toolName).sort());
  });

  it('builds documentation URLs on developer.apple.com', () => {
    for (const e of ENDPOINTS)
      expect(endpointDocUrl(e)).toMatch(/^https:\/\/developer\.apple\.com\/documentation\//);
  });

  it('supports lookups', () => {
    expect(getEndpointById('platform.getCampaign')?.toolName).toBe('platform_get_campaign');
    expect(getEndpointByTool('nope')).toBeUndefined();
  });

  it('pagination specs are consistent', () => {
    for (const e of ENDPOINTS.filter((x) => x.pagination)) {
      const p = e.pagination!;
      expect(e.queryParams).toHaveProperty(p.limitParam);
      expect(e.queryParams).toHaveProperty(p.offsetParam);
      expect(p.fetchAllPageSize).toBeLessThanOrEqual(p.maxPageSize);
      expect(p.defaultPageSize).toBeLessThanOrEqual(p.maxPageSize);
    }
  });

  describe('validateRegistry rejects bad definitions', () => {
    it.each([
      ['non-GET method', { ...sample, id: 'x', toolName: 'v5_x', method: 'POST' as 'GET' }],
      ['mismatched path params', { ...sample, id: 'x', toolName: 'v5_x', path: '/campaigns/{other}' }],
      ['wrong prefix', { ...sample, id: 'x', toolName: 'platform_x' }],
      ['invalid tool name', { ...sample, id: 'x', toolName: 'v5_Bad-Name' }],
      [
        'path traversal in template',
        { ...sample, id: 'x', toolName: 'v5_x', path: '/campaigns/../{campaignId}' },
      ],
      [
        'query string in template',
        { ...sample, id: 'x', toolName: 'v5_x', path: '/campaigns/{campaignId}?a=b' },
      ],
      [
        'query/path overlap',
        { ...sample, id: 'x', toolName: 'v5_x', queryParams: { campaignId: sample.pathParams.campaignId! } },
      ],
    ])('%s', (_label, bad) => {
      expect(() => validateRegistry([bad as EndpointDefinition])).toThrow();
    });

    it('duplicates', () => {
      expect(() => validateRegistry([sample, sample])).toThrow(/duplicate/);
      expect(() => validateRegistry([sample, { ...sample, id: 'other' }])).toThrow(/duplicate tool name/);
      expect(() => validateRegistry([sample, { ...sample, id: 'other', toolName: 'v5_other' }])).toThrow(
        /duplicate route/,
      );
    });

    it('pagination params must be declared', () => {
      const list = getEndpointByTool('v5_get_all_campaigns')!;
      expect(() => validateRegistry([{ ...list, queryParams: {} }])).toThrow(/pagination/);
    });
  });
});
