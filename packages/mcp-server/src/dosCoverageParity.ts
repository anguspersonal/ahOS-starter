/**
 * Parity check for `public.get_dos_coverage_days` (migration 158, ADR-119, #2264).
 *
 * The SQL function is the only runtime copy of the coverage day rule once #2312 lands.
 * The TypeScript functions it was written from (`coverageDateForArtifact`,
 * `isSynthesizableMaterial`) stay as the oracle: this module rebuilds the per-day rows
 * from raw artifact and marker rows with those two functions and reports every day
 * where the function disagrees. The repo has no database test harness, so this is run
 * once against production (#2310) through `scripts/dos-coverage-parity.ts`.
 *
 * Everything here is pure except `runDosCoverageParity`, which only reads: selects on
 * `artifacts` and `artifact_external_links`, and `rpc` calls to the function.
 */
import {
	COVERAGE_MAX_ATOMS_PER_DAY,
	COVERAGE_MAX_EFFECTIVE_LAG_DAYS,
	coverageDateForArtifact,
	enumerateDays,
	isSynthesizableMaterial,
	type SynthesisCoverageDay,
} from "@ahkms/core/adapters";
import {
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
	SYNTHESIZED,
	SYNTHESIZED_UNATTENDED,
} from "./vocab.js";

export const COVERAGE_RPC = "get_dos_coverage_days";

/** The four closing kinds, each with the count field and id field it feeds. */
const KIND_FIELDS = [
	[SYNTHESIZED, "synthesized", "synthesized_external_ids"],
	[SYNTHESIZED_UNATTENDED, "synthesized_unattended", "synthesized_unattended_external_ids"],
	[EVIDENCE_AGGREGATED, "evidence_aggregated", "evidence_aggregated_external_ids"],
	[
		EVIDENCE_AGGREGATED_UNATTENDED,
		"evidence_aggregated_unattended",
		"evidence_aggregated_unattended_external_ids",
	],
] as const;

export const CLOSING_KINDS: readonly string[] = KIND_FIELDS.map(([kind]) => kind);

const COUNT_FIELDS = [
	"synthesized",
	"synthesized_unattended",
	"evidence_aggregated",
	"evidence_aggregated_unattended",
	"captured_atoms",
] as const;
const ID_FIELDS = [
	"synthesized_external_ids",
	"synthesized_unattended_external_ids",
	"evidence_aggregated_external_ids",
	"evidence_aggregated_unattended_external_ids",
] as const;
const MARKER_FIELDS = [
	"synthesized",
	"synthesized_unattended",
	"evidence_aggregated",
	"evidence_aggregated_unattended",
	...ID_FIELDS,
] as const;

export type ParityArtifactRow = {
	id: string;
	captured_at: string | null;
	effective_at?: string | null;
	content_subtype?: string | null;
	lifecycle_stage?: string | null;
};

export type ParityMarkerRow = {
	artifact_id: string | null;
	kind: string;
	external_id: string | null;
	provider?: string | null;
};

export type CoverageDifference = {
	date: string;
	field: keyof SynthesisCoverageDay | "day";
	expected: unknown;
	actual: unknown;
};

export type LiveDifferenceLabel = "window-edge" | "cap" | "unexplained";

export type LiveDifference = {
	date: string;
	label: LiveDifferenceLabel;
	fields: CoverageDifference[];
};

