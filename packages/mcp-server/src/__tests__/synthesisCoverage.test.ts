import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import {
	COVERAGE_ARTIFACT_PAGE_SIZE,
	computeStreak,
	enumerateDays,
	getStreak,
	getSynthesisCoverage,
	isUncoveredDay,
} from "../links.js";
import { MAX_COVERAGE_DAYS } from "@ahkms/core";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { DOMAIN_PROVIDER } from "../domains.js";

import { DAILY_LOG_CONTENT_SUBTYPE } from "../vocab.js";

const getSynthesisCoverageHandler = (args: unknown) =>
	toMcpTool(serverRegistry().get("dos_synthesis_coverage")!).handler(args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

type MarkerRow = {
	id?: string;
	artifact_id: string;
	kind: string;
	external_id: string;
	// Which domain's ritual wrote this marker (#677). Optional so every pre-existing
	// fixture stays a single-provider world; when present, the stub HONOURS the
	// `.eq("provider", …)` predicate, so a domain-scoped read is a real behavioural
	// assertion and not just an argument check.
	provider?: string;
	// Present in the fixtures ON PURPOSE: this is the column a naive implementation would
	// bucket on, and the tests below assert the answer does not move with it.
	created_at?: string;
};
type ArtifactRow = {
	id: string;
	captured_at: string | null;
	effective_at?: string | null;
	content_subtype?: string | null;
	lifecycle_stage?: string | null;
};

type Calls = {
	markerSelect: string[];
	artifactSelect: string[];
	inCalls: unknown[][];
	/** Every `.eq()` the MARKER query applied. An absent provider predicate is a result. */
	markerEq: unknown[][];
	markerOrder: unknown[][];
	markerRange: Array<[number, number]>;
	markerGt: unknown[][];
	markerLimit: number[];
	gte: unknown[][];
	lte: unknown[][];
	or: string[];
	/** Every `.range(from, to)` the ARTIFACT query applied. Keyset paging (#2257) uses none. */
	range: Array<[number, number]>;
	/** Every `.limit(n)` the ARTIFACT query applied, one entry per page fetched. */
	artifactLimit: number[];
	order: unknown[][];
};

const POSTGREST_MAX_ROWS = 1000;

/**
 * Stub the two-query coverage read: the marker lookup on `artifact_external_links`, then
 * the `captured_at` lookup on `artifacts`. Every chained method returns the same thenable
 * builder, so both chain shapes (`...in()` and `...in().gte().lte().order().range()`)
 * resolve.
 *
 * The marker builder resolves LAZILY (inside `then`) so a `.eq("provider", …)`, `.gt("id", …)`,
 * `.order("id")`, or `.limit(n)` applied anywhere in the chain still filters/slices the rows it
 * hands back. The artifact builder's resolve function is handed the current `.range()` / `.limit()`
 * bounds so a stub with more rows than one page honours real PostgREST-style pagination instead of
 * always returning everything on the first request (#664 round-1 QA finding — the production code
 * now pages via `.range()`; a stub that ignored it would make that pagination untestable). Any read
 * with no `.range()` or `.limit()` returns at most 1,000 rows, matching PostgREST's `max_rows = 1000`
 * (#1779). Marker calls and artifact calls are recorded into separate sinks so marker pagination does
 * not pollute artifact `.range()` / `.order()` assertions.
 */
function stubCoverage(
	markers: MarkerRow[],
	artifacts: ArtifactRow[],
	opts: { markerError?: string; artifactError?: string } = {},
) {
	const calls: Calls = {
		markerSelect: [],
		artifactSelect: [],
		inCalls: [],
		markerEq: [],
		markerOrder: [],
		markerRange: [],
		markerGt: [],
		markerLimit: [],
		gte: [],
		lte: [],
		or: [],
		range: [],
		artifactLimit: [],
		order: [],
	};

	const normalizedMarkers = markers.map((m, i) => ({
		...m,
		id: m.id ?? `m-${String(i).padStart(6, "0")}`,
	}));

	function markerBuilder() {
		let currentRange: [number, number] | undefined;
		let limitCount: number | undefined;
		const localEq: Array<[string, unknown]> = [];
		const localGt: Array<[string, unknown]> = [];
		const localOrder: Array<{ col: string; asc: boolean }> = [];

		const b: any = {
			select: (cols: string) => {
				calls.markerSelect.push(cols);
				return b;
			},
			eq: (col: string, val: unknown) => {
				calls.markerEq.push([col, val]);
				localEq.push([col, val]);
				return b;
			},
			in: (...args: unknown[]) => {
				calls.inCalls.push(args);
				return b;
			},
			gt: (col: string, val: unknown) => {
				calls.markerGt.push([col, val]);
				localGt.push([col, val]);
				return b;
			},
			order: (...args: unknown[]) => {
				calls.markerOrder.push(args);
				if (typeof args[0] === "string") {
					const optsArg = args[1] as { ascending?: boolean } | undefined;
					localOrder.push({ col: args[0], asc: optsArg?.ascending ?? true });
				}
				return b;
			},
			limit: (n: number) => {
				limitCount = n;
				calls.markerLimit.push(n);
				return b;
			},
			range: (from: number, to: number) => {
				currentRange = [from, to];
				calls.markerRange.push(currentRange);
				return b;
			},
			then: (res: any, rej: any) =>
				Promise.resolve(
					(() => {
						if (opts.markerError) {
							return { data: null, error: { message: opts.markerError } };
						}
						const provider = localEq.find(([column]) => column === "provider")?.[1] as
							| string
							| undefined;
						let rows = provider
							? normalizedMarkers.filter((m) => m.provider === provider)
							: [...normalizedMarkers];
						for (const [col, val] of localGt) {
							rows = rows.filter((m) => String((m as any)[col] ?? "") > String(val));
						}
						if (localOrder.length > 0) {
							rows = [...rows].sort((a, bRow) => {
								for (const { col, asc } of localOrder) {
									const cmp = String((a as any)[col] ?? "").localeCompare(
										String((bRow as any)[col] ?? ""),
									);
									if (cmp !== 0) return asc ? cmp : -cmp;
								}
								return 0;
							});
						}
						if (currentRange) {
							const [from, to] = currentRange;
							rows = rows.slice(from, to + 1);
						} else {
							const cap =
								limitCount !== undefined
									? Math.min(limitCount, POSTGREST_MAX_ROWS)
									: POSTGREST_MAX_ROWS;
							rows = rows.slice(0, cap);
						}
						return { data: rows, error: null };
					})(),
				).then(res, rej),
		};
		return b;
	}

	function artifactBuilder() {
		let currentRange: [number, number] | undefined;
		let limitCount: number | undefined;
		let inIds: unknown[] | undefined;
		const orFilters: string[] = [];
		let gteCaptured: string | undefined;
		let lteCaptured: string | undefined;
		const localOrder: Array<{ col: string; asc: boolean }> = [];
		// Compare instants, not strings: the keyset bookmark is a row's own captured_at
		// ("…Z") while the window bounds are "….000Z".
		const ms = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);

		const b: any = {
			select: (cols: string) => {
				calls.artifactSelect.push(cols);
				return b;
			},
			eq: () => b,
			or: (expr: string) => {
				calls.or.push(expr);
				orFilters.push(expr);
				return b;
			},
			in: (...args: unknown[]) => {
				calls.inCalls.push(args);
				if (args[0] === "id" && Array.isArray(args[1])) {
					inIds = args[1];
				}
				return b;
			},
			gte: (...args: unknown[]) => {
				calls.gte.push(args);
				if (args[0] === "captured_at") gteCaptured = args[1] as string;
				return b;
			},
			lte: (...args: unknown[]) => {
				calls.lte.push(args);
				if (args[0] === "captured_at") lteCaptured = args[1] as string;
				return b;
			},
			order: (...args: unknown[]) => {
				calls.order.push(args);
				if (typeof args[0] === "string") {
					const optsArg = args[1] as { ascending?: boolean } | undefined;
					localOrder.push({ col: args[0], asc: optsArg?.ascending ?? true });
				}
				return b;
			},
			limit: (n: number) => {
				limitCount = n;
				calls.artifactLimit.push(n);
				return b;
			},
			range: (from: number, to: number) => {
				currentRange = [from, to];
				calls.range.push(currentRange);
				return b;
			},
			then: (res: any, rej: any) =>
				Promise.resolve(
					(() => {
						if (opts.artifactError) {
							return { data: null, error: { message: opts.artifactError } };
						}
						let base = inIds ? artifacts.filter((a) => inIds!.includes(a.id)) : artifacts;
						// Like PostgREST, a range predicate never matches a null captured_at.
						if (gteCaptured !== undefined) {
							base = base.filter((a) => ms(a.captured_at) >= ms(gteCaptured));
						}
						if (lteCaptured !== undefined) {
							base = base.filter((a) => ms(a.captured_at) <= ms(lteCaptured));
						}
						// The keyset bookmark (#2257): `captured_at.gt."<ts>",id.gt.<id>`.
						for (const expr of orFilters) {
							const m = /^captured_at\.gt\."([^"]+)",id\.gt\.(.+)$/.exec(expr);
							if (!m) continue;
							const [, ts, id] = m;
							base = base.filter(
								(a) => ms(a.captured_at) > ms(ts) || String(a.id).localeCompare(id) > 0,
							);
						}
						if (
							orFilters.includes(
								"lifecycle_stage.is.null,lifecycle_stage.not.in.(discovered,failed)",
							)
						) {
							base = base.filter(
								(a) =>
									a.lifecycle_stage == null ||
									(a.lifecycle_stage !== "discovered" &&
										a.lifecycle_stage !== "failed"),
							);
						}
						if (localOrder.length > 0) {
							base = [...base].sort((a, bRow) => {
								for (const { col, asc } of localOrder) {
									const cmp = String((a as any)[col] ?? "").localeCompare(
										String((bRow as any)[col] ?? ""),
									);
									if (cmp !== 0) return asc ? cmp : -cmp;
								}
								return 0;
							});
						}
						if (currentRange) {
							const [from, to] = currentRange;
							return { data: base.slice(from, to + 1), error: null };
						}
						const cap =
							limitCount !== undefined
								? Math.min(limitCount, POSTGREST_MAX_ROWS)
								: POSTGREST_MAX_ROWS;
						return { data: base.slice(0, cap), error: null };
					})(),
				).then(res, rej),
		};
		return b;
	}

	(supabase as any).from = vi.fn((table: string) =>
		table === "artifact_external_links" ? markerBuilder() : artifactBuilder(),
	);
	return calls;
}

