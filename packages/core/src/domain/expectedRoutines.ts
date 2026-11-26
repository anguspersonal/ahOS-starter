// The Claude Routines that are expected to fire, and which of their firings are due
// (#635 decisions 1 and 3, #2349).
//
// The server cannot see whether a Routine is enabled, or whether it fired. It only sees
// what a run produced. So a Routine that stopped is invisible unless something says it
// was due, and this list is that something: a doctor check walks it and asks "it was
// due, did it produce its output?".
//
// THE LIST CHANGES ONLY IN THE SAME PULL REQUEST AS THE ROUTINE'S ROW IN
// docs/guides/SCHEDULING_DISARM_PROTOCOL.md. It is a code constant, not a preference
// key. A row joins in the PR that records its Routine as armed, and its cron changes in
// the PR that records the retune. Never drop a row to make a check pass: a red check on
// a Routine that is not producing its output is accurate.
//
// Engine cadences are not Routines and never join. Their list is
// DEFINED_SCHEDULER_CADENCES in packages/mcp-server/src/doctor/wiringChecks.ts.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * When a Routine fires, in UTC. Deliberately not parsed from the cron: every Routine so
 * far is one of these two shapes, and a schedule that is neither is a decision for
 * #635, not a reason to add a cron parser.
 *
 * `dayOfMonth` must be 1 to 28, so that the day exists in every month.
 */
export type RoutineSchedule =
	| { readonly kind: "daily"; readonly hourUtc: number; readonly minuteUtc: number }
	| {
			readonly kind: "monthly";
			readonly dayOfMonth: number;
			readonly hourUtc: number;
			readonly minuteUtc: number;
	  };

/**
 * What a firing leaves behind, which is all the server can check.
 *
 * `proposal`: a proposal artifact carrying every tag in `tags`, plus `date:<YYYY-MM-DD>`
 * for the firing (see `firingDate`). `sweep_email`: one self-addressed sweep email.
 */
export type RoutineOutput =
	| { readonly kind: "proposal"; readonly tags: readonly string[] }
	| { readonly kind: "sweep_email" };

export interface ExpectedRoutine {
	readonly key: string;
	/** The Claude Routine's trigger id, as `RemoteTrigger get` reports it. */
	readonly triggerId: string;
	/** The live cron (UTC), for people. `schedule` is what the code reads. */
	readonly cron: string;
	readonly schedule: RoutineSchedule;
	readonly output: RoutineOutput;
}

/**
 * Only what runs today. Values read live with `RemoteTrigger get` on 21 Nov 2026.
 *
 * `sync day` fires at 16:00 UTC live, although ADR-112 §5 and the guide say 17:00. This
 * row records the live value; the retune is a separate human step whose PR changes it.
 */
export const EXPECTED_ROUTINES: readonly ExpectedRoutine[] = [
	{
		key: "sync day",
		triggerId: "trig_01D1ryfphosxkUdUNg8Fsaob",
		cron: "0 16 * * *",
		schedule: { kind: "daily", hourUtc: 16, minuteUtc: 0 },
		output: { kind: "proposal", tags: ["sync-proposal", "scope:day"] },
	},
	{
		key: "cv sweep",
		triggerId: "trig_01M6FeGRvWgKfwtBtYrWiTCM",
		cron: "0 7 1 * *",
		schedule: { kind: "monthly", dayOfMonth: 1, hourUtc: 7, minuteUtc: 0 },
		output: { kind: "sweep_email" },
	},
	{
		key: "golden-doc sweep",
		triggerId: "trig_01V9K9SmzJWyGEMPTy2vhtxk",
		cron: "0 7 2 * *",
		schedule: { kind: "monthly", dayOfMonth: 2, hourUtc: 7, minuteUtc: 0 },
		output: { kind: "sweep_email" },
	},
];

/**
 * A firing counts as settled once this long has passed since its scheduled time. Before
 * that the run may still be going, and a check that failed then would cry wolf.
 */
export const ROUTINE_GRACE_HOURS = 3;

const DAILY_FIRINGS = 3;

/**
 * The scheduled times of `routine` that are settled at `now`, newest first: the 3 most
 * recent for a daily Routine, the 1 most recent for a monthly one.
 */
export function settledFirings(routine: Pick<ExpectedRoutine, "schedule">, now: Date): Date[] {
	const { schedule } = routine;
	// A firing is settled when it is at or before this moment.
	const latest = now.getTime() - ROUTINE_GRACE_HOURS * HOUR_MS;
	const at = new Date(latest);
	const year = at.getUTCFullYear();
	const month = at.getUTCMonth();

	if (schedule.kind === "monthly") {
		const inMonth = (m: number) =>
			Date.UTC(year, m, schedule.dayOfMonth, schedule.hourUtc, schedule.minuteUtc);
		// Date.UTC rolls month -1 back to December of the year before.
		const firing = inMonth(month) <= latest ? inMonth(month) : inMonth(month - 1);
		return [new Date(firing)];
	}

	const today = Date.UTC(year, month, at.getUTCDate(), schedule.hourUtc, schedule.minuteUtc);
	const newest = today <= latest ? today : today - DAY_MS;
	return Array.from({ length: DAILY_FIRINGS }, (_, i) => new Date(newest - i * DAY_MS));
}

/** The firing's UTC date as `YYYY-MM-DD`: the value of a proposal's `date:` tag. */
export function firingDate(firing: Date): string {
	return firing.toISOString().slice(0, 10);
}

/** The firings that did not produce their output, in the order given. */
export function missedFirings(firings: readonly Date[], produced: (firing: Date) => boolean): Date[] {
	return firings.filter((firing) => !produced(firing));
}