/** `YYYY-MM-DD` plus `n` calendar days, in UTC. */
export function addDays(date: string, n: number): string {
	return new Date(Date.parse(`${date}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** One row per artifact id; the first occurrence wins. */
function uniqueArtifacts(artifacts: ParityArtifactRow[]): ParityArtifactRow[] {
	const seen = new Map<string, ParityArtifactRow>();
	for (const row of artifacts) {
		if (!seen.has(row.id)) seen.set(row.id, row);
	}
	return [...seen.values()];
}

function inScope(marker: ParityMarkerRow, provider: string | null | undefined): boolean {
	if (!marker.artifact_id) return false;
	if (!CLOSING_KINDS.includes(marker.kind)) return false;
	return provider == null || marker.provider === provider;
}

/** The earliest attributed day of any closing marker in scope; null when there is none. */
export function earliestMarkerDay(
	artifacts: ParityArtifactRow[],
	markers: ParityMarkerRow[],
	provider?: string | null,
): string | null {
	const byId = new Map(uniqueArtifacts(artifacts).map((row) => [row.id, row]));
	let earliest: string | null = null;
	for (const marker of markers) {
		if (!inScope(marker, provider)) continue;
		const artifact = byId.get(marker.artifact_id as string);
		const day = artifact ? coverageDateForArtifact(artifact) : null;
		if (day && (!earliest || day < earliest)) earliest = day;
	}
	return earliest;
}

/**
 * The rows `get_dos_coverage_days(p_user_id, from, to, provider)` must return, built
 * with the two oracle functions.
 *
 * - Material: artifacts captured (UTC date) in `[from, to + 7 days]`, counted on their
 *   attributed day when that day is in `[from, to]`. This is the window-edge rule: an
 *   atom captured on `to + 1` and dated `to` counts on `to`.
 * - Markers: every in-scope closing marker whose artifact has an attributed day in the
 *   window, with no stage or material filter on the artifact. A marker with a null
 *   `artifact_id`, or whose artifact is not among `artifacts`, is ignored.
 * - `from` null: start at the earliest marker day in scope; `[]` when there is none.
 *
 * `artifacts` must hold every material artifact captured in the scan window and every
 * artifact a marker points at. Extra rows are harmless.
 */
export function buildOracleCoverage(input: {
	from: string | null;
	to: string;
	artifacts: ParityArtifactRow[];
	markers: ParityMarkerRow[];
	provider?: string | null;
}): SynthesisCoverageDay[] {
	const artifacts = uniqueArtifacts(input.artifacts);
	const from = input.from ?? earliestMarkerDay(artifacts, input.markers, input.provider);
	if (!from) return [];

	const days = enumerateDays(from, input.to);
	const atoms = new Map<string, number>(days.map((d) => [d, 0]));
	const counts = new Map(days.map((d) => [d, new Map<string, number>()]));
	const ids = new Map(days.map((d) => [d, new Map<string, Set<string>>()]));

	const scanEnd = addDays(input.to, COVERAGE_MAX_EFFECTIVE_LAG_DAYS);
	const dayById = new Map<string, string | null>();
	for (const row of artifacts) {
		const day = coverageDateForArtifact(row);
		dayById.set(row.id, day);
		if (!day || !atoms.has(day)) continue;
		const capturedDay = row.captured_at ? row.captured_at.slice(0, 10) : null;
		if (!capturedDay || capturedDay < from || capturedDay > scanEnd) continue;
		if (isSynthesizableMaterial(row)) atoms.set(day, (atoms.get(day) ?? 0) + 1);
	}

	for (const marker of input.markers) {
		if (!inScope(marker, input.provider)) continue;
		const day = dayById.get(marker.artifact_id as string);
		if (!day) continue;
		const dayCounts = counts.get(day);
		const dayIds = ids.get(day);
		if (!dayCounts || !dayIds) continue;
		dayCounts.set(marker.kind, (dayCounts.get(marker.kind) ?? 0) + 1);
		if (marker.external_id) {
			const set = dayIds.get(marker.kind) ?? new Set<string>();
			set.add(marker.external_id);
			dayIds.set(marker.kind, set);
		}
	}

	return days.map((date) => {
		const day: SynthesisCoverageDay = {
			date,
			synthesized: 0,
			synthesized_unattended: 0,
			synthesized_external_ids: [],
			synthesized_unattended_external_ids: [],
			evidence_aggregated: 0,
			evidence_aggregated_unattended: 0,
			evidence_aggregated_external_ids: [],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms: atoms.get(date) ?? 0,
			no_material: false,
		};
		for (const [kind, countField, idField] of KIND_FIELDS) {
			day[countField] = counts.get(date)?.get(kind) ?? 0;
			day[idField] = [...(ids.get(date)?.get(kind) ?? [])].sort();
		}
		day.no_material =
			day.captured_atoms === 0 &&
			day.synthesized === 0 &&
			day.synthesized_unattended === 0 &&
			day.evidence_aggregated === 0 &&
			day.evidence_aggregated_unattended === 0;
		return day;
	});
}

function sameIds(a: unknown, b: unknown): boolean {
	return (
		Array.isArray(a) &&
		Array.isArray(b) &&
		a.length === b.length &&
		a.every((value, i) => value === b[i])
	);
}

function fieldDifferences(
	date: string,
	expected: SynthesisCoverageDay,
	actual: SynthesisCoverageDay,
): CoverageDifference[] {
	const out: CoverageDifference[] = [];
	for (const field of COUNT_FIELDS) {
		if (expected[field] !== actual[field]) {
			out.push({ date, field, expected: expected[field], actual: actual[field] });
		}
	}
	// Order is part of the contract: an id array out of order is a difference.
	for (const field of ID_FIELDS) {
		if (!sameIds(expected[field], actual[field])) {
			out.push({ date, field, expected: expected[field], actual: actual[field] });
		}
	}
	if (expected.no_material !== actual.no_material) {
		out.push({ date, field: "no_material", expected: expected.no_material, actual: actual.no_material });
	}
	return out;
}

/**
 * Every field on every day where `actual` differs from `expected`. A day present on one
 * side only is reported as a `day` difference. Empty means parity.
 */
export function diffCoverage(
	expected: SynthesisCoverageDay[],
	actual: SynthesisCoverageDay[],
): CoverageDifference[] {
	const actualByDate = new Map(actual.map((day) => [day.date, day]));
	const expectedDates = new Set(expected.map((day) => day.date));
	const out: CoverageDifference[] = [];
	for (const day of expected) {
		const other = actualByDate.get(day.date);
		if (!other) {
			out.push({ date: day.date, field: "day", expected: "present", actual: "missing" });
			continue;
		}
		out.push(...fieldDifferences(day.date, day, other));
	}
	for (const day of actual) {
		if (!expectedDates.has(day.date)) {
			out.push({ date: day.date, field: "day", expected: "missing", actual: "present" });
		}
	}
	return out;
}

/**
 * Differences between the function and today's `getSynthesisCoverage` over the same
 * window, each day labelled with the reason:
 *
 * - `window-edge`: the function counts more material on the day, and the surplus is no
 *   larger than the material atoms captured after `to` that are attributed to that day.
 *   Marker fields agree. This is the one intended difference (ADR-119).
 * - `cap`: both `captured_atoms` are at or above COVERAGE_MAX_ATOMS_PER_DAY and nothing
 *   else differs. The live read stops counting a saturated day; the function is exact.
 * - `unexplained`: anything else. Not expected; investigate before any reader switches.
 *
 * `expected` in each field difference is the function's value, `actual` the live read's.
 */
export function classifyLiveDifferences(input: {
	to: string;
	functionDays: SynthesisCoverageDay[];
	liveDays: SynthesisCoverageDay[];
	artifacts: ParityArtifactRow[];
}): LiveDifference[] {
	const lateAtoms = new Map<string, number>();
	for (const row of uniqueArtifacts(input.artifacts)) {
		const capturedDay = row.captured_at ? row.captured_at.slice(0, 10) : null;
		if (!capturedDay || capturedDay <= input.to) continue;
		if (!isSynthesizableMaterial(row)) continue;
		const day = coverageDateForArtifact(row);
		if (day) lateAtoms.set(day, (lateAtoms.get(day) ?? 0) + 1);
	}

	const byDate = new Map<string, CoverageDifference[]>();
	for (const diff of diffCoverage(input.functionDays, input.liveDays)) {
		const list = byDate.get(diff.date) ?? [];
		list.push(diff);
		byDate.set(diff.date, list);
	}
	const fnByDate = new Map(input.functionDays.map((day) => [day.date, day]));
	const liveByDate = new Map(input.liveDays.map((day) => [day.date, day]));

	const out: LiveDifference[] = [];
	for (const [date, fields] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		out.push({ date, fields, label: labelFor(fields, fnByDate.get(date), liveByDate.get(date), lateAtoms.get(date) ?? 0) });
	}
	return out;
}

function labelFor(
	fields: CoverageDifference[],
	fn: SynthesisCoverageDay | undefined,
	live: SynthesisCoverageDay | undefined,
	lateAtoms: number,
): LiveDifferenceLabel {
	if (!fn || !live) return "unexplained";
	const names = new Set<string>(fields.map((f) => f.field));
	if ((MARKER_FIELDS as readonly string[]).some((field) => names.has(field))) return "unexplained";

	if (
		names.size === 1 &&
		names.has("captured_atoms") &&
		fn.captured_atoms >= COVERAGE_MAX_ATOMS_PER_DAY &&
		live.captured_atoms >= COVERAGE_MAX_ATOMS_PER_DAY
	) {
		return "cap";
	}

	// Only captured_atoms (and no_material, which follows from it when the day has no
	// marker) may differ, and only upward by atoms the live read cannot see.
	const surplus = fn.captured_atoms - live.captured_atoms;
	if (names.has("captured_atoms") && surplus > 0 && surplus <= lateAtoms) return "window-edge";
	return "unexplained";
}

/** The attributed day holding the most material rows, for the EXPLAIN check; null when none. */
export function busiestMaterialDay(
	artifacts: ParityArtifactRow[],
): { date: string; material_rows: number } | null {
	const perDay = new Map<string, number>();
	for (const row of uniqueArtifacts(artifacts)) {
		if (!isSynthesizableMaterial(row)) continue;
		const day = coverageDateForArtifact(row);
		if (day) perDay.set(day, (perDay.get(day) ?? 0) + 1);
	}
	let best: { date: string; material_rows: number } | null = null;
	for (const [date, material_rows] of perDay) {
		if (!best || material_rows > best.material_rows || (material_rows === best.material_rows && date < best.date)) {
			best = { date, material_rows };
		}
	}
	return best;
}

/** A ready-to-paste statement for the SQL editor (#2310). Read-only: the function is STABLE. */
export function explainStatement(userId: string, date: string): string {
	return `EXPLAIN (ANALYZE, BUFFERS) SELECT public.${COVERAGE_RPC}('${userId}'::uuid, '${date}'::date, '${date}'::date, NULL);`;
}

/** True when an rpc error says the function is not in the database or the schema cache. */
export function isMissingFunctionError(error: { code?: string; message?: string } | null): boolean {
	if (!error) return false;
	const message = error.message ?? "";
	return (
		error.code === "PGRST202" ||
		error.code === "42883" ||
		/could not find the function/i.test(message) ||
		(/does not exist/i.test(message) && message.includes(COVERAGE_RPC))
	);
}

// ---------------------------------------------------------------------------
// The run (read-only)
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

/** The read-only part of the PostgREST builder chain the run uses. */
export type ParityQuery = PromiseLike<QueryResult> & {
	select(columns: string): ParityQuery;
	eq(column: string, value: string): ParityQuery;
	in(column: string, values: string[]): ParityQuery;
	or(filter: string): ParityQuery;
	gt(column: string, value: string): ParityQuery;
	gte(column: string, value: string): ParityQuery;
	lte(column: string, value: string): ParityQuery;
	order(column: string, options?: { ascending: boolean }): ParityQuery;
	limit(count: number): ParityQuery;
};

/** The slice of the Supabase client the run uses. Selects and one rpc; no writes. */
export type ParityClient = {
	from(table: string): ParityQuery;
	rpc(fn: string, params: Record<string, unknown>): PromiseLike<QueryResult>;
};

export type ParityScope = { label: string; domain: string | undefined; provider: string | null };

export type ParityCaseResult = {
	label: string;
	from: string | null;
	to: string;
	rpc_ms: number;
	days: number;
	oracleDifferences: CoverageDifference[];
	liveDifferences: LiveDifference[];
};

export type ParityReport = {
	cases: ParityCaseResult[];
	busiest: { date: string; material_rows: number } | null;
	explain: string | null;
	ok: boolean;
};

export class CoverageFunctionMissingError extends Error {
	constructor(detail: string) {
		super(
			`public.${COVERAGE_RPC} is not in the database (${detail}). Apply migration 158 with \`supabase db push\` (#2310), then run this again.`,
		);
		this.name = "CoverageFunctionMissingError";
	}
}

