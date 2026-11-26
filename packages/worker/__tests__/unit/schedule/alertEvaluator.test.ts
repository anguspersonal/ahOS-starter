/**
 * Unit tests for the exception-only alert evaluator (issue #573).
 *
 * The load-bearing test is `fires exactly once while the condition is held` —
 * that is the difference between an exception alert and the daily digest that
 * was rejected in #493 Q3. `utils/alerts.ts` only dedupes for 10 minutes in
 * memory, so without the durable crossing state a held breach would email every
 * single run.
 *
 * Resend is never reached: `src/utils/alerts` is mocked wholesale, so no test
 * here can send a real email.
 */

// Purpose-built Supabase fake. The shared __mocks__/supabase builder has no
// `gte`/`upsert`, and these tests need to assert exactly WHICH tables are
// touched (the "reads and emails, nothing else" acceptance criterion), so the
// fake records every access.
jest.mock('../../../src/utils/supabase', () => {
  const from = jest.fn();
  return { __esModule: true, supabase: { from }, default: { from } };
});
// No real email, ever.
jest.mock('../../../src/utils/alerts');
// scheduler_locks / scheduler_runs are cadence infrastructure, not the subject.
jest.mock('../../../src/schedule/lock');
jest.mock('../../../src/schedule/runLog');
// The sweep-outcome measurement loads @ahkms/core (ESM) at call time; it has its
// own unit test. Here it is a stub that reports "nothing missed" unless a test
// says otherwise, so every pre-#2270 test sees exactly the conditions it did.
jest.mock('../../../src/utils/sweepOutcome');

import { supabase } from '../../../src/utils/supabase';
import { logger } from '../../../src/utils/logger';
import { sendAlert } from '../../../src/utils/alerts';
import { withLock } from '../../../src/schedule/lock';
import { recordRun } from '../../../src/schedule/runLog';
import { getSweepOutcomes, type SweepOutcome } from '../../../src/utils/sweepOutcome';
import {
  decideAlert,
  resolveAlertConfig,
  daysBetween,
  DEFAULT_RITUAL_SILENT,
  DEFAULT_SOURCE_SILENT,
  RITUAL_SILENT_KEY,
  SOURCE_COVERAGE_KEY,
  sourceSilentKey,
  sweepMissedKey,
  sweepUnreadableKey,
} from '../../../src/schedule/alertConditions';
import {
  READABLE_TABLES,
  WRITABLE_TABLES,
  SYNTHESIS_MARKER_KINDS,
  getAlertUsers,
  getDaysSinceRitual,
  getSourceSilence,
  runAlertEvaluation,
  startAlertEvaluatorScheduler,
} from '../../../src/schedule/alertEvaluator';

const sendAlertMock = sendAlert as jest.MockedFunction<typeof sendAlert>;
const withLockMock = withLock as jest.MockedFunction<typeof withLock>;
const recordRunMock = recordRun as jest.MockedFunction<typeof recordRun>;
const getSweepOutcomesMock = getSweepOutcomes as jest.MockedFunction<typeof getSweepOutcomes>;
const fromMock = supabase.from as jest.MockedFunction<typeof supabase.from>;

// ── Fake DB ────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

interface FakeDb {
  tables: Record<string, Row[]>;
  /** Every `supabase.from(table)` call, in order. */
  reads: string[];
  /** Every table a mutating verb (upsert/insert/update/delete) was issued on. */
  writes: string[];
}

let db: FakeDb;

// Simulates PostgREST's `api.max_rows` config (`supabase/config.toml:18`,
// #780): the real server clamps the EFFECTIVE row count of any request —
// whether sized via `.limit()` or `.range()` — to this value regardless of
// what the caller asked for. Tests use this to prove the discovery scan's
// termination condition is "the page came back empty", not "the page came
// back shorter than requested" (see the shared mock's identical helper,
// `setMockServerRowCap`, in `__tests__/__mocks__/supabase.ts`). Reset to
// null by every `installFakeDb()` call.
let fakeServerRowCap: number | null = null;

function setFakeServerRowCap(cap: number | null) {
  fakeServerRowCap = cap;
}

/**
 * Splits a PostgREST `.or()` filter string on top-level commas — i.e. not
 * commas inside an `and(...)` group, which the composite-keyset-cursor
 * discovery scan (#786) uses for its tiebreaker clause.
 */
