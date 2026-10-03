import { describe, expect, it } from 'vitest';
import {
  collectPages,
  paginate,
  paginatePages,
  type Page,
  type PageRequest,
} from '../../src/apple-search-ads/pagination.js';

function dataset(size: number) {
  return Array.from({ length: size }, (_, i) => ({ id: i }));
}

function fetcher(items: { id: number }[], options: { withTotal?: boolean; cap?: number } = {}) {
  const requests: PageRequest[] = [];
  const fetchPage = async (request: PageRequest): Promise<Page<{ id: number }>> => {
    requests.push(request);
    const size = Math.min(request.limit, options.cap ?? Infinity);
    return {
      items: items.slice(request.offset, request.offset + size),
      total: options.withTotal === false ? undefined : items.length,
      request,
    };
  };
  return { fetchPage, requests };
}

const defaults = { startOffset: 0, pageSize: 10, maxPages: 100, maxRecords: 10_000 };

describe('pagination', () => {
  it('collects every record across pages using the reported total', async () => {
    const { fetchPage, requests } = fetcher(dataset(25));
    const { items, outcome } = await collectPages(fetchPage, defaults);
    expect(items.map((i) => i.id)).toEqual(dataset(25).map((i) => i.id));
    expect(requests.map((r) => r.offset)).toEqual([0, 10, 20]);
    expect(outcome).toMatchObject({
      pagesFetched: 3,
      recordsReturned: 25,
      total: 25,
      truncated: false,
      nextOffset: undefined,
    });
  });

  it('stops on a short page when Apple does not report a total', async () => {
    const { fetchPage, requests } = fetcher(dataset(23), { withTotal: false });
    const { items, outcome } = await collectPages(fetchPage, defaults);
    expect(items).toHaveLength(23);
    expect(requests).toHaveLength(3);
    expect(outcome.total).toBeUndefined();
  });

  it('keeps going when Apple caps the page size below the request but reports a total', async () => {
    const { fetchPage, requests } = fetcher(dataset(12), { cap: 5 });
    const { items } = await collectPages(fetchPage, { ...defaults, pageSize: 100 });
    expect(items).toHaveLength(12);
    expect(requests.map((r) => r.offset)).toEqual([0, 5, 10]);
  });

  it('handles an empty first page', async () => {
    const { fetchPage } = fetcher([]);
    const { items, outcome } = await collectPages(fetchPage, defaults);
    expect(items).toEqual([]);
    expect(outcome).toMatchObject({ pagesFetched: 1, truncated: false });
  });

  it('stops at max_pages and reports where to continue', async () => {
    const { fetchPage } = fetcher(dataset(100));
    const { items, outcome } = await collectPages(fetchPage, { ...defaults, maxPages: 2 });
    expect(items).toHaveLength(20);
    expect(outcome).toMatchObject({
      truncated: true,
      truncatedReason: 'max_pages',
      nextOffset: 20,
      total: 100,
    });
  });

  it('stops at max_records, shrinking the last request and trimming the page', async () => {
    const { fetchPage, requests } = fetcher(dataset(100));
    const { items, outcome } = await collectPages(fetchPage, { ...defaults, maxRecords: 25 });
    expect(items).toHaveLength(25);
    expect(requests.map((r) => r.limit)).toEqual([10, 10, 5]);
    expect(outcome).toMatchObject({ truncated: true, truncatedReason: 'max_records', nextOffset: 25 });
  });

  it('does not mark an exactly-exhausted data set as truncated', async () => {
    const { fetchPage } = fetcher(dataset(20));
    const { outcome } = await collectPages(fetchPage, { ...defaults, maxRecords: 20 });
    expect(outcome.truncated).toBe(false);
  });

  it('honours a start offset', async () => {
    const { fetchPage, requests } = fetcher(dataset(30));
    const { items } = await collectPages(fetchPage, { ...defaults, startOffset: 15 });
    expect(items[0]?.id).toBe(15);
    expect(items).toHaveLength(15);
    expect(requests[0]?.offset).toBe(15);
  });

  it('yields individual records with paginate()', async () => {
    const { fetchPage } = fetcher(dataset(15));
    const seen: number[] = [];
    for await (const item of paginate(fetchPage, { ...defaults, pageSize: 4 })) seen.push(item.id);
    expect(seen).toEqual(dataset(15).map((i) => i.id));
  });

  it('yields pages with paginatePages()', async () => {
    const { fetchPage } = fetcher(dataset(9));
    const sizes: number[] = [];
    for await (const page of paginatePages(fetchPage, { ...defaults, pageSize: 4 }))
      sizes.push(page.items.length);
    expect(sizes).toEqual([4, 4, 1]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { fetchPage } = fetcher(dataset(100));
    const generator = paginatePages(
      async (r) => {
        controller.abort(new Error('stop'));
        return fetchPage(r);
      },
      { ...defaults, signal: controller.signal },
    );
    await generator.next();
    await expect(generator.next()).rejects.toThrow('stop');
  });

  it.each([
    [{ pageSize: 0 }],
    [{ maxPages: 0 }],
    [{ maxRecords: -1 }],
    [{ startOffset: -1 }],
    [{ pageSize: 1.5 }],
  ])('validates options %j', async (override) => {
    const { fetchPage } = fetcher(dataset(1));
    await expect(collectPages(fetchPage, { ...defaults, ...override })).rejects.toBeInstanceOf(RangeError);
  });
});
