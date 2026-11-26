/**
 * Did the nightly dos sweep close the days it should have? (issue #2270)
 *
 * The measurement behind the `sweep_missed` and `sweep_unreadable` alert
 * conditions. It is the same answer `ahos_doctor`'s `dos sweep closed` outcome
 * check gives (#2268), computed by the same code: the window and the "missed"
 * rule come from `@ahkms/core`, and the days come from core's
 * `getSynthesisCoverage`. Nothing about which days count is restated here, so
 * the doctor and the email cannot disagree.
 *
 * `@ahkms/core` is ESM and this package is CommonJS, so it is loaded through a
 * native `require` at call time, the way `utils/embeddings.ts` loads the
 * embedding adapter. The loader is injectable so tests never touch the real
 * package.
 */

/** The slice of a Supabase client the coverage read needs. */
export interface CoverageClient {
  from(table: string): unknown;
}

/** Mirrors core's `SweepCoverageDay`. Which markers close a day is core's rule, not ours. */
interface CoverageDay {
  date: string;
  captured_atoms: number;
  no_material: boolean;
  synthesized: number;
  synthesized_unattended: number;
  evidence_aggregated: number;
  evidence_aggregated_unattended: number;
}

export interface SweepCore {
  DOMAINS: readonly string[];
  sweepCheckWindow(now: Date): { from: string; to: string };
  missedSweepDays<T extends CoverageDay>(days: readonly T[]): T[];
  getSynthesisCoverage(
    fromDate: string,
    toDate: string,
    domain: string | undefined,
    deps: { client: CoverageClient; ownerId: () => string },
  ): Promise<CoverageDay[]>;
}

export interface SweepOutcome {
  domain: string;
  from: string;
  to: string;
  /** Days with material and no marker; `null` when the coverage read failed. */
  missed: Array<{ date: string; atoms: number }> | null;
  /** Why the coverage read failed; `null` when it returned. */
  error: string | null;
}

const builtinModule = process.getBuiltinModule('module') as typeof import('module');
const nativeRequire = builtinModule.createRequire(__filename);

/** The real `@ahkms/core`, resolved lazily so importing this module costs nothing. */
export function loadSweepCore(): SweepCore {
  const core = nativeRequire('@ahkms/core') as Pick<
    SweepCore,
    'DOMAINS' | 'sweepCheckWindow' | 'missedSweepDays'
  >;
  const adapters = nativeRequire('@ahkms/core/adapters') as Pick<SweepCore, 'getSynthesisCoverage'>;
  return {
    DOMAINS: core.DOMAINS,
    sweepCheckWindow: core.sweepCheckWindow,
    missedSweepDays: core.missedSweepDays,
    getSynthesisCoverage: adapters.getSynthesisCoverage,
  };
}

/**
 * One outcome per domain. Never throws for a single domain's failure: a read
 * that fails is itself the finding (`error` set, `missed` null), and the other
 * domain still reports.
 */
export async function getSweepOutcomes(
  userId: string,
  now: Date,
  client: CoverageClient,
  load: () => SweepCore = loadSweepCore,
): Promise<SweepOutcome[]> {
  const core = load();
  const { from, to } = core.sweepCheckWindow(now);

  const outcomes: SweepOutcome[] = [];
  for (const domain of core.DOMAINS) {
    try {
      const days = await core.getSynthesisCoverage(from, to, domain, {
        client,
        ownerId: () => userId,
      });
      outcomes.push({
        domain,
        from,
        to,
        missed: core.missedSweepDays(days).map((d) => ({ date: d.date, atoms: d.captured_atoms })),
        error: null,
      });
    } catch (err) {
      outcomes.push({
        domain,
        from,
        to,
        missed: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}
