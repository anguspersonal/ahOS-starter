/**
 * Shared keyset-pagination loop for the worker package's user/surface
 * enumeration scans (#778 — extracted from two near-identical/diverged
 * copies: `dedupSweep.ts`'s `getActiveUserIds` (#401, PR #771) and
 * `learning/analyze.ts`'s `getUsersWithRecentEdits` (#763, PR #777)).
 * `alertEvaluator.ts`'s discovery scan (#780) also used this helper's
 * single-column `id ASC` cursor for a time, but #786 moved it to a hand-rolled
 * composite `(captured_at DESC, id DESC)` cursor loop — this module's
 * contract is a scalar `id` cursor, and generalising it to a tuple cursor for
 * one caller wasn't worth widening the shared contract for the other two.
 * See `alertEvaluator.ts`'s `getSourceSilence` docstring for the detail.
 *
 * ## Why keyset, and why termination-on-empty-page is the only safe signal
 *
 * PostgREST clamps the *effective* rows-per-request to `api.max_rows`
 * (`supabase/config.toml:18`, currently `1000`) regardless of what a caller
 * asks for via `.limit()`/`.range()` — that file governs local
 * `supabase start` only; the hosted project's `max_rows` is a separate,
 * unversioned dashboard setting that can legitimately be lower. So a
 * requested page size is a request, not a guarantee, and a pagination loop
 * must not infer "table exhausted" from "this page came back shorter than I
 * asked for" — if the server clamps every page below the requested size,
 * every page looks short and an offset loop using that test stops after
 * page one, silently dropping every row past it (the #401 defect class,
 * and the exact QA finding that sank #401's first draft). The only signal
 * that is true under any server-side cap is an **empty** page, so that is
 * the sole exhaustion test this loop uses.
 *
 * Offset pagination has a second, independent problem this loop also
 * avoids: paging by `.range()` over a column uncorrelated with insert order
 * (e.g. a uuid primary key) can skip a row outright if a concurrent insert
 * lands ahead of the current offset window, shifting it right mid-scan.
 * Keyset pagination (`id > cursor`, ordered ascending by `id`) sidesteps
 * this too — a concurrent insert can only land after the cursor has already
 * scanned past it, and `id`'s uniqueness makes `id > cursor` a stable,
 * gap-free walk regardless of insert/delete activity elsewhere in the
 * table.
 *
 * ## Division of responsibility
 *
 * This module owns exactly three things: advancing the cursor off the last
 * row's `id`, the empty-page termination test, and the page-count safety
 * valve. Everything else — which table, which filters, which columns, and
 * what a query failure means in that caller's context — stays with the
 * caller, via `fetchPage`. That keeps each call site's error messages
 * meaningful (e.g. "Failed to enumerate active users for dedup sweep" vs.
 * "Failed to discover active surfaces for {userId}") instead of flattening
 * them into one generic wrapper.
 *
 * ## Why a callback per page, not a concatenated return
 *
 * Every current caller only ever folds a page into a `Set` or `Map` — none
 * of them need every row alive in memory at once. `onPage` is invoked once
 * per non-empty page so a scan's memory stays bounded to one page at a
 * time regardless of table size, rather than this function accumulating
 * every row across every page and handing back one giant array.
 */

/**
 * Requested page size for a keyset scan. See this module's docstring for
 * why this is a request size, not a guarantee.
 */
export const DEFAULT_KEYSET_PAGE_SIZE = 1000;

