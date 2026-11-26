import { afterEach, describe, expect, it, vi } from "vitest";

// #911 / ADR-067 §3: the ritual's backlog slice is a bounded top-N over the whole
// unconsumed set, so its ORDER decides what the owner sees. `rank_by_role` ranks
// that set by ADR-046 §3 source role (narrative > evidence > metrics > excluded),
// then by effective date, newest first -- and it must rank the WHOLE set before
// the limit, never re-sort one page.
//
// These tests run the handler against a small in-memory PostgREST stand-in rather
// than a chain of hand-rolled stubs, because the property under test (every row
// lands in exactly one tier, and the limit is taken after the tiers) lives in the
// filter STRING the handler sends. A stub that ignores the string cannot see it.

vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return { ...actual, env: { ...actual.env, openaiApiKey: undefined as string | undefined } };
});
vi.mock("../embeddings.js", () => ({ embed: vi.fn(async () => [0.1, 0.2, 0.3]) }));

import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import {
	capturePreferencesSchema,
	effectiveSurfaceRoleMap,
	resolveSynthesisRole,
	roleTierFilters,
	type CapturePreferences,
} from "../captureConfig.js";
import { SYNTHESIS_ROLES, type SynthesisRole } from "../vocab.js";

const searchHandler = (args: any) =>
	toMcpTool(serverRegistry().get("knowledge_search")!).handler(args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as unknown as { from: unknown }).from = origFrom;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A PostgREST logic-tree evaluator, for the subset this repo sends: nested
// and(...)/or(...), `col.is.null`, `col.[not.]in.(v,...)` with quoted or bare
// values, and `col.[not.]eq|neq.v`. SQL three-valued logic collapses to
// two-valued here because nothing above a leaf is ever negated: UNKNOWN behaves
// exactly like FALSE under AND/OR at the top of a WHERE clause.
// ---------------------------------------------------------------------------

type Cond =
	| { kind: "and" | "or"; items: Cond[] }
	| { kind: "leaf"; col: string; not: boolean; op: string; value: string | string[] };

function parseLogic(src: string): Cond {
	let i = 0;
	const fail = (why: string): never => {
		throw new Error(`unparseable PostgREST logic at ${i} (${why}): ${src}`);
	};
	const expectChar = (c: string) => {
		if (src[i] !== c) fail(`expected '${c}'`);
		i++;
	};
	const value = (): string => {
		if (src[i] === '"') {
			i++;
			let out = "";
			while (src[i] !== '"') {
				if (i >= src.length) fail("unterminated quote");
				if (src[i] === "\\") i++;
				out += src[i++];
			}
			i++;
			return out;
		}
		if (src[i] === "{") {
			let out = "";
			while (i < src.length && src[i] !== "}") {
				if (src[i] === '"') {
					out += src[i++];
					while (i < src.length && src[i] !== '"') {
						if (src[i] === "\\") out += src[i++];
						out += src[i++];
					}
				}
				out += src[i++];
			}
			expectChar("}");
			return out + "}";
		}
		const start = i;
		while (i < src.length && src[i] !== "," && src[i] !== ")") i++;
		return src.slice(start, i);
	};
	const cond = (): Cond => {
		for (const kw of ["and", "or"] as const) {
			if (src.startsWith(`${kw}(`, i)) {
				i += kw.length + 1;
				const items = list();
				expectChar(")");
				return { kind: kw, items };
			}
		}
		const colEnd = src.indexOf(".", i);
		if (colEnd < 0) fail("no column");
		const col = src.slice(i, colEnd);
		i = colEnd + 1;
		let not = false;
		if (src.startsWith("not.", i)) {
			not = true;
			i += 4;
		}
		const opEnd = src.indexOf(".", i);
		if (opEnd < 0) fail("no operator");
		const op = src.slice(i, opEnd);
		i = opEnd + 1;
		if (op === "in") {
			expectChar("(");
			const values: string[] = [];
			while (src[i] !== ")") {
				values.push(value());
				if (src[i] === ",") i++;
			}
			i++;
			return { kind: "leaf", col, not, op, value: values };
		}
		return { kind: "leaf", col, not, op, value: value() };
	};
	const list = (): Cond[] => {
		const items = [cond()];
		while (src[i] === ",") {
			i++;
			items.push(cond());
		}
		return items;
	};
	const items = list();
	if (i !== src.length) fail("trailing input");
	return { kind: "or", items };
}

function evaluate(c: Cond, row: Record<string, unknown>): boolean {
	if (c.kind !== "leaf") {
		return c.kind === "and" ? c.items.every((x) => evaluate(x, row)) : c.items.some((x) => evaluate(x, row));
	}
	const v = row[c.col];
	if (c.op === "is") {
		const isNull = v === null || v === undefined;
		return c.not ? !isNull : isNull;
	}
	if (v === null || v === undefined) return false; // NULL (NOT) IN / = / <> is UNKNOWN
	const s = String(v);
	if (c.op === "in") {
		const hit = (c.value as string[]).includes(s);
		return c.not ? !hit : hit;
	}
	if (c.op === "eq" || c.op === "neq") {
		const eq = s === c.value;
		const res = c.op === "eq" ? eq : !eq;
		return c.not ? !res : res;
	}
	if (c.op === "cs" || c.op === "ov") {
		const arr = Array.isArray(v) ? v.map(String) : [];
		const target = String(c.value)
			.replace(/^\{|\}$/g, "")
			.split(",")
			.map((x) => x.replace(/^"|"$/g, ""))
			.filter(Boolean);
		const hit =
			c.op === "cs"
				? target.every((t) => arr.includes(t))
				: target.some((t) => arr.includes(t));
		return c.not ? !hit : hit;
	}
	throw new Error(`evaluator does not support op '${c.op}'`);
}

