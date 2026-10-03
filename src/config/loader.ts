import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { API_FAMILY_IDS, type ApiFamilyId } from '../apple-search-ads/apis.js';
import { ConfigurationError } from '../apple-search-ads/errors.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

/** Account ids are short, URL/filename-safe identifiers. They are never used to build file paths. */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const numericId = z
  .union([
    z
      .string()
      .trim()
      .regex(/^\d{1,19}$/),
    z.number().int().nonnegative().refine(Number.isSafeInteger),
  ])
  .transform(String);
const opaqueId = z
  .union([
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/),
    z.number().int().nonnegative().refine(Number.isSafeInteger),
  ])
  .transform(String);

const AccountEntrySchema = z
  .object({
    id: z.string().regex(ACCOUNT_ID_PATTERN, 'must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(1000).optional(),
    clientId: z.string().trim().min(1).max(256),
    teamId: z.string().trim().min(1).max(256),
    keyId: z.string().trim().min(1).max(256),
    privateKey: z.string().min(1).optional(),
    privateKeyPath: z.string().min(1).optional(),
    privateKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    orgId: numericId.optional(),
    adAccountId: opaqueId.optional(),
    apis: z.array(z.enum(API_FAMILY_IDS)).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sources = [value.privateKey, value.privateKeyPath, value.privateKeyEnv].filter(
      (v) => v !== undefined,
    );
    if (sources.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of privateKey, privateKeyPath or privateKeyEnv is required',
        path: ['privateKey'],
      });
    }
  });