const PAGE = 1000;
const ID_CHUNK = 300;
const ARTIFACT_COLUMNS = "id, captured_at, effective_at, content_subtype, lifecycle_stage";
/** The same pointer filter the live read and migration 153's partial index use. */
const MATERIAL_STAGE_FILTER = "lifecycle_stage.is.null,lifecycle_stage.not.in.(discovered,failed)";

async function readMarkers(client: ParityClient, userId: string): Promise<ParityMarkerRow[]> {
	const rows: Array<ParityMarkerRow & { id: string }> = [];
	for (let last: string | null = null; ; ) {
		let q = client
			.from("artifact_external_links")
			.select("id, artifact_id, kind, external_id, provider")
			.eq("user_id", userId)
			.in("kind", [...CLOSING_KINDS]);
		if (last !== null) q = q.gt("id", last);
		const { data, error } = await q.order("id").limit(PAGE);
		if (error) throw new Error(`Marker read failed: ${error.message}`);
		const page = (data ?? []) as Array<ParityMarkerRow & { id: string }>;
		rows.push(...page);
		if (page.length < PAGE) break;
		last = page[page.length - 1].id;
	}
	return rows;
}

async function readArtifactsById(
	client: ParityClient,
	userId: string,
	ids: string[],
): Promise<ParityArtifactRow[]> {
	const rows: ParityArtifactRow[] = [];
	for (let i = 0; i < ids.length; i += ID_CHUNK) {
		const { data, error } = await client
			.from("artifacts")
			.select(ARTIFACT_COLUMNS)
			.eq("user_id", userId)
			.in("id", ids.slice(i, i + ID_CHUNK));
		if (error) throw new Error(`Marker artifact read failed: ${error.message}`);
		rows.push(...((data ?? []) as ParityArtifactRow[]));
	}
	return rows;
}

