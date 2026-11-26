import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { getDailyLogQueue } from "../links.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { DOMAIN_PROVIDER } from "../domains.js";
import { DAILY_LOG_LINK_KIND, STATE_DOC_LINK_KIND } from "../vocab.js";

const getDailyLogQueueHandler = (args: unknown) =>
	toMcpTool(serverRegistry().get("dos_daily_log_queue")!).handler(args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

type Row = Record<string, unknown>;

/**
 * An in-memory PostgREST: every chained predicate is recorded and applied to the table's
 * rows at await time, so a read that forgets a predicate (or adds a wrong one) changes the
 * answer rather than just an argument list. Three reads share `artifact_external_links`
 * and are told apart by what they filter on, which is the point.
 */
const POSTGREST_MAX_ROWS = 1000;

function stubTables(tables: Record<string, Row[]>, errors: Record<string, string> = {}) {
	const froms: string[] = [];
	const callsPerTable: Record<string, number> = {};
	const normalizedTables: Record<string, Row[]> = Object.fromEntries(
		Object.entries(tables).map(([table, rows]) => [
			table,
			rows.map((r, idx) => ({
				...r,
				id: r.id ?? `row-${String(idx).padStart(6, "0")}`,
			})),
		]),
	);
	function builder(table: string) {
		// An error can be keyed by table, or by "table#n" for the n-th call to that table
		// (1-based), so the second read of artifact_external_links can fail on its own.
		const nth = (callsPerTable[table] = (callsPerTable[table] ?? 0) + 1);
		const failure = errors[table] ?? errors[`${table}#${nth}`];
		const preds: Array<(r: Row) => boolean> = [];
		const orders: Array<{ col: string; asc: boolean }> = [];
		let rangeWindow: [number, number] | null = null;
		let limitCount: number | null = null;
		const b: any = {
			select: () => b,
			eq: (col: string, v: unknown) => {
				preds.push((r) => r[col] === v);
				return b;
			},
			gt: (col: string, v: unknown) => {
				preds.push((r) => String(r[col] ?? "") > String(v));
				return b;
			},
			in: (col: string, vs: unknown[]) => {
				preds.push((r) => vs.includes(r[col]));
				return b;
			},
			is: (col: string, v: unknown) => {
				preds.push((r) => (v === null ? r[col] == null : r[col] === v));
				return b;
			},
			order: (col?: string, opts?: { ascending?: boolean }) => {
				if (col) orders.push({ col, asc: opts?.ascending ?? true });
				return b;
			},
			limit: (n: number) => {
				limitCount = n;
				return b;
			},
			range: (from: number, to: number) => {
				rangeWindow = [from, to];
				return b;
			},
			then: (res: any, rej: any) => {
				if (failure) {
					return Promise.resolve({ data: null, error: { message: failure } }).then(res, rej);
				}
				let data = (normalizedTables[table] ?? []).filter((r) => preds.every((p) => p(r)));
				if (orders.length > 0) {
					data = [...data].sort((a, bRow) => {
						for (const { col, asc } of orders) {
							const cmp = String(a[col] ?? "").localeCompare(String(bRow[col] ?? ""));
							if (cmp !== 0) return asc ? cmp : -cmp;
						}
						return 0;
					});
				}
				if (rangeWindow) {
					data = data.slice(rangeWindow[0], rangeWindow[1] + 1);
				} else if (limitCount !== null) {
					data = data.slice(0, Math.min(limitCount, POSTGREST_MAX_ROWS));
				} else {
					data = data.slice(0, POSTGREST_MAX_ROWS);
				}
				return Promise.resolve({ data, error: null }).then(res, rej);
			},
		};
		return b;
	}
	(supabase as any).from = vi.fn((table: string) => {
		froms.push(table);
		return builder(table);
	});
	return froms;
}

const USER = "00000000-0000-0000-0000-000000000000"; // vitest.config env
const HL = DOMAIN_PROVIDER.work;
const AN = DOMAIN_PROVIDER.angus;

const twin = (id: string, captured_at: string, extra: Row = {}): Row => ({
	id,
	user_id: USER,
	content_subtype: "daily_log",
	archived_at: null,
	title: `log ${id}`,
	captured_at,
	...extra,
});
const pointer = (artifact_id: string, provider: string, page: string): Row => ({
	user_id: USER,
	artifact_id,
	provider,
	kind: DAILY_LOG_LINK_KIND,
	external_id: page,
	external_url: `https://notion.so/${page}`,
});
const hop2 = (artifact_id: string, provider: string, stateDoc: string): Row => ({
	user_id: USER,
	artifact_id,
	provider,
	kind: STATE_DOC_LINK_KIND,
	external_id: stateDoc,
	external_url: null,
});
const marker = (atom: string, kind: string, page: string, provider = HL): Row => ({
	user_id: USER,
	artifact_id: atom,
	provider,
	kind,
	external_id: page,
});

describe("getDailyLogQueue", () => {
	it("lists every twin with no consumed_by_state row, oldest first, with its page and domain", async () => {
		stubTables({
			artifacts: [
				twin("t2", "2026-08-24T00:00:00Z"),
				twin("t1", "2026-08-21T00:00:00Z"),
				// An ordinary atom: not a twin, never listed.
				{ id: "a1", user_id: USER, content_subtype: null, archived_at: null, captured_at: "2026-08-21T09:00:00Z" },
				// An archived twin: gone.
				twin("t0", "2026-08-01T00:00:00Z", { archived_at: "2026-08-02T00:00:00Z" }),
			],
			artifact_external_links: [pointer("t1", HL, "page-21"), pointer("t2", AN, "page-24")],
		});

		const queue = await getDailyLogQueue();

		// The stub does not sort; the read asks the database to, and the entries keep the
		// order the rows arrive in. What is asserted here is membership and attribution.
		expect(queue.map((e) => e.artifact_id).sort()).toEqual(["t1", "t2"]);
		const t1 = queue.find((e) => e.artifact_id === "t1")!;
		expect(t1).toEqual({
			artifact_id: "t1",
			date: "2026-08-21",
			title: "log t1",
			domain: "work",
			provider: HL,
			page_id: "page-21",
			page_url: "https://notion.so/page-21",
			// No marker of either kind points at page-21: that is its own state, never
			// "confirmed" by default (finding 1 of the QA round on #985).
			markers: "none",
			conflicting_providers: [],
			consumed_by_state: null,
		});
		expect(queue.find((e) => e.artifact_id === "t2")!.domain).toBe("angus");
	});

	it("drops a twin the State Doc has absorbed, and lists it marked when asked to", async () => {
		stubTables({
			artifacts: [twin("t1", "2026-08-21T00:00:00Z"), twin("t2", "2026-08-22T00:00:00Z")],
			artifact_external_links: [
				pointer("t1", HL, "page-21"),
				pointer("t2", HL, "page-22"),
				hop2("t1", HL, "state-doc"),
			],
		});

		expect((await getDailyLogQueue()).map((e) => e.artifact_id)).toEqual(["t2"]);

		const all = await getDailyLogQueue(undefined, true);
		expect(all.map((e) => [e.artifact_id, e.consumed_by_state])).toEqual([
			["t1", "state-doc"],
			["t2", null],
		]);
	});

	it("derives the marker state from the page's markers: attended wins, unattended alone is a draft, nothing is nothing", async () => {
		stubTables({
			artifacts: [
				twin("swept", "2026-08-21T00:00:00Z"),
				twin("promoted", "2026-08-22T00:00:00Z"),
				twin("closed", "2026-08-23T00:00:00Z"),
				twin("unmarked", "2026-08-24T00:00:00Z"),
			],
			artifact_external_links: [
				pointer("swept", HL, "page-21"),
				pointer("promoted", HL, "page-22"),
				pointer("closed", HL, "page-23"),
				pointer("unmarked", HL, "page-24"),
				marker("a1", "synthesized_unattended", "page-21"),
				marker("a2", "synthesized_unattended", "page-22"),
				marker("a2", "synthesized", "page-22"),
				marker("a3", "synthesized", "page-23"),
			],
		});

		const byId = Object.fromEntries((await getDailyLogQueue()).map((e) => [e.artifact_id, e.markers]));
		expect(byId).toEqual({ swept: "unattended", promoted: "attended", closed: "attended", unmarked: "none" });
	});

	it("reports a twin whose pointers name two domains as a conflict rather than picking one by row order", async () => {
		stubTables({
			artifacts: [twin("t1", "2026-08-21T00:00:00Z"), twin("t2", "2026-08-22T00:00:00Z")],
			artifact_external_links: [
				pointer("t1", HL, "page-hl"),
				pointer("t1", AN, "page-an"),
				pointer("t2", HL, "page-22"),
			],
		});

		const unscoped = await getDailyLogQueue();
		expect(unscoped.find((e) => e.artifact_id === "t1")).toMatchObject({
			domain: null,
			provider: null,
			page_id: null,
			markers: "none",
			conflicting_providers: [HL, AN].sort(),
		});
		// Scoped, the twin is attributed through the pointer that names the domain asked for.
		expect((await getDailyLogQueue("work")).map((e) => [e.artifact_id, e.page_id])).toEqual([
			["t1", "page-hl"],
			["t2", "page-22"],
		]);
		expect((await getDailyLogQueue("angus")).map((e) => [e.artifact_id, e.page_id])).toEqual([["t1", "page-an"]]);
	});

	it("only asks about the selected twins' pages when scoped", async () => {
		const seen: unknown[][] = [];
		stubTables({
			artifacts: [twin("hl", "2026-08-21T00:00:00Z"), twin("an", "2026-08-22T00:00:00Z")],
			artifact_external_links: [pointer("hl", HL, "page-hl"), pointer("an", AN, "page-an")],
		});
		const orig = supabase.from;
		(supabase as any).from = vi.fn((table: string) => {
			const b = (orig as any)(table);
			const origIn = b.in;
			b.in = (col: string, vs: unknown[]) => {
				if (col === "external_id") seen.push(vs);
				return origIn(col, vs);
			};
			return b;
		});

		await getDailyLogQueue("angus");
		expect(seen).toEqual([["page-an"]]);
	});

	it("scopes by the pointer's provider in memory, so a pointerless twin shows only unscoped", async () => {
		stubTables({
			artifacts: [
				twin("hl", "2026-08-21T00:00:00Z"),
				twin("an", "2026-08-22T00:00:00Z"),
				twin("orphan", "2026-08-23T00:00:00Z"),
			],
			artifact_external_links: [pointer("hl", HL, "page-hl"), pointer("an", AN, "page-an")],
		});

		expect((await getDailyLogQueue("work")).map((e) => e.artifact_id)).toEqual(["hl"]);
		expect((await getDailyLogQueue("angus")).map((e) => e.artifact_id)).toEqual(["an"]);

		const unscoped = await getDailyLogQueue();
		expect(unscoped.map((e) => e.artifact_id)).toEqual(["hl", "an", "orphan"]);
		const orphan = unscoped.find((e) => e.artifact_id === "orphan")!;
		expect(orphan).toMatchObject({ domain: null, provider: null, page_id: null, markers: "none", conflicting_providers: [] });
	});

	it("does not read the ledger at all when there are no twins", async () => {
		const froms = stubTables({ artifacts: [] });
		expect(await getDailyLogQueue()).toEqual([]);
		expect(froms).toEqual(["artifacts"]);
	});

	it("throws, never returns a partial queue, when a read fails", async () => {
		stubTables({}, { artifacts: "down" });
		await expect(getDailyLogQueue()).rejects.toThrow(/Daily-log twin lookup failed: down/);

		stubTables({ artifacts: [twin("t1", "2026-08-21T00:00:00Z")] }, { artifact_external_links: "boom" });
		await expect(getDailyLogQueue()).rejects.toThrow(/Daily-log link lookup failed: boom.*migration 047/);

		// The marker read is the SECOND call to the links table; only it fails here.
		stubTables(
			{ artifacts: [twin("t1", "2026-08-21T00:00:00Z")], artifact_external_links: [pointer("t1", HL, "page-21")] },
			{ "artifact_external_links#2": "bang" },
		);
		await expect(getDailyLogQueue()).rejects.toThrow(/Daily-log marker lookup failed: bang.*migration 047/);
	});

	it("reports two pages under one provider as a conflict too, in either scoping", async () => {
		stubTables({
			artifacts: [twin("t1", "2026-08-21T00:00:00Z")],
			artifact_external_links: [pointer("t1", HL, "page-a"), pointer("t1", HL, "page-b")],
		});
		for (const scope of [undefined, "work" as const]) {
			const [entry] = await getDailyLogQueue(scope);
			expect(entry).toMatchObject({ page_id: null, domain: null, conflicting_providers: [HL, HL] });
		}
		expect(await getDailyLogQueue("angus")).toEqual([]);
	});

	it("reads the ledger in bounded chunks when there are more twins than one request carries", async () => {
		const many = Array.from({ length: 301 }, (_, i) => twin(`t${i}`, "2026-08-01T00:00:00Z"));
		const froms = stubTables({
			artifacts: many,
			artifact_external_links: many.map((t) => pointer(t.id as string, HL, `page-${t.id}`)),
		});
		const queue = await getDailyLogQueue();
		expect(queue).toHaveLength(301);
		// One twin read, two link chunks (300 + 1), two marker chunks (300 + 1 pages).
		expect(froms.filter((t) => t === "artifact_external_links")).toHaveLength(4);
	});
});

describe("dos_daily_log_queue tool", () => {
	it("renders the queue with its status per log and the JSON payload", async () => {
		stubTables({
			artifacts: [twin("t1", "2026-08-21T00:00:00Z"), twin("t2", "2026-08-24T00:00:00Z")],
			artifact_external_links: [
				pointer("t1", HL, "page-21"),
				pointer("t2", HL, "page-24"),
				marker("a1", "synthesized_unattended", "page-24"),
			],
		});

		const { content } = await getDailyLogQueueHandler({ domain: "work" });
		const text = content[0].text;
		expect(text).toContain("domain: work");
		expect(text).toContain("2026-08-21  work  NO SYNTHESIS MARKERS (its atoms were never marked; half-written)  page page-21");
		expect(text).toContain("2026-08-24  work  UNCONFIRMED (swept draft, #561)  page page-24");
		expect(text).toContain("2 log(s) not yet folded into the State Doc; 1 unconfirmed swept drafts; 1 with no synthesis markers; 0 with no page pointer; 0 unattributable (pointer conflict).");
		expect(text).toContain(`stamps\n'${STATE_DOC_LINK_KIND}' on the TWIN`);
		expect(JSON.parse(text.split("```json\n")[1].split("\n```")[0])).toHaveLength(2);
	});

	it("says (none) for an empty queue", async () => {
		stubTables({ artifacts: [] });
		const { content } = await getDailyLogQueueHandler({});
		expect(content[0].text).toContain("(none)");
		expect(content[0].text).toContain("0 log(s) not yet folded");
	});
});

describe("beyond the first 1,000 markers", () => {
	it("a page whose synthesized marker is past row 1,000 of its chunk reads attended", async () => {
		const unattendedMarkers = Array.from({ length: 1050 }, (_, i) => ({
			...marker(`atom-${i + 1}`, "synthesized_unattended", "page-21"),
			id: `m-${String(i + 1).padStart(6, "0")}`,
		}));
		const attendedMarker = {
			...marker("atom-1", "synthesized", "page-21"),
			id: "m-001051",
		};
		stubTables({
			artifacts: [twin("t1", "2026-08-21T00:00:00Z")],
			artifact_external_links: [
				{ ...pointer("t1", HL, "page-21"), id: "p-000001" },
				...unattendedMarkers,
				attendedMarker,
			],
		});

		const [entry] = await getDailyLogQueue("work");
		expect(entry.markers).toBe("attended");
	});
});

describe("evidence closing kinds (#2227)", () => {
	it("treats evidence_aggregated_unattended on a twin as markers: 'unattended' and renders UNCONFIRMED until consumed_by_state", async () => {
		stubTables({
			artifacts: [twin("t1", "2026-11-18T00:00:00Z")],
			artifact_external_links: [
				pointer("t1", HL, "page-18"),
				marker("t1", "evidence_aggregated_unattended", "page-18"),
			],
		});

		const queue = await getDailyLogQueue("work");
		expect(queue).toHaveLength(1);
		expect(queue[0].markers).toBe("unattended");
		expect(queue[0].consumed_by_state).toBeNull();

		const { content } = await getDailyLogQueueHandler({ domain: "work" });
		expect(content[0].text).toContain("UNCONFIRMED");

		// Once state_doc_update writes consumed_by_state on the twin, it leaves the queue (ADR-110 §3).
		stubTables({
			artifacts: [twin("t1", "2026-11-18T00:00:00Z")],
			artifact_external_links: [
				pointer("t1", HL, "page-18"),
				marker("t1", "evidence_aggregated_unattended", "page-18"),
				{
					artifact_id: "t1",
					user_id: USER,
					provider: HL,
					kind: STATE_DOC_LINK_KIND,
					external_id: "state-doc-1",
				},
			],
		});
		const afterConsume = await getDailyLogQueue("work");
		expect(afterConsume).toHaveLength(0);
	});

	it("treats evidence_aggregated as markers: 'attended' and lets it override unattended markers", async () => {
		stubTables({
			artifacts: [twin("t1", "2026-11-18T00:00:00Z"), twin("t2", "2026-11-19T00:00:00Z")],
			artifact_external_links: [
				pointer("t1", HL, "page-18"),
				marker("t1", "evidence_aggregated", "page-18"),
				pointer("t2", HL, "page-19"),
				marker("a1", "synthesized_unattended", "page-19"),
				marker("t2", "evidence_aggregated_unattended", "page-19"),
				marker("t2", "evidence_aggregated", "page-19"),
			],
		});

		const queue = await getDailyLogQueue("work");
		expect(queue.map((e) => [e.artifact_id, e.markers])).toEqual([
			["t1", "attended"],
			["t2", "attended"],
		]);
	});
});

