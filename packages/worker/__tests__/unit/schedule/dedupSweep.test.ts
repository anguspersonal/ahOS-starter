/**
 * Unit tests for the periodic dedup sweep (issue #396).
 *
 * Proves the production trigger actually invokes emitMergeSuggestions per active
 * user, and that the scheduler entry point drives the sweep (once immediately and
 * then on its interval) only when enabled.
 */

// emitMergeSuggestions is the collaborator under test — mock just that export
// so the sweep's own logic (enumeration, per-user loop, error isolation) is
// what we exercise, while keeping the real DEFAULT_DEDUP_ENTITY_TYPES constant
// (a full `jest.mock(path)` automock would collapse that exported array,
// which dedupSweep.ts spreads into its own DEFAULT_ENTITY_TYPES at import
// time — see #310).
jest.mock('../../../src/workflows/identityResolution', () => {
  const actual = jest.requireActual('../../../src/workflows/identityResolution');
  return {
    ...actual,
    emitMergeSuggestions: jest.fn(),
  };
});
// The lock + run-log talk to scheduler_locks / scheduler_runs (not in the DB
// mock's table set); stub them so the sweep logic is isolated.
jest.mock('../../../src/schedule/lock');
jest.mock('../../../src/schedule/runLog');

import { emitMergeSuggestions, DEFAULT_DEDUP_ENTITY_TYPES } from '../../../src/workflows/identityResolution';
import { withLock } from '../../../src/schedule/lock';
import { recordRun } from '../../../src/schedule/runLog';
import { supabase } from '../../../src/utils/supabase';
import {
  runDedupSweep,
  getActiveUserIds,
  startDedupSweepScheduler,
  ACTIVE_USER_SCAN_PAGE_SIZE,
} from '../../../src/schedule/dedupSweep';
import {
  resetMockData,
  setMockData,
  resetMockSupabase,
  setMockServerRowCap,
} from '../../__mocks__/supabase';

const emitMock = emitMergeSuggestions as jest.MockedFunction<typeof emitMergeSuggestions>;
const withLockMock = withLock as jest.MockedFunction<typeof withLock>;
const recordRunMock = recordRun as jest.MockedFunction<typeof recordRun>;