/** Every non-pointer artifact captured in `[fromDay, toDay]`, keyset-paged, with no per-day cap. */
async function readMaterialWindow(
	client: ParityClient,
	userId: string,
	fromDay: string,
	toDay: string,
): Promise<ParityArtifactRow[]> {
	const rows: ParityArtifactRow[] = [];
	let lowerBound = `${fromDay}T00:00:00.000Z`;
	let after: { ts: string; id: string } | null = null;
	for (;;) {
		let q = client
			.from("artifacts")
			.select(ARTIFACT_COLUMNS)
			.eq("user_id", userId)
			.or(MATERIAL_STAGE_FILTER)
			.gte("captured_at", lowerBound)
			.lte("captured_at", `${toDay}T23:59:59.999999Z`);
		if (after) q = q.or(`captured_at.gt."${after.ts}",id.gt.${after.id}`);
		const { data, error } = await q
			.order("captured_at", { ascending: true })
			.order("id")
			.limit(PAGE);
		if (error) throw new Error(`Material read failed: ${error.message}`);
		const page = (data ?? []) as ParityArtifactRow[];
		rows.push(...page);
		const last = page[page.length - 1];
		if (page.length < PAGE || !last?.captured_at) break;
		lowerBound = last.captured_at;
		after = { ts: last.captured_at, id: last.id };
	}
	return rows;
}

