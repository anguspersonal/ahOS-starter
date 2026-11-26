import { defineAction } from "../defineAction.js";
import {
	documentDuplicatesSchema,
	type DocumentDuplicatesInput,
} from "../domain/capture.js";
import type {
	Cluster,
	ClusterRow,
	DocumentDuplicatesPort,
	DocumentDuplicatesResult,
} from "../../ports/artifacts.js";

/**
 * Members the RPC returns per cluster. It lives in the migration's final WHERE; kept
 * here only to word the "+N more" line. 10 members x at most 50 clusters stays
 * under PostgREST's 1000-row response cap, so the RPC's own output is never cut.
 */
export const MEMBERS_PER_CLUSTER = 10;

/** Members of one family the RPC reads and ranks (`c_family_read` in migration 119 / 150). */
export const FAMILY_READ_CAP = 100;

/** Matching titles a query run reads before the RPC refuses it (`c_seed_cap`, migration 119 / 150). */
export const QUERY_TITLE_CAP = 2000;

/** Rows arrive ordered by cluster, then member; regroup without reordering. */
export function groupClusters(rows: ClusterRow[]): Cluster[] {
	const byRank = new Map<number, Cluster>();
	for (const row of rows) {
		let cluster = byRank.get(row.cluster_rank);
		if (!cluster) {
			cluster = {
				kind: row.cluster_kind,
				key: row.cluster_key,
				memberCount: row.member_count,
				rankedMembers: row.ranked_members,
				distinctContents: row.distinct_contents,
				unhashedMembers: row.unhashed_members,
				members: [],
			};
			byRank.set(row.cluster_rank, cluster);
		}
		cluster.members.push(row);
	}
	for (const cluster of byRank.values()) cluster.members.sort((a, b) => a.member_rank - b.member_rank);
	return [...byRank.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
}

/** The RPC compares source-modified times on their first 19 characters (to the second). */
function sameModified(a: ClusterRow, b: ClusterRow): boolean {
	return (a.source_modified_at ?? "").slice(0, 19) === (b.source_modified_at ?? "").slice(0, 19);
}

/**
 * Why member 1 was suggested, in the order the RPC ranked: the most recent source
 * modification, and where the next member ties on it, the tie-break that decided
 * (owned by the owner, then enriched, then the earliest-registered pointer). Ends
 * with what is known about the cluster's contents -- and, for a family too large
 * to read whole, which members the pick was made among.
 */
export function explainCanonical(cluster: Cluster): string[] {
	const [pick, next] = cluster.members;
	const reasons: string[] = [];
	if (!pick) return reasons;
	const partial = cluster.rankedMembers < cluster.memberCount;

	const modified = pick.source_modified_at;
	const tied = next !== undefined && sameModified(pick, next);
	if (!modified) {
		reasons.push("no member records a source modification date");
	} else if (tied) {
		reasons.push(`most recent source modification (${modified}), tied with the next copy`);
	} else {
		reasons.push(`most recent source modification (${modified})`);
	}
	if (tied || !modified) {
		if (pick.owned_by_self && !next?.owned_by_self) reasons.push("owned by you");
		else if (pick.enriched && !next?.enriched) reasons.push("enriched (its text is in the store)");
		else if (next) reasons.push("level on every tie-break, so the earliest-registered pointer");
	}

	if (cluster.kind === "exact") {
		reasons.push(`all ${cluster.memberCount} members are byte-identical (same md5)`);
	} else {
		const unhashed =
			cluster.unhashedMembers > 0
				? `; ${cluster.unhashedMembers} have no md5, so their content cannot be compared`
				: "";
		const among = partial ? `the ${cluster.rankedMembers} members read` : `${cluster.memberCount} members`;
		reasons.push(`${cluster.distinctContents} distinct content(s) by md5 among ${among}${unhashed}`);
	}
	if (partial) {
		reasons.push(
			`ranked among the ${cluster.rankedMembers} most recently originated of ${cluster.memberCount} members (a family this large is usually a naming pattern, not one document's versions)`,
		);
	}
	return reasons;
}

function ownerText(row: ClusterRow): string {
	const label =
		row.owner && row.owner_email ? `${row.owner} <${row.owner_email}>` : (row.owner ?? row.owner_email);
	if (!label) return row.owned_by_self ? "owner you" : "owner unknown";
	return `owner ${label}${row.owned_by_self ? " (you)" : ""}`;
}

function memberLine(row: ClusterRow): string {
	const parts = [
		`${row.member_rank === 1 ? "★" : "•"} [${row.artifact_id}] ${row.title ?? "(untitled)"}`,
		`${row.connector ?? "?"} ${row.external_id ?? "?"}`,
		`modified ${row.source_modified_at ?? "unknown"}`,
		`created ${row.source_created_at ?? "unknown"}`,
		ownerText(row),
		`hash ${row.content_hash_kind ?? "none"}`,
	];
	if (row.enriched) parts.push("enriched");
	if (row.archived) parts.push(`archived (${row.archived_reason ?? "no reason recorded"})`);
	parts.push(row.link ?? "(no link)");
	return `   ${parts.join(" · ")}`;
}

export function formatClusters(
	rows: ClusterRow[],
	args: DocumentDuplicatesInput,
): string {
	const scope = [
		args.query ? `titles containing "${args.query}"` : null,
		args.connector ? `connector ${args.connector}` : null,
		`clusters of ${args.min_cluster ?? 2}+`,
		args.include_archived ? "archived included" : null,
	]
		.filter(Boolean)
		.join(", ");
	const clusters = groupClusters(rows);
	// Which exact clusters a run can see (migration 119's header): a full run follows
	// md5s from the families it read, so a renamed copy of a document with no family
	// only shows up when its title is queried. Said on every full run, found or not.
	const exactScope = args.query
		? "exact = byte-identical copies of a matching title (same Drive md5)"
		: "exact = byte-identical copies (same Drive md5) of a listed family's members; a renamed copy of a document with no version family shows up when you pass its title as `query`";
	if (clusters.length === 0) {
		return `No duplicate clusters found (${scope}). Only discovered pointers are scanned.${args.query ? "" : ` ${exactScope}.`}`;
	}

	const lines = [
		`${clusters.length} duplicate cluster(s) (${scope}), largest first. ${exactScope}; version_family = same title once copy markers, dates and extensions are stripped. Derived now, nothing stored; ★ marks the suggested canonical.`,
	];
	clusters.forEach((cluster, i) => {
		const pick = cluster.members[0];
		lines.push(
			"",
			`${i + 1}. ${cluster.kind} · ${cluster.memberCount} members · key "${cluster.key}"`,
			`   Suggested canonical: [${pick.artifact_id}] ${pick.title ?? "(untitled)"}`,
			`   Why: ${explainCanonical(cluster).join("; ")}`,
			...cluster.members.map(memberLine),
		);
		const hidden = cluster.memberCount - cluster.members.length;
		if (hidden > 0) {
			lines.push(
				`   +${hidden} more not shown (at most ${MEMBERS_PER_CLUSTER} per cluster, suggested canonical first); knowledge_search on the title with \`artifacts_only: true\` lists copies by name.`,
			);
		}
	});
	if (clusters.length === (args.limit ?? 20)) {
		lines.push("", `⚠️ The cluster limit (${args.limit ?? 20}) was reached; more clusters may exist. Raise \`limit\` (max 50) or narrow.`);
	}
	return lines.join("\n");
}

export function formatDocumentDuplicatesMcp(result: DocumentDuplicatesResult): string {
	return formatClusters(result.rows, result.args);
}

export interface DocumentDuplicatesActionOptions {
	formatMcp?: (result: DocumentDuplicatesResult) => string;
}

export function createDocumentDuplicatesAction(
	port: DocumentDuplicatesPort | Pick<DocumentDuplicatesPort, "documentDuplicates">,
	options?: DocumentDuplicatesActionOptions,
) {
	return defineAction({
		id: "document_duplicates",
		description:
			"Find duplicated documents among discovered pointers: exact copies (same Drive md5) and version " +
			"families (same normalised title), largest first, each with a suggested canonical and why. " +
			"Derived at read; changes nothing. At most 10 members per cluster, with a '+N more' count. " +
			"Full notes: docs/guides/tools/document_duplicates.md",
		schema: documentDuplicatesSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: DocumentDuplicatesInput, ctx) => port.documentDuplicates(input, ctx.userId),
		formatMcp: options?.formatMcp ?? formatDocumentDuplicatesMcp,
	});
}