function splitTopLevelOrClauses(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

/** One `field.op.value` condition, e.g. `captured_at.lt.2026-08-01T00:00:00.000Z`. */
function parseOrCondition(condition: string): (row: Row) => boolean {
  const firstDot = condition.indexOf('.');
  const secondDot = condition.indexOf('.', firstDot + 1);
  const field = condition.slice(0, firstDot);
  const op = condition.slice(firstDot + 1, secondDot);
  // The value may itself contain dots (an ISO timestamp's fractional
  // seconds), so it's everything after the second dot, not a further split.
  const value = condition.slice(secondDot + 1);
  switch (op) {
    case 'eq':
      return (row) => String(row[field] ?? '') === value;
    case 'lt':
      return (row) => String(row[field] ?? '') < value;
    case 'lte':
      return (row) => String(row[field] ?? '') <= value;
    case 'gt':
      return (row) => String(row[field] ?? '') > value;
    case 'gte':
      return (row) => String(row[field] ?? '') >= value;
    default:
      throw new Error(`fake db .or(): unsupported operator "${op}" in "${condition}"`);
  }
}

/** One `.or()` clause: either a bare condition, or an `and(cond,cond,...)` group. */
function parseOrClause(clause: string): (row: Row) => boolean {
  if (clause.startsWith('and(') && clause.endsWith(')')) {
    const subConditions = splitTopLevelOrClauses(clause.slice(4, -1)).map(parseOrCondition);
    return (row) => subConditions.every((matches) => matches(row));
  }
  return parseOrCondition(clause);
}

function installFakeDb(tables: Record<string, Row[]>): FakeDb {
  db = { tables: { ...tables }, reads: [], writes: [] };
  fakeServerRowCap = null;

  fromMock.mockImplementation((table: string) => {
    db.reads.push(table);
    const state = {
      filters: [] as Array<(row: Row) => boolean>,
      // PostgREST applies order keys in call order, so this accumulates
      // rather than overwriting.
      order: [] as Array<{ field: string; ascending: boolean }>,
      limit: null as number | null,
      range: null as { from: number; to: number } | null,
    };

    const run = () => {
      // Fixtures in this file predate keyset pagination and don't set `id`;
      // synthesize a stable one from array position rather than forcing
      // every call site in this file to set one by hand. Derived fresh from
      // `db.tables[table]` each call, so it stays consistent across pages as
      // long as rows are only ever appended (true for every test here).
      let rows = [...(db.tables[table] || [])].map((row, idx) =>
        row.id !== undefined ? row : { ...row, id: `${table}-${String(idx).padStart(6, '0')}` },
      );
      for (const f of state.filters) rows = rows.filter(f);
      if (state.order.length > 0) {
        rows.sort((a, b) => {
          for (const { field, ascending } of state.order) {
            const av = String(a[field] ?? '');
            const bv = String(b[field] ?? '');
            const cmp = ascending ? av.localeCompare(bv) : bv.localeCompare(av);
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
      }

      // Resolve the requested window to an offset + row count, then clamp
      // that count to the simulated server cap — mirrors PostgREST, which
      // clamps the effective limit regardless of whether the caller sized
      // the request via `.range()` or `.limit()`.
      let offset = 0;
      let requestedCount: number | null = null;
      if (state.range) {
        offset = state.range.from;
        requestedCount = state.range.to - state.range.from + 1;
      } else if (state.limit !== null) {
        requestedCount = state.limit;
      }
      if (requestedCount !== null) {
        const effectiveCount =
          fakeServerRowCap !== null ? Math.min(requestedCount, fakeServerRowCap) : requestedCount;
        rows = rows.slice(offset, offset + effectiveCount);
      } else if (offset > 0) {
        rows = rows.slice(offset);
      }

      return { data: rows, error: null as null | { message: string } };
    };

    const builder: any = {
      select: () => builder,
      eq: (field: string, value: any) => {
        state.filters.push((row) => row[field] === value);
        return builder;
      },
      in: (field: string, values: any[]) => {
        state.filters.push((row) => values.includes(row[field]));
        return builder;
      },
      gte: (field: string, value: any) => {
        state.filters.push((row) => String(row[field]) >= String(value));
        return builder;
      },
      // The `id` keyset cursor (#780) — mirrors `.gte()`, strict inequality.
      gt: (field: string, value: any) => {
        state.filters.push((row) => String(row[field]) > String(value));
        return builder;
      },
      // The composite `(captured_at, id)` keyset cursor's tiebreaker filter
      // (#786) — parses PostgREST's `field.op.value` / `and(...)` syntax.
      or: (filter: string) => {
        const clauses = splitTopLevelOrClauses(filter).map(parseOrClause);
        state.filters.push((row) => clauses.some((matches) => matches(row)));
        return builder;
      },
      order: (field: string, options?: { ascending?: boolean }) => {
        state.order.push({ field, ascending: options?.ascending !== false });
        return builder;
      },
      limit: (n: number) => {
        state.limit = n;
        return builder;
      },
      range: (from: number, to: number) => {
        state.range = { from, to };
        return builder;
      },
      upsert: (row: Row, options?: { onConflict?: string }) => {
        db.writes.push(table);
        const keys = (options?.onConflict ?? 'id').split(',').map((k) => k.trim());
        const existing = (db.tables[table] || []).find((candidate) =>
          keys.every((k) => candidate[k] === row[k]),
        );
        if (existing) Object.assign(existing, row);
        else (db.tables[table] = db.tables[table] || []).push({ ...row });
        return Promise.resolve({ data: [row], error: null });
      },
      insert: (row: Row) => {
        db.writes.push(table);
        (db.tables[table] = db.tables[table] || []).push({ ...row });
        return Promise.resolve({ data: [row], error: null });
      },
      update: () => {
        db.writes.push(table);
        return Promise.resolve({ data: [], error: null });
      },
      delete: () => {
        db.writes.push(table);
        return Promise.resolve({ data: [], error: null });
      },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
      catch: (reject: any) => Promise.resolve(run()).catch(reject),
    };
    return builder;
  });

  return db;
}

const USER = '11111111-1111-1111-1111-111111111111';

function prefsRow(exceptionAlerts: unknown, userId = USER): Row {
  return {
    user_id: userId,
    notification_preferences: { daily_summary: false, exception_alerts: exceptionAlerts },
  };
}

function marker(createdAt: string, kind = 'synthesized', userId = USER): Row {
  return { user_id: userId, kind, created_at: createdAt, external_id: 'page-1' };
}

function artifact(capturedAt: string, surface: string, userId = USER): Row {
  return { user_id: userId, surface, captured_at: capturedAt };
}

function day(n: number): Date {
  // 2026-08-01T12:00:00Z + n days
  return new Date(Date.UTC(2026, 7, 1 + n, 12, 0, 0));
}

/** The happy path: Resend accepted the message. */
const DELIVERED = { delivered: true, channel: 'resend' } as const;
/** RESEND_API_KEY missing — the H1 scenario. */
const UNDELIVERED = {
  delivered: false,
  channel: 'none',
  reason: 'not_configured',
  detail: 'no delivery method',
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  sendAlertMock.mockResolvedValue(DELIVERED);
  recordRunMock.mockResolvedValue(undefined);
  getSweepOutcomesMock.mockResolvedValue([]);
  delete process.env.KMS_ALERT_EVALUATOR_ENABLED;
  delete process.env.KMS_ALERT_EVALUATOR_INTERVAL_MINUTES;
  installFakeDb({});
});

// ── The crossing/re-arm rule (pure) ────────────────────────────────────────

describe('decideAlert', () => {
  it('fires on the first breach when there is no stored state', () => {
    expect(decideAlert(6, 6, null)).toEqual({
      outcome: 'fire',
      shouldSend: true,
      nextArmed: false,
      breached: true,
    });
  });

  it('stays silent while the condition is merely HELD', () => {
    const disarmed = { armed: false, lastValue: 6, lastFiredAt: 'x', lastFiredValue: 6 };
    expect(decideAlert(30, 6, disarmed)).toEqual({
      outcome: 'held',
      shouldSend: false,
      nextArmed: false,
      breached: true,
    });
  });

  it('re-arms only when the condition clears', () => {
    const disarmed = { armed: false, lastValue: 9, lastFiredAt: 'x', lastFiredValue: 9 };
    expect(decideAlert(0, 6, disarmed)).toEqual({
      outcome: 'rearm',
      shouldSend: false,
      nextArmed: true,
      breached: false,
    });
  });

  it('treats an unmeasurable signal as neither breach nor clear', () => {
    const disarmed = { armed: false, lastValue: 9, lastFiredAt: 'x', lastFiredValue: 9 };
    expect(decideAlert(null, 6, disarmed)).toEqual({
      outcome: 'clear',
      shouldSend: false,
      nextArmed: false,
      breached: false,
    });
    expect(decideAlert(null, 6, null).nextArmed).toBe(true);
  });

  it('does not re-fire just because the value keeps growing', () => {
    let state = { armed: true, lastValue: null, lastFiredAt: null, lastFiredValue: null } as any;
    const sends: boolean[] = [];
    for (const value of [6, 7, 20, 100, 1000]) {
      const decision = decideAlert(value, 6, state);
      sends.push(decision.shouldSend);
      state = { ...state, armed: decision.nextArmed };
    }
    expect(sends).toEqual([true, false, false, false, false]);
  });
});

describe('resolveAlertConfig', () => {
  it('fills in defaults when the blob is absent', () => {
    const config = resolveAlertConfig(undefined);
    expect(config.enabled).toBe(true);
    expect(config.ritualSilent).toEqual(DEFAULT_RITUAL_SILENT);
    expect(config.sourceSilent).toEqual(DEFAULT_SOURCE_SILENT);
  });

  it('takes thresholds and switches from the DB blob (ADR-030: no deploy needed)', () => {
    const config = resolveAlertConfig({
      enabled: false,
      ritual_silent: { enabled: false, threshold_days: 14 },
      source_silent: { threshold_days: 3, sources: ['gmail_ingest', ' drive '] },
    });
    expect(config.enabled).toBe(false);
    expect(config.ritualSilent).toEqual({ enabled: false, threshold_days: 14 });
    expect(config.sourceSilent.threshold_days).toBe(3);
    expect(config.sourceSilent.sources).toEqual(['gmail_ingest', 'drive']);
  });

  it('falls back to defaults rather than throwing on a malformed blob', () => {
    const config = resolveAlertConfig({
      enabled: 'yes',
      ritual_silent: { threshold_days: -4 },
      source_silent: { sources: 'gmail' },
    });
    expect(config.enabled).toBe(true);
    expect(config.ritualSilent.threshold_days).toBe(DEFAULT_RITUAL_SILENT.threshold_days);
    expect(config.sourceSilent.sources).toEqual([]);
  });
});

describe('daysBetween', () => {
  it('floors to whole days', () => {
    expect(daysBetween(day(0), day(6))).toBe(6);
    expect(daysBetween(new Date(Date.UTC(2026, 7, 1, 23, 0)), day(6))).toBe(5);
  });
});

// ── Signals ────────────────────────────────────────────────────────────────

describe('getDaysSinceRitual', () => {
  it("counts the unattended sweep's marker, not just the kind the ritual writes", async () => {
    expect(SYNTHESIS_MARKER_KINDS).toEqual(['synthesized', 'synthesized_unattended']);

    // The most recent synthesis marker is the UNATTENDED one, so if the read set ever
    // narrowed to the written kind this would fall back to day(0) and report 10 — the
    // "swept atoms present as unconsumed forever" failure ADR-050 §6 names.
    installFakeDb({
      artifact_external_links: [
        marker(day(0).toISOString(), 'synthesized'),
        marker(day(4).toISOString(), 'synthesized_unattended'),
        marker(day(9).toISOString(), 'task'), // not a synthesis marker
      ],
    });

    await expect(getDaysSinceRitual(USER, day(10))).resolves.toBe(6);
  });

  it('returns null when the ritual has never run (a fresh install is not an exception)', async () => {
    installFakeDb({ artifact_external_links: [marker(day(0).toISOString(), 'task')] });
    await expect(getDaysSinceRitual(USER, day(30))).resolves.toBeNull();
  });

  it('counts evidence_aggregated and evidence_aggregated_unattended as ritual closure (#2227)', async () => {
    installFakeDb({
      artifact_external_links: [
        marker(day(0).toISOString(), 'synthesized'),
        marker(day(8).toISOString(), 'evidence_aggregated_unattended'),
      ],
    });
    await expect(getDaysSinceRitual(USER, day(10))).resolves.toBe(2);

    installFakeDb({
      artifact_external_links: [
        marker(day(0).toISOString(), 'synthesized'),
        marker(day(9).toISOString(), 'evidence_aggregated'),
      ],
    });
    await expect(getDaysSinceRitual(USER, day(10))).resolves.toBe(1);
  });
});

describe('getSourceSilence', () => {
  it('probes each explicitly configured source, reporting never-seen as null', async () => {
    installFakeDb({
      artifacts: [artifact(day(2).toISOString(), 'gmail_ingest')],
    });

    const result = await getSourceSilence(
      USER,
      { ...DEFAULT_SOURCE_SILENT, sources: ['gmail_ingest', 'drive_ingest'] },
      day(11),
    );

    expect(result.discoveryTruncated).toBe(false);
    expect(result.sources).toEqual([
      { surface: 'gmail_ingest', daysSince: 9 },
      { surface: 'drive_ingest', daysSince: null },
    ]);
  });

  it('auto-discovers live surfaces and ignores one-off ones below min_observations', async () => {
    installFakeDb({
      artifacts: [
        artifact(day(0).toISOString(), 'gmail_ingest'),
        artifact(day(1).toISOString(), 'gmail_ingest'),
        artifact(day(2).toISOString(), 'gmail_ingest'),
        artifact(day(3).toISOString(), 'one_off_surface'),
      ],
    });

    const result = await getSourceSilence(USER, { ...DEFAULT_SOURCE_SILENT }, day(10));

    expect(result.sources).toEqual([{ surface: 'gmail_ingest', daysSince: 8 }]);
  });
});

// ── Config gating ──────────────────────────────────────────────────────────

describe('getAlertUsers', () => {
  it('skips users whose DB config disables alerts', async () => {
    installFakeDb({
      user_preferences: [
        prefsRow({ enabled: false }),
        prefsRow(undefined, '22222222-2222-2222-2222-222222222222'),
      ],
    });

    const users = await getAlertUsers();

    expect(users.map((u) => u.userId)).toEqual(['22222222-2222-2222-2222-222222222222']);
  });
});

// ── THE acceptance criterion: one email per crossing ───────────────────────

// ── The nightly sweep's outcome (#2270) ────────────────────────────────────

describe('runAlertEvaluation — dos sweep outcome (#2270)', () => {
  const quiet = { ritual_silent: { enabled: false }, source_silent: { enabled: false } };
  const sweep = (
    domain: string,
    missed: Array<{ date: string; atoms: number }> | null,
    error: string | null = null,
  ): SweepOutcome => ({ domain, from: '2026-11-13', to: '2026-11-17', missed, error });
  const stateFor = (key: string) =>
    db.tables.alert_condition_state.find((r) => r.condition_key === key);

  beforeEach(() => {
    installFakeDb({ user_preferences: [prefsRow(quiet)], alert_condition_state: [] });
  });

  it('measures the user through the read allowlist, at the evaluation clock', async () => {
    await runAlertEvaluation({ now: day(3) });

    expect(getSweepOutcomesMock).toHaveBeenCalledTimes(1);
    const [userId, now, client] = getSweepOutcomesMock.mock.calls[0];
    expect(userId).toBe(USER);
    expect(now).toEqual(day(3));
    // The coverage read may only reach allowlisted tables, like everything else here.
    expect(() => client.from('artifacts')).not.toThrow();
    expect(() => client.from('entities')).toThrow(/non-allowlisted/);
  });

  it('sends nothing while every day is closed', async () => {
    getSweepOutcomesMock.mockResolvedValue([sweep('work', []), sweep('angus', [])]);

    await runAlertEvaluation({ now: day(1) });

    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(stateFor(sweepMissedKey('work'))).toMatchObject({ armed: true, last_value: 0 });
  });

  // The whole point: one email when days first go missing, not one a day.
  it('emails ONCE when days go missing and stays silent while they stay missing', async () => {
    getSweepOutcomesMock.mockResolvedValue([
      sweep('work', [
        { date: '2026-11-13', atoms: 3 },
        { date: '2026-11-14', atoms: 1 },
      ]),
      sweep('angus', []),
    ]);

    for (let d = 1; d <= 6; d++) await runAlertEvaluation({ now: day(d) });

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const [, subject, message] = sendAlertMock.mock.calls[0];
    expect(subject).toBe('[ahOS] dos sweep missed 2 day(s) in work');
    expect(message).toContain('2026-11-13 (3 atoms)');
    expect(message).toContain('2026-11-14 (1 atoms)');
    expect(stateFor(sweepMissedKey('work'))).toMatchObject({ armed: false, last_value: 2 });
    expect(stateFor(sweepMissedKey('angus'))).toMatchObject({ armed: true });
  });

  it('re-arms once every missed day is closed, and fires again on a new miss', async () => {
    getSweepOutcomesMock.mockResolvedValue([sweep('work', [{ date: '2026-11-13', atoms: 3 }])]);
    await runAlertEvaluation({ now: day(1) });
    await runAlertEvaluation({ now: day(2) });
    expect(sendAlertMock).toHaveBeenCalledTimes(1);

    getSweepOutcomesMock.mockResolvedValue([sweep('work', [])]);
    await runAlertEvaluation({ now: day(3) });
    expect(stateFor(sweepMissedKey('work'))).toMatchObject({ armed: true });

    getSweepOutcomesMock.mockResolvedValue([sweep('work', [{ date: '2026-11-18', atoms: 2 }])]);
    await runAlertEvaluation({ now: day(4) });
    expect(sendAlertMock).toHaveBeenCalledTimes(2);
  });

  // November 2026: the coverage read timed out, so nothing could be measured.
  it('reports an unreadable window as its own alert and never as "nothing missed"', async () => {
    getSweepOutcomesMock.mockResolvedValue([
      sweep('work', null, 'Coverage artifact lookup failed: canceling statement due to statement timeout.'),
    ]);

    for (let d = 1; d <= 3; d++) await runAlertEvaluation({ now: day(d) });

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const [, subject, message] = sendAlertMock.mock.calls[0];
    expect(subject).toBe('[ahOS] dos sweep coverage cannot be read in work');
    expect(message).toContain('statement timeout');
    expect(stateFor(sweepUnreadableKey('work'))).toMatchObject({ armed: false, last_value: 1 });
    // Unmeasured, so the missed-days condition neither fired nor recorded a clean zero.
    expect(stateFor(sweepMissedKey('work'))).toMatchObject({ armed: true, last_value: null });
  });

  it('coalesces both domains missing on the same run into one email', async () => {
    getSweepOutcomesMock.mockResolvedValue([
      sweep('work', [{ date: '2026-11-13', atoms: 3 }]),
      sweep('angus', [{ date: '2026-11-13', atoms: 3 }]),
    ]);

    await runAlertEvaluation({ now: day(1) });

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][1]).toBe('[ahOS] 2 exception alerts crossed together');
    expect(sendAlertMock.mock.calls[0][2]).toContain('dos sweep missed 1 day(s) in work');
    expect(sendAlertMock.mock.calls[0][2]).toContain('dos sweep missed 1 day(s) in angus');
  });

  it('is off when the master switch is off', async () => {
    installFakeDb({ user_preferences: [prefsRow({ enabled: false })], alert_condition_state: [] });
    getSweepOutcomesMock.mockResolvedValue([sweep('work', [{ date: '2026-11-13', atoms: 3 }])]);

    await runAlertEvaluation({ now: day(1) });

    expect(getSweepOutcomesMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('still writes only its own crossing state', async () => {
    getSweepOutcomesMock.mockResolvedValue([sweep('work', [{ date: '2026-11-13', atoms: 3 }])]);

    await runAlertEvaluation({ now: day(1) });

    expect([...new Set(db.writes)]).toEqual(['alert_condition_state']);
  });
});

describe('runAlertEvaluation — crossing vs held', () => {
  it('fires exactly ONE email when the ritual-silent condition is held over 10 consecutive runs', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      // Last ritual on day 0. Threshold defaults to 6 days.
      artifact_external_links: [marker(day(0).toISOString())],
      artifacts: [],
      alert_condition_state: [],
    });

    for (let d = 5; d <= 14; d++) {
      await runAlertEvaluation({ now: day(d) });
    }

    // Day 5 is below threshold; days 6..14 are all breached. A naive evaluator
    // would have sent nine emails.
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toBe('warning');
    expect(sendAlertMock.mock.calls[0][1]).toContain('ritual silent for 6 days');

    const state = db.tables.alert_condition_state.find(
      (r) => r.condition_key === RITUAL_SILENT_KEY,
    );
    expect(state).toMatchObject({ armed: false, last_value: 14 });
  });

  it('re-arms after the condition clears and fires again on the next crossing', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      artifact_external_links: [marker(day(0).toISOString())],
      artifacts: [],
      alert_condition_state: [],
    });

    for (let d = 6; d <= 9; d++) await runAlertEvaluation({ now: day(d) });
    expect(sendAlertMock).toHaveBeenCalledTimes(1);

    // The owner runs the ritual on day 10 — the condition clears and re-arms.
    db.tables.artifact_external_links.push(marker(day(10).toISOString()));
    await runAlertEvaluation({ now: day(10) });
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(
      db.tables.alert_condition_state.find((r) => r.condition_key === RITUAL_SILENT_KEY),
    ).toMatchObject({ armed: true });

    // Silence again, crossing the threshold a second time.
    for (let d = 16; d <= 20; d++) await runAlertEvaluation({ now: day(d) });
    expect(sendAlertMock).toHaveBeenCalledTimes(2);
  });

  it('honours a DB threshold override without a deploy', async () => {
    installFakeDb({
      user_preferences: [
        prefsRow({ ritual_silent: { threshold_days: 30 }, source_silent: { enabled: false } }),
      ],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });

    for (let d = 6; d <= 20; d++) await runAlertEvaluation({ now: day(d) });

    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('never fires when the ritual has never run', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      artifact_external_links: [],
      alert_condition_state: [],
    });

    for (let d = 6; d <= 20; d++) await runAlertEvaluation({ now: day(d) });

    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('tracks each watched source independently and fires once per source crossing', async () => {
    installFakeDb({
      user_preferences: [
        prefsRow({
          ritual_silent: { enabled: false },
          source_silent: { threshold_days: 7, sources: ['gmail_ingest', 'drive_ingest'] },
        }),
      ],
      artifacts: [
        artifact(day(0).toISOString(), 'gmail_ingest'),
        artifact(day(3).toISOString(), 'drive_ingest'),
      ],
      alert_condition_state: [],
    });

    for (let d = 7; d <= 20; d++) await runAlertEvaluation({ now: day(d) });

    expect(sendAlertMock).toHaveBeenCalledTimes(2);
    const subjects = sendAlertMock.mock.calls.map((c) => c[1]);
    expect(subjects[0]).toContain('"gmail_ingest" silent for 7 days');
    expect(subjects[1]).toContain('"drive_ingest" silent for 7 days');
    expect(
      db.tables.alert_condition_state.map((r) => r.condition_key).sort(),
    ).toEqual([
      SOURCE_COVERAGE_KEY,
      sourceSilentKey('drive_ingest'),
      sourceSilentKey('gmail_ingest'),
    ]);
  });

  it('reports run outcomes to scheduler_runs under the alerts cadence', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });

    await runAlertEvaluation({ now: day(9) });

    expect(recordRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: 'alerts',
        error: undefined,
        counts: expect.objectContaining({ users: 1, conditions: 1, fired: 1 }),
      }),
    );
  });

  it('isolates per-user failures and records an error run', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });
    const original = fromMock.getMockImplementation()!;
    fromMock.mockImplementation((table: string) => {
      if (table === 'artifact_external_links') throw new Error('db down');
      return original(table);
    });

    const summary = await runAlertEvaluation({ now: day(9) });

    expect(summary.errors).toBe(1);
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: 'alerts', error: '1 user(s) failed' }),
    );
  });
});

