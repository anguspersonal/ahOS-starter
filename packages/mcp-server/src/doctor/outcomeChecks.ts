import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missedSweepDays, sweepCheckWindow } from "@ahkms/core";
import { DOMAINS, DOMAIN_PROVIDER, type Domain } from "../domains.js";
import { getDailyLogQueue, getStreak, getSynthesisCoverage } from "../links.js";
import { supabase } from "../supabase.js";
import type { DoctorCheck } from "./report.js";

// ahos_doctor, family 4: outcomes (#2268).
//
// The other families ask whether ahOS is set up. This one asks whether a routine
// produced what it should have. The two come apart: in November 2026 the nightly dos
// sweep was correctly wired, its run status read SUCCEEDED every night, and it wrote
// nothing for two weeks. Missing output was a WARN in the wiring family, and the streak
// read was never exercised at all.
//
// So a missing result here is a FAIL, each check stands alone, and one read failing
// never hides another.
//
// Covered: the dos sweep, whether every queued Daily Log twin can be attributed to a
// domain (#2314), and whether this build's migrations are applied (#2269, at the foot of
// this file). Not checked, because the server cannot see it: whether
// the routine fired. It runs as a scheduled Claude session whose run history lives
// outside this database; what it produced is the observable fact.

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `dos coverage read` and `dos sweep closed` share one read: the second is unknowable
 * when the first fails, and saying so is more useful than reporting it twice or guessing.
 */
async function sweepChecks(domain: Domain, now: Date): Promise<DoctorCheck[]> {
	const readName = `dos coverage read ${domain}`;
	const closedName = `dos sweep closed ${domain}`;
	const { from, to } = sweepCheckWindow(now);

	let coverage: Awaited<ReturnType<typeof getSynthesisCoverage>>;
	try {
		coverage = await getSynthesisCoverage(from, to, domain);
	} catch (err) {
		return [
			{
				family: "outcomes",
				name: readName,
				status: "fail",
				detail: `the coverage read for ${from} to ${to} failed, so the sweep cannot decide which days to close: ${message(err)}`,
				fix: "a statement timeout means the coverage indexes are missing (migration 153, #2257): apply pending migrations; otherwise check database connectivity",
			},
			{
				family: "outcomes",
				name: closedName,
				status: "fail",
				detail: `unknown: the coverage read failed, so no day in ${from} to ${to} could be checked`,
				fix: `fix '${readName}' first`,
			},
		];
	}

	const missed = missedSweepDays(coverage);
	return [
		{
			family: "outcomes",
			name: readName,
			status: "ok",
			detail: `the coverage read for ${from} to ${to} returned ${coverage.length} day(s).`,
			fix: "",
		},
		missed.length > 0
			? {
					family: "outcomes",
					name: closedName,
					status: "fail",
					detail: `${missed.length} day(s) the sweep has already had a run to close have material and neither a draft nor a confirmed Daily Log: ${missed.map((d) => `${d.date} (${d.captured_atoms} atoms)`).join(", ")}`,
					fix: "the nightly sweep did not close these days: read its last run, then run an attended `sync catchup`. A day older than today-7 can only be closed attended",
				}
			: {
					family: "outcomes",
					name: closedName,
					status: "ok",
					detail: `every day with material in ${from} to ${to} carries a draft or a confirmed Daily Log.`,
					fix: "",
				},
	];
}

/** A WARN, not a FAIL: the streak is a motivational figure and decides nothing. */
async function streakCheck(domain: Domain): Promise<DoctorCheck> {
	const name = `dos streak read ${domain}`;
	try {
		const streak = await getStreak(domain);
		return { family: "outcomes", name, status: "ok", detail: `streak: ${streak.formatted}`, fix: "" };
	} catch (err) {
		return {
			family: "outcomes",
			name,
			status: "warn",
			detail: `the streak could not be computed, so dos_synthesis_coverage reports it as unavailable: ${message(err)}`,
			fix: "a statement timeout means the coverage indexes are missing (migration 153, #2257): apply pending migrations",
		};
	}
}