// ---------------------------------------------------------------------------
// A PostgREST stand-in over in-memory tables. Every builder records what it was
// asked, so a test can assert on the query shape as well as on the rows.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
type QueryLog = {
	table: string;
	selectOpts?: { count?: string; head?: boolean };
	ors: string[];
	orders: Array<{ col: string; ascending: boolean }>;
	limit?: number;
};

function installFakeDb(tables: Record<string, Rec[]>): QueryLog[] {
	const log: QueryLog[] = [];
	(supabase as unknown as { from: unknown }).from = vi.fn((table: string) => {
		const entry: QueryLog = { table, ors: [], orders: [] };
		log.push(entry);
		const preds: Array<(r: Rec) => boolean> = [];
		const run = () => {
			let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
			const count = rows.length;
			for (const o of [...entry.orders].reverse()) {
				rows = [...rows].sort((a, b) => {
					const av = String(a[o.col] ?? "");
					const bv = String(b[o.col] ?? "");
					return o.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
				});
			}
			const rowLimit = entry.limit !== undefined ? entry.limit : 1000;
			rows = rows.slice(0, rowLimit);
			const withCount = entry.selectOpts?.count ? { count } : {};
			if (entry.selectOpts?.head) return { data: null, error: null, ...withCount };
			return { data: rows, error: null, ...withCount };
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a self-returning chain stand-in
		const b: any = {
			select: (_cols: string, opts?: QueryLog["selectOpts"]) => {
				entry.selectOpts = opts;
				return b;
			},
			eq: (col: string, v: unknown) => {
				// user_id is the caller's scope; the fixtures are all one user's rows.
				if (col !== "user_id") preds.push((r) => r[col] === v);
				return b;
			},
			in: (col: string, vs: unknown[]) => {
				preds.push((r) => vs.includes(r[col]));
				return b;
			},
			gte: (col: string, v: string) => {
				preds.push((r) => r[col] != null && String(r[col]) >= v);
				return b;
			},
			lte: (col: string, v: string) => {
				preds.push((r) => r[col] != null && String(r[col]) <= v);
				return b;
			},
			not: (col: string, op: string, v: string) => {
				if (op === "in") {
					const values = v.replace(/^\(|\)$/g, "").split(",");
					preds.push((r) => r[col] == null || !values.includes(String(r[col])));
				} else if (op === "ilike") {
					const pattern = v.replace(/%/g, ".*");
					const reg = new RegExp(pattern, "i");
					preds.push((r) => r[col] == null || !reg.test(String(r[col])));
				} else {
					throw new Error(`fake .not supports 'in' and 'ilike' only, got ${op}`);
				}
				return b;
			},
			filter: (col: string, op: string, v: string) => {
				if (op === "cs") {
					const values = v
						.replace(/^\{|\}$/g, "")
						.split(",")
						.map((s) => s.replace(/^"|"$/g, ""))
						.filter(Boolean);
					preds.push(
						(r) => Array.isArray(r[col]) && values.every((val) => (r[col] as unknown[]).includes(val)),
					);
				} else {
					throw new Error(`fake .filter supports 'cs' only, got ${op}`);
				}
				return b;
			},
			or: (filters: string) => {
				entry.ors.push(filters);
				const tree = parseLogic(filters);
				preds.push((r) => evaluate(tree, r));
				return b;
			},
			order: (col: string, opts?: { ascending?: boolean }) => {
				entry.orders.push({ col, ascending: opts?.ascending ?? true });
				return b;
			},
			limit: (n: number) => {
				entry.limit = n;
				return b;
			},
			maybeSingle: () => {
				const { data } = run();
				return Promise.resolve({ data: (data as Rec[] | null)?.[0] ?? null, error: null });
			},
			then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
				Promise.resolve(run()).then(resolve, reject),
		};
		return b;
	});

	(supabase as unknown as { rpc: unknown }).rpc = vi.fn((fnName: string, params: any) => {
		if (fnName === "search_unconsumed_artifacts") {
			let rows = [...(tables["artifacts"] ?? [])];
			if (!params.p_include_archived) {
				rows = rows.filter((r) => !r.archived);
			}
			if (params.p_effective_after) {
				rows = rows.filter((r) => r.effective_at && String(r.effective_at) >= params.p_effective_after);
			}
			if (params.p_effective_before) {
				rows = rows.filter((r) => r.effective_at && String(r.effective_at) <= params.p_effective_before);
			}
			if (params.p_excluded_subtypes && params.p_excluded_subtypes.length > 0) {
				rows = rows.filter(
					(r) => r.content_subtype == null || !params.p_excluded_subtypes.includes(r.content_subtype),
				);
			}
			if (!params.p_include_discovered) {
				rows = rows.filter(
					(r) => r.lifecycle_stage == null || !["discovered", "failed"].includes(String(r.lifecycle_stage)),
				);
			}
			if (params.p_tags && params.p_tags.length > 0) {
				rows = rows.filter(
					(r) =>
						Array.isArray(r.tags) &&
						params.p_tags.every((tag: string) => (r.tags as string[]).includes(tag)),
				);
			}
			const links = tables["artifact_external_links"] ?? [];
			const consumedIds = new Set(
				links
					.filter((l) => {
						if (!params.p_kinds.includes(l.kind)) return false;
						if (params.p_provider && l.provider !== params.p_provider) return false;
						return true;
					})
					.map((l) => l.artifact_id),
			);
			rows = rows.filter((r) => !consumedIds.has(r.id));

			if (params.p_role_hit_keys != null || params.p_role_default_hit || (params.p_role_override_tags && params.p_role_override_tags.length > 0)) {
				const hitKeys: string[] = params.p_role_hit_keys ?? [];
				const allKeys: string[] = params.p_role_all_keys ?? [];
				const overrideTags: string[] = params.p_role_override_tags ?? [];
				rows = rows.filter((r) => {
					if (params.p_role_hit_keys == null) return true;
					const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
					if (overrideTags.length > 0 && overrideTags.some((t) => tags.includes(t))) return true;
					const surface = r.surface as string | null | undefined;
					const source_channel = r.source_channel as string | null | undefined;
					if (surface && hitKeys.includes(surface)) return true;
					const surfaceUnmapped = !surface || !allKeys.includes(surface);
					if (surfaceUnmapped && source_channel && hitKeys.includes(source_channel)) return true;
					const channelUnmapped = !source_channel || !allKeys.includes(source_channel);
					if (params.p_role_default_hit && surfaceUnmapped && channelUnmapped) return true;
					return false;
				});
			}

			if (params.p_exclude_title_patterns && params.p_exclude_title_patterns.length > 0) {
				rows = rows.filter((r) => {
					const title = String(r.title ?? "");
					for (const pat of params.p_exclude_title_patterns) {
						const clean = pat.replace(/^%|%$/g, "").toLowerCase();
						if (clean && title.toLowerCase().includes(clean)) return false;
					}
					return true;
				});
			}

			if (params.p_exclude_robot_authored !== false) {
				rows = rows.filter((r) => {
					const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
					if (tags.includes("not_robot_authored")) return true;
					return !tags.includes("robot_authored") && !tags.includes("auto-task");
				});
			}

			// Order by effective_at DESC, id DESC
			rows.sort((a, b) => {
				const av = String(a.effective_at ?? "");
				const bv = String(b.effective_at ?? "");
				if (av !== bv) return bv.localeCompare(av);
				return String(b.id ?? "").localeCompare(String(a.id ?? ""));
			});
			const total_count = params.p_with_count !== false ? rows.length : null;
			const limit = params.p_limit !== undefined && params.p_limit !== null ? params.p_limit : rows.length;
			const sliced = rows.slice(0, limit);
			const withCount = sliced.map((r) => ({ ...r, total_count }));
			return Promise.resolve({ data: withCount, error: null });
		}
		return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
	});

	return log;
}

let seq = 0;
/** One artifact row. `surface`/`source_channel` decide its role; `effective_at`
 * defaults to `captured_at`, exactly as the generated column does. */
function atom(over: Partial<Rec> & { id: string }): Rec {
	const captured_at = (over.captured_at as string) ?? "2026-09-01T12:00:00Z";
	return {
		title: `title ${over.id}`,
		plain_text: `body ${seq++}`,
		created_at: captured_at,
		captured_at,
		effective_at: captured_at,
		lifecycle_stage: "extracted",
		tags: [],
		content_subtype: null,
		archived: false,
		surface: "claude_code",
		source_channel: "mcp",
		...over,
	};
}

/** A Drive-discovered, enriched row: role `evidence` through DISCOVER_ROLE_SEED. */
function driveAtom(over: Partial<Rec> & { id: string }): Rec {
	return atom({ surface: "discovered_gdrive", source_channel: "discovered_gdrive", ...over });
}

function prefsRow(prefs: Partial<CapturePreferences> = {}): Rec {
	return { capture_preferences: capturePreferencesSchema.parse(prefs) };
}

/** Ids in the order the result text lists them. */
function listedIds(text: string): string[] {
	return [...text.matchAll(/^• \[([^\]]+)\]/gm)].map((m) => m[1]);
}

