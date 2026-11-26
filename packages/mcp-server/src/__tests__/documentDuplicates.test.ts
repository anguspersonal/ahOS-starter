import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import {
	type ClusterRow,
	documentDuplicatesAction,
	documentDuplicatesHandler,
	documentDuplicatesInput,
	explainCanonical,
	formatClusters,
} from "../tools/documentDuplicates.js";
import { executeAction } from "../actions/index.js";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { buildRegistry } from "@ahkms/core/actions";
import { z } from "zod";

// #1217: document_duplicates prints what the `document_duplicate_clusters` RPC
// (migration 119) derives: exact copies (same md5) and version families (same
// title key), member 1 of each the suggested canonical. The grouping and ranking
// run in SQL; what is tested here is the contract with that RPC and the honesty of
// the output -- the "+N more" count, the reasons, md5 versus modified_time.

const origRpc = supabase.rpc;
const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).rpc = origRpc;
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const schema = z.object(documentDuplicatesInput);

function member(overrides: Partial<ClusterRow> = {}): ClusterRow {
	return {
		cluster_kind: "exact",
		cluster_key: "5d41402abc4b2a76b9719d911017c592",
		cluster_rank: 1,
		member_count: 2,
		// Every member read and ranked, unless a test says otherwise.
		ranked_members: overrides.member_count ?? 2,
		distinct_contents: 1,
		unhashed_members: 0,
		member_rank: 1,
		artifact_id: "b564a861-0000-4000-8000-000000000001",
		title: "Angus Hally CV.pdf",
		link: "https://drive.google.com/file/d/1c8ZKVEOdhSClaJ-uLJrmTRO_Sp2Yn5DV/view",
		connector: "gdrive",
		external_id: "1c8ZKVEOdhSClaJ-uLJrmTRO_Sp2Yn5DV",
		source_created_at: "2025-09-18T10:00:00.000Z",
		source_modified_at: "2025-09-18T10:00:00.000Z",
		owner: "Angus Hally",
		owner_email: null,
		content_hash: "5d41402abc4b2a76b9719d911017c592",
		content_hash_kind: "md5",
		owned_by_self: true,
		enriched: false,
		lifecycle_stage: "discovered",
		archived: false,
		archived_reason: null,
		...overrides,
	};
}

/** The 'Angus Hally CV.pdf' exact pair from the audit (b564a861 / d5d99274). */
const EXACT_PAIR = [
	member(),
	member({
		member_rank: 2,
		artifact_id: "d5d99274-0000-4000-8000-000000000002",
		external_id: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
		link: "https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
		source_created_at: "2025-05-13T09:00:00.000Z",
		source_modified_at: "2025-05-13T09:30:00.000Z",
	}),
];

function stubRpc(rows: ClusterRow[] | null, error: { code?: string; message: string } | null = null) {
	const rpc = vi.fn(() => Promise.resolve({ data: rows, error }));
	(supabase as any).rpc = rpc;
	(supabase as any).from = vi.fn(() => {
		throw new Error("document_duplicates must not touch a table directly");
	});
	return rpc;
}

async function run(args: z.infer<typeof schema>): Promise<string> {
	return (await documentDuplicatesHandler(args)).content[0].text;
}

