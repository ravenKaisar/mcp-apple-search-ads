import { z } from 'zod';
import type { OffsetPaginationSpec, ParamSpec } from './types.js';

/**
 * Reusable parameter schemas. Every ID that ends up in a URL path is validated against a strict
 * pattern (no '/', '.', '%', whitespace or control characters), which makes path traversal and
 * request smuggling through tool arguments impossible. Path values are additionally percent-encoded.
 */

const SAFE_INTEGER_MESSAGE = 'numeric IDs above 2^53 must be passed as strings';

/** int64 identifiers (campaignId, adamId, keywordId, ...). Accepts a numeric string or a safe integer. */
export function int64Id(description: string): ParamSpec {
  return {
    required: true,
    description: `${description} (int64; pass as a string to avoid precision loss)`,
    schema: z
      .union([
        z.string().regex(/^\d{1,19}$/, 'must be a numeric ID'),
        z.number().int().nonnegative().refine(Number.isSafeInteger, SAFE_INTEGER_MESSAGE),
      ])
      .transform(String),
  };
}

/** Opaque string identifiers documented by Apple as `string` (Platform API ids). */
export function opaqueId(description: string): ParamSpec {
  return {
    required: true,
    description,
    schema: z
      .union([
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'must contain only letters, digits, "-" or "_"'),
        z.number().int().nonnegative().refine(Number.isSafeInteger, SAFE_INTEGER_MESSAGE),
      ])
      .transform(String),
  };
}

/** UUID identifiers (asset ids). */
export function uuidId(description: string): ParamSpec {
  return {
    required: true,
    description: `${description} (UUID)`,
    schema: z
      .string()
      .regex(
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
        'must be a UUID',
      ),
  };
}

/** App Store Connect product page ids (UUID-like strings). */
export function productPageId(description: string): ParamSpec {
  return {
    required: true,
    description,
    schema: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'must be a product page id (UUID-like string)'),
  };
}

export function limitParam(options: {
  name?: 'limit' | 'pageSize';
  max: number;
  defaultValue: number;
  description?: string;
}): ParamSpec {
  return {
    required: false,
    description:
      options.description ??
      `Maximum number of results per page (Apple default ${options.defaultValue}, maximum ${options.max}).`,
    schema: z.number().int().min(1).max(options.max),
  };
}

export function offsetParam(
  description = 'Zero-based offset of the first result to return (default 0).',
): ParamSpec {
  return { required: false, description, schema: z.number().int().min(0).max(100_000_000) };
}

export function booleanParam(description: string): ParamSpec {
  return { required: false, description, schema: z.boolean() };
}

export function enumParam<const T extends readonly [string, ...string[]]>(
  values: T,
  description: string,
  required = false,
): ParamSpec {
  return { required, description, schema: z.enum(values) };
}

export function enumListParam<const T extends readonly [string, ...string[]]>(
  values: T,
  description: string,
): ParamSpec {
  return {
    required: false,
    description,
    serialize: 'csv',
    schema: z.array(z.enum(values)).min(1).max(values.length),
  };
}

/** Free-text search strings. Control characters are rejected. */
export function textParam(
  description: string,
  options: { required?: boolean; maxLength?: number } = {},
): ParamSpec {
  return {
    required: options.required ?? false,
    description,
    schema: z
      .string()
      .min(1)
      .max(options.maxLength ?? 256)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/, 'must not contain control characters'),
  };
}

export function countryCodeParam(description: string, required = false): ParamSpec {
  return {
    required,
    description: `${description} (ISO 3166-1 alpha-2, e.g. "US")`,
    schema: z.string().regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code'),
  };
}

export function countryCodeListParam(description: string, serialize: 'csv' | 'repeat'): ParamSpec {
  return {
    required: false,
    description: `${description} (ISO 3166-1 alpha-2 codes, e.g. ["US", "GB"])`,
    serialize,
    schema: z
      .array(z.string().regex(/^[A-Z]{2}$/, 'must be an upper-case ISO 3166-1 alpha-2 code'))
      .min(1)
      .max(250),
  };
}

export function stringListParam(
  description: string,
  itemPattern: RegExp,
  patternMessage: string,
  maxItems = 100,
): ParamSpec {
  return {
    required: false,
    description,
    serialize: 'csv',
    schema: z.array(z.string().regex(itemPattern, patternMessage)).min(1).max(maxItems),
  };
}

/** A single Apple field name such as `creationTime`. */
export function fieldNameParam(description: string): ParamSpec {
  return {
    required: false,
    description,
    schema: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/, 'must be a field name'),
  };
}

/** v5 partial fetch: `?fields=id,name,...` ("Use a Partial Fetch" in Apple's docs). */
export function v5FieldsParam(): ParamSpec {
  return stringListParam(
    'Partial fetch: only return these top-level fields (e.g. ["id", "name", "status"]).',
    /^[A-Za-z][A-Za-z0-9]{0,63}$/,
    'must be a field name',
    100,
  );
}

/** Standard v5 list pagination: `limit` (default 20, max 1000) and `offset`. */
export const V5_LIST_PAGINATION: OffsetPaginationSpec = {
  kind: 'offset',
  offsetParam: 'offset',
  limitParam: 'limit',
  defaultPageSize: 20,
  maxPageSize: 1000,
  fetchAllPageSize: 1000,
  supportsFetchAll: true,
};

export function v5ListQueryParams(): Record<string, ParamSpec> {
  return {
    limit: limitParam({ max: 1000, defaultValue: 20 }),
    offset: offsetParam(),
  };
}