// ── Write boundary: reads and emails, nothing else ─────────────────────────

describe('write boundary', () => {
  it('declares exactly one writable table, and no synthesis path is on it', () => {
    expect([...WRITABLE_TABLES]).toEqual(['alert_condition_state']);
    for (const synthesisTable of [
      'artifacts',
      'artifact_external_links',
      'artifact_entity_links',
      'entities',
      'user_tasks',
      'system_decisions',
      'user_preferences',
    ]) {
      expect(WRITABLE_TABLES as readonly string[]).not.toContain(synthesisTable);
    }
  });

  // NOTE ON SCOPE (review round 1, L2): `lock` and `runLog` are mocked at the
  // top of this file, so the scheduler_locks UPDATE and scheduler_runs INSERT
  // the evaluator genuinely performs never reach `db.writes`. What this test
  // proves is narrower than "the process writes one table": it proves the
  // evaluator's OWN Supabase access is confined to the allowlist. Neither
  // scheduler table is a synthesis path, so AC #5 still holds — but the name
  // says what is actually asserted.
  it('confines its own Supabase access to the allowlist (scheduler infra is mocked out)', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { sources: ['gmail_ingest'] } })],
      artifact_external_links: [marker(day(0).toISOString())],
      artifacts: [artifact(day(0).toISOString(), 'gmail_ingest')],
      alert_condition_state: [],
    });

    await runAlertEvaluation({ now: day(20) });

    // Ritual + source both crossed on this run, so delivery coalesces to one
    // email (H3) while both conditions disarm independently.
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    for (const table of db.reads) {
      expect(READABLE_TABLES as readonly string[]).toContain(table);
    }
    expect([...new Set(db.writes)]).toEqual(['alert_condition_state']);
  });
});

