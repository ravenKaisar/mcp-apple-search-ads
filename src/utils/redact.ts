/**
 * Redaction helpers. Every log line and every MCP response passes through these so that
 * private keys, client secrets, access tokens and authorization headers never leave the process.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose values are always masked in logs (matched case-insensitively, ignoring separators). */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /privatekey/,
  /accesstoken/,
  /refreshtoken/,
  /idtoken/,
  /clientsecret/,
  /authorization/,
  /^auth$/,
  /password/,
  /passphrase/,
  /^secret$/,
  /apikey/,
  /^token$/,
  /bearer/,
  /cookie/,
  /jwt/,
  /signingkey/,
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;
// Three- or five-segment base64url strings starting with a JSON header ("eyJ") - JWS / JWE tokens.
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*){2,4}/g;
const CLIENT_SECRET_PARAM = /(client_secret=)[^&\s"']+/gi;
const ACCESS_TOKEN_PARAM = /(access_token=)[^&\s"']+/gi;

/** Masks secret-looking substrings (PEM blocks, bearer tokens, JWTs, secret query params). */
export function redactString(value: string): string {
  return value
    .replace(PEM_BLOCK, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(JWT_LIKE, REDACTED)
    .replace(CLIENT_SECRET_PARAM, `$1${REDACTED}`)
    .replace(ACCESS_TOKEN_PARAM, `$1${REDACTED}`);
}

/**
 * Deep-redacts a value for logging: sensitive keys are masked and string values are scanned for
 * secret-looking content. Handles cycles and Error objects.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') {
      out.code = code;
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(inner, seen);
  }
  return out;
}

/**
 * Tracks the exact secret values this process knows about (private keys, client secrets, access
 * tokens) and removes them from any outbound text. This is a defence-in-depth layer applied to every
 * MCP response: even if an upstream response echoed a credential back, it would never reach a client.
 */
export class SecretScrubber {
  readonly #secrets = new Set<string>();

  register(secret: string | undefined | null): void {
    if (typeof secret !== 'string') return;
    const trimmed = secret.trim();
    // Very short values could collide with legitimate data; real secrets are long.
    if (trimmed.length < 12) return;
    this.#secrets.add(trimmed);
    // Also register the bare base64 body of PEM blocks so re-wrapped keys are still caught.
    if (trimmed.includes('-----BEGIN')) {
      const body = trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('-----'))
        .join('');
      if (body.length >= 12) this.#secrets.add(body);
      for (const line of trimmed.split('\n')) {
        const l = line.trim();
        if (l.length >= 32 && !l.startsWith('-----')) this.#secrets.add(l);
      }
    }
  }

  unregister(secret: string): void {
    this.#secrets.delete(secret.trim());
  }

  get size(): number {
    return this.#secrets.size;
  }

  /** Removes every registered secret and any secret-looking pattern from the text. */
  scrub(text: string): string {
    let out = text;
    for (const secret of this.#secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
      // JSON-escaped form (e.g. PEM newlines rendered as \n inside JSON strings).
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret && out.includes(escaped)) {
        out = out.split(escaped).join(REDACTED);
      }
    }
    return redactString(out);
  }

  /**
   * Scrubs every string (values and keys) inside a JSON-like value, returning a structurally
   * identical copy. Objects are rebuilt, so the input is never mutated.
   */
  scrubValue<T>(value: T): T {
    return this.#scrubDeep(value, new WeakSet()) as T;
  }

  #scrubDeep(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.scrub(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.#scrubDeep(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[this.scrub(key)] = this.#scrubDeep(inner, seen);
    }
    return out;
  }
}