describe("document_duplicates — the RPC contract (#1217)", () => {
	it("calls document_duplicate_clusters with the batch contract's parameters and defaults", async () => {
		const rpc = stubRpc([]);
		await run({});
		expect(rpc).toHaveBeenCalledWith("document_duplicate_clusters", {
			p_user_id: expect.any(String),
			p_query: null,
			p_connector: null,
			p_min_cluster: 2,
			p_limit: 20,
			p_include_archived: false,
		});
	});

	it("passes every filter through", async () => {
		const rpc = stubRpc([]);
		await run({ query: "Angus Hally CV", connector: "gdrive", min_cluster: 3, limit: 5, include_archived: true });
		expect(rpc).toHaveBeenCalledWith(
			"document_duplicate_clusters",
			expect.objectContaining({
				p_query: "Angus Hally CV",
				p_connector: "gdrive",
				p_min_cluster: 3,
				p_limit: 5,
				p_include_archived: true,
			}),
		);
	});

	it("validates its inputs at the schema", () => {
		expect(schema.safeParse({ min_cluster: 1 }).success).toBe(false);
		expect(schema.safeParse({ limit: 51 }).success).toBe(false);
		expect(schema.safeParse({ connector: "google-drive" }).success).toBe(false);
		expect(schema.safeParse({ connector: "gdrive_work", limit: 50 }).success).toBe(true);
	});

	it("points a missing RPC at migration 119", async () => {
		stubRpc(null, {
			code: "PGRST202",
			message: "Could not find the function public.document_duplicate_clusters(p_connector, ...) in the schema cache",
		});
		await expect(run({})).rejects.toThrow(/apply migration 119/);
	});

	it("turns a statement timeout into 'narrow the run', not a migration hint", async () => {
		stubRpc(null, { code: "57014", message: "canceling statement due to statement timeout" });
		const err = await run({}).catch((e: Error) => e);
		expect(String(err)).toMatch(/timed out in the database \(statement timeout, 57014\)/);
		expect(String(err)).toMatch(/pass `query` \(a title\) or `connector`/);
		expect(String(err)).not.toMatch(/migration/);
	});

	it("passes the RPC's refusal of an over-broad query through with what to do", async () => {
		stubRpc(null, {
			code: "54000",
			message: 'document_duplicate_clusters: "report" matches 24000 document titles, more than the 2000 a query run reads',
		});
		const err = await run({ query: "report" }).catch((e: Error) => e);
		expect(String(err)).toMatch(/"report" matches 24000 document titles/);
		expect(String(err)).toMatch(/Narrow the query/);
		expect(String(err)).not.toMatch(/migration/);
	});

	it("reports any other failure as it is", async () => {
		stubRpc(null, { code: "XX000", message: "something else" });
		await expect(run({})).rejects.toThrow(/^document_duplicates failed: something else \[request_id=[0-9a-f-]{36}\]$/);
	});

	it("says plainly when nothing is duplicated, naming the scope", async () => {
		stubRpc([]);
		const out = await run({ query: "passport", connector: "gdrive" });
		expect(out).toBe(
			'No duplicate clusters found (titles containing "passport", connector gdrive, clusters of 2+). Only discovered pointers are scanned.',
		);
	});

	it("says on a full run which exact copies it could see, found or not", async () => {
		// A full run follows md5s from the families it reads (migration 119's header), so a
		// renamed copy of a document with no family needs a query to be found.
		stubRpc([]);
		expect(await run({})).toContain("shows up when you pass its title as `query`");
		stubRpc(EXACT_PAIR);
		const full = await run({});
		expect(full).toContain("exact = byte-identical copies (same Drive md5) of a listed family's members");
		stubRpc(EXACT_PAIR);
		const queried = await run({ query: "Angus Hally CV" });
		expect(queried).toContain("exact = byte-identical copies of a matching title (same Drive md5)");
		expect(queried).not.toContain("listed family's members");
	});
});

