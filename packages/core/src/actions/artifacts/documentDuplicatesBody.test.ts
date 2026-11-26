import { describe, expect, it, vi } from "vitest";
import { createSupabaseArtifactRepository } from "../../adapters/supabase/artifacts.js";
import type { ClusterRow } from "../../ports/artifacts.js";
import { formatDocumentDuplicatesMcp } from "./documentDuplicates.js";
import { describeRpcError, documentDuplicatesCore } from "./documentDuplicatesBody.js";

function member(overrides: Partial<ClusterRow> = {}): ClusterRow {
	return {
		cluster_kind: "exact",
		cluster_key: "5d41402abc4b2a76b9719d911017c592",
		cluster_rank: 1,
		member_count: 2,
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

describe("documentDuplicatesBody (#1659)", () => {
	it("1. duplicateClusters calls document_duplicate_clusters RPC with defaults and explicit filters", async () => {
		const rpc = vi.fn(async () => ({ data: [], error: null }));
		const repo = createSupabaseArtifactRepository({
			client: {
				from: () => {
					throw new Error("must not touch tables directly");
				},
				rpc: rpc as any,
			},
			ownerId: "owner-1",
		});

		await documentDuplicatesCore(repo, {});
		expect(rpc).toHaveBeenCalledWith("document_duplicate_clusters", {
			p_user_id: "owner-1",
			p_query: null,
			p_connector: null,
			p_min_cluster: 2,
			p_limit: 20,
			p_include_archived: false,
		});

		await documentDuplicatesCore(
			repo,
			{ query: "Angus Hally CV", connector: "gdrive", min_cluster: 3, limit: 5, include_archived: true },
			"override-user",
		);
		expect(rpc).toHaveBeenLastCalledWith("document_duplicate_clusters", {
			p_user_id: "override-user",
			p_query: "Angus Hally CV",
			p_connector: "gdrive",
			p_min_cluster: 3,
			p_limit: 5,
			p_include_archived: true,
		});
	});

	it("2. describeRpcError matches dev wording for 57014, 54000, PGRST202, and plain errors", async () => {
		expect(describeRpcError({ code: "57014", message: "statement timeout" }, {})).toBe(
			"document_duplicates timed out in the database (statement timeout, 57014). Narrow the run: pass `query` (a title) or `connector`, or lower `limit`.",
		);
		expect(describeRpcError({ code: "57014", message: "statement timeout" }, { query: "cv" })).toBe(
			"document_duplicates timed out in the database (statement timeout, 57014). Narrow the run: pass a longer `query`, a `connector`, or a lower `limit`.",
		);
		expect(
			describeRpcError(
				{ code: "54000", message: 'document_duplicate_clusters: "report" matches 24000 document titles' },
				{ query: "report" },
			),
		).toBe(
			'document_duplicates: document_duplicate_clusters: "report" matches 24000 document titles. Narrow the query (a longer title fragment) or pass `connector`; a query run reads at most 2000 matching titles.',
		);
		expect(
			describeRpcError(
				{ code: "PGRST202", message: "Could not find the function public.document_duplicate_clusters" },
				{},
			),
		).toBe(
			"document_duplicates failed: Could not find the function public.document_duplicate_clusters. The document_duplicate_clusters RPC is missing: apply migration 119.",
		);
		expect(describeRpcError({ code: "XX000", message: "something else" }, {})).toBe(
			"document_duplicates failed: something else",
		);
		const failingRepo = {
			duplicateClusters: vi.fn(async () => {
				throw Object.assign(new Error("something else"), { code: "XX000" });
			}),
		};
		await expect(documentDuplicatesCore(failingRepo, {})).rejects.toThrow(
			"document_duplicates failed: something else",
		);
	});

	it("3. formats fixture rows identically to dev, including +N more and the limit warning", async () => {
		const cappedRows = Array.from({ length: 10 }, (_, i) =>
			member({
				cluster_key: "0cc175b9c0f1b6a831c399e269772661",
				member_count: 24,
				member_rank: i + 1,
				artifact_id: `feb23-${i + 1}`,
				title: "Angus Hally CV Feb 23.docx",
				source_modified_at: "2025-10-17T04:55:31.000Z",
				archived: i === 9,
				archived_reason: i === 9 ? "superseded:b564a861" : null,
			}),
		);
		const res = await documentDuplicatesCore(
			{ duplicateClusters: vi.fn(async () => cappedRows) },
			{ include_archived: true, limit: 1 },
		);
		const out = formatDocumentDuplicatesMcp(res);
		expect(out).toContain("1 duplicate cluster(s) (clusters of 2+, archived included), largest first.");
		expect(out).toContain('1. exact · 24 members · key "0cc175b9c0f1b6a831c399e269772661"');
		expect(out.match(/^ {3}[★•] \[feb23-\d+\]/gm)).toHaveLength(10);
		expect(out).toContain("archived (superseded:b564a861)");
		expect(out).toContain("+14 more not shown (at most 10 per cluster, suggested canonical first)");
		expect(out).toContain("⚠️ The cluster limit (1) was reached; more clusters may exist.");
	});
});