const BEFORE_TODAY = "2026-09-25T00:00:00Z";

// ---------------------------------------------------------------------------
// The pure seam: roleTierFilters must partition every row exactly as
// resolveSynthesisRole does -- the SQL mirror of the one read-time resolver.
// ---------------------------------------------------------------------------

describe("roleTierFilters — the SQL mirror of resolveSynthesisRole (ADR-046 §3)", () => {
	const configs: Array<{ name: string; prefs: CapturePreferences }> = [
		{ name: "shipped seed only (the owner's live config today)", prefs: capturePreferencesSchema.parse({}) },
		{
			name: "stored map overlapping the seed, surface and channel keys disagreeing",
			prefs: capturePreferencesSchema.parse({
				surface_role_map: {
					discovered_gdrive: "narrative",
					slack: "evidence",
					rescuetime: "metrics",
					dos: "excluded",
					mcp: "excluded",
				},
			}),
		},
		{
			name: "default role demoted to evidence",
			prefs: capturePreferencesSchema.parse({
				default_role: "evidence",
				surface_role_map: { claude_code: "narrative", mcp: "metrics" },
			}),
		},
		{
			name: "keys PostgREST reserves: comma, quote, parens, dot, colon, backslash",
			prefs: capturePreferencesSchema.parse({
				surface_role_map: { 'we,ird"key)': "metrics", "a.b:c(d": "evidence", "back\\slash": "excluded" },
			}),
		},
	];

	for (const { name, prefs } of configs) {
		it(`puts every row in exactly the tier resolveSynthesisRole names — ${name}`, () => {
			const tiers = roleTierFilters(prefs);
			expect(tiers.map((t) => t.role)).toEqual([...SYNTHESIS_ROLES]);
			const keys = Object.keys(effectiveSurfaceRoleMap(prefs));
			const values: Array<string | null> = [null, "", "claude_code", "unmapped_surface", ...keys];
			for (const surface of values) {
				for (const source_channel of values) {
					const row = { surface, source_channel };
					const matching = tiers.filter((t) =>
						t.match === "all" ? true : t.match === "none" ? false : evaluate(parseLogic(t.or), row),
					);
					expect(
						matching.map((t) => t.role),
						`surface=${JSON.stringify(surface)} source_channel=${JSON.stringify(source_channel)}`,
					).toEqual([resolveSynthesisRole(prefs, row)]);

					const matchingStructured = tiers.filter((t) => {
						if (t.match === "none") return false;
						if (t.match === "all") return true;
						if (surface && t.hitKeys?.includes(surface)) return true;
						const surfaceUnmapped = !surface || !t.allKeys.includes(surface);
						if (surfaceUnmapped && source_channel && t.hitKeys?.includes(source_channel)) return true;
						const channelUnmapped = !source_channel || !t.allKeys.includes(source_channel);
						if (t.defaultHit && surfaceUnmapped && channelUnmapped) return true;
						return false;
					});
					expect(
						matchingStructured.map((t) => t.role),
						`structured surface=${JSON.stringify(surface)} source_channel=${JSON.stringify(source_channel)}`,
					).toEqual([resolveSynthesisRole(prefs, row)]);
				}
			}
		});
	}

	it("sends a stable, quoted wire shape (pinned so a refactor cannot drift it silently)", () => {
		const prefs = capturePreferencesSchema.parse({});
		const tiers = roleTierFilters(prefs);
		// The DISCOVER_ROLE_SEED keys, sorted: the Drive spellings plus the Gmail
		// attachment connectors (#1210) plus local (#1211) plus the machine-ingest
		// surfaces act_receipt, github, slack, slack_dm, derived and gmail_ingest (#1767, #1771)
		// plus kpi_snapshot at role metrics.
		const allSeedKeys =
			'("act_receipt","derived","discovered_drive","discovered_gdrive","discovered_gdrive_work","discovered_gmail_attachment","discovered_gmail_attachment_work","discovered_google_drive","discovered_local","discovered_onedrive","github","gmail_ingest","kpi_snapshot","slack","slack_dm","whatsapp","whatsapp_dm")';
		const evidenceKeys =
			'("act_receipt","derived","discovered_drive","discovered_gdrive","discovered_gdrive_work","discovered_gmail_attachment","discovered_gmail_attachment_work","discovered_google_drive","discovered_local","discovered_onedrive","github","gmail_ingest","slack","slack_dm","whatsapp","whatsapp_dm")';
		const metricsKeys = '("kpi_snapshot")';
		const evidenceKeysArray = [
			"act_receipt",
			"derived",
			"discovered_drive",
			"discovered_gdrive",
			"discovered_gdrive_work",
			"discovered_gmail_attachment",
			"discovered_gmail_attachment_work",
			"discovered_google_drive",
			"discovered_local",
			"discovered_onedrive",
			"github",
			"gmail_ingest",
			"slack",
			"slack_dm",
			"whatsapp",
			"whatsapp_dm",
		];
		const seedKeysArray = [
			"act_receipt",
			"derived",
			"discovered_drive",
			"discovered_gdrive",
			"discovered_gdrive_work",
			"discovered_gmail_attachment",
			"discovered_gmail_attachment_work",
			"discovered_google_drive",
			"discovered_local",
			"discovered_onedrive",
			"github",
			"gmail_ingest",
			"kpi_snapshot",
			"slack",
			"slack_dm",
			"whatsapp",
			"whatsapp_dm",
		];
		expect(tiers).toEqual([
			{
				role: "narrative",
				match: "filter",
				or: `and(or(surface.is.null,surface.not.in.${allSeedKeys}),or(source_channel.is.null,source_channel.not.in.${allSeedKeys}))`,
				hitKeys: [],
				allKeys: seedKeysArray,
				defaultHit: true,
			},
			{
				role: "evidence",
				match: "filter",
				or: `surface.in.${evidenceKeys},and(or(surface.is.null,surface.not.in.${allSeedKeys}),source_channel.in.${evidenceKeys})`,
				hitKeys: evidenceKeysArray,
				allKeys: seedKeysArray,
				defaultHit: false,
			},
			{
				role: "metrics",
				match: "filter",
				or: `surface.in.${metricsKeys},and(or(surface.is.null,surface.not.in.${allSeedKeys}),source_channel.in.${metricsKeys})`,
				hitKeys: ["kpi_snapshot"],
				allKeys: seedKeysArray,
				defaultHit: false,
			},
			{ role: "excluded", match: "none", hitKeys: [], allKeys: seedKeysArray, defaultHit: false },
		]);
	});
});