/**
 * Hard ceiling on pages fetched per `keysetPaginate` call — a safety valve
 * against a server that never returns an empty page, not a truncation
 * point. Enumeration is deliberately unbounded in row-count terms (that's
 * the whole point of paging this way), so without this a misbehaving
 * server would wedge a caller in an infinite loop. Hitting it throws —
 * loud failure, never a silent partial result — because it means the
 * server is misbehaving, not that real data legitimately needs more pages:
 * 10,000 pages * 1,000 rows/page = 10M rows, far beyond any plausible scan
 * in this package.
 *
 * A caller wanting a smaller, *non-throwing* product cap (e.g.
 * `alertEvaluator`'s bounded discovery scan, which is allowed to
 * deliberately stop early and report that it did) enforces that itself by
 * returning `'stop'` from `onPage` — this valve is only for the
 * "should never happen" case. The "10M rows, far beyond any plausible scan"
 * margin holds while pages come back full; a server that clamped every page
 * to a handful of rows would still hit this valve (and throw) before a much
 * smaller product cap like `DISCOVERY_ROW_CAP` did — vanishingly unlikely in
 * practice, but the margin is conditional on page size, not unconditional.
 */
export const DEFAULT_KEYSET_MAX_PAGES = 10_000;

export interface KeysetPaginateOptions<Row> {
  /**
   * Fetch one page given the previous page's last-seen `id` cursor (`null`
   * for the first page) and the page size to request. Owns applying
   * `.gt('id', afterId)` when `afterId` is non-null, `.order('id', {
   * ascending: true })`, `.limit(pageSize)`, and turning a `{ error }`
   * response into a thrown `Error` with call-site-appropriate context —
   * exactly what each call site already did by hand, so centralising the
   * loop here changes none of their filters, ordering, or error text.
   */
  fetchPage: (afterId: string | null, pageSize: number) => Promise<Row[]>;
  /** Extracts the unique `id` cursor value from a row. */
  getId: (row: Row) => string | null | undefined;
  /**
   * Invoked once per non-empty page. Return `'stop'` to end the scan early
   * without it being treated as an error (e.g. a deliberate, product-level
   * row cap) — contrast with `maxPages`, which always throws.
   */
  onPage: (rows: Row[]) => void | 'stop' | Promise<void | 'stop'>;
  /** Identifies the caller in the max-pages / missing-id error messages. */
  label: string;
  /** @default DEFAULT_KEYSET_PAGE_SIZE */
  pageSize?: number;
  /** @default DEFAULT_KEYSET_MAX_PAGES */
  maxPages?: number;
}

export interface KeysetPaginateResult {
  /**
   * Number of `fetchPage` calls made — i.e. round trips, including the
   * final one (whether it came back empty, exhausting the scan, or was the
   * last page processed before `onPage` returned `'stop'`).
   */
  pages: number;
  /** Total rows seen across every page (the final empty page contributes 0). */
  rows: number;
  /** True when the scan ended via `onPage` returning `'stop'`, not exhaustion. */
  stopped: boolean;
}

/**
 * Drive a keyset-paginated scan to completion (or an early caller-requested
 * stop). See this module's docstring for the rationale.
 */
export async function keysetPaginate<Row>(
  options: KeysetPaginateOptions<Row>,
): Promise<KeysetPaginateResult> {
  const pageSize = options.pageSize ?? DEFAULT_KEYSET_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_KEYSET_MAX_PAGES;

  let afterId: string | null = null;
  let rowCount = 0;

  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      throw new Error(
        `${options.label}: exceeded ${maxPages} pages without an empty page — ` +
          'aborting instead of scanning forever (the server may be misbehaving)',
      );
    }

    const rows = await options.fetchPage(afterId, pageSize);
    if (rows.length === 0) {
      return { pages: page + 1, rows: rowCount, stopped: false };
    }

    rowCount += rows.length;
    const outcome = await options.onPage(rows);

    // Honour an early stop before the cursor-advance guard below: a caller
    // that has deliberately asked to end the scan doesn't need a further
    // cursor, so a malformed/missing `id` on this already-last page must not
    // turn a clean stop into a throw.
    if (outcome === 'stop') {
      return { pages: page + 1, rows: rowCount, stopped: true };
    }

    const lastId = options.getId(rows[rows.length - 1]);
    if (typeof lastId !== 'string' || !lastId) {
      throw new Error(`${options.label}: a returned row is missing its id — cannot page further`);
    }
    afterId = lastId;
  }
}