/**
 * Runs every case (each window for each scope) and returns the report. Reads only.
 *
 * `liveCoverage` is today's `getSynthesisCoverage`, injected so the comparison is with
 * the read production actually serves.
 */
export async function runDosCoverageParity(deps: {
	client: ParityClient;
	userId: string;
	today: string;
	windowDays: number;
	scopes: ParityScope[];
	liveCoverage: (from: string, to: string, domain: string | undefined) => Promise<SynthesisCoverageDay[]>;
	log?: (line: string) => void;
}): Promise<ParityReport> {
	const { client, userId, today: to, scopes } = deps;
	const log = deps.log ?? (() => {});
	const windowFrom = addDays(to, -(deps.windowDays - 1));

	const markers = await readMarkers(client, userId);
	const markerArtifactIds = [
		...new Set(markers.map((m) => m.artifact_id).filter((id): id is string => Boolean(id))),
	];
	const markerArtifacts = await readArtifactsById(client, userId, markerArtifactIds);
	const historyFrom = earliestMarkerDay(markerArtifacts, markers);
	const scanFrom = historyFrom && historyFrom < windowFrom ? historyFrom : windowFrom;
	log(`markers=${markers.length} marker_artifacts=${markerArtifacts.length} material scan from ${scanFrom}`);
	const material = await readMaterialWindow(
		client,
		userId,
		scanFrom,
		addDays(to, COVERAGE_MAX_EFFECTIVE_LAG_DAYS),
	);
	log(`material_rows=${material.length}`);
	const artifacts = [...material, ...markerArtifacts];

	const cases: ParityCaseResult[] = [];
	for (const scope of scopes) {
		for (const from of [windowFrom, null]) {
			const label = `${from ? `${deps.windowDays}-day window` : "streak history"} / ${scope.label}`;
			const started = Date.now();
			const { data, error } = await client.rpc(COVERAGE_RPC, {
				p_user_id: userId,
				p_from: from,
				p_to: to,
				p_provider: scope.provider,
			});
			const rpc_ms = Date.now() - started;
			if (error) {
				if (isMissingFunctionError(error)) throw new CoverageFunctionMissingError(error.message);
				throw new Error(`${COVERAGE_RPC} failed for ${label}: ${error.message}`);
			}
			const functionDays = (Array.isArray(data) ? data : []) as SynthesisCoverageDay[];
			const oracleDays = buildOracleCoverage({ from, to, artifacts, markers, provider: scope.provider });
			const oracleDifferences = diffCoverage(oracleDays, functionDays);

			// The live read needs a start day; for the streak history that is the oracle's.
			const liveFrom = from ?? oracleDays[0]?.date ?? null;
			const liveDifferences = liveFrom
				? classifyLiveDifferences({
						to,
						functionDays,
						liveDays: await deps.liveCoverage(liveFrom, to, scope.domain),
						artifacts,
					})
				: [];
			cases.push({ label, from, to, rpc_ms, days: functionDays.length, oracleDifferences, liveDifferences });
		}
	}

	const busiest = busiestMaterialDay(material);
	return {
		cases,
		busiest,
		explain: busiest ? explainStatement(userId, busiest.date) : null,
		ok: cases.every(
			(c) =>
				c.oracleDifferences.length === 0 &&
				c.liveDifferences.every((d) => d.label !== "unexplained"),
		),
	};
}

