import { redactString } from '../utils/redact.js';

export type ErrorType =
  | 'CONFIGURATION_ERROR'
  | 'ACCOUNT_NOT_FOUND'
  | 'AUTHENTICATION_ERROR'
  | 'APPLE_SEARCH_ADS_API_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'NETWORK_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'INTERNAL_ERROR';

/** One normalized error item returned by Apple (v5 `messageCode`/`field` or Platform `code`/`details`). */
export interface AppleErrorDetail {
  code?: string;
  message?: string;
  field?: string;
}

/** Shape of every error returned to MCP clients. */
export interface ErrorPayload {
  error: {
    type: ErrorType;
    message: string;
    status?: number;
    request_id?: string;
    retry_after_seconds?: number;
    code?: string;
    details?: unknown;
  };
}

export abstract class AppError extends Error {
  abstract readonly type: ErrorType;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }

  toPayload(): ErrorPayload {
    return { error: { type: this.type, message: redactString(this.message) } };
  }
}

export class ConfigurationError extends AppError {
  readonly type = 'CONFIGURATION_ERROR' as const;
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.issues = issues;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    if (this.issues.length > 0) payload.error.details = this.issues.map(redactString);
    return payload;
  }
}

export class AccountNotFoundError extends AppError {
  readonly type = 'ACCOUNT_NOT_FOUND' as const;

  constructor(accountId: string) {
    super(
      `Unknown account_id "${sanitizeForMessage(accountId)}". Call list_accounts to see configured accounts.`,
    );
  }
}

export class AuthenticationError extends AppError {
  readonly type = 'AUTHENTICATION_ERROR' as const;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.code = options.code;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    if (this.status !== undefined) payload.error.status = this.status;
    if (this.code !== undefined) payload.error.code = this.code;
    return payload;
  }
}

export class AppleSearchAdsApiError extends AppError {
  readonly type: ErrorType = 'APPLE_SEARCH_ADS_API_ERROR';
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: readonly AppleErrorDetail[];
  readonly code: string | undefined;

  constructor(
    message: string,
    options: {
      status: number;
      requestId?: string;
      details?: readonly AppleErrorDetail[];
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details ?? [];
    this.code = options.code;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    payload.error.status = this.status;
    if (this.requestId) payload.error.request_id = this.requestId;
    if (this.code) payload.error.code = redactString(this.code);
    if (this.details.length > 0) {
      payload.error.details = this.details.map((d) => ({
        ...(d.code !== undefined ? { code: redactString(d.code) } : {}),
        ...(d.message !== undefined ? { message: redactString(d.message) } : {}),
        ...(d.field !== undefined ? { field: redactString(d.field) } : {}),
      }));
    }
    return payload;
  }
}

export class RateLimitError extends AppleSearchAdsApiError {
  override readonly type: ErrorType = 'RATE_LIMIT_ERROR';
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: { requestId?: string; retryAfterSeconds?: number; details?: readonly AppleErrorDetail[] },
  ) {
    super(message, { status: 429, requestId: options.requestId, details: options.details });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    if (this.retryAfterSeconds !== undefined) payload.error.retry_after_seconds = this.retryAfterSeconds;
    return payload;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends AppError {
  readonly type = 'VALIDATION_ERROR' as const;
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    if (this.issues.length > 0) {
      payload.error.details = this.issues.map((i) => ({
        path: redactString(i.path),
        message: redactString(i.message),
      }));
    }
    return payload;
  }
}

export class UnsupportedOperationError extends AppError {
  readonly type = 'UNSUPPORTED_OPERATION' as const;
}

export type NetworkErrorKind =
  'timeout' | 'connection_reset' | 'dns' | 'connection_refused' | 'aborted' | 'other';

export class NetworkError extends AppError {
  readonly type = 'NETWORK_ERROR' as const;
  readonly kind: NetworkErrorKind;

  constructor(message: string, kind: NetworkErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    payload.error.code = this.kind.toUpperCase();
    return payload;
  }
}

export class MalformedResponseError extends AppError {
  readonly type = 'MALFORMED_RESPONSE' as const;
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: { status?: number; requestId?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.requestId = options.requestId;
  }

  override toPayload(): ErrorPayload {
    const payload = super.toPayload();
    if (this.status !== undefined) payload.error.status = this.status;
    if (this.requestId) payload.error.request_id = this.requestId;
    return payload;
  }
}

export class InternalError extends AppError {
  readonly type = 'INTERNAL_ERROR' as const;
}

/** Converts anything thrown into the public error payload, never leaking stack traces or secrets. */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) {
    return error.toPayload();
  }
  return {
    error: {
      type: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    },
  };
}

/** Strips control characters and truncates user-supplied strings before echoing them back. */
export function sanitizeForMessage(value: string, maxLength = 64): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '?');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}