// ── H1: an undelivered alert must not be recorded as fired ─────────────────

describe('delivery gating (review round 1, H1)', () => {
  const heldSilentDb = () =>
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });

  it('leaves the condition ARMED when the send is not delivered, and retries next run', async () => {
    heldSilentDb();
    sendAlertMock.mockResolvedValue(UNDELIVERED);

    for (let d = 6; d <= 9; d++) await runAlertEvaluation({ now: day(d) });

    // It tried on every run rather than going quiet after the first.
    expect(sendAlertMock).toHaveBeenCalledTimes(4);
    const state = db.tables.alert_condition_state.find(
      (r) => r.condition_key === RITUAL_SILENT_KEY,
    );
    // Still armed, and the DB does NOT claim an alert fired.
    expect(state).toMatchObject({ armed: true, last_fired_at: null, last_fired_value: null });
  });

  it('fires exactly once when delivery starts working, not once per missed run', async () => {
    heldSilentDb();
    sendAlertMock.mockResolvedValue(UNDELIVERED);
    for (let d = 6; d <= 9; d++) await runAlertEvaluation({ now: day(d) });

    // The owner sets RESEND_API_KEY.
    sendAlertMock.mockResolvedValue(DELIVERED);
    for (let d = 10; d <= 20; d++) await runAlertEvaluation({ now: day(d) });

    const deliveredCalls = sendAlertMock.mock.calls.length;
    expect(deliveredCalls).toBe(4 + 1); // 4 failed attempts, then one success
    expect(
      db.tables.alert_condition_state.find((r) => r.condition_key === RITUAL_SILENT_KEY),
    ).toMatchObject({ armed: false });
  });

  it('records an undelivered crossing as an error run rather than a quiet one', async () => {
    heldSilentDb();
    sendAlertMock.mockResolvedValue(UNDELIVERED);

    const summary = await runAlertEvaluation({ now: day(9) });

    expect(summary.fired).toBe(0);
    expect(summary.send_failures).toBe(1);
    expect(summary.emails).toBe(0);
    expect(recordRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: 'alerts',
        error: expect.stringContaining('undelivered'),
      }),
    );
  });
});

