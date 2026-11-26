/**
 * Unit tests for the batch learning analysis active-user enumeration (#763,
 * same defect class as #401 — see schedule/dedupSweep.test.ts's getActiveUserIds
 * suite for the reference fix this mirrors).
 *
 * `getUsersWithRecentEdits` used to be an unpaginated `.select('user_id')`
 * over `user_edits`, so at scale it was silently capped by PostgREST's
 * effective row limit and users whose edits fell past the cap were dropped
 * from the nightly batch run with no error. These tests prove the
 * keyset-paginated replacement enumerates every matching user regardless of
 * how many pages that takes, and that its only exhaustion signal is an empty
 * page rather than a short one.
 */
import { supabase } from '../../../src/utils/supabase';
import {
  getUsersWithRecentEdits,
  runBatchLearningAnalysis,
  LEARNING_USER_SCAN_PAGE_SIZE,
} from '../../../src/learning/analyze';
import {
  resetMockData,
  setMockData,
  resetMockSupabase,
  setMockServerRowCap,
  createQueryBuilder,
} from '../../__mocks__/supabase';

/**
 * A PostgREST response stub for a single page that errors instead of
 * throwing (QA round 1 L2, #777): every chain method returns the stub
 * itself, and awaiting it at any point resolves `{ data: null, error }` —
 * mirroring the real client, which surfaces a failed request as a `{ error }`
 * field rather than a rejected promise.
 */
function erroringPageStub(message: string) {
  const stub: any = {};
  const chain = () => stub;
  stub.select = chain;
  stub.gt = chain;
  stub.not = chain;
  stub.order = chain;
  stub.limit = chain;
  stub.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: null, error: { message } }).then(resolve, reject);
  return stub;
}

function editRow(id: string, userId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    edit_type: 'entity_match_correction',
    original_value: {},
    corrected_value: {},
    created_at: '2026-08-20T00:00:00.000Z',
    ...extra,
  };
}

const SINCE = new Date('2026-08-15T00:00:00.000Z');

beforeEach(() => {
  resetMockData();
  resetMockSupabase();
  jest.clearAllMocks();
});

describe('getUsersWithRecentEdits', () => {
  it('returns distinct user_ids with an edit strictly after the cutoff, excluding an edit exactly at the cutoff and stale edits', async () => {
    // QA round 1 L3 (#777): the filter is .gt('created_at', since) — exclusive
    // — so an edit timestamped exactly at `since` must NOT count as "recent".
    setMockData('user_edits', [
      editRow('a', 'u1'),
      editRow('b', 'u1'), // same user -> deduped
      editRow('c', 'u2'),
      editRow('at-cutoff', 'u4', { created_at: SINCE.toISOString() }), // exactly at cutoff -> excluded (gt is exclusive)
      editRow('e', 'u3', { created_at: '2026-08-01T00:00:00.000Z' }), // before cutoff -> excluded
    ]);

    const ids = await getUsersWithRecentEdits(SINCE);

    expect(ids.sort()).toEqual(['u1', 'u2']);
  });

  it('excludes rows with a null user_id from the result (defence-in-depth: user_edits.user_id is NOT NULL in production)', async () => {
    // QA round 1 L1 (#777): this asserts the OUTCOME only — a null-user_id row
    // is missing from the returned set — which the client-side guard at the
    // aggregation step (`typeof row.user_id === 'string' && row.user_id`)
    // already guarantees on its own. It does NOT prove the server-side
    // `.not('user_id', 'is', null)` filter is what did the excluding; see the
    // next test for that.
    setMockData('user_edits', [editRow('a', 'u1'), editRow('d', null)]);

    const ids = await getUsersWithRecentEdits(SINCE);

    expect(ids).toEqual(['u1']);
  });

  it('asks the server to exclude null user_id via .not(), not only the client-side guard (#777 QA round 1 L1)', async () => {
    // Deleting the `.not('user_id', 'is', null)` call from getUsersWithRecentEdits
    // failed zero tests before this one: the client-side guard produces the
    // same outcome on its own, so an outcome-only assertion can't tell the two
    // apart. Pin the query itself via the mock's call log instead.
    setMockData('user_edits', [editRow('a', 'u1')]);

    await getUsersWithRecentEdits(SINCE);

    const fromMock = supabase.from as jest.Mock;
    const firstPageBuilder = fromMock.mock.results[0].value;
    expect(firstPageBuilder.not).toHaveBeenCalledWith('user_id', 'is', null);
  });

  it('pages past a single page of matching edits so users beyond the page size are not silently dropped (#763)', async () => {
    // One page's worth of rows plus a bit more, each a distinct user, so a
    // single-shot query (capped at LEARNING_USER_SCAN_PAGE_SIZE) would have
    // silently lost every user from the second page onward.
    const totalUsers = LEARNING_USER_SCAN_PAGE_SIZE + 250;
    const rows = Array.from({ length: totalUsers }, (_, i) => editRow(`edit-${i}`, `user-${i}`));
    setMockData('user_edits', rows);

    const ids = await getUsersWithRecentEdits(SINCE);

    expect(ids.sort()).toEqual(rows.map((_, i) => `user-${i}`).sort());
  });

  it('stops after one extra empty page when the result set lands exactly on a page boundary (#763)', async () => {
    const rows = Array.from({ length: LEARNING_USER_SCAN_PAGE_SIZE }, (_, i) =>
      editRow(`edit-${i}`, `user-${i}`),
    );
    setMockData('user_edits', rows);

    const ids = await getUsersWithRecentEdits(SINCE);

    expect(ids).toHaveLength(LEARNING_USER_SCAN_PAGE_SIZE);
    // Exactly two round trips: a full page (proves nothing was truncated) then
    // one empty page — keyset's only exhaustion signal — proving the loop
    // terminates instead of paging forever.
    expect((supabase.from as jest.Mock).mock.calls.filter(([table]) => table === 'user_edits')).toHaveLength(2);
  });

  it('returns every user even when the server clamps every page below the requested page size (#763, same class as #401 QA round 1 H1)', async () => {
    // Reproduces the QA finding that sank #401's first fix directly: simulate
    // api.max_rows (supabase/config.toml:18) sitting BELOW
    // LEARNING_USER_SCAN_PAGE_SIZE, so every page this fetches comes back
    // short of what it asked for. An offset-paginated loop that treats "short
    // page" as "table exhausted" would stop after page one here and silently
    // drop everyone past row 500. Keyset only stops on an EMPTY page, so it
    // must still return all of them.
    const totalUsers = LEARNING_USER_SCAN_PAGE_SIZE + 250;
    const rows = Array.from({ length: totalUsers }, (_, i) => editRow(`edit-${i}`, `user-${i}`));
    setMockData('user_edits', rows);
    setMockServerRowCap(500);

    const ids = await getUsersWithRecentEdits(SINCE);

    expect(ids.sort()).toEqual(rows.map((_, i) => `user-${i}`).sort());
  });

  it('throws with the PostgREST error message when a page returns { data: null, error } (#777 QA round 1 L2)', async () => {
    // The prior "propagates an enumeration failure" test only exercised
    // supabase.from() throwing synchronously. A realistic PostgREST failure
    // instead resolves the query with an `error` field, which is the branch
    // this test targets: page 1 succeeds (so the loop reaches page 2's
    // .from() call), page 2 resolves with an error.
    //
    // Chained .mockImplementationOnce() rather than a permanent
    // .mockImplementation() + .mockRestore(): supabase.from is already a
    // jest.fn() in the shared mock (not a real function jest.spyOn is
    // wrapping), so .mockRestore() has no original implementation to fall
    // back to and instead leaves it returning undefined for every later
    // test in this file. The "once" queue self-empties after two calls and
    // never touches the base implementation, so no restore is needed.
    setMockData('user_edits', [editRow('a', 'u1')]);
    jest
      .spyOn(supabase, 'from')
      .mockImplementationOnce((table: string) => createQueryBuilder(table))
      .mockImplementationOnce(() => erroringPageStub('boom'));

    await expect(getUsersWithRecentEdits(SINCE)).rejects.toThrow(
      'Failed to fetch users with recent edits: boom',
    );
  });
});