describe("document_duplicates — output (#1217)", () => {
	it("prints the exact pair with its suggested canonical and why", async () => {
		stubRpc(EXACT_PAIR);
		const out = await run({});
		expect(out).toContain("1 duplicate cluster(s) (clusters of 2+), largest first.");
		expect(out).toContain('1. exact · 2 members · key "5d41402abc4b2a76b9719d911017c592"');
		expect(out).toContain("Suggested canonical: [b564a861-0000-4000-8000-000000000001] Angus Hally CV.pdf");
		expect(out).toContain(
			"Why: most recent source modification (2025-09-18T10:00:00.000Z); all 2 members are byte-identical (same md5)",
		);
		expect(out).toContain(
			"★ [b564a861-0000-4000-8000-000000000001] Angus Hally CV.pdf · gdrive 1c8ZKVEOdhSClaJ-uLJrmTRO_Sp2Yn5DV · modified 2025-09-18T10:00:00.000Z · created 2025-09-18T10:00:00.000Z · owner Angus Hally (you) · hash md5 · https://drive.google.com/file/d/1c8ZKVEOdhSClaJ-uLJrmTRO_Sp2Yn5DV/view",
		);
		expect(out).toContain("• [d5d99274-0000-4000-8000-000000000002] Angus Hally CV.pdf · gdrive 1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-");
		expect(out).not.toContain("more not shown");
	});

	it("counts the members past the per-cluster cap: no silent caps", async () => {
		// 24 copies of 'Angus Hally CV Feb 23.docx'; the RPC returns the first ten.
		const rows = Array.from({ length: 10 }, (_, i) =>
			member({
				cluster_key: "0cc175b9c0f1b6a831c399e269772661",
				member_count: 24,
				member_rank: i + 1,
				artifact_id: `feb23-${i + 1}`,
				title: "Angus Hally CV Feb 23.docx",
				source_modified_at: "2025-10-17T04:55:31.000Z",
			}),
		);
		stubRpc(rows);
		const out = await run({});
		expect(out).toContain("1. exact · 24 members");
		expect(out.match(/^ {3}[★•] \[feb23-\d+\]/gm)).toHaveLength(10);
		expect(out).toContain("+14 more not shown (at most 10 per cluster, suggested canonical first)");
	});

	it("groups rows by cluster in rank order, whatever order they arrive in", async () => {
		const family = [
			member({
				cluster_kind: "version_family",
				cluster_key: "angus hally cv",
				cluster_rank: 1,
				member_count: 3,
				distinct_contents: 2,
				unhashed_members: 1,
				member_rank: 2,
				artifact_id: "fam-2",
				title: "Angus Hally CV Mar 21-v20250622131750.pdf",
				source_modified_at: "2025-06-22T13:17:50.000Z",
			}),
			member({
				cluster_kind: "version_family",
				cluster_key: "angus hally cv",
				cluster_rank: 1,
				member_count: 3,
				distinct_contents: 2,
				unhashed_members: 1,
				member_rank: 1,
				artifact_id: "fam-1",
				title: "Angus Hally CV Jun 24.pdf",
				source_modified_at: "2026-09-11T09:00:00.000Z",
			}),
			member({
				cluster_kind: "version_family",
				cluster_key: "angus hally cv",
				cluster_rank: 1,
				member_count: 3,
				distinct_contents: 2,
				unhashed_members: 1,
				member_rank: 3,
				artifact_id: "fam-3",
				title: "Angus Hally CV",
				content_hash: "2025-01-01T00:00:00.000Z",
				content_hash_kind: "modified_time",
				source_modified_at: "2025-01-01T00:00:00.000Z",
			}),
		];
		stubRpc([...EXACT_PAIR.map((r) => ({ ...r, cluster_rank: 2 })), ...family]);
		const out = await run({ query: "Angus Hally CV" });

		expect(out).toContain('2 duplicate cluster(s) (titles containing "Angus Hally CV", clusters of 2+)');
		expect(out.indexOf('1. version_family · 3 members · key "angus hally cv"')).toBeLessThan(
			out.indexOf("2. exact · 2 members"),
		);
		expect(out).toContain("Suggested canonical: [fam-1] Angus Hally CV Jun 24.pdf");
		expect(out).toContain(
			"2 distinct content(s) by md5 among 3 members; 1 have no md5, so their content cannot be compared",
		);
		expect(out.indexOf("★ [fam-1]")).toBeLessThan(out.indexOf("• [fam-2]"));
		expect(out).toContain("[fam-3] Angus Hally CV · gdrive");
		expect(out).toContain("hash modified_time");
	});

	it("says when a family too large to read whole was ranked on a subset", async () => {
		// 'Screenshot ... at ...' titles: one key, hundreds of files. The RPC reads and
		// ranks the 100 most recently originated; the output must not pass that off as all.
		const rows = Array.from({ length: 10 }, (_, i) =>
			member({
				cluster_kind: "version_family",
				cluster_key: "screenshot at",
				member_count: 640,
				ranked_members: 100,
				distinct_contents: 100,
				member_rank: i + 1,
				artifact_id: `shot-${i + 1}`,
				title: `Screenshot 2023-05-12 at 10.23.${10 + i}.png`,
				source_modified_at: `2023-05-12T10:23:${10 + i}.000Z`,
			}),
		);
		stubRpc(rows);
		const out = await run({});
		expect(out).toContain('1. version_family · 640 members · key "screenshot at"');
		expect(out).toContain("100 distinct content(s) by md5 among the 100 members read");
		expect(out).toContain(
			"ranked among the 100 most recently originated of 640 members (a family this large is usually a naming pattern, not one document's versions)",
		);
		expect(out).toContain("+630 more not shown");
	});

	it("shows archived members with their reason, and flags a reached cluster limit", async () => {
		stubRpc([
			member({ member_count: 2 }),
			member({ member_rank: 2, artifact_id: "arch-1", archived: true, archived_reason: "superseded:b564a861" }),
		]);
		const out = await run({ include_archived: true, limit: 1 });
		expect(out).toContain("archived included");
		expect(out).toContain("archived (superseded:b564a861)");
		expect(out).toContain("⚠️ The cluster limit (1) was reached; more clusters may exist.");
	});
});