// ── H3: a correlated outage is one email, not N ────────────────────────────

describe('fan-out coalescing (review round 1, H3)', () => {
  it('sends ONE email when the ritual and every watched surface cross together', async () => {
    const surfaces = ['gmail_ingest', 'drive_ingest', 'slack', 'notion', 'web', 'mobile'];
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { threshold_days: 7, sources: surfaces } })],
      artifact_external_links: [marker(day(0).toISOString())],
      // One shared cause: everything stopped on day 0.
      artifacts: surfaces.map((s) => artifact(day(0).toISOString(), s)),
      alert_condition_state: [],
    });

    const summary = await runAlertEvaluation({ now: day(10) });

    // 7 conditions crossed (ritual + 6 surfaces) — but exactly one email.
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(summary.emails).toBe(1);
    expect(summary.fired).toBe(7);

    const [, subject, message] = sendAlertMock.mock.calls[0];
    expect(subject).toContain('7 exception alerts crossed together');
    for (const surface of surfaces) expect(message).toContain(surface);
    expect(message).toContain('ritual');

    // Each condition still disarmed on its own row.
    const disarmed = db.tables.alert_condition_state.filter((r) => r.armed === false);
    expect(disarmed).toHaveLength(7);
  });

  it('keeps the single-condition email unchanged when only one crosses', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { enabled: false } })],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });

    await runAlertEvaluation({ now: day(9) });

    expect(sendAlertMock.mock.calls[0][1]).toContain('ritual silent for 9 days');
    expect(sendAlertMock.mock.calls[0][1]).not.toContain('crossed together');
  });
});

