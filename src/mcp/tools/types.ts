import type { z } from 'zod';
import type { AccountManager } from '../../apple-search-ads/accounts.js';
import type { AppleSearchAdsClient } from '../../apple-search-ads/client.js';
import type { ErrorPayload } from '../../apple-search-ads/errors.js';
import type { PaginationLimits } from '../../config/env.js';
import type { Logger } from '../../utils/logger.js';
import type { SecretScrubber } from '../../utils/redact.js';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolOutcome =
  { ok: true; payload: Record<string, unknown> } | { ok: false; payload: ErrorPayload };

export interface ToolContext {
  signal?: AbortSignal;
}

/** Transport-agnostic tool: schema + handler. The MCP server adapts it to the protocol. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  /** JSON Schema advertised to MCP clients (derived from inputSchema). */
  jsonSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Endpoint id when the tool maps to an Apple endpoint. */
  endpointId?: string;
  execute(args: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolDependencies {
  accounts: AccountManager;
  client: AppleSearchAdsClient;
  pagination: PaginationLimits;
  scrubber: SecretScrubber;
  logger: Logger;
}

export const READ_ONLY_ANNOTATIONS: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