describe("explainCanonical — the reasons", () => {
	const cluster = (members: ClusterRow[], kind: ClusterRow["cluster_kind"] = "exact") => ({
		kind,
		key: "k",
		memberCount: members.length,
		rankedMembers: members.length,
		distinctContents: 1,
		unhashedMembers: 0,
		members,
	});

	it("names owned-by-you as the tie-break when the modification times tie", () => {
		const reasons = explainCanonical(
			cluster([
				member({ owned_by_self: true, source_modified_at: "2025-10-17T04:55:31.000Z" }),
				member({ member_rank: 2, owned_by_self: false, source_modified_at: "2025-10-17T04:55:31Z" }),
			]),
		);
		expect(reasons).toEqual([
			"most recent source modification (2025-10-17T04:55:31.000Z), tied with the next copy",
			"owned by you",
			"all 2 members are byte-identical (same md5)",
		]);
	});

	it("names enrichment when ownership ties too", () => {
		const reasons = explainCanonical(
			cluster([
				member({ enriched: true }),
				member({ member_rank: 2, enriched: false }),
			]),
		);
		expect(reasons[1]).toBe("enriched (its text is in the store)");
	});

	it("admits a deterministic pick when every tie-break is level", () => {
		const reasons = explainCanonical(cluster([member(), member({ member_rank: 2 })]));
		expect(reasons[1]).toBe("level on every tie-break, so the earliest-registered pointer");
	});

	it("says when no member has a modification date", () => {
		const reasons = explainCanonical(
			cluster([
				member({ source_modified_at: null, owned_by_self: true }),
				member({ member_rank: 2, source_modified_at: null, owned_by_self: false }),
			]),
		);
		expect(reasons.slice(0, 2)).toEqual(["no member records a source modification date", "owned by you"]);
	});
});

describe("formatClusters", () => {
	it("labels an owner by email and marks the owner's own copies", () => {
		const out = formatClusters(
			[
				member({ owner: null, owner_email: "owner@example.com" }),
				member({ member_rank: 2, owner: "Laura Sharp", owner_email: "l@example.com", owned_by_self: false }),
			],
			{},
		);
		expect(out).toContain("owner owner@example.com (you)");
		expect(out).toContain("owner Laura Sharp <l@example.com> ·");
	});
});

describe("documentDuplicatesAction (ADR-100)", () => {
	it("executes directly returning structured DocumentDuplicatesResult", async () => {
		const seeded = [
			member({ title: "Doc A", member_rank: 1 }),
			member({ title: "Doc B", member_rank: 2 }),
		];
		(supabase as any).rpc = vi.fn(async () => ({ data: seeded, error: null }));

		const result = await executeAction(documentDuplicatesAction, {
			limit: 5,
		});

		expect(result.rows).toHaveLength(2);
		expect(result.clusters).toBeDefined();
		expect(result.args.limit).toBe(5);
	});

	it("wires formatMcp in buildRegistry so MCP calls return formatted cluster summaries instead of raw JSON (#2099)", async () => {
		const seeded = [
			member({ title: "Doc A", member_rank: 1 }),
			member({ title: "Doc B", member_rank: 2 }),
		];
		const fakePort = {
			capture: vi.fn(),
			documentDuplicates: vi.fn(async (args) => ({
				rows: seeded,
				clusters: [],
				args,
			})),
		};

		const action = buildRegistry({ artifacts: fakePort }).get("document_duplicates")!;
		expect(action.formatMcp).toBeDefined();

		const mcpResponse = await toMcpTool(action).handler({ limit: 5 });
		const text = mcpResponse.content[0].text;
		expect(text).toContain("1 duplicate cluster(s) (clusters of 2+), largest first.");
		expect(text).not.toMatch(/^\s*\{\s*"rows"/);
	});
});