describe("enumerateDays", () => {
	it("returns every calendar day in the closed interval, in order", () => {
		expect(enumerateDays("2026-08-12", "2026-08-15")).toEqual([
			"2026-08-12",
			"2026-08-13",
			"2026-08-14",
			"2026-08-15",
		]);
	});

	it("returns a single day when from equals to", () => {
		expect(enumerateDays("2026-08-12", "2026-08-12")).toEqual(["2026-08-12"]);
	});

	it("crosses a month boundary without skipping or duplicating a day", () => {
		expect(enumerateDays("2026-07-30", "2026-08-02")).toEqual([
			"2026-07-30",
			"2026-07-31",
			"2026-08-01",
			"2026-08-02",
		]);
	});
});

describe("getSynthesisCoverage - counts by kind", () => {
	// ACCEPTANCE (#561, build-plan item 1): a day carrying only the unattended marker
	// reports {synthesized: 0, synthesized_unattended: n} - never a collapsed scalar
	// state. #493/#495 derive against this shape (ADR-052 section 6), so it must not be
	// lossy from birth.
	it("reports a day swept unattended as 0 synthesized / n unattended", async () => {
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized_unattended", external_id: "page-13" },
				{ artifact_id: "a2", kind: "synthesized_unattended", external_id: "page-13" },
				{ artifact_id: "a3", kind: "synthesized_unattended", external_id: "page-13" },
			],
			[
				{ id: "a1", captured_at: "2026-08-13T09:00:00Z" },
				{ id: "a2", captured_at: "2026-08-13T14:00:00Z" },
				{ id: "a3", captured_at: "2026-08-13T21:00:00Z" },
			],
		);

		const days = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(days).toEqual([
			{
				date: "2026-08-13",
				synthesized: 0,
				synthesized_unattended: 3,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: ["page-13"],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 3,
				no_material: false,
			},
		]);
	});

	it("keeps both kinds separate on a promoted day rather than collapsing them", async () => {
		// A day the sweep closed and dos-catchup later promoted carries BOTH kinds:
		// promotion is an INSERT of a second marker, never an UPDATE of the first.
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized_unattended", external_id: "page-13" },
				{ artifact_id: "a1", kind: "synthesized", external_id: "page-13" },
			],
			[{ id: "a1", captured_at: "2026-08-13T09:00:00Z" }],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(day.synthesized).toBe(1);
		expect(day.synthesized_unattended).toBe(1);
		// The attribution the pooled `external_ids` could not express: both kinds point at
		// the SAME page here, and a consumer can now see that rather than infer it.
		expect(day.synthesized_external_ids).toEqual(["page-13"]);
		expect(day.synthesized_unattended_external_ids).toEqual(["page-13"]);
	});

	// The #562 fix, stated as the case that used to be unanswerable. Before it, the id set
	// was filled OUTSIDE the kind branch, so this day reported `external_ids:
	// [draft-13, promoted-13]` with nothing saying which page carried which marker — and
	// the tool downstream hard-coded the guess. The counts were never wrong; the
	// attribution simply did not exist.
	it("attributes each page id to the kind whose marker points at it, on a both-kinds day", async () => {
		stubCoverage(
			[
				// The sweep's draft, and a separate entry the owner later closed attended.
				{ artifact_id: "a1", kind: "synthesized_unattended", external_id: "draft-13" },
				{ artifact_id: "a2", kind: "synthesized", external_id: "promoted-13" },
			],
			[
				{ id: "a1", captured_at: "2026-08-13T09:00:00Z" },
				{ id: "a2", captured_at: "2026-08-13T10:00:00Z" },
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(day.synthesized_external_ids).toEqual(["promoted-13"]);
		expect(day.synthesized_unattended_external_ids).toEqual(["draft-13"]);
		// The per-LOG predicate #562 needs: `draft-13` is unconfirmed because it appears
		// under the unattended kind and not under the attended one. `promoted-13` is not.
		expect(day.synthesized_external_ids).not.toContain("draft-13");
		expect(day.synthesized_unattended_external_ids).not.toContain("promoted-13");
	});

	it("reports an attended day as n synthesized / 0 unattended", async () => {
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized", external_id: "page-14" },
				{ artifact_id: "a2", kind: "synthesized", external_id: "page-14" },
			],
			[
				{ id: "a1", captured_at: "2026-08-14T09:00:00Z" },
				{ id: "a2", captured_at: "2026-08-14T10:00:00Z" },
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-14", "2026-08-14");

		expect(day).toEqual({
			date: "2026-08-14",
			synthesized: 2,
			synthesized_unattended: 0,
			synthesized_external_ids: ["page-14"],
			synthesized_unattended_external_ids: [],
			evidence_aggregated: 0,
			evidence_aggregated_unattended: 0,
			evidence_aggregated_external_ids: [],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms: 2,
			no_material: false,
		});
	});
});

