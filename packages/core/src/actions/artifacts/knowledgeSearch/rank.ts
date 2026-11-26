import {
	DAILY_LOG_CONTENT_SUBTYPE,
	REFLECTION_CONTENT_SUBTYPE,
	SCAFFOLD_CONTENT_SUBTYPE,
	UNENRICHED_ARTIFACT_STAGES,
} from "../../../domain/vocab.js";
import type { GraphKind, GraphRow, Row, SearchMode } from "../../../ports/search.js";

export type { GraphKind, GraphRow, Row, SearchMode };

export const TASK_REQUEST_CONTENT_SUBTYPE = "task_request" as const;
export const EVENT_REQUEST_CONTENT_SUBTYPE = "event_request" as const;
export const RANKED_OVERFETCH = 3;
export const HYBRID_MAX_ROWS = 120;
export const RRF_TOOL_K = 50;
export const GRAPH_ARM_WEIGHT = 2;
export const ARTIFACT_ARM_WEIGHT = 1;

export type DisplayRow = {
	kind: "artifact" | GraphKind;
	id: string;
	title: string | null;
	note: string;
	snippetText: string;
	aliases?: string[];
	properties?: Record<string, unknown> | null;
};

export type DegradeReason = "no-key" | "provider-unavailable";
export type Truncation = { count: number; exact: boolean };

export type Arm = {
	kind: DisplayRow["kind"];
	rows: DisplayRow[];
	rpcRowCount: number;
	ceiling: number;
};

export interface SearchFilterArgs {
	artifacts_only?: boolean;
	tags?: string[];
	include_task_requests?: boolean;
	include_event_requests?: boolean;
	include_daily_logs?: boolean;
	include_scaffolds?: boolean;
	include_reflections?: boolean;
	captured_after?: string;
	captured_before?: string;
	not_consumed?: boolean;
	include_discovered?: boolean;
}

