import { z } from 'zod';
import { ACCOUNT_ID_PATTERN } from '../../config/loader.js';
import type { ValidationIssue } from '../../apple-search-ads/errors.js';

export const accountIdSchema = z
  .string()
  .regex(ACCOUNT_ID_PATTERN, 'must be a configured account id (see list_accounts)')
  .describe('Id of the configured Apple Search Ads account to use (see list_accounts).');

export const orgIdSchema = z
  .union([
    z.string().regex(/^\d{1,19}$/, 'must be a numeric orgId'),
    z.number().int().nonnegative().refine(Number.isSafeInteger, 'pass large ids as strings'),
  ])
  .transform(String)
  .describe(
    'Campaign Management API v5 organization id sent as "X-AP-Context: orgId=<org_id>". Defaults to the account\'s configured orgId. Discover ids with v5_get_user_acl.',
  );

export const adAccountIdSchema = z
  .union([
    z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be an ad account id'),
    z.number().int().nonnegative().refine(Number.isSafeInteger, 'pass large ids as strings'),
  ])
  .transform(String)
  .describe(
    'Apple Ads Platform API ad account id sent as "X-AP-Context: adAccountId=<ad_account_id>". Defaults to the account\'s configured adAccountId. Discover ids with platform_get_user_acls.',
  );

export function paginationControlShape(limits: {
  maxPagesLimit: number;
  maxRecordsLimit: number;
  defaultMaxPages: number;
  defaultMaxRecords: number;
}) {
  return {
    fetch_all: z
      .boolean()
      .optional()
      .describe(
        'When true, follow pagination and return every record (bounded by max_pages / max_records). When false or omitted, return a single page.',
      ),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(limits.maxPagesLimit)
      .optional()
      .describe(
        `fetch_all only: maximum pages to request (default ${limits.defaultMaxPages}, max ${limits.maxPagesLimit}).`,
      ),
    max_records: z
      .number()
      .int()
      .min(1)
      .max(limits.maxRecordsLimit)
      .optional()
      .describe(
        `fetch_all only: maximum records to return (default ${limits.defaultMaxRecords}, max ${limits.maxRecordsLimit}).`,
      ),
  };
}

/** Converts zod issues into the public validation issue format. */
export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '(root)';
    if (issue.code === 'unrecognized_keys') {
      return { path, message: `unknown parameter(s): ${issue.keys.join(', ')}` };
    }
    return { path, message: issue.message };
  });
}