/** The report as printable lines. */
export function formatParityReport(report: ParityReport): string[] {
	const lines: string[] = [];
	for (const c of report.cases) {
		const unexplained = c.liveDifferences.filter((d) => d.label === "unexplained").length;
		lines.push(
			`${c.oracleDifferences.length === 0 && unexplained === 0 ? "OK  " : "FAIL"} ${c.label}: ` +
				`${c.days} day(s), rpc ${c.rpc_ms} ms, function vs oracle ${c.oracleDifferences.length} difference(s), ` +
				`function vs live ${c.liveDifferences.length} day(s) (${unexplained} unexplained)`,
		);
		for (const d of c.oracleDifferences) {
			lines.push(
				`  oracle ${d.date} ${d.field}: oracle=${JSON.stringify(d.expected)} function=${JSON.stringify(d.actual)}`,
			);
		}
		for (const d of c.liveDifferences) {
			const detail = d.fields
				.map((f) => `${f.field}: function=${JSON.stringify(f.expected)} live=${JSON.stringify(f.actual)}`)
				.join("; ");
			lines.push(`  live ${d.date} [${d.label}] ${detail}`);
		}
	}
	if (report.busiest && report.explain) {
		lines.push(
			`Busiest material day: ${report.busiest.date} (${report.busiest.material_rows} rows). Paste into the SQL editor:`,
			`  ${report.explain}`,
			"  This gives the function's total time and buffers. EXPLAIN does not show the plan of the query inside a function.",
		);
	} else {
		lines.push("No material rows in the scan window; nothing to EXPLAIN.");
	}
	lines.push(report.ok ? "PARITY OK" : "PARITY FAILED");
	return lines;
}
