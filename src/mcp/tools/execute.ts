import { z } from 'zod';
import { toErrorPayload, ValidationError, AppError } from '../../apple-search-ads/errors.js';
import type { Logger } from '../../utils/logger.js';
import type { SecretScrubber } from '../../utils/redact.js';
import { toValidationIssues } from '../schemas/common.js';
import type { ToolOutcome } from './types.js';

/** Validates tool arguments against a strict zod schema, throwing a ValidationError on failure. */
export function parseToolArgs<T>(schema: z.ZodType<T>, args: unknown, toolName: string): T {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    throw new ValidationError(`Invalid arguments for ${toolName}`, toValidationIssues(result.error));
  }
  return result.data;
}

/**
 * Runs a tool body and converts the outcome (or any thrown error) into the public, scrubbed payload.
 * Secrets known to the process are removed from both success and error payloads.
 */
export async function runTool(
  toolName: string,
  deps: { scrubber: SecretScrubber; logger: Logger },
  body: () => Promise<Record<string, unknown>>,
): Promise<ToolOutcome> {
  const started = Date.now();
  try {
    const payload = await body();
    deps.logger.info('tool_call', { tool: toolName, ok: true, duration_ms: Date.now() - started });
    return { ok: true, payload: deps.scrubber.scrubValue(payload) };
  } catch (error) {
    const payload = toErrorPayload(error);
    const fields: Record<string, unknown> = {
      tool: toolName,
      ok: false,
      error_type: payload.error.type,
      status: payload.error.status,
      duration_ms: Date.now() - started,
    };
    if (!(error instanceof AppError)) {
      fields.error = error;
      deps.logger.error('tool_call_unexpected_error', fields);
    } else {
      deps.logger.warn('tool_call', fields);
    }
    return { ok: false, payload: deps.scrubber.scrubValue(payload) };
  }
}

/** Builds the JSON schema advertised to MCP clients from a zod object schema. */
export function toToolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return json;
}