function personRow(id: string, userId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Person ${id}`,
    entity_type: 'people',
    user_id: userId,
    archived: false,
    properties: {},
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  resetMockData();
  resetMockSupabase();
  jest.clearAllMocks();
  emitMock.mockResolvedValue({ candidates: [], created: 0, skipped: 0 });
  recordRunMock.mockResolvedValue(undefined);
  delete process.env.KMS_DEDUP_SWEEP_ENABLED;
  delete process.env.KMS_DEDUP_SWEEP_INTERVAL_MINUTES;
});

describe('getActiveUserIds', () => {
  it('returns distinct user_ids that own a non-archived entity of a swept type', async () => {
    setMockData('entities', [
      personRow('a', 'u1'),
      personRow('b', 'u1'), // same user -> deduped
      personRow('c', 'u2'),
      personRow('d', 'u3', { archived: true }), // archived -> excluded
      personRow('e', 'u4', { entity_type: 'project' }), // wrong type -> excluded
    ]);

    const ids = await getActiveUserIds(['people']);

    expect(ids.sort()).toEqual(['u1', 'u2']);
  });

  it('pages past a single page of matching entities so users beyond the page size are not silently dropped (#401)', async () => {
    // One page's worth of rows plus a bit more, each a distinct user, so a
    // single-shot query (capped at ACTIVE_USER_SCAN_PAGE_SIZE) would have
    // silently lost every user from the second page onward.
    const totalUsers = ACTIVE_USER_SCAN_PAGE_SIZE + 250;
    const rows = Array.from({ length: totalUsers }, (_, i) =>
      personRow(`entity-${i}`, `user-${i}`),
    );
    setMockData('entities', rows);

    const ids = await getActiveUserIds(['people']);

    expect(ids).toHaveLength(totalUsers);
    // Spot-check a user that only a second page fetch could have returned.
    expect(ids).toContain(`user-${totalUsers - 1}`);
  });

  it('stops after one extra empty page when the result set lands exactly on a page boundary (#401)', async () => {
    const rows = Array.from({ length: ACTIVE_USER_SCAN_PAGE_SIZE }, (_, i) =>
      personRow(`entity-${i}`, `user-${i}`),
    );
    setMockData('entities', rows);

    const ids = await getActiveUserIds(['people']);

    expect(ids).toHaveLength(ACTIVE_USER_SCAN_PAGE_SIZE);
    // Exactly two round trips: a full page (proves nothing was truncated) then
    // one empty page — keyset's only exhaustion signal — proving the loop
    // terminates instead of paging forever.
    expect((supabase.from as jest.Mock).mock.calls.filter(([table]) => table === 'entities')).toHaveLength(2);
  });

  it('returns every user even when the server clamps every page below the requested page size (#401 QA round 1 H1)', async () => {
    // Reproduces the QA finding directly: simulate api.max_rows (supabase/
    // config.toml:18) sitting BELOW ACTIVE_USER_SCAN_PAGE_SIZE, so every page
    // this fetches comes back short of what it asked for. An offset-paginated
    // loop that treats "short page" as "table exhausted" would stop after
    // page one here and silently drop everyone past row 500 — exactly #401.
    // Keyset only stops on an EMPTY page, so it must still return all 1250.
    const totalUsers = ACTIVE_USER_SCAN_PAGE_SIZE + 250;
    const rows = Array.from({ length: totalUsers }, (_, i) =>
      personRow(`entity-${i}`, `user-${i}`),
    );
    setMockData('entities', rows);
    setMockServerRowCap(500);

    const ids = await getActiveUserIds(['people']);

    expect(ids).toHaveLength(totalUsers);
  });
});

describe('runDedupSweep', () => {
  it('defaults entityTypes to DEFAULT_DEDUP_ENTITY_TYPES (people + project + organization, #310)', async () => {
    expect(DEFAULT_DEDUP_ENTITY_TYPES).toEqual(['people', 'project', 'organization']);
  });

  it('invokes emitMergeSuggestions once per active user', async () => {
    setMockData('entities', [personRow('a', 'u1'), personRow('b', 'u2')]);
    emitMock.mockResolvedValue({ candidates: [], created: 1, skipped: 0 });

    const summary = await runDedupSweep();

    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(emitMock).toHaveBeenCalledWith({
      userId: 'u1',
      entityTypes: ['people', 'project', 'organization'],
      threshold: undefined,
    });
    expect(emitMock).toHaveBeenCalledWith({
      userId: 'u2',
      entityTypes: ['people', 'project', 'organization'],
      threshold: undefined,
    });
    expect(summary).toEqual({ users: 2, created: 2, skipped: 0, errors: 0 });
    expect(recordRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: 'dedup', error: undefined }),
    );
  });

  it('scans project and organization entities by default, not just people (#310 — the Work project dup)', async () => {
    setMockData('entities', [
      personRow('a', 'u1', { entity_type: 'project', title: 'Work' }),
      personRow('b', 'u1', { entity_type: 'project', title: 'Work AI' }),
    ]);
    emitMock.mockResolvedValue({ candidates: [], created: 0, skipped: 0 });

    const summary = await runDedupSweep();

    expect(emitMock).toHaveBeenCalledWith({
      userId: 'u1',
      entityTypes: ['people', 'project', 'organization'],
      threshold: undefined,
    });
    expect(summary.users).toBe(1);
  });

  it('isolates per-user failures: one throwing user does not abort the rest', async () => {
    setMockData('entities', [personRow('a', 'u1'), personRow('b', 'u2')]);
    emitMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ candidates: [], created: 3, skipped: 1 });

    const summary = await runDedupSweep();

    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ users: 2, created: 3, skipped: 1, errors: 1 });
    expect(recordRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: 'dedup', error: '1 user(s) failed' }),
    );
  });

  it('passes a custom entityTypes/threshold through to detection and enumeration', async () => {
    setMockData('entities', [personRow('a', 'u1', { entity_type: 'company' })]);

    await runDedupSweep({ entityTypes: ['company'], threshold: 0.9 });

    expect(emitMock).toHaveBeenCalledWith({ userId: 'u1', entityTypes: ['company'], threshold: 0.9 });
  });

  it('records an error run and does not throw when enumeration fails', async () => {
    // No 'entities' rows configured is fine; force enumeration to reject instead.
    const spy = jest
      .spyOn(require('../../../src/utils/supabase').supabase, 'from')
      .mockImplementationOnce(() => {
        throw new Error('db down');
      });

    const summary = await runDedupSweep();

    expect(summary).toEqual({ users: 0, created: 0, skipped: 0, errors: 1 });
    expect(emitMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: 'dedup', error: 'db down' }),
    );
    spy.mockRestore();
  });
});

describe('startDedupSweepScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    withLockMock.mockResolvedValue({ skipped: true });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does nothing when KMS_DEDUP_SWEEP_ENABLED is not set', () => {
    const handle = startDedupSweepScheduler();

    jest.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(handle).toBeNull();
    expect(withLockMock).not.toHaveBeenCalled();
  });

  it('runs the sweep immediately under the dedup lock when enabled', () => {
    process.env.KMS_DEDUP_SWEEP_ENABLED = 'true';

    const handle = startDedupSweepScheduler();

    expect(handle).not.toBeNull();
    expect(withLockMock).toHaveBeenCalledTimes(1);
    expect(withLockMock).toHaveBeenCalledWith('dedup', runDedupSweep);
    clearInterval(handle as NodeJS.Timeout);
  });

  it('re-runs the sweep on its configured interval', () => {
    process.env.KMS_DEDUP_SWEEP_ENABLED = 'true';
    process.env.KMS_DEDUP_SWEEP_INTERVAL_MINUTES = '10';

    const handle = startDedupSweepScheduler();
    withLockMock.mockClear();

    jest.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(withLockMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(withLockMock).toHaveBeenCalledWith('dedup', runDedupSweep);
    clearInterval(handle as NodeJS.Timeout);
  });
});
