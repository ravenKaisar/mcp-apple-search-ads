import type { AppleErrorDetail } from './errors.js';

/**
 * The two Apple advertising APIs this server reads from.
 *
 * - `campaign-management-v5`: Apple Search Ads Campaign Management API 5 (now "Apple Ads Campaign
 *   Management API"). Deprecated by Apple; sunset on 2027-01-26.
 * - `platform-v1`: Apple Ads Platform API 1.0 (released August 2026), the replacement.
 */
export const API_FAMILY_IDS = ['campaign-management-v5', 'platform-v1'] as const;
export type ApiFamilyId = (typeof API_FAMILY_IDS)[number];

export interface ParsedAppleError {
  code?: string;
  message?: string;
  details: AppleErrorDetail[];
}

export interface ApiFamily {
  readonly id: ApiFamilyId;
  readonly displayName: string;
  readonly version: string;
  readonly defaultBaseUrl: string;
  readonly docsBaseUrl: string;
  readonly toolPrefix: string;
  /** The key used inside `X-AP-Context: <key>=<value>`. */
  readonly contextHeaderKey: 'orgId' | 'adAccountId';
  /** The MCP tool input that overrides the account's default context value. */
  readonly contextInputName: 'org_id' | 'ad_account_id';
  readonly deprecation?: string;
  /** Extracts the list items from a list response body. */
  readItems(body: unknown): unknown[] | undefined;
  /** Extracts the total record count from a list response body, when Apple provides it. */
  readTotal(body: unknown): number | undefined;
  /** Extracts Apple's error details from an error response body. */
  readError(body: unknown): ParsedAppleError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export const CAMPAIGN_MANAGEMENT_V5: ApiFamily = {
  id: 'campaign-management-v5',
  displayName: 'Apple Search Ads Campaign Management API v5',
  version: '5 (changelog through 5.6, June 2026)',
  defaultBaseUrl: 'https://api.searchads.apple.com/api/v5',
  docsBaseUrl: 'https://developer.apple.com/documentation/apple_ads',
  toolPrefix: 'v5_',
  contextHeaderKey: 'orgId',
  contextInputName: 'org_id',
  deprecation:
    'Apple has deprecated the Campaign Management API; it will be sunset on 2027-01-26. Prefer the platform_* tools.',
  // v5 envelope: { data: <object|array>, pagination: { totalResults, startIndex, itemsPerPage } | null, error }
  readItems(body) {
    if (Array.isArray(body)) return body as unknown[];
    if (isRecord(body) && Array.isArray(body.data)) return body.data as unknown[];
    return undefined;
  },
  readTotal(body) {
    if (isRecord(body) && isRecord(body.pagination)) return asCount(body.pagination.totalResults);
    return undefined;
  },
  // v5 errors: { error: { errors: [ { messageCode, message, field } ] } }
  readError(body) {
    const details: AppleErrorDetail[] = [];
    if (isRecord(body) && isRecord(body.error) && Array.isArray(body.error.errors)) {
      for (const item of body.error.errors) {
        if (!isRecord(item)) continue;
        details.push({
          code: asString(item.messageCode),
          message: asString(item.message),
          field: asString(item.field),
        });
      }
    }
    return { code: details[0]?.code, message: details[0]?.message, details };
  },
};

export const PLATFORM_V1: ApiFamily = {
  id: 'platform-v1',
  displayName: 'Apple Ads Platform API v1',
  version: '1.0 (August 2026)',
  defaultBaseUrl: 'https://api.ads.apple.com/v1',
  docsBaseUrl: 'https://developer.apple.com/documentation/apple-ads-platform-api',
  toolPrefix: 'platform_',
  contextHeaderKey: 'adAccountId',
  contextInputName: 'ad_account_id',
  // Platform envelope: { result: <object|array>, pagination?: { offset, pageSize, totalCount }, error? }
  readItems(body) {
    if (isRecord(body) && Array.isArray(body.result)) return body.result as unknown[];
    return undefined;
  },
  readTotal(body) {
    if (isRecord(body) && isRecord(body.pagination)) return asCount(body.pagination.totalCount);
    return undefined;
  },
  // Platform errors: { error: { code, message, details: [ { code, message } ] } }
  readError(body) {
    const details: AppleErrorDetail[] = [];
    if (isRecord(body) && isRecord(body.error)) {
      const err = body.error;
      if (Array.isArray(err.details)) {
        for (const item of err.details) {
          if (!isRecord(item)) continue;
          const info = isRecord(item.info) ? asString(item.info.field) : undefined;
          details.push({ code: asString(item.code), message: asString(item.message), field: info });
        }
      }
      return { code: asString(err.code), message: asString(err.message), details };
    }
    return { details };
  },
};

export const API_FAMILIES: Readonly<Record<ApiFamilyId, ApiFamily>> = {
  'campaign-management-v5': CAMPAIGN_MANAGEMENT_V5,
  'platform-v1': PLATFORM_V1,
};

export function getApiFamily(id: ApiFamilyId): ApiFamily {
  return API_FAMILIES[id];
}