// ── H1 × H3: the coalesced send fails, so NOTHING may disarm ───────────────
//
// Delivery is all-or-nothing per user per run (H3 merges a run's crossings into
// one sendAlert), and H1 says an undelivered crossing stays armed. Their
// intersection is the whole retry story for a correlated outage — the case where
// the most conditions are outstanding is exactly the case where losing them
// costs most — and each half was previously tested only on its own (round 2, G2).

describe('undelivered fan-out (review round 2, G2)', () => {
  const surfaces = ['gmail_ingest', 'drive_ingest', 'slack', 'notion', 'web', 'mobile'];
  /** The 7 conditions that cross: the ritual plus every watched surface. */
  const CROSSING_KEYS = [RITUAL_SILENT_KEY, ...surfaces.map((s) => `source_silent:${s}`)];

  const outageDb = () =>
    installFakeDb({
      user_preferences: [prefsRow({ source_silent: { threshold_days: 7, sources: surfaces } })],
      artifact_external_links: [marker(day(0).toISOString())],
      // One shared cause: everything stopped on day 0.
      artifacts: surfaces.map((s) => artifact(day(0).toISOString(), s)),
      alert_condition_state: [],
    });

  const crossingRows = () =>
    db.tables.alert_condition_state.filter((r) => CROSSING_KEYS.includes(r.condition_key));

  it('leaves ALL 7 conditions armed when the coalesced send fails', async () => {
    outageDb();
    sendAlertMock.mockResolvedValue(UNDELIVERED);

    const summary = await runAlertEvaluation({ now: day(10) });

    // One coalesced attempt, and not one condition recorded as fired.
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(summary.emails).toBe(0);
    expect(summary.fired).toBe(0);
    expect(summary.send_failures).toBe(7);

    // Every crossing still armed, and none of them claims a fire.
    const rows = crossingRows();
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row).toMatchObject({ armed: true, last_fired_at: null, last_fired_value: null });
    }
  });

  it('sends exactly ONE email for all 7 once delivery recovers', async () => {
    outageDb();
    sendAlertMock.mockResolvedValue(UNDELIVERED);

    // Four failed runs: one attempt each, nothing lost, nothing disarmed.
    for (let d = 10; d <= 13; d++) await runAlertEvaluation({ now: day(d) });
    expect(sendAlertMock).toHaveBeenCalledTimes(4);

    // The owner sets RESEND_API_KEY.
    sendAlertMock.mockResolvedValue(DELIVERED);
    for (let d = 14; d <= 25; d++) await runAlertEvaluation({ now: day(d) });

    // 4 failed attempts + exactly one success — not one email per missed run,
    // and not one per condition.
    expect(sendAlertMock).toHaveBeenCalledTimes(4 + 1);

    const recovered = sendAlertMock.mock.calls[4];
    expect(recovered[1]).toContain('7 exception alerts crossed together');

    // All 7 disarmed together on the single confirmed send.
    const rows = crossingRows();
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.armed).toBe(false);
  });

  it('does not disturb a condition that never crossed', async () => {
    // Coverage is healthy here (6 surfaces are measurable), so it must ride
    // through the failed run untouched — a failure may not manufacture state.
    outageDb();
    sendAlertMock.mockResolvedValue(UNDELIVERED);

    await runAlertEvaluation({ now: day(10) });

    const coverage = db.tables.alert_condition_state.find(
      (r) => r.condition_key === 'source_coverage_degraded',
    );
    expect(coverage).toMatchObject({ armed: true, last_fired_at: null, last_fired_value: null });
  });
});