// ---------------------------------------------------------------------------
// The handler seam.
// ---------------------------------------------------------------------------

describe("knowledge_search rank_by_role (ADR-067 §3, #911)", () => {
	it("ranks every narrative atom above every evidence atom, whatever their dates", async () => {
		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				atom({ id: "narrative-july", captured_at: "2026-07-01T09:00:00Z" }),
				driveAtom({ id: "evidence-sept", captured_at: "2026-09-20T09:00:00Z" }),
				atom({ id: "narrative-aug", captured_at: "2026-08-01T09:00:00Z" }),
			],
		});

		const out = await searchHandler({ captured_before: BEFORE_TODAY, rank_by_role: true });

		expect(listedIds(out.content[0].text)).toEqual(["narrative-aug", "narrative-july", "evidence-sept"]);
	});

	it("breaks ties within a role on effective date, newest first -- a backdated atom sorts under its content date, not its arrival (ADR-088)", async () => {
		const log = installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				// Arrived yesterday, but the source says the content is from 2017.
				atom({
					id: "arrived-yesterday-from-2017",
					captured_at: "2026-09-24T09:00:00Z",
					originated_at: "2017-03-01T00:00:00Z",
					effective_at: "2017-03-01T00:00:00Z",
				}),
				atom({ id: "from-last-fortnight", captured_at: "2026-09-10T09:00:00Z" }),
			],
		});

		const out = await searchHandler({ captured_before: BEFORE_TODAY, rank_by_role: true });

		expect(listedIds(out.content[0].text)).toEqual(["from-last-fortnight", "arrived-yesterday-from-2017"]);
		const artifactQueries = log.filter((q) => q.table === "artifacts" && !q.selectOpts?.head);
		expect(artifactQueries.length).toBeGreaterThan(0);
		for (const q of artifactQueries) {
			expect(q.orders).toEqual([{ col: "effective_at", ascending: false }]);
		}
	});

	it("takes the limit after ranking the WHOLE unconsumed set, not by re-sorting one page", async () => {
		const evidence = Array.from({ length: 60 }, (_, n) =>
			driveAtom({ id: `evidence-${n}`, captured_at: `2026-09-${String(10 + (n % 14)).padStart(2, "0")}T0${n % 10}:00:00Z` }),
		);
		const narrative = [
			atom({ id: "narrative-old-1", captured_at: "2026-07-02T09:00:00Z" }),
			atom({ id: "narrative-old-2", captured_at: "2026-07-01T09:00:00Z" }),
			atom({ id: "narrative-consumed", captured_at: "2026-07-03T09:00:00Z" }),
			atom({ id: "narrative-old-3", captured_at: "2026-06-30T09:00:00Z" }),
		];
		installFakeDb({
			user_preferences: [prefsRow()],
			artifact_external_links: [{ artifact_id: "narrative-consumed", kind: "synthesized", provider: "notion" }],
			artifacts: [...evidence, ...narrative],
		});

		const args = {
			captured_before: BEFORE_TODAY,
			not_consumed: true,
			roles: [...SYNTHESIS_ROLES],
			limit: 50,
		};
		const ranked = (await searchHandler({ ...args, rank_by_role: true })).content[0].text;
		const plain = (await searchHandler(args)).content[0].text;

		// The default read's newest-first page of 50 is all evidence: the three older
		// narrative atoms are not on it, so no re-sort of that page could surface them.
		expect(listedIds(plain).some((id) => id.startsWith("narrative"))).toBe(false);
		// Ranked over the whole set, they lead -- and the consumed one stays out.
		const ids = listedIds(ranked);
		expect(ids).toHaveLength(50);
		expect(ids.slice(0, 3)).toEqual(["narrative-old-1", "narrative-old-2", "narrative-old-3"]);
		expect(ids).not.toContain("narrative-consumed");
		expect(ids.slice(3).every((id) => id.startsWith("evidence-"))).toBe(true);
		expect(ranked).toContain("13 more result(s) not shown");
	});

	it("defaults not_consumed: true without roles to ['narrative'] even with rank_by_role: true (#2231)", async () => {
		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				atom({ id: "narr-1", captured_at: "2026-09-01T09:00:00Z" }),
				driveAtom({ id: "evid-1", captured_at: "2026-09-20T09:00:00Z" }),
				atom({ id: "met-1", surface: "kpi_snapshot", captured_at: "2026-09-21T09:00:00Z" }),
			],
		});

		const ranked = (
			await searchHandler({ captured_before: BEFORE_TODAY, not_consumed: true, rank_by_role: true })
		).content[0].text;
		expect(listedIds(ranked)).toEqual(["narr-1"]);
		expect(ranked).toContain("narrative 1 · evidence 0 · metrics 0 · excluded 0");
	});

	it("counts a tier it did not need to fetch, so the total left behind stays exact", async () => {
		const log = installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				...Array.from({ length: 55 }, (_, n) =>
					atom({ id: `narrative-${n}`, captured_at: `2026-08-${String(1 + (n % 28)).padStart(2, "0")}T09:00:00Z` }),
				),
				...Array.from({ length: 5 }, (_, n) => driveAtom({ id: `evidence-${n}`, captured_at: "2026-09-20T09:00:00Z" })),
			],
		});

		const out = (await searchHandler({ captured_before: BEFORE_TODAY, limit: 50, rank_by_role: true }))
			.content[0].text;

		expect(listedIds(out)).toHaveLength(50);
		expect(listedIds(out).every((id) => id.startsWith("narrative-"))).toBe(true);
		expect(out).toContain("10 more result(s) not shown");
		expect(out).toContain("narrative 55");
		expect(out).toContain("evidence 5");
		// The evidence tier was counted, never fetched: no row body crossed the wire for it.
		const evidenceTier = log.find((q) => q.table === "artifacts" && q.ors.some((o) => o.startsWith("surface.in.")));
		expect(evidenceTier?.selectOpts).toEqual({ count: "exact", head: true });
	});

	it("orders non-robot rows across role tiers while preserving non-robot membership when roles is omitted", async () => {
		const artifacts = [
			...Array.from({ length: 7 }, (_, n) => atom({ id: `n-${n}`, captured_at: `2026-08-0${n + 1}T09:00:00Z` })),
			...Array.from({ length: 9 }, (_, n) => driveAtom({ id: `e-${n}`, captured_at: `2026-09-1${n}T09:00:00Z` })),
			atom({ id: "discovered-pointer", captured_at: "2026-09-01T09:00:00Z", lifecycle_stage: "discovered" }),
			atom({ id: "a-daily-log", captured_at: "2026-09-02T09:00:00Z", content_subtype: "daily_log" }),
		];
		installFakeDb({ user_preferences: [prefsRow()], artifacts });

		const all = { captured_before: BEFORE_TODAY, limit: 50 };
		const rankedAll = listedIds((await searchHandler({ ...all, rank_by_role: true })).content[0].text);
		const plainAll = listedIds((await searchHandler(all)).content[0].text);
		expect([...rankedAll].sort()).toEqual([...plainAll].sort());
		expect(rankedAll).not.toContain("discovered-pointer");
		expect(rankedAll).not.toContain("a-daily-log");

		const page = { captured_before: BEFORE_TODAY, limit: 5 };
		const rankedPage = (await searchHandler({ ...page, rank_by_role: true })).content[0].text;
		const plainPage = (await searchHandler(page)).content[0].text;
		expect(rankedPage).toContain("11 more result(s) not shown");
		expect(plainPage).toContain("11 more result(s) not shown");
	});

	it("honours the owner's stored map over the shipped seed, and the default role", async () => {
		installFakeDb({
			user_preferences: [
				prefsRow({ surface_role_map: { discovered_gdrive: "narrative", slack: "evidence", auto_planner: "excluded" } }),
			],
			artifacts: [
				atom({ id: "slack-newest", surface: "slack", source_channel: "slack", captured_at: "2026-09-23T09:00:00Z" }),
				atom({ id: "planner-newer", surface: "auto_planner", captured_at: "2026-09-22T09:00:00Z" }),
				driveAtom({ id: "drive-promoted", captured_at: "2026-09-01T09:00:00Z" }),
				atom({ id: "capture-oldest", captured_at: "2026-08-01T09:00:00Z" }),
			],
		});

		const out = await searchHandler({ captured_before: BEFORE_TODAY, rank_by_role: true });

		expect(listedIds(out.content[0].text)).toEqual([
			"drive-promoted",
			"capture-oldest",
			"slack-newest",
			"planner-newer",
		]);
	});

	it("leaves the default path exactly as it was: no preferences read, one query, newest effective date first, no role filter", async () => {
		const log = installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				atom({ id: "narrative-july", captured_at: "2026-07-01T09:00:00Z" }),
				driveAtom({ id: "evidence-sept", captured_at: "2026-09-20T09:00:00Z" }),
			],
		});

		const out = await searchHandler({ captured_before: BEFORE_TODAY });

		expect(listedIds(out.content[0].text)).toEqual(["evidence-sept", "narrative-july"]);
		expect(out.content[0].text).not.toContain("ranked by source role");
		expect(log.map((q) => q.table)).toEqual(["artifacts"]);
		expect(log[0].orders).toEqual([{ col: "effective_at", ascending: false }]);
		expect(log[0].ors.some((o) => o.includes("surface"))).toBe(false);
	});

	it("refuses rank_by_role alongside a query, loudly, rather than silently ignoring it", async () => {
		installFakeDb({ user_preferences: [prefsRow()], artifacts: [] });

		await expect(
			searchHandler({ query: "pricing", not_consumed: true, rank_by_role: true }),
		).rejects.toThrow(/rank_by_role/);
	});

	it("says how the slice was ranked, with every tier's size", async () => {
		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [atom({ id: "n" }), driveAtom({ id: "e" })],
		});

		const out = (await searchHandler({ captured_before: BEFORE_TODAY, rank_by_role: true })).content[0].text;

		const expected: Record<SynthesisRole, number> = { narrative: 1, evidence: 1, metrics: 0, excluded: 0 };
		expect(out).toContain("ranked by source role");
		for (const role of SYNTHESIS_ROLES) expect(out).toContain(`${role} ${expected[role]}`);
		// Strictly additive: the per-row `(captured YYYY-MM-DD)` the dos ritual reads is intact.
		expect(out).toContain("(captured 2026-09-01)");
	});

	// ADR-108 §4 (owner, 2026-10-14): an attended send receipt is evidence (#1771).
	// Robot receipts are excluded across every role tier while attended sends corroborate.
	it("excludes robot-authored receipts from narrative tier while preserving attended sends (#1222)", async () => {
		const prefs = capturePreferencesSchema.parse({});
		const robotTask = atom({
			id: "robot-task",
			title: "[auto-task] Draft PR #1389",
			surface: "act_receipt",
		});
		const robotRoutine = atom({
			id: "robot-routine",
			title: "Scheduled routine completed: checks",
			surface: "act_receipt",
		});
		const robotTagged = atom({
			id: "robot-tagged",
			title: "Automated alert",
			surface: "act_receipt",
			tags: ["robot_authored"],
		});
		const robotText = atom({
			id: "robot-text",
			title: "Routine status",
			surface: "act_receipt",
			plain_text: "Scheduled routine completed: hourly sync",
		});
		const ownerSend = atom({
			id: "owner-send",
			title: "Follow-up notes to partner",
			surface: "act_receipt",
		});

		expect(resolveSynthesisRole(prefs, robotTask)).toBe("excluded");
		expect(resolveSynthesisRole(prefs, robotRoutine)).toBe("excluded");
		expect(resolveSynthesisRole(prefs, robotTagged)).toBe("excluded");
		expect(resolveSynthesisRole(prefs, robotText)).toBe("excluded");
		expect(resolveSynthesisRole(prefs, ownerSend)).toBe("evidence");

		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [robotTask, robotRoutine, robotTagged, robotText, ownerSend],
		});

		const out = await searchHandler({ captured_before: BEFORE_TODAY, rank_by_role: true });
		expect(listedIds(out.content[0].text)).toEqual(["owner-send"]);
		expect(out.content[0].text).toContain("evidence 1");
	});

	it("marks total inexact when a full page cannot fill the requested limit after dropping robot rows (#1771)", async () => {
		// limit = 5. fetchLimit = 5 + 50 = 55.
		// 54 robot receipts + 1 recent owner send + 1 older owner send.
		// Top 55 fetched: 54 robots + 1 recent owner send.
		// After dropping 54 robots, only 1 row remains (< limit 5).
		// Page hit fetchLimit (55 === 55), so total is marked inexact.
		const robots = Array.from({ length: 54 }, (_, i) =>
			atom({
				id: `robot-${i}`,
				title: `[auto-task] Task ${i}`,
				surface: "act_receipt",
				effective_at: `2026-08-${String(54 - i).padStart(2, "0")}T12:00:00Z`,
			}),
		);
		const recentSend = atom({
			id: "owner-send-recent",
			title: "Recent manual send",
			surface: "act_receipt",
			effective_at: "2026-07-01T12:00:00Z",
		});
		const oldSend = atom({
			id: "owner-send-old",
			title: "Older manual send",
			surface: "act_receipt",
			effective_at: "2026-01-01T12:00:00Z",
		});

		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [...robots, recentSend, oldSend],
		});

		const out = await searchHandler({ captured_before: BEFORE_TODAY, rank_by_role: true, limit: 5 });
		expect(listedIds(out.content[0].text)).toEqual(["owner-send-recent"]);
		expect(out.content[0].text).toContain("ranked-search ceiling reached, so the true total may be higher");
	});

	it("not_consumed excludes all 1,200 consumed atoms", async () => {
		// Fixture per issue #1769:
		// 1,200 consumed atoms, all newer than 60 unconsumed ones, with their markers stored in any order.
		// knowledge_search({ not_consumed: true, limit: 50 }) must list exactly the 50 newest unconsumed ids
		// and report "10 more".
		const consumedAtoms = Array.from({ length: 1200 }, (_, i) => {
			const pad = String(i).padStart(4, "0");
			return atom({
				id: `consumed-${pad}`,
				captured_at: "2026-09-20T12:00:00Z",
				effective_at: "2026-09-20T12:00:00Z",
			});
		});

		const unconsumedAtoms = Array.from({ length: 60 }, (_, i) => {
			const pad = String(i).padStart(2, "0");
			const day = 20 - Math.floor(i / 3);
			const hour = 23 - (i % 24);
			const timeStr = `2026-08-${String(Math.max(1, day)).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(59 - (i % 60)).padStart(2, "0")}:00Z`;
			return atom({
				id: `unconsumed-${pad}`,
				captured_at: timeStr,
				effective_at: timeStr,
			});
		});

		unconsumedAtoms.sort((a, b) => String(b.effective_at).localeCompare(String(a.effective_at)));
		const expectedTop50Ids = unconsumedAtoms.slice(0, 50).map((a) => a.id as string);

		// Markers stored in any order (e.g. reversed order)
		const links = consumedAtoms.slice().reverse().map((a) => ({
			artifact_id: a.id,
			kind: "synthesized_unattended",
			provider: null,
		}));

		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [...consumedAtoms, ...unconsumedAtoms],
			artifact_external_links: links,
		});

		const res = await searchHandler({ not_consumed: true, limit: 50 });
		const text = res.content[0].text;
		const returnedIds = listedIds(text);

		expect(returnedIds).toHaveLength(50);
		expect(returnedIds).toEqual(expectedTop50Ids);
		expect(text).toContain("10 more result(s) not shown");
	});

	it("filters by tags on both ranked and unranked not_consumed searches (#1769)", async () => {
		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				atom({ id: "tagged-narrative", tags: ["focus", "q4"], captured_at: "2026-09-10T09:00:00Z" }),
				atom({ id: "partial-narrative", tags: ["focus"], captured_at: "2026-09-11T09:00:00Z" }),
				driveAtom({ id: "tagged-evidence", tags: ["focus", "q4", "extra"], captured_at: "2026-09-20T09:00:00Z" }),
				driveAtom({ id: "untagged-evidence", tags: [], captured_at: "2026-09-21T09:00:00Z" }),
			],
		});

		const ranked = await searchHandler({
			not_consumed: true,
			rank_by_role: true,
			roles: [...SYNTHESIS_ROLES],
			tags: ["focus", "q4"],
		});
		expect(listedIds(ranked.content[0].text)).toEqual(["tagged-narrative", "tagged-evidence"]);

		const unranked = await searchHandler({
			not_consumed: true,
			roles: [...SYNTHESIS_ROLES],
			tags: ["focus", "q4"],
		});
		expect(listedIds(unranked.content[0].text)).toEqual(["tagged-evidence", "tagged-narrative"]);
	});

	it("breaks ties on effective_at deterministically by id DESC in not_consumed searches (#1769)", async () => {
		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [
				atom({ id: "atom-a", captured_at: "2026-09-10T09:00:00Z", effective_at: "2026-09-10T09:00:00Z" }),
				atom({ id: "atom-c", captured_at: "2026-09-10T09:00:00Z", effective_at: "2026-09-10T09:00:00Z" }),
				atom({ id: "atom-b", captured_at: "2026-09-10T09:00:00Z", effective_at: "2026-09-10T09:00:00Z" }),
			],
		});

		const unranked = await searchHandler({ not_consumed: true });
		expect(listedIds(unranked.content[0].text)).toEqual(["atom-c", "atom-b", "atom-a"]);

		const ranked = await searchHandler({ not_consumed: true, rank_by_role: true });
		expect(listedIds(ranked.content[0].text)).toEqual(["atom-c", "atom-b", "atom-a"]);
	});

	it("filters by roles across narrative, evidence, metrics, and excluded on unconsumed and filter-only reads (#2229)", async () => {
		installFakeDb({
			user_preferences: [prefsRow({ surface_role_map: { auto_planner: "excluded" } })],
			artifacts: [
				atom({ id: "narr-1", surface: "claude_code", captured_at: "2026-09-10T09:00:00Z" }),
				driveAtom({ id: "evid-1", captured_at: "2026-09-11T09:00:00Z" }),
				atom({ id: "met-1", surface: "kpi_snapshot", captured_at: "2026-09-12T09:00:00Z" }),
				atom({ id: "excl-surface", surface: "auto_planner", captured_at: "2026-09-13T09:00:00Z" }),
				atom({ id: "excl-robot", surface: "claude_code", tags: ["robot_authored"], captured_at: "2026-09-14T09:00:00Z" }),
			],
		});

		const narr = await searchHandler({ not_consumed: true, roles: ["narrative"] });
		expect(listedIds(narr.content[0].text)).toEqual(["narr-1"]);

		const evid = await searchHandler({ not_consumed: true, roles: ["evidence"] });
		expect(listedIds(evid.content[0].text)).toEqual(["evid-1"]);

		const met = await searchHandler({ not_consumed: true, roles: ["metrics"] });
		expect(listedIds(met.content[0].text)).toEqual(["met-1"]);

		const excl = await searchHandler({ not_consumed: true, roles: ["excluded"] });
		expect(listedIds(excl.content[0].text)).toEqual(["excl-robot", "excl-surface"]);

		const filterOnlyMet = await searchHandler({ captured_before: BEFORE_TODAY, roles: ["metrics"] });
		expect(listedIds(filterOnlyMet.content[0].text)).toEqual(["met-1"]);
	});

	it("excludes robot_authored / auto-task rows in SQL before LIMIT unless excluded is requested or not_robot_authored is set (#2229)", async () => {
		const robots = Array.from({ length: 60 }, (_, i) =>
			atom({
				id: `robot-${String(i).padStart(2, "0")}`,
				surface: "claude_code",
				tags: [i % 2 === 0 ? "robot_authored" : "auto-task"],
				captured_at: `2026-09-${String(10 + (i % 15)).padStart(2, "0")}T12:00:00Z`,
			}),
		);
		const human = atom({
			id: "human-older",
			surface: "claude_code",
			captured_at: "2026-08-01T12:00:00Z",
		});
		const rescued = atom({
			id: "rescued-robot-tag",
			surface: "claude_code",
			tags: ["robot_authored", "not_robot_authored"],
			captured_at: "2026-08-02T12:00:00Z",
		});

		installFakeDb({
			user_preferences: [prefsRow()],
			artifacts: [...robots, human, rescued],
		});

		// Without pre-LIMIT SQL filtering, the 60 newer robot rows would fill limit=10 and starve human-older.
		const unconsumed = await searchHandler({ not_consumed: true, roles: ["narrative"], limit: 10 });
		expect(listedIds(unconsumed.content[0].text)).toEqual(["rescued-robot-tag", "human-older"]);

		const filterOnly = await searchHandler({ captured_before: BEFORE_TODAY, roles: ["narrative"], limit: 10 });
		expect(listedIds(filterOnly.content[0].text)).toEqual(["rescued-robot-tag", "human-older"]);

		// When 'excluded' is requested, robot rows are included.
		const withExcluded = await searchHandler({ not_consumed: true, roles: ["excluded"], limit: 5 });
		expect(listedIds(withExcluded.content[0].text)).toHaveLength(5);
		expect(listedIds(withExcluded.content[0].text).every((id) => id.startsWith("robot-"))).toBe(true);
	});

	it("preserves role:<role> tag overrides on unconsumed and filter-only reads including unmapped roles (#2229)", async () => {
		installFakeDb({
			user_preferences: [
				prefsRow({
					surface_role_map: {
						claude_code: "narrative",
						google_drive: "evidence",
						kpi_snapshot: "evidence",
					},
					default_role: "narrative",
				}),
			],
			artifacts: [
				atom({ id: "narr-plain", surface: "claude_code", captured_at: "2026-09-10T09:00:00Z" }),
				driveAtom({
					id: "evid-overridden-narr",
					tags: ["role:narrative"],
					captured_at: "2026-09-11T09:00:00Z",
				}),
				driveAtom({
					id: "evid-overridden-met",
					tags: ["role:metrics"],
					captured_at: "2026-09-12T09:00:00Z",
				}),
				atom({
					id: "narr-overridden-evid",
					surface: "claude_code",
					tags: ["role:evidence"],
					captured_at: "2026-09-13T09:00:00Z",
				}),
			],
		});

		const unconsumedNarr = await searchHandler({ not_consumed: true, roles: ["narrative"] });
		expect(listedIds(unconsumedNarr.content[0].text)).toEqual(["evid-overridden-narr", "narr-plain"]);

		const filterOnlyNarr = await searchHandler({ captured_before: BEFORE_TODAY, roles: ["narrative"] });
		expect(listedIds(filterOnlyNarr.content[0].text)).toEqual(["evid-overridden-narr", "narr-plain"]);

		// 'metrics' has no entry in surface_role_map and is not default_role, so only role:metrics tag overrides match.
		const unconsumedMet = await searchHandler({ not_consumed: true, roles: ["metrics"] });
		expect(listedIds(unconsumedMet.content[0].text)).toEqual(["evid-overridden-met"]);

		const filterOnlyMet = await searchHandler({ captured_before: BEFORE_TODAY, roles: ["metrics"] });
		expect(listedIds(filterOnlyMet.content[0].text)).toEqual(["evid-overridden-met"]);
	});
});


