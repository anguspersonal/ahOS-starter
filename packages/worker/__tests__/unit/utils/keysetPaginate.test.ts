/**
 * Direct unit tests for the shared keyset-pagination loop (#778/#780).
 *
 * Until now `keysetPaginate` was only exercised indirectly through its three
 * callers (`dedupSweep.test.ts`, `analyze.test.ts`, `alertEvaluator.test.ts`),
 * each stubbing a real Supabase-shaped query. That's the right coverage for
 * "does the whole scan behave correctly", but it left the loop's own
 * mechanics — the max-pages valve, the missing-id guard, `'stop'` handling,
 * and the `KeysetPaginateResult` shape — provable-but-unproven: a #785
 * review round 1 mutation probe (M1) found the valve and the missing-id
 * guard both survive the full 702-test worker suite when disabled, because
 * nothing in those three callers' fixtures happens to hit either path. This
 * file targets `keysetPaginate` directly with a stub `fetchPage`, so those
 * paths have a test that fails when they break.
 */
import { keysetPaginate, DEFAULT_KEYSET_PAGE_SIZE, DEFAULT_KEYSET_MAX_PAGES } from '../../../src/utils/keysetPaginate';

type Row = { id: string | null; value: string };

function row(id: string | null, value = 'x'): Row {
  return { id, value };
}

/** Builds a `fetchPage` that serves fixed pages in order, ignoring cursor/pageSize. */
function fixedPages(pages: Row[][]): jest.Mock {
  const queue = [...pages];
  return jest.fn(async () => queue.shift() ?? []);
}

describe('keysetPaginate', () => {
  it('returns immediately on an empty first page: one round trip, zero rows, not stopped', async () => {
    const fetchPage = fixedPages([[]]);
    const onPage = jest.fn();

    const result = await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => r.id,
      fetchPage,
      onPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onPage).not.toHaveBeenCalled();
    expect(result).toEqual({ pages: 1, rows: 0, stopped: false });
  });

  it('pages until an empty page, accumulating pages/rows counts across every fetch', async () => {
    const fetchPage = fixedPages([
      [row('a'), row('b')],
      [row('c')],
      [],
    ]);
    const seen: Row[][] = [];

    const result = await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => r.id,
      fetchPage,
      onPage: (rows) => {
        seen.push(rows);
      },
    });

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([[row('a'), row('b')], [row('c')]]);
    // 3 round trips total (two with rows, one empty) — "pages fetched"
    // counts every fetchPage call, per the KeysetPaginateResult docstring.
    expect(result).toEqual({ pages: 3, rows: 3, stopped: false });
  });

  it('advances the cursor using getId(lastRowOfPage), passed to the next fetchPage call', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce([row('a'), row('b')])
      .mockResolvedValueOnce([row('c')])
      .mockResolvedValueOnce([]);

    await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => r.id,
      fetchPage,
      onPage: () => undefined,
    });

    expect(fetchPage.mock.calls[0][0]).toBeNull();
    expect(fetchPage.mock.calls[1][0]).toBe('b');
    expect(fetchPage.mock.calls[2][0]).toBe('c');
  });

  it('requests DEFAULT_KEYSET_PAGE_SIZE by default, and a caller-supplied pageSize when given', async () => {
    const fetchPage = fixedPages([[]]);
    await keysetPaginate<Row>({ label: 'test', getId: (r) => r.id, fetchPage, onPage: () => undefined });
    expect(fetchPage).toHaveBeenCalledWith(null, DEFAULT_KEYSET_PAGE_SIZE);

    const fetchPage2 = fixedPages([[]]);
    await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => r.id,
      fetchPage: fetchPage2,
      onPage: () => undefined,
      pageSize: 25,
    });
    expect(fetchPage2).toHaveBeenCalledWith(null, 25);
  });

  it('ends cleanly when onPage returns "stop": no further fetch, stopped: true, pages includes the stopping page', async () => {
    const fetchPage = fixedPages([[row('a'), row('b')], [row('should-not-be-fetched')]]);

    const result = await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => r.id,
      fetchPage,
      onPage: () => 'stop',
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pages: 1, rows: 2, stopped: true });
  });

  it('honours "stop" even when the stopping page\'s last row has no id — a dead cursor is fine because there is no next fetch', async () => {
    const fetchPage = fixedPages([[row('a'), row(null)]]);

    const result = await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => r.id,
      fetchPage,
      onPage: () => 'stop',
    });

    expect(result).toEqual({ pages: 1, rows: 2, stopped: true });
  });

  it('throws naming the caller when a non-stopping page\'s last row has no usable id', async () => {
    const fetchPage = fixedPages([[row('a'), row(null)], [row('unreachable')]]);

    await expect(
      keysetPaginate<Row>({
        label: 'MyScan.thing',
        getId: (r) => r.id,
        fetchPage,
        onPage: () => undefined,
      }),
    ).rejects.toThrow('MyScan.thing: a returned row is missing its id — cannot page further');

    // The guard fires before any further fetch would use the dead cursor.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws naming the caller and the limit when maxPages is exceeded without an empty page', async () => {
    const fetchPage = jest.fn(async (afterId: string | null) => [row(afterId ? `${afterId}x` : 'a')]);

    await expect(
      keysetPaginate<Row>({
        label: 'MyScan.thing',
        getId: (r) => r.id,
        fetchPage,
        onPage: () => undefined,
        maxPages: 3,
      }),
    ).rejects.toThrow(
      'MyScan.thing: exceeded 3 pages without an empty page — aborting instead of scanning forever (the server may be misbehaving)',
    );

    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('defaults maxPages to DEFAULT_KEYSET_MAX_PAGES', async () => {
    let calls = 0;
    const fetchPage = jest.fn(async (afterId: string | null) => {
      calls += 1;
      if (calls > DEFAULT_KEYSET_MAX_PAGES) return [];
      return [row(afterId ? `${afterId}x` : 'a')];
    });

    await expect(
      keysetPaginate<Row>({ label: 'test', getId: (r) => r.id, fetchPage, onPage: () => undefined }),
    ).rejects.toThrow(`exceeded ${DEFAULT_KEYSET_MAX_PAGES} pages without an empty page`);
  });

  it('awaits an async onPage before advancing the cursor', async () => {
    const order: string[] = [];
    const fetchPage = fixedPages([[row('a')], []]);

    await keysetPaginate<Row>({
      label: 'test',
      getId: (r) => {
        order.push('getId');
        return r.id;
      },
      fetchPage,
      onPage: async () => {
        order.push('onPage-start');
        await Promise.resolve();
        order.push('onPage-end');
      },
    });

    expect(order).toEqual(['onPage-start', 'onPage-end', 'getId']);
  });
});