// The single most likely thing to get wrong (#561 open risks): the sweep is LAZY, so every
// marker it backfills carries the SWEEP date in artifact_external_links.created_at. A view
// keyed on created_at collapses a five-day catch-up into one day. The covered day is the
// swept atom's artifacts.captured_at date, full stop.
describe("getSynthesisCoverage - day attribution is captured_at, never created_at", () => {
	it("buckets a marker written days later to the day the atom was captured", async () => {
		// One sweep on the 18th, backfilling five days at once. Every marker row shares a
		// created_at; the atoms do not. A created_at-keyed read would report five markers
		// on the 18th and four uncovered days.
		const sweptOn = "2026-08-18T19:04:00Z";
		stubCoverage(
			["a1", "a2", "a3", "a4", "a5"].map((id, i) => ({
				artifact_id: id,
				kind: "synthesized_unattended",
				external_id: `page-1${i + 2}`,
				created_at: sweptOn,
			})),
			["a1", "a2", "a3", "a4", "a5"].map((id, i) => ({
				id,
				captured_at: `2026-08-1${i + 2}T10:00:00Z`,
			})),
		);

		const days = await getSynthesisCoverage("2026-08-12", "2026-08-18");

		expect(days.map((d) => [d.date, d.synthesized_unattended])).toEqual([
			["2026-08-12", 1],
			["2026-08-13", 1],
			["2026-08-14", 1],
			["2026-08-15", 1],
			["2026-08-16", 1],
			["2026-08-17", 0],
			["2026-08-18", 0],
		]);
		// The sweep date itself is NOT where the coverage lands.
		expect(days.find((d) => d.date === "2026-08-18")!.synthesized_unattended).toBe(0);
	});

	it("never reads the marker row's created_at column at all", async () => {
		const calls = stubCoverage([], []);
		await getSynthesisCoverage("2026-08-12", "2026-08-13");
		expect(calls.markerSelect).toEqual(["id, artifact_id, kind, external_id"]);
		expect(calls.markerSelect.join()).not.toContain("created_at");
	});

	it("windows the artifact lookup on captured_at, not on the link's timestamp", async () => {
		const calls = stubCoverage(
			[{ artifact_id: "a1", kind: "synthesized", external_id: "page-1" }],
			[{ id: "a1", captured_at: "2026-08-13T10:00:00Z" }],
		);

		await getSynthesisCoverage("2026-08-12", "2026-08-14");

		expect(calls.gte).toEqual([["captured_at", "2026-08-12T00:00:00.000Z"]]);
		expect(calls.lte).toEqual([["captured_at", "2026-08-14T23:59:59.999Z"]]);
	});
});

// Issue #677: the marker ledger is keyed on (artifact, provider, kind, external_id), but
// this read keyed on `kind` alone — so a day the personal ritual closed read as covered
// for Work too, and #561's sweep skipped a Work day nobody had ever run. One log
// PER DOMAIN (ADR-051 §11) means coverage is a per-domain question.
describe("getSynthesisCoverage - per-domain coverage (#677)", () => {
	/** One day, closed in `angus` only. The asymmetry every test below turns on. */
	const ANGUS_ONLY = () =>
		stubCoverage(
			[
				{
					artifact_id: "a1",
					kind: "synthesized",
					external_id: "personal-page",
					provider: DOMAIN_PROVIDER.angus,
				},
			],
			[{ id: "a1", captured_at: "2026-08-13T10:00:00Z" }],
		);

	// ACCEPTANCE: "a day logged only in `angus` reads as uncovered for `work`".
	it("reports a day closed only in angus as UNCOVERED for work", async () => {
		ANGUS_ONLY();

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13", "work");

		expect(day.synthesized).toBe(0);
		expect(day.synthesized_unattended).toBe(0);
		expect(day.synthesized_external_ids).toEqual([]);
	});

	it("reports the same day as COVERED for angus", async () => {
		ANGUS_ONLY();

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13", "angus");

		expect(day.synthesized).toBe(1);
		expect(day.synthesized_external_ids).toEqual(["personal-page"]);
	});

	// ACCEPTANCE: "unscoped calls keep today's behaviour" — no provider predicate at all,
	// NOT a default domain. A default would silently narrow every pre-#677 caller.
	it("applies no provider predicate at all when no domain is given, and still sees the day", async () => {
		const calls = ANGUS_ONLY();

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(calls.markerEq.map(([column]) => column)).toEqual(["user_id"]);
		expect(day.synthesized).toBe(1);
	});

	it("pools both domains' markers for one day when unscoped, and splits them when scoped", async () => {
		const bothDomains = () =>
			stubCoverage(
				[
					{
						artifact_id: "a1",
						kind: "synthesized",
						external_id: "hl-page",
						provider: DOMAIN_PROVIDER.work,
					},
					{
						artifact_id: "a2",
						kind: "synthesized",
						external_id: "personal-page",
						provider: DOMAIN_PROVIDER.angus,
					},
				],
				[
					{ id: "a1", captured_at: "2026-08-13T09:00:00Z" },
					{ id: "a2", captured_at: "2026-08-13T21:00:00Z" },
				],
			);

		bothDomains();
		const [pooled] = await getSynthesisCoverage("2026-08-13", "2026-08-13");
		expect(pooled.synthesized).toBe(2);
		expect(pooled.synthesized_external_ids).toEqual(["hl-page", "personal-page"]);

		bothDomains();
		const [hl] = await getSynthesisCoverage("2026-08-13", "2026-08-13", "work");
		expect(hl.synthesized).toBe(1);
		expect(hl.synthesized_external_ids).toEqual(["hl-page"]);
	});

	// The provider is resolved through DOMAIN_PROVIDER, never written as a literal:
	// ADR-054 §3 renames notion_personal -> notion_angus (#681) and a literal predicate
	// would silently stop matching the day that lands.
	it("filters on the provider DOMAIN_PROVIDER maps the domain to", async () => {
		const calls = stubCoverage([], []);

		await getSynthesisCoverage("2026-08-13", "2026-08-13", "angus");

		expect(calls.markerEq).toContainEqual(["provider", DOMAIN_PROVIDER.angus]);
	});
});