// ── dos twins attributable (#2314) ──────────────────────────────────────────
//
// A Daily Log twin belongs to a domain only through its `daily_log` pointer. The two
// classes fail differently (`choosePointer` in core's externalLinks adapter):
// - pointerless: no domain-scoped read returns it, so the attended ritual never sees the
//   log and it is never folded into the State Doc.
// - pointer conflict: a scoped read keeps only the pointers under its own provider. A
//   twin with one pointer under each provider is returned by BOTH scoped reads as a
//   normal entry, so each ritual sees it as healthy and both can fold it; a twin with two
//   pointers under one provider is returned by that domain's read, flagged, and the other
//   domain's read does not return it. What each domain sees depends on the twin's
//   providers, so the detail says it per twin (`scopedView`).
// Only the unscoped queue read shows either class, so until this check the finding
// reached whoever happened to run that read and nobody else (#2258, decision 6).
//
// One check, not one per domain: an unattributable twin has no domain to file it under.
// The two classes are the ones `formatDosDailyLogQueueMcp` counts, over queued entries
// only (a twin already folded into the State Doc is past needing attribution).

type QueueEntry = Awaited<ReturnType<typeof getDailyLogQueue>>[number];

const describeTwin = (e: QueueEntry): string =>
	`${e.artifact_id} (${e.title ? `"${e.title}"` : "untitled"}, ${e.date ?? "no date"})`;

// What each domain's scoped read makes of a conflicted twin, mirroring `choosePointer`:
// no pointer under its provider, not returned; one, a normal entry; more, flagged.
const scopedView = (e: QueueEntry): string => {
	let healthy = 0;
	const views = DOMAINS.map((d) => {
		const n = e.conflicting_providers.filter((p) => p === DOMAIN_PROVIDER[d]).length;
		if (n === 0) return `the ${d} read does not return it`;
		if (n === 1) {
			healthy += 1;
			return `the ${d} read sees it as healthy`;
		}
		return `the ${d} read flags it as a conflict`;
	});
	return `${views.join(", ")}${healthy > 1 ? ", so both rituals may fold it" : ""}`;
};

const TWIN_REPAIR =
	"pointerless twin: one `external_link_create` call with kind: \"daily_log\", artifact_id the twin, provider the Notion domain provider of the workspace its page lives in ('notion_work' or 'notion_personal'; you name the domain, it is never guessed) and external_id the Notion page id";
const CONFLICT_REPAIR =
	"pointer conflict: there is no automated repair; resolve with the owner which pointer is the true one";

async function twinsAttributableCheck(): Promise<DoctorCheck> {
	const base = { family: "outcomes" as const, name: "dos twins attributable" };

	let entries: QueueEntry[];
	try {
		// No domain: a scoped read matches on the pointer's provider, so it cannot
		// return a pointerless twin at all.
		entries = await getDailyLogQueue();
	} catch (err) {
		return {
			...base,
			status: "fail",
			detail: `the unscoped Daily Log queue read failed, so no twin could be checked: ${message(err)}`,
			fix: "check database connectivity, then re-run",
		};
	}

	const queued = entries.filter((e) => e.consumed_by_state === null);
	const conflicts = queued.filter((e) => e.conflicting_providers.length > 0);
	const pointerless = queued.filter((e) => e.page_id === null && e.conflicting_providers.length === 0);

	if (pointerless.length === 0 && conflicts.length === 0) {
		return {
			...base,
			status: "ok",
			detail: `all ${queued.length} queued Daily Log twin(s) carry exactly one daily_log pointer.`,
			fix: "",
		};
	}

	const parts = [
		`${pointerless.length} pointerless twin(s) and ${conflicts.length} pointer conflict(s) among ${queued.length} queued Daily Log twin(s)`,
	];
	if (pointerless.length > 0) {
		parts.push(
			`pointerless (no domain-scoped read returns these, so no ritual will see them): ${pointerless.map(describeTwin).join(", ")}`,
		);
	}
	if (conflicts.length > 0) {
		parts.push(
			`pointer conflict (a scoped read sees only its own provider's pointers; only the unscoped read shows the whole disagreement): ${conflicts.map((e) => `${describeTwin(e)} under ${e.conflicting_providers.join(" and ")} (${scopedView(e)})`).join("; ")}`,
		);
	}
	return {
		...base,
		status: "fail",
		detail: parts.join(". "),
		fix: [pointerless.length > 0 ? TWIN_REPAIR : "", conflicts.length > 0 ? CONFLICT_REPAIR : ""]
			.filter(Boolean)
			.join(". "),
	};
}

