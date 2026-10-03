/**
 * Reusable offset/limit pagination.
 *
 * Every paginated Apple Ads GET endpoint (v5 `limit`/`offset`, Platform `limit|pageSize`/`offset`)
 * is offset based. The abstraction is strategy-driven (`PageRequest` -> `Page`) so a cursor-based
 * strategy can be added without touching callers.
 */

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  /** Total number of records reported by Apple, when available. */
  total?: number;
  request: PageRequest;
}

export interface PaginateOptions {
  startOffset: number;
  pageSize: number;
  /** Hard stop after this many pages. */
  maxPages: number;
  /** Hard stop after this many records. */
  maxRecords: number;
  signal?: AbortSignal;
}

export type TruncationReason = 'max_pages' | 'max_records';

export interface PaginationOutcome {
  pagesFetched: number;
  recordsReturned: number;
  startOffset: number;
  /** Offset to request next to continue, or undefined when the data set is exhausted. */
  nextOffset: number | undefined;
  total: number | undefined;
  /** True when a safety limit stopped pagination before the data set was exhausted. */
  truncated: boolean;
  truncatedReason: TruncationReason | undefined;
}

export type PageFetcher<T> = (request: PageRequest) => Promise<Page<T>>;

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

/**
 * Yields pages until the data set is exhausted or a safety limit (maxPages / maxRecords) is hit.
 * The generator's return value describes how pagination ended.
 */
export async function* paginatePages<T>(
  fetchPage: PageFetcher<T>,
  options: PaginateOptions,
): AsyncGenerator<Page<T>, PaginationOutcome, void> {
  assertPositiveInt('pageSize', options.pageSize);
  assertPositiveInt('maxPages', options.maxPages);
  assertPositiveInt('maxRecords', options.maxRecords);
  if (!Number.isInteger(options.startOffset) || options.startOffset < 0) {
    throw new RangeError('startOffset must be a non-negative integer');
  }

  let offset = options.startOffset;
  let pagesFetched = 0;
  let records = 0;
  let total: number | undefined;

  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Aborted');
    }
    const remainingRecords = options.maxRecords - records;
    const request: PageRequest = { offset, limit: Math.min(options.pageSize, remainingRecords) };
    const page = await fetchPage(request);
    pagesFetched += 1;
    total = page.total ?? total;

    const items = page.items.slice(0, remainingRecords);
    records += items.length;
    yield { ...page, items };

    const nextOffset = offset + page.items.length;
    const exhausted =
      page.items.length === 0 ||
      (total !== undefined ? nextOffset >= total : page.items.length < request.limit);

    const outcome = (truncatedReason: TruncationReason | undefined): PaginationOutcome => ({
      pagesFetched,
      recordsReturned: records,
      startOffset: options.startOffset,
      nextOffset: exhausted ? undefined : offset + items.length,
      total,
      truncated: truncatedReason !== undefined,
      truncatedReason,
    });

    if (exhausted) return outcome(undefined);
    if (records >= options.maxRecords) return outcome('max_records');
    if (pagesFetched >= options.maxPages) return outcome('max_pages');
    offset = nextOffset;
  }
}

/** Yields individual records across pages (convenience wrapper over paginatePages). */
export async function* paginate<T>(
  fetchPage: PageFetcher<T>,
  options: PaginateOptions,
): AsyncGenerator<T, void, void> {
  for await (const page of paginatePages(fetchPage, options)) {
    yield* page.items;
  }
}

/** Collects all records (within the safety limits) and reports how pagination ended. */
export async function collectPages<T>(
  fetchPage: PageFetcher<T>,
  options: PaginateOptions,
): Promise<{ items: T[]; outcome: PaginationOutcome }> {
  const items: T[] = [];
  const generator = paginatePages(fetchPage, options);
  for (;;) {
    const next = await generator.next();
    if (next.done) return { items, outcome: next.value };
    items.push(...next.value.items);
  }
}