describe("getSynthesisCoverage - uncovered days and edges", () => {
	it("emits a zero row for every day in range with no marker at all", async () => {
		stubCoverage([], []);

		const days = await getSynthesisCoverage("2026-08-11", "2026-08-14");

		const zero = (date: string) => ({
			date,
			synthesized: 0,
			synthesized_unattended: 0,
			synthesized_external_ids: [],
			synthesized_unattended_external_ids: [],
			evidence_aggregated: 0,
			evidence_aggregated_unattended: 0,
			evidence_aggregated_external_ids: [],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms: 0,
			no_material: true,
		});
		expect(days).toEqual([
			zero("2026-08-11"),
			zero("2026-08-12"),
			zero("2026-08-13"),
			zero("2026-08-14"),
		]);
	});

	it("distinguishes zero-capture days (no_material) from uncovered days with material", async () => {
		// 2026-08-12 has atoms but no markers -> uncovered (no_material false)
		// 2026-08-13 has no atoms and no markers -> no_material true (#664)
		stubCoverage(
			[],
			[{ id: "atom-1", captured_at: "2026-08-12T10:00:00Z" }],
		);

		const days = await getSynthesisCoverage("2026-08-12", "2026-08-13");

		expect(days[0].captured_atoms).toBe(1);
		expect(days[0].no_material).toBe(false);
		expect(days[1].captured_atoms).toBe(0);
		expect(days[1].no_material).toBe(true);
	});

	it("leaves a day uncovered when its only marked atom has no captured_at", async () => {
		// Unattributable to any day; claiming a close would be a false positive.
		stubCoverage(
			[{ artifact_id: "a1", kind: "synthesized", external_id: "page-1" }],
			[{ id: "a1", captured_at: null }],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(day.synthesized).toBe(0);
		expect(day.synthesized_external_ids).toEqual([]);
	});

	it("dedupes and sorts the objects a day's markers point at", async () => {
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized", external_id: "page-b" },
				{ artifact_id: "a2", kind: "synthesized", external_id: "page-a" },
				{ artifact_id: "a3", kind: "synthesized", external_id: "page-b" },
			],
			[
				{ id: "a1", captured_at: "2026-08-13T01:00:00Z" },
				{ id: "a2", captured_at: "2026-08-13T02:00:00Z" },
				{ id: "a3", captured_at: "2026-08-13T03:00:00Z" },
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(day.synthesized_external_ids).toEqual(["page-a", "page-b"]);
		expect(day.synthesized).toBe(3);
	});

	it("ignores a marker whose artifact falls outside the window", async () => {
		stubCoverage(
			[{ artifact_id: "a-old", kind: "synthesized", external_id: "page-old" }],
			// The windowed query would not return it; mirror that by returning nothing.
			[],
		);

		const days = await getSynthesisCoverage("2026-08-13", "2026-08-13");

		expect(days[0].synthesized).toBe(0);
	});

	it("throws rather than degrading to an empty read when the marker lookup fails", async () => {
		// An empty coverage read is indistinguishable from "every day uncovered", and the
		// caller acts on that by writing drafts over days the owner already closed.
		stubCoverage([], [], { markerError: "relation does not exist" });

		await expect(getSynthesisCoverage("2026-08-13", "2026-08-13")).rejects.toThrow(
			/Synthesis-marker lookup failed/,
		);
	});

	it("throws rather than degrading when the artifact lookup fails", async () => {
		stubCoverage([{ artifact_id: "a1", kind: "synthesized", external_id: "page-1" }], [], {
			artifactError: "timeout",
		});

		await expect(getSynthesisCoverage("2026-08-13", "2026-08-13")).rejects.toThrow(
			/Coverage artifact lookup failed/,
		);
	});

	// Round-1 QA finding (#664 PR review): the artifact scan used to be one unchunked,
	// unpaginated request, so a window whose captured-atom count exceeded PostgREST's
	// `max_rows` cap would have the excess rows silently dropped — undercounting
	// `captured_atoms` and wrongly flipping `no_material` to true for a day that actually
	// had captures. This fixture puts more rows in the window than a single page holds,
	// so a regression back to the unpaginated query would make it fail.
	it("does not truncate a window with more captured atoms than one page holds", async () => {
		const total = COVERAGE_ARTIFACT_PAGE_SIZE + 5;
		const artifacts = Array.from({ length: total }, (_, i) => ({
			id: `a${i}`,
			captured_at: "2026-08-20T12:00:00Z",
		}));

		// Every row shares one captured_at, so the bookmark must break the tie on id.
		const sortedIds = artifacts.map((a) => a.id).sort((x, y) => x.localeCompare(y));
		const lastSortedId = sortedIds[COVERAGE_ARTIFACT_PAGE_SIZE - 1].slice(1);
		const calls = stubCoverage([], artifacts);

		const [day] = await getSynthesisCoverage("2026-08-20", "2026-08-20");

		expect(day.captured_atoms).toBe(total);
		expect(day.no_material).toBe(false);
		// Two pages fetched (a full page, then the 5-row remainder), proving the read
		// paginated instead of relying on one request to return everything.
		expect(calls.artifactLimit).toEqual([
			COVERAGE_ARTIFACT_PAGE_SIZE,
			COVERAGE_ARTIFACT_PAGE_SIZE,
		]);
		// Keyset, never OFFSET (#2257): the second page is bounded by a bookmark on the
		// last row read, so Postgres does not re-walk the first page to find it.
		expect(calls.range).toEqual([]);
		expect(calls.gte).toEqual([
			["captured_at", "2026-08-20T00:00:00.000Z"],
			["captured_at", "2026-08-20T12:00:00Z"],
		]);
		expect(calls.or).toContain(`captured_at.gt."2026-08-20T12:00:00Z",id.gt.a${lastSortedId}`);
	});
});

describe("dos_synthesis_coverage handler", () => {
	it("renders counts per kind per day plus a machine-readable payload", async () => {
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized_unattended", external_id: "page-13" },
				{ artifact_id: "a2", kind: "synthesized", external_id: "page-14" },
			],
			[
				{ id: "a1", captured_at: "2026-08-13T09:00:00Z" },
				{ id: "a2", captured_at: "2026-08-14T09:00:00Z" },
			],
		);

		const out = await getSynthesisCoverageHandler({
			from: "2026-08-13",
			to: "2026-08-15",
		} as any);
		const text = out.content[0].text;

		expect(text).toContain(
			"2026-08-13  synthesized=0  synthesized_unattended=1  evidence_aggregated=0  evidence_aggregated_unattended=0  synthesized_unattended → page-13",
		);
		expect(text).toContain(
			"2026-08-14  synthesized=1  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  synthesized → page-14",
		);
		expect(text).toContain(
			"2026-08-15  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0",
		);
		expect(text).toContain("2 day(s) carry a synthesis marker; 1 carry none.");

		const json = JSON.parse(text.split("```json\n")[1].split("\n```")[0]);
		expect(json).toHaveLength(3);
		expect(json[0]).toEqual({
			date: "2026-08-13",
			synthesized: 0,
			synthesized_unattended: 1,
			synthesized_external_ids: [],
			synthesized_unattended_external_ids: ["page-13"],
			evidence_aggregated: 0,
			evidence_aggregated_unattended: 0,
			evidence_aggregated_external_ids: [],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms: 1,
			no_material: false,
		});
	});

	it("refuses a backwards window", async () => {
		stubCoverage([], []);
		await expect(
			getSynthesisCoverageHandler({ from: "2026-08-14", to: "2026-08-13" } as any),
		).rejects.toThrow(/must be on or after/);
	});

	it("refuses a window wider than the cap", async () => {
		stubCoverage([], []);
		await expect(
			getSynthesisCoverageHandler({ from: "2026-01-01", to: "2026-12-31" } as any),
		).rejects.toThrow(new RegExp(`the maximum is ${MAX_COVERAGE_DAYS}`));
	});

	// #677: which domain(s) the numbers cover changes what every one of them means, so the
	// rendering says which — a reader must never have to assume.
	it("threads domain through to the read and names the scope in the output", async () => {
		const calls = stubCoverage(
			[
				{
					artifact_id: "a1",
					kind: "synthesized",
					external_id: "personal-page",
					provider: DOMAIN_PROVIDER.angus,
				},
			],
			[{ id: "a1", captured_at: "2026-08-13T09:00:00Z" }],
		);

		const out = await getSynthesisCoverageHandler({
			from: "2026-08-13",
			to: "2026-08-13",
			domain: "work",
		} as any);
		const text = out.content[0].text;

		expect(calls.markerEq).toContainEqual(["provider", DOMAIN_PROVIDER.work]);
		expect(text).toContain("domain: work");
		// The angus-only day is uncovered FOR WORK, and the text says why that is not
		// the same claim as "nothing happened".
		expect(text).toContain("2026-08-13  synthesized=0  synthesized_unattended=0");
		expect(text).toContain("0 day(s) carry a synthesis marker; 1 carry none.");
		expect(text).toContain("for domain 'work' ALONE");
	});

	it("says the counts are pooled when no domain was given", async () => {
		stubCoverage([], []);

		const out = await getSynthesisCoverageHandler({
			from: "2026-08-13",
			to: "2026-08-13",
		} as any);

		expect(out.content[0].text).toContain("all domains pooled (no domain given)");
		expect(out.content[0].text).toContain("Counts POOL every domain");
	});

	it("renders streak badge and explains no_material breakdown in the output", async () => {
		// 2026-08-13 attended synthesis -> extends streak to 1
		// 2026-08-14 no material -> pauses streak at 1 (#664)
		// 2026-08-15 uncovered with material -> breaks streak to 0
		stubCoverage(
			[{ artifact_id: "a1", kind: "synthesized", external_id: "page-13" }],
			[
				{ id: "a1", captured_at: "2026-08-13T09:00:00Z" },
				{ id: "atom-15", captured_at: "2026-08-15T09:00:00Z" },
			],
		);

		const out = await getSynthesisCoverageHandler({
			from: "2026-08-13",
			to: "2026-08-15",
		} as any);
		const text = out.content[0].text;

		expect(text).toContain("streak: day 0 · best 1");
		expect(text).toContain(
			"2026-08-14  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → no_material",
		);
		expect(text).toContain(
			"2026-08-15  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → uncovered",
		);
		expect(text).toContain(
			"Of the days with no marker: 1 uncovered (material existed), 1 no_material (zero atoms captured).",
		);
	});

	// Round-1 QA finding (PR #1183): the badge must be the real streak, not a property of
	// this call's own [from, to] window. Ten consecutive synthesized days precede a
	// narrow 2-day window; if the handler still fed `computeStreak` only the days it
	// listed, the badge would be capped at ~2 instead of showing the true 10-day run.
	it("reports a streak longer than the requested window, not capped by it", async () => {
		const attendedDays = [
			"2026-07-01",
			"2026-07-02",
			"2026-07-03",
			"2026-07-04",
			"2026-07-05",
			"2026-07-06",
			"2026-07-07",
			"2026-07-08",
			"2026-07-09",
			"2026-07-10",
		];
		stubCoverage(
			attendedDays.map((date, i) => ({
				artifact_id: `a${i + 1}`,
				kind: "synthesized",
				external_id: `page-${i + 1}`,
			})),
			attendedDays.map((date, i) => ({ id: `a${i + 1}`, captured_at: `${date}T09:00:00Z` })),
		);

		// The window this call actually lists is the LAST TWO of those ten days.
		const out = await getSynthesisCoverageHandler({
			from: "2026-07-09",
			to: "2026-07-10",
		} as any);

		expect(out.content[0].text).toContain("streak: day 10 🔥 · best 10");
	});

	// #664: zero-capture days derive no_material at read time (ADR-052 §8 amendment).
	it("reports a zero-capture day as no_material = true and renders → no_material", async () => {
		stubCoverage([], []);

		const out = await getSynthesisCoverageHandler({
			from: "2026-08-13",
			to: "2026-08-13",
		} as any);
		const text = out.content[0].text;

		expect(text).toContain(
			"2026-08-13  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → no_material",
		);
		expect(text).toContain("0 day(s) carry a synthesis marker; 1 carry none.");
		expect(text).toContain(
			"Of the days with no marker: 0 uncovered (material existed), 1 no_material (zero atoms captured).",
		);
		expect(text).toContain(
			"A day with zero atoms captured is no_material — it pauses the streak rather than breaking it (ADR-052 §8, #664).",
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");
		expect(day.captured_atoms).toBe(0);
		expect(day.no_material).toBe(true);
	});

	it("distinguishes an uncovered day (atoms captured, no markers) from a no_material day (0 atoms captured)", async () => {
		stubCoverage([], [{ id: "a1", captured_at: "2026-08-13T10:00:00Z" }]);

		const out = await getSynthesisCoverageHandler({
			from: "2026-08-13",
			to: "2026-08-14",
		} as any);
		const text = out.content[0].text;

		expect(text).toContain(
			"2026-08-13  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → uncovered",
		);
		expect(text).toContain(
			"2026-08-14  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → no_material",
		);
		expect(text).toContain("0 day(s) carry a synthesis marker; 2 carry none.");
		expect(text).toContain(
			"Of the days with no marker: 1 uncovered (material existed), 1 no_material (zero atoms captured).",
		);

		const days = await getSynthesisCoverage("2026-08-13", "2026-08-14");
		expect(days[0].captured_atoms).toBe(1);
		expect(days[0].no_material).toBe(false);
		expect(days[1].captured_atoms).toBe(0);
		expect(days[1].no_material).toBe(true);
	});

	it("excludes Daily Log twins from captured_atoms count so an empty day with only a log twin stays no_material", async () => {
		stubCoverage(
			[],
			[
				{
					id: "log-twin-1",
					captured_at: "2026-08-13T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");
		expect(day.captured_atoms).toBe(0);
		expect(day.no_material).toBe(true);
	});

	it("excludes discovered/failed pointers and scaffold rows from captured_atoms count (#567, #994)", async () => {
		stubCoverage(
			[],
			[
				{
					id: "ptr-1",
					captured_at: "2026-08-13T04:00:00Z",
					lifecycle_stage: "discovered",
				},
				{
					id: "ptr-2",
					captured_at: "2026-08-13T05:00:00Z",
					lifecycle_stage: "failed",
				},
				{
					id: "scaf-1",
					captured_at: "2026-08-13T17:00:00Z",
					content_subtype: "scaffold",
				},
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");
		expect(day.captured_atoms).toBe(0);
		expect(day.no_material).toBe(true);
	});

	it("buckets late-ingested meeting notes (effective_at within 7 days of captured_at) to their meeting date while keeping historic backfills on captured_at", async () => {
		stubCoverage(
			[
				{ artifact_id: "meeting-nov-3", kind: "synthesized_unattended", external_id: "page-nov-3" },
			],
			[
				{
					id: "meeting-nov-3",
					effective_at: "2026-11-03T15:00:00Z",
					captured_at: "2026-11-04T01:00:00Z",
				},
				{
					id: "historic-2016",
					effective_at: "2016-03-12T09:41:00Z",
					captured_at: "2026-11-04T10:00:00Z",
				},
			],
		);

		const days = await getSynthesisCoverage("2026-11-03", "2026-11-04");
		expect(days[0]).toMatchObject({
			date: "2026-11-03",
			synthesized_unattended: 1,
			synthesized_unattended_external_ids: ["page-nov-3"],
			captured_atoms: 1,
			no_material: false,
		});
		expect(days[1]).toMatchObject({
			date: "2026-11-04",
			synthesized_unattended: 0,
			captured_atoms: 1,
			no_material: false,
		});
	});
});

describe("computeStreak (ADR-052 §8, #493, #664)", () => {
	const day = (
		date: string,
		synthesized: number,
		synthesized_unattended: number,
		no_material = false,
	) => ({
		date,
		synthesized,
		synthesized_unattended,
		synthesized_external_ids: [],
		synthesized_unattended_external_ids: [],
		evidence_aggregated: 0,
		evidence_aggregated_unattended: 0,
		evidence_aggregated_external_ids: [],
		evidence_aggregated_unattended_external_ids: [],
		// Dev's #664 shape: a no_material day captured zero atoms; any other day in these
		// fixtures is treated as having captured one.
		captured_atoms: no_material ? 0 : 1,
		no_material,
	});

	it("starts at 0 when days is empty", () => {
		const result = computeStreak([]);
		expect(result).toEqual({ current: 0, best: 0, formatted: "day 0 · best 0" });
	});

	it("extends streak on consecutive synthesized days and only adds 🔥 when current > 3", () => {
		const days = [
			day("2026-08-01", 1, 0),
			day("2026-08-02", 2, 0),
			day("2026-08-03", 1, 0),
		];
		const result = computeStreak(days, { asOfToday: "2026-08-04" });
		expect(result).toEqual({ current: 3, best: 3, formatted: "day 3 · best 3" });

		const fourDays = [...days, day("2026-08-04", 1, 0)];
		expect(computeStreak(fourDays, { asOfToday: "2026-08-05" })).toEqual({
			current: 4,
			best: 4,
			formatted: "day 4 🔥 · best 4",
		});
	});

	it("pauses streak on synthesized_unattended and on no_material (#664)", () => {
		const days = [
			day("2026-08-01", 1, 0),
			// Pauses: unattended sweep
			day("2026-08-02", 0, 1),
			day("2026-08-03", 1, 0),
			// Pauses: zero-capture weekend
			day("2026-08-04", 0, 0, true),
			day("2026-08-05", 1, 0),
		];
		const result = computeStreak(days, { asOfToday: "2026-08-06" });
		expect(result).toEqual({ current: 3, best: 3, formatted: "day 3 · best 3" });
	});

	it("breaks streak on uncovered day with captured material and preserves personal best", () => {
		const days = [
			day("2026-08-01", 1, 0),
			day("2026-08-02", 1, 0),
			day("2026-08-03", 1, 0), // streak reaches 3, best = 3
			day("2026-08-04", 0, 0), // uncovered with material -> breaks to 0
			day("2026-08-05", 1, 0), // resumes -> current = 1, best = 3
		];
		const result = computeStreak(days, { asOfToday: "2026-08-06" });
		expect(result).toEqual({ current: 1, best: 3, formatted: "day 1 · best 3" });
	});

	it("does not break streak when today is still in progress and not yet synthesized", () => {
		const days = [
			day("2026-08-01", 1, 0),
			day("2026-08-02", 1, 0),
			// Today is in progress, has atoms, not synthesized yet
			day("2026-08-03", 0, 0),
		];
		const result = computeStreak(days, { asOfToday: "2026-08-03" });
		expect(result).toEqual({ current: 2, best: 2, formatted: "day 2 · best 2" });
	});

	it("extends streak when today is already synthesized", () => {
		const days = [
			day("2026-08-01", 1, 0),
			day("2026-08-02", 1, 0),
			// Today has already been synthesized
			day("2026-08-03", 1, 0),
		];
		const result = computeStreak(days, { asOfToday: "2026-08-03" });
		expect(result).toEqual({ current: 3, best: 3, formatted: "day 3 · best 3" });
	});
});

describe("getStreak (live query derivation across history)", () => {
	it("returns 0 streak when there are no markers", async () => {
		stubCoverage([], []);
		const result = await getStreak();
		expect(result).toEqual({ current: 0, best: 0, formatted: "day 0 · best 0" });
	});

	it("computes streak across historical range respecting pauses and breaks", async () => {
		// Day 1: 2026-08-10 synthesized
		// Day 2: 2026-08-11 no material -> pauses (#664)
		// Day 3: 2026-08-12 synthesized -> extends to 2
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized", external_id: "page-1" },
				{ artifact_id: "a2", kind: "synthesized", external_id: "page-2" },
			],
			[
				{ id: "a1", captured_at: "2026-08-10T10:00:00Z" },
				{ id: "a2", captured_at: "2026-08-12T10:00:00Z" },
			],
		);

		const result = await getStreak(undefined, "2026-08-12");
		expect(result).toEqual({ current: 2, best: 2, formatted: "day 2 · best 2" });
	});

	// getStreak consumes the same #664 derivation as getSynthesisCoverage: a day whose only
	// capture is a Daily Log twin has captured_atoms 0, so it is no_material and pauses,
	// while a day with a real atom and no marker breaks the streak.
	it("pauses on a Daily-Log-only day and breaks on an uncovered day with atoms", async () => {
		stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized", external_id: "page-1" },
				{ artifact_id: "a2", kind: "synthesized", external_id: "page-2" },
				{ artifact_id: "a4", kind: "synthesized", external_id: "page-4" },
			],
			[
				{ id: "a1", captured_at: "2026-08-10T10:00:00Z" },
				{
					id: "log-11",
					captured_at: "2026-08-11T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
				{ id: "a2", captured_at: "2026-08-12T10:00:00Z" },
				{ id: "atom-13", captured_at: "2026-08-13T10:00:00Z" },
				{ id: "a4", captured_at: "2026-08-14T10:00:00Z" },
			],
		);

		const result = await getStreak(undefined, "2026-08-14");
		expect(result).toEqual({ current: 1, best: 2, formatted: "day 1 · best 2" });
	});

	it("pauses (rather than breaks) the streak on a day containing only discovered/failed pointers and scaffold rows (#567, #994)", async () => {
		const calls = stubCoverage(
			[
				{ artifact_id: "a1", kind: "synthesized", external_id: "page-1" },
				{ artifact_id: "a3", kind: "synthesized", external_id: "page-3" },
			],
			[
				{ id: "a1", captured_at: "2026-08-10T10:00:00Z" },
				{
					id: "ptr-discovered",
					captured_at: "2026-08-11T04:00:00Z",
					lifecycle_stage: "discovered",
				},
				{
					id: "ptr-failed",
					captured_at: "2026-08-11T05:00:00Z",
					lifecycle_stage: "failed",
				},
				{
					id: "scaf-11",
					captured_at: "2026-08-11T17:00:00Z",
					content_subtype: "scaffold",
				},
				{ id: "a3", captured_at: "2026-08-12T10:00:00Z" },
			],
		);

		const result = await getStreak(undefined, "2026-08-12");
		expect(result).toEqual({ current: 2, best: 2, formatted: "day 2 · best 2" });
		expect(calls.or).toContain(
			"lifecycle_stage.is.null,lifecycle_stage.not.in.(discovered,failed)",
		);
	});

	// Round-1 QA finding (PR #1183): unlike the sibling `.in("id", …)` lookup in
	// getSynthesisCoverage/getDailyLogQueue, this one shipped with no chunking. A years-long
	// streak history is exactly the case getStreak exists for, so 301 marked artifacts (one
	// over COVERAGE_ID_CHUNK) must become two `.in("id", …)` calls, never one oversized one.
	it("chunks the marked-artifact lookup so it never exceeds the .in() page size", async () => {
		const ids = Array.from({ length: 301 }, (_, i) => `a${i + 1}`);
		const markers = ids.map((id, i) => ({
			artifact_id: id,
			kind: "synthesized",
			external_id: `page-${i + 1}`,
		}));
		const artifacts = ids.map((id) => ({ id, captured_at: "2026-01-01T00:00:00Z" }));
		const calls = stubCoverage(markers, artifacts);

		await getStreak();

		const idCalls = calls.inCalls.filter(([column]) => column === "id");
		expect(idCalls).toHaveLength(2);
		expect((idCalls[0][1] as string[]).length).toBe(300);
		expect((idCalls[1][1] as string[]).length).toBe(1);
	});
});

describe("beyond the first 1,000 markers", () => {
	it("coverage counts a marker that is the 1,200th row", async () => {
		const markers = Array.from({ length: 1200 }, (_, i) => ({
			id: `m-${String(i + 1).padStart(6, "0")}`,
			artifact_id: i === 1199 ? "target-atom" : `older-atom-${i + 1}`,
			kind: "synthesized",
			external_id: i === 1199 ? "page-aug-14" : `page-old-${i + 1}`,
		}));
		const artifacts = [
			...Array.from({ length: 1199 }, (_, i) => ({
				id: `older-atom-${i + 1}`,
				captured_at: "2026-01-01T10:00:00Z",
			})),
			{ id: "target-atom", captured_at: "2026-08-14T10:00:00Z" },
		];
		const calls = stubCoverage(markers, artifacts);

		const [day] = await getSynthesisCoverage("2026-08-14", "2026-08-14");
		expect(day).toEqual({
			date: "2026-08-14",
			synthesized: 1,
			synthesized_unattended: 0,
			synthesized_external_ids: ["page-aug-14"],
			synthesized_unattended_external_ids: [],
			evidence_aggregated: 0,
			evidence_aggregated_unattended: 0,
			evidence_aggregated_external_ids: [],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms: 1,
			no_material: false,
		});
		expect(calls.markerLimit).toEqual([1000, 1000]);
		expect(calls.markerGt).toEqual([["id", "m-001000"]]);
		// One window page: the stub now honours the captured_at bounds (#2257), and only
		// one of this fixture's artifacts falls on 14 Aug.
		expect(calls.order).toEqual([
			["captured_at", { ascending: true }],
			["id"],
		]);
	});

	it("the streak sees a day whose only marker is past row 1,000", async () => {
		const markers = [
			...Array.from({ length: 1050 }, (_, i) => ({
				id: `m-${String(i + 1).padStart(6, "0")}`,
				artifact_id: `day1-atom-${i + 1}`,
				kind: "synthesized",
				external_id: "page-aug-13",
			})),
			{
				id: "m-001051",
				artifact_id: "day2-atom",
				kind: "synthesized",
				external_id: "page-aug-14",
			},
		];
		const artifacts = [
			...Array.from({ length: 1050 }, (_, i) => ({
				id: `day1-atom-${i + 1}`,
				captured_at: "2026-08-13T10:00:00Z",
			})),
			{ id: "day2-atom", captured_at: "2026-08-14T10:00:00Z" },
		];
		const calls = stubCoverage(markers, artifacts);

		const streak = await getStreak(undefined, "2026-08-14");
		expect(streak).toEqual({ current: 2, best: 2, formatted: "day 2 · best 2" });
		expect(calls.markerLimit).toEqual([1000, 1000]);
		expect(calls.markerGt).toEqual([["id", "m-001000"]]);
		expect(calls.order).toEqual([
			["captured_at", { ascending: true }],
			["id"],
			["captured_at", { ascending: true }],
			["id"],
		]);
	});

	// #2257: a bulk day is skipped once it has yielded COVERAGE_MAX_ATOMS_PER_DAY material
	// rows. The read must then resume at the NEXT day with no stale bookmark, or the days
	// after the bulk day would be filtered out by the previous page's id.
	it("skips the rest of a saturated day and still counts the days after it", async () => {
		const bulk = Array.from({ length: 5000 }, (_, i) => ({
			id: `z-${String(i).padStart(5, "0")}`,
			captured_at: "2026-08-10T10:00:00Z",
		}));
		const calls = stubCoverage(
			[],
			[
				{ id: "a-before", captured_at: "2026-08-09T10:00:00Z" },
				...bulk,
				{ id: "a-after", captured_at: "2026-08-11T10:00:00Z" },
			],
		);

		const days = await getSynthesisCoverage("2026-08-09", "2026-08-11");

		expect(days.map((d) => d.captured_atoms > 0)).toEqual([true, true, true]);
		expect(days[2].captured_atoms).toBe(1);
		// 4 pages, not the 6 an unskipped read of 5,002 rows needs: three reach into the
		// bulk day (saturating it past 2,000), then one resumes from 11 Aug.
		expect(calls.artifactLimit).toHaveLength(4);
		expect(calls.gte.at(-1)).toEqual(["captured_at", "2026-08-11T00:00:00.000Z"]);
	});

	it("streak pages a long history by bookmark, not by offset", async () => {
		const markers = [{ artifact_id: "a-00000", kind: "synthesized", external_id: "p" }];
		const artifacts = Array.from({ length: 2500 }, (_, i) => ({
			id: `a-${String(i).padStart(5, "0")}`,
			captured_at: `2026-08-${String(1 + (i % 5)).padStart(2, "0")}T10:00:00Z`,
		}));
		const calls = stubCoverage(markers, artifacts);

		await getStreak(undefined, "2026-08-05");

		expect(calls.range).toEqual([]);
		// One `.limit()` for the marked-artifact lookup is absent (it uses `.in()` only),
		// so these are the window pages: 2,500 rows in three bookmarked pages.
		expect(calls.artifactLimit).toEqual([1000, 1000, 1000]);
		expect(calls.or.filter((o) => o.startsWith("captured_at.gt."))).toHaveLength(2);
	});

	it("paginates 5,000 markers and 20,000 window rows in 6 + 21 queries under 5s", async () => {
		const markers = Array.from({ length: 5000 }, (_, i) => ({
			id: `m-${String(i + 1).padStart(6, "0")}`,
			artifact_id: `a-${String(i + 1).padStart(6, "0")}`,
			kind: "synthesized",
			external_id: "page-aug-14",
		}));
		const artifacts = Array.from({ length: 20000 }, (_, i) => ({
			id: `a-${String(i + 1).padStart(6, "0")}`,
			captured_at: `2026-08-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00Z`,
		}));
		const calls = stubCoverage(markers, artifacts);

		const start = performance.now();
		const days = await getSynthesisCoverage("2026-08-01", "2026-08-20");
		const elapsedMs = performance.now() - start;

		expect(days).toHaveLength(20);
		expect(days.reduce((sum, d) => sum + d.synthesized, 0)).toBe(5000);
		expect(calls.markerLimit).toHaveLength(6);
		expect(calls.artifactLimit).toHaveLength(21);
		expect(calls.range).toEqual([]);
		expect(elapsedMs).toBeLessThan(5000);
	});
});

describe("evidence_aggregated and evidence_aggregated_unattended (#2226)", () => {
	it("counts evidence_aggregated on a Daily Log twin, excludes the twin from captured_atoms, and marks isUncoveredDay false", async () => {
		stubCoverage(
			[{ artifact_id: "twin-1", kind: "evidence_aggregated", external_id: "page-1" }],
			[
				{ id: "atom-1", captured_at: "2026-08-13T09:00:00Z" },
				{
					id: "twin-1",
					captured_at: "2026-08-13T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");
		expect(day).toEqual({
			date: "2026-08-13",
			synthesized: 0,
			synthesized_unattended: 0,
			synthesized_external_ids: [],
			synthesized_unattended_external_ids: [],
			evidence_aggregated: 1,
			evidence_aggregated_unattended: 0,
			evidence_aggregated_external_ids: ["page-1"],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms: 1,
			no_material: false,
		});
		expect(isUncoveredDay(day)).toBe(false);
	});

	it("counts evidence_aggregated_unattended on a twin and sets no_material false even when captured_atoms === 0", async () => {
		stubCoverage(
			[
				{
					artifact_id: "twin-1",
					kind: "evidence_aggregated_unattended",
					external_id: "page-unatt",
				},
			],
			[
				{
					id: "twin-1",
					captured_at: "2026-08-13T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
			],
		);

		const [day] = await getSynthesisCoverage("2026-08-13", "2026-08-13");
		expect(day.evidence_aggregated).toBe(0);
		expect(day.evidence_aggregated_unattended).toBe(1);
		expect(day.evidence_aggregated_unattended_external_ids).toEqual(["page-unatt"]);
		expect(day.captured_atoms).toBe(0);
		expect(day.no_material).toBe(false);
		expect(isUncoveredDay(day)).toBe(false);
	});

	it("getStreak extends on evidence_aggregated, pauses on evidence_aggregated_unattended, and lets attended win", async () => {
		stubCoverage(
			[
				{ artifact_id: "twin-1", kind: "evidence_aggregated", external_id: "p1" },
				{ artifact_id: "twin-2", kind: "evidence_aggregated_unattended", external_id: "p2" },
				{ artifact_id: "a-3", kind: "synthesized_unattended", external_id: "p3" },
				{ artifact_id: "twin-3", kind: "evidence_aggregated", external_id: "p3" },
			],
			[
				{
					id: "twin-1",
					captured_at: "2026-08-10T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
				{
					id: "twin-2",
					captured_at: "2026-08-11T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
				{ id: "a-3", captured_at: "2026-08-12T10:00:00Z" },
				{
					id: "twin-3",
					captured_at: "2026-08-12T23:55:00Z",
					content_subtype: DAILY_LOG_CONTENT_SUBTYPE,
				},
			],
		);

		const streak = await getStreak(undefined, "2026-08-12");
		expect(streak).toEqual({ current: 2, best: 2, formatted: "day 2 · best 2" });
	});
});