export const AccountsFileSchema = z
  .object({
    $schema: z.string().optional(),
    accounts: z.array(AccountEntrySchema).min(1, 'at least one account must be configured'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.accounts.forEach((account, index) => {
      const key = account.id.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate account id "${account.id}" (ids are case-insensitive)`,
          path: ['accounts', index, 'id'],
        });
      }
      seen.add(key);
    });
  });

export type AccountsFile = z.infer<typeof AccountsFileSchema>;
type AccountEntry = AccountsFile['accounts'][number];

/**
 * Signing material for one account. Fields are private (#) so the object cannot be serialized,
 * spread or logged by accident; JSON/inspect output is always redacted.
 */
export class AccountCredentials {
  readonly #clientId: string;
  readonly #teamId: string;
  readonly #keyId: string;
  readonly #privateKey: KeyObject;

  constructor(input: { clientId: string; teamId: string; keyId: string; privateKey: KeyObject }) {
    this.#clientId = input.clientId;
    this.#teamId = input.teamId;
    this.#keyId = input.keyId;
    this.#privateKey = input.privateKey;
  }

  get clientId(): string {
    return this.#clientId;
  }

  get teamId(): string {
    return this.#teamId;
  }

  get keyId(): string {
    return this.#keyId;
  }

  get privateKey(): KeyObject {
    return this.#privateKey;
  }

  toJSON(): string {
    return '[REDACTED CREDENTIALS]';
  }

  toString(): string {
    return '[REDACTED CREDENTIALS]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED CREDENTIALS]';
  }
}

export interface AccountConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly apis: readonly ApiFamilyId[];
  /** Default `X-AP-Context: orgId=` for Campaign Management API v5 calls. */
  readonly orgId: string | undefined;
  /** Default `X-AP-Context: adAccountId=` for Platform API v1 calls. */
  readonly adAccountId: string | undefined;
  readonly credentials: AccountCredentials;
}

export interface LoadedAccounts {
  accounts: AccountConfig[];
  /** Raw secret strings (PEM text) so the response scrubber can block them. */
  secretMaterial: string[];
}

export interface LoadAccountsOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

function normalizePem(raw: string): string {
  let pem = raw.trim();
  // Allow keys stored on one line with literal "\n" sequences (common in JSON/env files).
  if (!pem.includes('\n') && pem.includes('\\n')) {
    pem = pem.replace(/\\n/g, '\n');
  }
  // `openssl ecparam -genkey` may prepend an EC PARAMETERS block; Node only needs the key block.
  pem = pem.replace(/-----BEGIN EC PARAMETERS-----[\s\S]*?-----END EC PARAMETERS-----\s*/g, '');
  return pem;
}

/** Parses and validates an ES256 (EC P-256) private key. Never includes key material in errors. */
export function parseEs256PrivateKey(raw: string, label: string): KeyObject {
  const pem = normalizePem(raw);
  if (!pem.includes('-----BEGIN') || !pem.includes('PRIVATE KEY-----')) {
    throw new ConfigurationError(`${label}: private key is not a PEM-encoded private key`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new ConfigurationError(`${label}: private key could not be parsed (malformed PEM)`);
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new ConfigurationError(
      `${label}: private key must be an elliptic-curve (EC) key for ES256, got ${key.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== 'prime256v1') {
    throw new ConfigurationError(
      `${label}: private key must use the P-256 (prime256v1) curve for ES256, got ${curve ?? 'unknown'}`,
    );
  }
  return key;
}

function warnIfWorldReadable(path: string, logger: Logger, what: string): void {
  try {
    const mode = statSync(path).mode;
    if (process.platform !== 'win32' && (mode & 0o004) !== 0) {
      logger.warn('insecure_file_permissions', {
        file_kind: what,
        message: `${what} is world-readable; restrict it (e.g. chmod 600)`,
      });
    }
  } catch {
    // Best-effort check only.
  }
}

function readPrivateKeySource(
  entry: AccountEntry,
  baseDir: string,
  env: NodeJS.ProcessEnv,
  logger: Logger,
): string {
  const label = `account "${entry.id}"`;
  if (entry.privateKey !== undefined) {
    return entry.privateKey;
  }
  if (entry.privateKeyPath !== undefined) {
    const keyPath = isAbsolute(entry.privateKeyPath)
      ? entry.privateKeyPath
      : resolve(baseDir, entry.privateKeyPath);
    try {
      const contents = readFileSync(keyPath, 'utf8');
      warnIfWorldReadable(keyPath, logger, `private key file for ${label}`);
      return contents;
    } catch {
      throw new ConfigurationError(`${label}: privateKeyPath could not be read`);
    }
  }
  const envName = entry.privateKeyEnv as string;
  const value = env[envName];
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(`${label}: environment variable ${envName} (privateKeyEnv) is not set`);
  }
  return value;
}

/** Parses and validates an accounts document that is already in memory. */
export function parseAccountsDocument(
  document: unknown,
  options: LoadAccountsOptions & { baseDir?: string } = {},
): LoadedAccounts {
  const env = options.env ?? process.env;
  const logger = options.logger ?? silentLogger;
  const parsed = AccountsFileSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigurationError('Invalid accounts configuration', issues);
  }

  const baseDir = options.baseDir ?? process.cwd();
  const secretMaterial: string[] = [];
  const accounts = parsed.data.accounts.map((entry): AccountConfig => {
    const label = `account "${entry.id}"`;
    const rawKey = readPrivateKeySource(entry, baseDir, env, logger);
    secretMaterial.push(rawKey, normalizePem(rawKey));
    const privateKey = parseEs256PrivateKey(rawKey, label);
    return Object.freeze({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      apis: Object.freeze([...(entry.apis ?? API_FAMILY_IDS)]),
      orgId: entry.orgId,
      adAccountId: entry.adAccountId,
      credentials: new AccountCredentials({
        clientId: entry.clientId,
        teamId: entry.teamId,
        keyId: entry.keyId,
        privateKey,
      }),
    });
  });
  return { accounts, secretMaterial };
}

/** Loads the accounts JSON file referenced by ACCOUNTS_CONFIG. */
export function loadAccountsFile(path: string, options: LoadAccountsOptions = {}): LoadedAccounts {
  const logger = options.logger ?? silentLogger;
  const absolute = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigurationError(
      code === 'ENOENT'
        ? `Accounts configuration file not found: ${absolute} (set ACCOUNTS_CONFIG)`
        : `Accounts configuration file could not be read: ${absolute}`,
    );
  }
  warnIfWorldReadable(absolute, logger, 'accounts configuration file');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ConfigurationError(`Accounts configuration file is not valid JSON: ${absolute}`);
  }
  return parseAccountsDocument(document, { ...options, baseDir: dirname(absolute) });
}