// ── M1: a threshold raise is not a clear ───────────────────────────────────

describe('threshold changes (review round 1, M1)', () => {
  it('does NOT re-arm when the threshold is raised above an uncleared breach', async () => {
    const prefs = prefsRow({
      ritual_silent: { threshold_days: 6 },
      source_silent: { enabled: false },
    });
    installFakeDb({
      user_preferences: [prefs],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });

    await runAlertEvaluation({ now: day(10) });
    expect(sendAlertMock).toHaveBeenCalledTimes(1);

    // The owner quietens it by raising the threshold — without running the ritual.
    prefs.notification_preferences.exception_alerts.ritual_silent.threshold_days = 20;

    for (let d = 11; d <= 40; d++) await runAlertEvaluation({ now: day(d) });

    // Still exactly one email for one uninterrupted stretch of silence: the
    // condition never cleared, so day 20 must not produce a second.
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
  });

  it('still re-arms when the ritual actually runs, even after a threshold raise', async () => {
    const prefs = prefsRow({
      ritual_silent: { threshold_days: 6 },
      source_silent: { enabled: false },
    });
    installFakeDb({
      user_preferences: [prefs],
      artifact_external_links: [marker(day(0).toISOString())],
      alert_condition_state: [],
    });

    await runAlertEvaluation({ now: day(10) });
    prefs.notification_preferences.exception_alerts.ritual_silent.threshold_days = 20;

    // A genuine clear: the value drops because the event happened.
    db.tables.artifact_external_links.push(marker(day(12).toISOString()));
    await runAlertEvaluation({ now: day(12) });

    expect(
      db.tables.alert_condition_state.find((r) => r.condition_key === RITUAL_SILENT_KEY),
    ).toMatchObject({ armed: true });

    for (let d = 33; d <= 40; d++) await runAlertEvaluation({ now: day(d) });
    expect(sendAlertMock).toHaveBeenCalledTimes(2);
  });
});

// ── M2/M3: a watcher that watches nothing must say so ──────────────────────

describe('source coverage (review round 1, M2 + M3)', () => {
  it('alerts when source_silent is enabled but no surface is measurable', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ ritual_silent: { enabled: false } })],
      // Artifacts exist, but none carries a `surface` — the #570 state.
      artifacts: [
        { user_id: USER, surface: null, captured_at: day(0).toISOString() },
        { user_id: USER, surface: null, captured_at: day(1).toISOString() },
      ],
      alert_condition_state: [],
    });

    for (let d = 2; d <= 10; d++) await runAlertEvaluation({ now: day(d) });

    // Exactly one email — the coverage warning — not one per run, and not silence.
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][1]).toContain('watching nothing');
    // The copy points at the real cause rather than leaving it a mystery.
    expect(String(sendAlertMock.mock.calls[0][3]?.suggestedAction)).toContain('#570');
    expect(
      db.tables.alert_condition_state.find((r) => r.condition_key === SOURCE_COVERAGE_KEY),
    ).toMatchObject({ armed: false });
  });

  it('stays quiet, and re-arms, once a surface becomes measurable', async () => {
    installFakeDb({
      user_preferences: [prefsRow({ ritual_silent: { enabled: false } })],
      artifacts: [{ user_id: USER, surface: null, captured_at: day(0).toISOString() }],
      alert_condition_state: [],
    });

    await runAlertEvaluation({ now: day(1) });
    expect(sendAlertMock).toHaveBeenCalledTimes(1);

    // #570 lands: surfaces start being stamped.
    for (let i = 0; i < 3; i++) {
      db.tables.artifacts.push(artifact(day(2).toISOString(), 'drive_ingest'));
    }
    await runAlertEvaluation({ now: day(2) });

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(
      db.tables.alert_condition_state.find((r) => r.condition_key === SOURCE_COVERAGE_KEY),
    ).toMatchObject({ armed: true });
  });

  it('pages through discovery so the most-silent surfaces are not truncated away', async () => {
    // 1200 rows > one page. The quiet surface's only artifacts are the OLDEST
    // in the window, so a single newest-first page would have dropped them.
    const rows: Row[] = [];
    for (let i = 0; i < 3; i++) rows.push(artifact(day(1).toISOString(), 'quiet_surface'));
    for (let i = 0; i < 1200; i++) {
      rows.push(artifact(new Date(day(40).getTime() + i * 1000).toISOString(), 'busy_surface'));
    }
    installFakeDb({ artifacts: rows });

    const result = await getSourceSilence(USER, { ...DEFAULT_SOURCE_SILENT }, day(50));

    expect(result.discoveryTruncated).toBe(false);
    expect(result.sources.map((s) => s.surface).sort()).toEqual([
      'busy_surface',
      'quiet_surface',
    ]);
    expect(result.sources.find((s) => s.surface === 'quiet_surface')?.daysSince).toBe(49);
  });
});