// ── migrations applied (#2269) ──────────────────────────────────────────────
//
// A merged fix whose migration never ran is not live, and nothing said so: on
// 2026-11-20 production stopped at migration 151 while `main` carried 152 and 153.
//
// "Expected" is the migration files THIS BUILD was made from, not whatever `main` holds
// now: the question is whether the database matches the code that is running. The
// Dockerfile copies `supabase/migrations/` into the image for exactly this; from a
// checkout the same relative path resolves to the repo's own directory.

/** `<repo>/supabase/migrations`, four levels above `src/doctor` (or `dist/doctor`). */
export const MIGRATIONS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

/** version -> filename for every migration file in `dir`. Throws when `dir` is unreadable. */
export async function expectedMigrations(dir: string = MIGRATIONS_DIR): Promise<Map<string, string>> {
	const expected = new Map<string, string>();
	for (const file of (await readdir(dir)).sort()) {
		const match = MIGRATION_FILE.exec(file);
		if (match) expected.set(match[1], file);
	}
	return expected;
}

const DB_PUSH = "run `supabase db push` from a checkout of `main` (docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md)";

export async function migrationsAppliedCheck(dir: string = MIGRATIONS_DIR): Promise<DoctorCheck> {
	const base = { family: "outcomes" as const, name: "migrations applied" };

	let expected: Map<string, string>;
	try {
		expected = await expectedMigrations(dir);
	} catch (err) {
		return {
			...base,
			status: "warn",
			detail: `this build carries no migration list to compare against (${message(err)}), so unapplied migrations cannot be detected`,
			fix: "the image must contain supabase/migrations/ (packages/mcp-server/Dockerfile copies it); redeploy from a build that does",
		};
	}
	if (expected.size === 0) {
		return {
			...base,
			status: "warn",
			detail: `no migration files were found in ${dir}, so unapplied migrations cannot be detected`,
			fix: "the image must contain supabase/migrations/ (packages/mcp-server/Dockerfile copies it); redeploy from a build that does",
		};
	}

	const { data, error } = await supabase.rpc("applied_migration_versions");
	if (error) {
		// PGRST202 / 42883: the function itself is absent, which means migration 154
		// (the one that creates it) has not been applied. That IS the finding.
		const missingFunction = error.code === "PGRST202" || error.code === "42883";
		return {
			...base,
			status: "fail",
			detail: missingFunction
				? "applied_migration_versions() does not exist in the database, so migration 154 and anything after it is unapplied"
				: `could not read the applied migration versions: ${error.message}`,
			fix: missingFunction ? DB_PUSH : "check database connectivity, then re-run",
		};
	}

	const applied = new Set(
		((data ?? []) as unknown[]).map((row) =>
			typeof row === "string" ? row : String((row as { applied_migration_versions?: unknown }).applied_migration_versions ?? ""),
		),
	);
	const unapplied = [...expected].filter(([version]) => !applied.has(version)).map(([, file]) => file);
	if (unapplied.length > 0) {
		return {
			...base,
			status: "fail",
			detail: `${unapplied.length} migration(s) in this build are not applied to the database, so the code that depends on them is not fully live: ${unapplied.join(", ")}`,
			fix: DB_PUSH,
		};
	}

	// Applied-but-not-in-this-build is reported, not failed: history carries a few
	// versions with no file (out-of-band applies repaired per the runbook), and a
	// database one release ahead of a not-yet-redeployed server is a normal moment.
	const unknown = [...applied].filter((version) => version && !expected.has(version)).length;
	return {
		...base,
		status: "ok",
		detail: `all ${expected.size} migration(s) in this build are applied${unknown > 0 ? ` (${unknown} applied version(s) have no file in this build)` : ""}.`,
		fix: "",
	};
}

export async function checkOutcomes(now: Date = new Date()): Promise<DoctorCheck[]> {
	const migrations = migrationsAppliedCheck().catch(
		(err): DoctorCheck => ({
			family: "outcomes",
			name: "migrations applied",
			status: "fail",
			detail: `could not check applied migrations: ${message(err)}`,
			fix: "check database connectivity, then re-run",
		}),
	);
	// Started before the per-domain reads are awaited, and it catches its own read
	// failure, so it neither waits on nor is hidden by any other check.
	const twins = twinsAttributableCheck();
	const perDomain = await Promise.all(
		DOMAINS.map(async (domain) => {
			const [sweep, streak] = await Promise.all([sweepChecks(domain, now), streakCheck(domain)]);
			return [...sweep, streak];
		}),
	);
	return [...perDomain.flat(), await twins, await migrations];
}
