import type { AccountConfig } from '../config/loader.js';
import { ACCOUNT_ID_PATTERN } from '../config/loader.js';
import type { SecretScrubber } from '../utils/redact.js';
import type { Clock } from '../utils/time.js';
import type { ApiFamilyId } from './apis.js';
import { AccountTokenManager, type AuthenticationProvider, type OAuthTokenClient } from './auth.js';
import { AccountNotFoundError, ConfigurationError } from './errors.js';

/** Public, credential-free view of an account (what list_accounts returns). */
export interface AccountSummary {
  id: string;
  name: string;
  description?: string;
  apis: ApiFamilyId[];
  default_org_id?: string;
  default_ad_account_id?: string;
}

/**
 * Owns the configured accounts and one isolated token manager per account.
 *
 * Isolation guarantees:
 * - Accounts are looked up by exact id in an in-memory map; ids are never used as file paths.
 * - Every account has its own AccountTokenManager bound to its own credentials at construction time,
 *   so a token minted for account A is never returned for account B.
 */
export class AccountManager implements AuthenticationProvider {
  readonly #accounts = new Map<string, AccountConfig>();
  readonly #tokens = new Map<string, AccountTokenManager>();

  constructor(
    accounts: readonly AccountConfig[],
    deps: {
      tokenClient: OAuthTokenClient;
      clock?: Clock;
      refreshSkewSeconds: number;
      scrubber?: SecretScrubber;
    },
  ) {
    if (accounts.length === 0) {
      throw new ConfigurationError('At least one Apple Search Ads account must be configured');
    }
    for (const account of accounts) {
      if (this.#accounts.has(account.id)) {
        throw new ConfigurationError(`Duplicate account id "${account.id}"`);
      }
      this.#accounts.set(account.id, account);
      this.#tokens.set(
        account.id,
        new AccountTokenManager({
          accountId: account.id,
          credentials: account.credentials,
          client: deps.tokenClient,
          clock: deps.clock,
          refreshSkewSeconds: deps.refreshSkewSeconds,
          scrubber: deps.scrubber,
        }),
      );
    }
  }

  /** Lists accounts without any credential material. */
  list(): AccountSummary[] {
    return [...this.#accounts.values()].map((account) => toSummary(account));
  }

  has(accountId: string): boolean {
    return typeof accountId === 'string' && this.#accounts.has(accountId);
  }

  /** Returns the account or throws AccountNotFoundError. Rejects malformed ids before lookup. */
  get(accountId: string): AccountConfig {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new AccountNotFoundError(String(accountId));
    }
    const account = this.#accounts.get(accountId);
    if (!account) throw new AccountNotFoundError(accountId);
    return account;
  }

  summary(accountId: string): AccountSummary {
    return toSummary(this.get(accountId));
  }

  async getAccessToken(accountId: string, signal?: AbortSignal): Promise<string> {
    this.get(accountId);
    const manager = this.#tokens.get(accountId);
    if (!manager) throw new AccountNotFoundError(accountId);
    return manager.getAccessToken(signal);
  }

  invalidateAccessToken(accountId: string, rejectedToken?: string): void {
    this.#tokens.get(accountId)?.invalidate(rejectedToken);
  }

  get size(): number {
    return this.#accounts.size;
  }

  toJSON(): AccountSummary[] {
    return this.list();
  }
}

function toSummary(account: AccountConfig): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    ...(account.description ? { description: account.description } : {}),
    apis: [...account.apis],
    ...(account.orgId ? { default_org_id: account.orgId } : {}),
    ...(account.adAccountId ? { default_ad_account_id: account.adAccountId } : {}),
  };
}
