import type { z } from 'zod';
import type { ApiFamilyId } from '../apis.js';
import type { ValidationIssue } from '../errors.js';

/** A single Apple path or query parameter, keyed by Apple's exact parameter name. */
export interface ParamSpec {
  /** Zod schema for the MCP tool input. Its output must be string | number | boolean | string[]. */
  readonly schema: z.ZodType;
  readonly description: string;
  readonly required: boolean;
  /** How array values are put on the query string. Defaults to `csv`. */
  readonly serialize?: 'csv' | 'repeat';
}

/** Offset-based pagination as used by every paginated Apple Ads GET endpoint. */
export interface OffsetPaginationSpec {
  readonly kind: 'offset';
  readonly offsetParam: 'offset';
  /** Apple's page-size query parameter name for this endpoint. */
  readonly limitParam: 'limit' | 'pageSize';
  /** Apple's documented default page size. */
  readonly defaultPageSize: number;
  /** Largest page size the tool accepts (Apple's documented maximum, or a conservative cap). */
  readonly maxPageSize: number;
  /** Page size used for fetch_all when the caller does not provide one. */
  readonly fetchAllPageSize: number;
  /** False when Apple's paging semantics are ambiguous; then only single pages are fetched. */
  readonly supportsFetchAll: boolean;
}

export type PaginationSpec = OffsetPaginationSpec;

export interface EndpointDefinition {
  /** Stable identifier, e.g. `v5.getCampaign`. */
  readonly id: string;
  /** MCP tool name, e.g. `v5_get_campaign`. */
  readonly toolName: string;
  readonly api: ApiFamilyId;
  readonly category: string;
  /** Title of Apple's documentation page. */
  readonly title: string;
  /** One-paragraph description used for the MCP tool. */
  readonly description: string;
  /** Always GET. The literal type makes any other method a compile-time error. */
  readonly method: 'GET';
  /** Path relative to the API base URL, with `{param}` placeholders. */
  readonly path: string;
  readonly pathParams: Readonly<Record<string, ParamSpec>>;
  readonly queryParams: Readonly<Record<string, ParamSpec>>;
  /** Whether Apple requires the `X-AP-Context` header (orgId / adAccountId). */
  readonly requiresContext: boolean;
  readonly pagination?: PaginationSpec;
  /** Apple documentation slug; the full URL is built from the API family's docs base URL. */
  readonly docSlug: string;
  /** Apple's documented response object name. */
  readonly responseType: string;
  readonly notes?: readonly string[];
  /** Optional cross-field validation that a JSON schema cannot express. */
  readonly validate?: (args: Readonly<Record<string, unknown>>) => ValidationIssue[];
}

export type QueryValue = string | number | boolean | readonly string[];