describe('discovery scan pagination (#780)', () => {
  // #780: `alertEvaluator.ts`'s discovery scan had the same #401-class defect
  // as `dedupSweep.ts`'s `getActiveUserIds` (#401) and `analyze.ts`'s
  // `getUsersWithRecentEdits` (#763) — `rows.length < DISCOVERY_PAGE_SIZE`
  // treats a short page as "table exhausted", which is only true when the
  // server honours the requested page size exactly. `DISCOVERY_PAGE_SIZE`
  // (1000) equals the local `api.max_rows` (`supabase/config.toml:18`), so
  // it worked today by coincidence; the hosted project's `max_rows` is a
  // separate, unversioned setting that can legitimately sit lower.
  it('does not truncate when the server clamps every page below the requested page size', async () => {
    // Reproduces the QA finding that sank #401's first draft, applied to
    // this call site: simulate api.max_rows sitting BELOW DISCOVERY_PAGE_SIZE
    // so every page this fetches comes back short of what it asked for. The
    // old short-page check would treat that as "table exhausted" and stop —
    // here, after page one, having scanned only 500 of the 1203 total rows.
    //
    // 'quiet_surface' is pushed AFTER the 1200 'busy_surface' rows so its
    // rows sit at the END of the keyset walk (ascending `id`, i.e. array
    // position in this fake) — exactly what the old bug would never reach.
    // If this regressed to short-page termination, 'quiet_surface' would be
    // silently missing from `sources` even though `busy_surface` still
    // showed up, which is precisely the kind of "it looks like it worked"
    // failure #401/#763/#780 are all about.
    const rows: Row[] = [];
    for (let i = 0; i < 1200; i++) {
      rows.push(artifact(new Date(day(40).getTime() + i * 1000).toISOString(), 'busy_surface'));
    }
    for (let i = 0; i < 3; i++) rows.push(artifact(day(1).toISOString(), 'quiet_surface'));
    installFakeDb({ artifacts: rows });
    setFakeServerRowCap(500);

    const result = await getSourceSilence(USER, { ...DEFAULT_SOURCE_SILENT }, day(50));

    expect(result.discoveryTruncated).toBe(false);
    expect(result.sources.map((s) => s.surface).sort()).toEqual([
      'busy_surface',
      'quiet_surface',
    ]);
    expect(result.sources.find((s) => s.surface === 'quiet_surface')?.daysSince).toBe(49);
  });

  it('still honours its own deliberate DISCOVERY_ROW_CAP, reports discoveryTruncated, but now reports the newest-first slice it saw (#786)', async () => {
    // Distinguishes the product-level row cap from the server-cap fix above:
    // a scan that legitimately exceeds DISCOVERY_ROW_CAP (50,000) rows must
    // still stop (it is a bounded scan by design) and say so, rather than
    // the #780 fix accidentally making it unbounded.
    //
    // `buried_old_surface`'s 3 rows are the OLDEST in the window;
    // `filler_surface`'s 50,000 rows are all newer. Under the composite
    // `captured_at DESC` cursor (#786), the retained (first) 50,000 rows are
    // exactly `filler_surface`'s — the newest-first slice — so it is reported
    // correctly rather than the whole run going silent (#785's fail-safe).
    // `buried_old_surface` falls entirely outside that slice and is omitted,
    // not falsely reported — the same documented, known omission bias the
    // original pre-#780 `captured_at DESC` scan had.
    const rows: Row[] = [];
    for (let i = 0; i < 3; i++) rows.push(artifact(day(1).toISOString(), 'buried_old_surface'));
    for (let i = 0; i < 50_000; i++) {
      rows.push(artifact(new Date(day(2).getTime() + i * 1000).toISOString(), 'filler_surface'));
    }
    installFakeDb({ artifacts: rows });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await getSourceSilence(USER, { ...DEFAULT_SOURCE_SILENT }, day(50));

    expect(result.discoveryTruncated).toBe(true);
    expect(result.sources).toEqual([{ surface: 'filler_surface', daysSince: expect.any(Number) }]);
    expect(result.sources.find((s) => s.surface === 'buried_old_surface')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DISCOVERY_ROW_CAP=50000'),
      expect.objectContaining({ userId: USER, discoveryRowCap: 50_000 }),
    );
    warnSpy.mockRestore();
  });

  it('reports a live surface correctly off a truncated scan instead of falsely silent (#785 review round 1 H1; fixed properly by #786)', async () => {
    // The original H1 reviewer reproduction, in this file's own fixture
    // shape: `busy_surface` has 50,000 OLD rows plus one row from YESTERDAY
    // pushed last. Under the old `id ASC` keyset order, that most-recent
    // row's uuid `id` could sort past DISCOVERY_ROW_CAP, so a scan that
    // stopped at the cap could miss it entirely — understating a surface
    // that is actually live as far past its silence threshold. #785's
    // fail-safe made that miss impossible to act on wrongly (by reporting no
    // sources at all whenever the scan was known-incomplete) but also made a
    // genuinely truncated run go silent even when correct data existed.
    //
    // The composite `captured_at DESC` cursor (#786) visits the most recent
    // row FIRST, so it is never missed: the retained slice is exactly the
    // day(49) row plus as many of the day(1) rows as fit before the cap.
    const rows: Row[] = [];
    for (let i = 0; i < 50_000; i++) {
      rows.push(artifact(day(1).toISOString(), 'busy_surface'));
    }
    rows.push(artifact(day(49).toISOString(), 'busy_surface')); // yesterday, relative to now = day(50)
    installFakeDb({ artifacts: rows });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await getSourceSilence(USER, { ...DEFAULT_SOURCE_SILENT }, day(50));

    expect(result.discoveryTruncated).toBe(true);
    // The bug this pins: under the old `id ASC` order this could report
    // `daysSince: 49` — a false silence report for a surface with real
    // activity as recently as yesterday. The composite cursor reports the
    // true, current value instead.
    expect(result.sources).toEqual([{ surface: 'busy_surface', daysSince: 1 }]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── Scheduler entry point ──────────────────────────────────────────────────

describe('startAlertEvaluatorScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    withLockMock.mockResolvedValue({ skipped: true });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does nothing when KMS_ALERT_EVALUATOR_ENABLED is not set', () => {
    const handle = startAlertEvaluatorScheduler();

    jest.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(handle).toBeNull();
    expect(withLockMock).not.toHaveBeenCalled();
  });

  it('runs immediately under the alerts lock when enabled', () => {
    process.env.KMS_ALERT_EVALUATOR_ENABLED = 'true';

    const handle = startAlertEvaluatorScheduler();

    expect(handle).not.toBeNull();
    expect(withLockMock).toHaveBeenCalledTimes(1);
    expect(withLockMock).toHaveBeenCalledWith('alerts', expect.any(Function));
    clearInterval(handle as NodeJS.Timeout);
  });

  it('re-runs on its configured interval', () => {
    process.env.KMS_ALERT_EVALUATOR_ENABLED = 'true';
    process.env.KMS_ALERT_EVALUATOR_INTERVAL_MINUTES = '10';

    const handle = startAlertEvaluatorScheduler();
    withLockMock.mockClear();

    jest.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(withLockMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(withLockMock).toHaveBeenCalledWith('alerts', expect.any(Function));
    clearInterval(handle as NodeJS.Timeout);
  });
});