function normalizeAliases(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function collectAliases(row: {
	aliases?: readonly string[] | null;
	properties?: Record<string, unknown> | null;
}): string[] {
	const legacy = row.properties?.aliases;
	return normalizeAliases([...(row.aliases ?? []), ...(Array.isArray(legacy) ? legacy : [])]);
}

export function excludedSystemSubtypes(opts: {
	includeTaskRequests: boolean;
	includeEventRequests: boolean;
	includeDailyLogs: boolean;
	includeScaffolds: boolean;
	includeReflections: boolean;
}): string[] {
	const excluded: string[] = [];
	if (!opts.includeTaskRequests) excluded.push(TASK_REQUEST_CONTENT_SUBTYPE);
	if (!opts.includeEventRequests) excluded.push(EVENT_REQUEST_CONTENT_SUBTYPE);
	if (!opts.includeDailyLogs) excluded.push(DAILY_LOG_CONTENT_SUBTYPE);
	if (!opts.includeScaffolds) excluded.push(SCAFFOLD_CONTENT_SUBTYPE);
	if (!opts.includeReflections) excluded.push(REFLECTION_CONTENT_SUBTYPE);
	return excluded;
}

export function dropExcludedSubtypes(rows: Row[], excluded: string[]): Row[] {
	if (excluded.length === 0) return rows;
	const excludedSet = new Set(excluded);
	return rows.filter((r) => !r.content_subtype || !excludedSet.has(r.content_subtype));
}

export function graphArmsWanted(args: Pick<SearchFilterArgs, "artifacts_only" | "tags">): boolean {
	return !args.artifacts_only && !args.tags?.length;
}

export function tagFilter(args: Pick<SearchFilterArgs, "tags">): string[] | null {
	return args.tags?.length ? [...new Set(args.tags)] : null;
}

export function tagRpcParam(args: Pick<SearchFilterArgs, "tags">): { filter_tags?: string[] } {
	const tags = tagFilter(args);
	return tags ? { filter_tags: tags } : {};
}

export function textArrayLiteral(values: string[]): string {
	return `{${values.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
}

export function rpcMigrationHint(args: Pick<SearchFilterArgs, "tags">, base: string): string {
	return tagFilter(args) ? `${base}; the \`tags\` filter needs migration 119` : base;
}

export function subtypeOptIns(
	args: Pick<
		SearchFilterArgs,
		| "include_task_requests"
		| "include_event_requests"
		| "include_daily_logs"
		| "include_scaffolds"
		| "include_reflections"
	>,
) {
	return {
		includeTaskRequests: args.include_task_requests ?? false,
		includeEventRequests: args.include_event_requests ?? false,
		includeDailyLogs: args.include_daily_logs ?? false,
		includeScaffolds: args.include_scaffolds ?? false,
		includeReflections: args.include_reflections ?? false,
	};
}

export function isSynthesisWindow(
	args: Pick<SearchFilterArgs, "captured_after" | "captured_before" | "not_consumed">,
): boolean {
	return Boolean(args.captured_after || args.captured_before || args.not_consumed);
}

export function excludeUnenrichedDiscovered(rows: Row[]): Row[] {
	return rows.filter(
		(r) => !r.lifecycle_stage || !UNENRICHED_ARTIFACT_STAGES.has(r.lifecycle_stage),
	);
}

export function snippet(text: string | null): string {
	if (!text) return "";
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

export function degradationNote(reason: DegradeReason, detail?: string): string {
	if (reason === "no-key") {
		return "ℹ️ search_mode: full-text-only (no OpenAI embedding key configured — semantic/vector recall skipped).\n\n";
	}
	return (
		"⚠️ search_mode: full-text-only (embedding provider unavailable" +
		(detail ? `: ${detail}` : "") +
		" — keyword results only, semantic/vector recall skipped).\n\n"
	);
}

export function toArtifactDisplayRows(rows: Row[]): DisplayRow[] {
	return rows.map((r) => {
		const stageNote =
			r.lifecycle_stage && UNENRICHED_ARTIFACT_STAGES.has(r.lifecycle_stage)
				? ` [${r.lifecycle_stage}]`
				: "";
		const capturedNote = r.captured_at
			? ` (captured ${r.captured_at.slice(0, 10)})`
			: " (captured date unknown)";
		const originNote =
			r.effective_at && r.captured_at && r.effective_at.slice(0, 10) !== r.captured_at.slice(0, 10)
				? ` (from ${r.effective_at.slice(0, 10)})`
				: "";
		return {
			kind: "artifact" as const,
			id: r.id,
			title: r.title,
			note: `${stageNote}${capturedNote}${originNote}`,
			snippetText: snippet(r.plain_text),
		};
	});
}

export function toGraphDisplayRows(rows: GraphRow[], kind: GraphKind): DisplayRow[] {
	return rows.map((r) => {
		let text = r.description;
		if (!text && r.properties && typeof r.properties === "object") {
			const props = r.properties as Record<string, unknown>;
			const expansion = typeof props.expansion === "string" ? props.expansion : null;
			const context = typeof props.context === "string" ? props.context : null;
			if (expansion) {
				text = context ? `${expansion} (${context})` : expansion;
			}
		}
		const aliases = collectAliases(r);
		if (!text && aliases.length > 0) {
			text = `aka: ${aliases.join(", ")}`;
		}
		return {
			kind,
			id: r.id,
			title: r.title,
			aliases,
			properties: r.properties,
			note: kind === "entity" ? " [entity]" : " [person]",
			snippetText: snippet(text),
		};
	});
}

export function formatDisplayRows(
	rows: DisplayRow[],
	truncated?: Truncation,
	mode?: SearchMode,
	degrade: { reason: DegradeReason; detail?: string } = { reason: "no-key" },
	preamble = "",
): {
	content: { type: "text"; text: string }[];
} {
	const modeNote =
		preamble +
		(mode === "full-text-only" ? degradationNote(degrade.reason, degrade.detail) : "");
	if (rows.length === 0) {
		return { content: [{ type: "text", text: `${modeNote}No matches.` }] };
	}
	const body = rows
		.map((r) => `• [${r.id}] ${r.title ?? "(untitled)"}${r.note}\n  ${r.snippetText}`)
		.join("\n");
	const narrow =
		"raise `limit` or use `captured_after`/`captured_before` to narrow the window.";
	let truncationNote = "";
	if (truncated && truncated.count > 0) {
		truncationNote = truncated.exact
			? `\n\n⚠️ ${truncated.count} more result(s) not shown — ${narrow}`
			: `\n\n⚠️ at least ${truncated.count} more result(s) not shown (ranked-search ceiling reached, so the true total may be higher) — ${narrow}`;
	} else if (truncated && !truncated.exact) {
		truncationNote = `\n\n⚠️ More results may exist — the ranked-search ceiling was reached before filtering, so this page may not be everything. ${narrow}`;
	}
	return {
		content: [
			{
				text: `${modeNote}${rows.length} result(s):\n${body}${truncationNote}`,
				type: "text",
			},
		],
	};
}

export function isNameExactMatch(row: DisplayRow, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (row.title && row.title.trim().toLowerCase() === q) return true;
	if (row.aliases && row.aliases.some((a) => a && a.trim().toLowerCase() === q)) return true;
	const expansion =
		typeof row.properties?.expansion === "string" ? row.properties.expansion : null;
	if (expansion && expansion.trim().toLowerCase() === q) return true;
	return false;
}

export function fuseArms(
	arms: { kind: DisplayRow["kind"]; rows: DisplayRow[] }[],
	query: string,
): DisplayRow[] {
	const scored = arms.flatMap(({ kind, rows }) =>
		rows.map((row, rankIx) => ({
			row,
			exact: kind !== "artifact" && isNameExactMatch(row, query),
			score:
				(kind === "artifact" ? ARTIFACT_ARM_WEIGHT : GRAPH_ARM_WEIGHT) /
				(RRF_TOOL_K + rankIx),
		})),
	);
	scored.sort((a, b) => {
		if (a.exact !== b.exact) return a.exact ? -1 : 1;
		return b.score - a.score;
	});
	return scored.map((s) => s.row);
}

export function mergeArms(
	arms: Arm[],
	query: string,
	limit: number,
	mode: SearchMode,
	degrade?: { reason: DegradeReason; detail?: string },
): { content: { type: "text"; text: string }[] } {
	const fused = fuseArms(arms, query);
	const truncated: Truncation = {
		count: fused.length > limit ? fused.length - limit : 0,
		exact: arms.every((a) => a.rpcRowCount < a.ceiling),
	};
	return formatDisplayRows(fused.slice(0, limit), truncated, mode, degrade);
}

export function errDetail(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