describe('runBatchLearningAnalysis', () => {
  it('completes without error when no users have recent edits', async () => {
    setMockData('user_edits', []);

    await expect(runBatchLearningAnalysis()).resolves.toEqual({ users: 0, errors: 0 });
  });

  it('returns a {users, errors} summary the "learning" cadence can record to scheduler_runs (#948)', async () => {
    // Both edits dated "now" so they land inside runBatchLearningAnalysis's own
    // internal 7-day cutoff (unlike getUsersWithRecentEdits above, it has no
    // injectable clock).
    setMockData('user_edits', [
      editRow('a', 'u1', { created_at: new Date().toISOString() }),
      editRow('b', 'u2', { created_at: new Date().toISOString() }),
    ]);

    const summary = await runBatchLearningAnalysis();

    // Two users, neither with enough edits to cross MIN_OBSERVATIONS_FOR_PATTERN
    // for any of the four sub-analysers, so both complete cleanly.
    expect(summary).toEqual({ users: 2, errors: 0 });
  });

  // The remaining two tests spy on `supabase.from` via `jest.spyOn` rather
  // than `setMockData`. The shared mock's `.from` is one persistent
  // module-level `jest.fn`, and `resetMockSupabase()` only `mockClear()`s it
  // (call history, not implementation) — so a spy that outlives its test
  // leaves later tests unable to rely on the plain `setMockData` path. Both
  // spy-based tests are kept last in this describe block for that reason;
  // if you add another plain (non-spying) case, put it above this comment.

  it('propagates an enumeration failure instead of swallowing it', async () => {
    const spy = jest
      .spyOn(supabase, 'from')
      .mockImplementationOnce(() => {
        throw new Error('db down');
      });

    await expect(runBatchLearningAnalysis()).rejects.toThrow('db down');

    spy.mockRestore();
  });

  it('counts a per-user analysis failure without aborting the batch, matching runDedupSweep\'s isolation (#948)', async () => {
    setMockData('user_edits', [
      editRow('a', 'u1', { created_at: new Date().toISOString() }),
      editRow('b', 'u2', { created_at: new Date().toISOString() }),
    ]);

    // Calls 1-2: getUsersWithRecentEdits' page + its terminating empty page.
    // Calls 3-6: u1's four sub-analysers (entity matching, task duration,
    // intent, disambiguation) — none find enough data to do anything, so none
    // throw. Call 7 is u2's first sub-analyser (entity matching); forcing it
    // to throw fails u2's whole pass the way a real DB outage would, proving
    // the batch still finishes and reports the failure instead of aborting.
    const spy = jest.spyOn(supabase, 'from');
    for (let i = 0; i < 6; i++) {
      spy.mockImplementationOnce((table: string) => createQueryBuilder(table));
    }
    spy.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const summary = await runBatchLearningAnalysis();

    expect(summary).toEqual({ users: 2, errors: 1 });

    spy.mockRestore();
  });
});
