import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return { ...actual, env: { ...actual.env, openaiApiKey: undefined as string | undefined } };
});
vi.mock("../embeddings.js", () => ({ embed: vi.fn(async () => [0.1, 0.2, 0.3]) }));

import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { capturePreferencesSchema } from "../captureConfig.js";

const searchHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("knowledge_search")!).handler(args);

const origFrom = supabase.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as unknown as { from: unknown }).from = origFrom;
	(supabase as unknown as { rpc: unknown }).rpc = origRpc;
	vi.restoreAllMocks();
});

type Rec = Record<string, unknown>;

function makeArtifact(overrides: Partial<Rec> & { id: string }): Rec {
	const captured_at = (overrides.captured_at as string) ?? "2026-10-19T12:00:00Z";
	return {
		title: `title ${overrides.id}`,
		plain_text: `body ${overrides.id}`,
		created_at: captured_at,
		captured_at,
		effective_at: captured_at,
		lifecycle_stage: "extracted",
		tags: [],
		content_subtype: null,
		archived: false,
		surface: "claude_code",
		source_channel: "mcp",
		...overrides,
	};
}

function installFakeSupabase(artifacts: Rec[]) {
	const prefsRow: Rec = { capture_preferences: capturePreferencesSchema.parse({}) };

	(supabase as unknown as { from: unknown }).from = vi.fn((table: string) => {
		const preds: Array<(r: Rec) => boolean> = [];
		const orders: Array<{ col: string; ascending: boolean }> = [];
		let rowLimit = 1000;
		let selectOpts: { count?: string; head?: boolean } | undefined;

		const run = () => {
			let rows = (table === "user_preferences" ? [prefsRow] : artifacts).filter((r) =>
				preds.every((p) => p(r)),
			);
			const count = rows.length;
			for (const o of [...orders].reverse()) {
				rows = [...rows].sort((a, b) => {
					const av = String(a[o.col] ?? "");
					const bv = String(b[o.col] ?? "");
					return o.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
				});
			}
			rows = rows.slice(0, rowLimit);
			const withCount = selectOpts?.count ? { count } : {};
			if (selectOpts?.head) return { data: null, error: null, ...withCount };
			return { data: rows, error: null, ...withCount };
		};

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const b: any = {
			select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
				selectOpts = opts;
				return b;
			},
			eq: (col: string, v: unknown) => {
				if (col !== "user_id") preds.push((r) => r[col] === v);
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
				}
				return b;
			},
			or: () => b,
			order: (col: string, opts?: { ascending?: boolean }) => {
				orders.push({ col, ascending: opts?.ascending ?? true });
				return b;
			},
			limit: (n: number) => {
				rowLimit = n;
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

	(supabase as unknown as { rpc: unknown }).rpc = vi.fn(
		(fnName: string, params: Record<string, unknown>) => {
			if (fnName !== "search_unconsumed_artifacts") {
				return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
			}
			let rows = [...artifacts];
			if (params.p_effective_after) {
				rows = rows.filter(
					(r) => r.effective_at && String(r.effective_at) >= String(params.p_effective_after),
				);
			}
			if (params.p_effective_before) {
				rows = rows.filter(
					(r) => r.effective_at && String(r.effective_at) <= String(params.p_effective_before),
				);
			}
			if (params.p_role_hit_keys != null) {
				const hitKeys = (params.p_role_hit_keys as string[]) ?? [];
				const allKeys = (params.p_role_all_keys as string[]) ?? [];
				const overrideTags = (params.p_role_override_tags as string[]) ?? [];
				rows = rows.filter((r) => {
					const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
					if (overrideTags.some((t) => tags.includes(t))) return true;
					const surface = r.surface as string | null | undefined;
					const sourceChannel = r.source_channel as string | null | undefined;
					if (surface && hitKeys.includes(surface)) return true;
					const surfaceUnmapped = !surface || !allKeys.includes(surface);
					if (surfaceUnmapped && sourceChannel && hitKeys.includes(sourceChannel)) return true;
					const channelUnmapped = !sourceChannel || !allKeys.includes(sourceChannel);
					return Boolean(params.p_role_default_hit && surfaceUnmapped && channelUnmapped);
				});
			}
			if (params.p_exclude_robot_authored !== false) {
				rows = rows.filter((r) => {
					const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
					if (tags.includes("not_robot_authored")) return true;
					return !tags.includes("robot_authored") && !tags.includes("auto-task");
				});
			}
			const total_count = rows.length;
			const limit = (params.p_limit as number | undefined) ?? rows.length;
			return Promise.resolve({
				data: rows.slice(0, limit).map((r) => ({ ...r, total_count })),
				error: null,
			});
		},
	);
}

function listedIds(text: string): string[] {
	return [...text.matchAll(/^• \[([^\]]+)\]/gm)].map((m) => m[1]);
}

describe("knowledge_search default narrative role on not_consumed (#2231)", () => {
	const fixtures = [
		makeArtifact({ id: "narr-1", surface: "claude_code", captured_at: "2026-10-19T10:00:00Z" }),
		makeArtifact({ id: "evid-gh", surface: "github", captured_at: "2026-10-19T09:00:00Z" }),
		makeArtifact({ id: "evid-slack", surface: "slack", captured_at: "2026-10-19T08:00:00Z" }),
		makeArtifact({
			id: "evid-receipt",
			surface: "act_receipt",
			content_subtype: "act_receipt",
			captured_at: "2026-10-19T07:00:00Z",
		}),
		makeArtifact({ id: "met-1", surface: "kpi_snapshot", captured_at: "2026-10-19T06:00:00Z" }),
		makeArtifact({
			id: "excl-1",
			surface: "claude_code",
			tags: ["robot_authored"],
			captured_at: "2026-10-19T05:00:00Z",
		}),
	];

	it("defaults not_consumed: true without roles to ['narrative']", async () => {
		installFakeSupabase(fixtures);
		const res = await searchHandler({
			not_consumed: true,
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(listedIds(res.content[0].text)).toEqual(["narr-1"]);
	});

	it("overrides the default when explicit roles are passed with not_consumed: true", async () => {
		installFakeSupabase(fixtures);
		const evidRes = await searchHandler({
			not_consumed: true,
			roles: ["evidence"],
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(listedIds(evidRes.content[0].text)).toEqual(["evid-gh", "evid-slack", "evid-receipt"]);

		const rankedBoth = await searchHandler({
			not_consumed: true,
			roles: ["narrative", "evidence"],
			rank_by_role: true,
			captured_before: "2026-10-20T00:00:00Z",
		});
		expect(rankedBoth.content[0].text).toContain("narrative 1 · evidence 3 · metrics 0 · excluded 0");
		expect(listedIds(rankedBoth.content[0].text)).toEqual([
			"narr-1",
			"evid-gh",
			"evid-slack",
			"evid-receipt",
		]);
	});

	it("returns all roles when not_consumed is omitted", async () => {
		installFakeSupabase(fixtures);
		const res = await searchHandler({
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(listedIds(res.content[0].text)).toEqual([
			"narr-1",
			"evid-gh",
			"evid-slack",
			"evid-receipt",
			"met-1",
			"excl-1",
		]);
	});
});
