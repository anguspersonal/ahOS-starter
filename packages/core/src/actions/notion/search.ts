import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { NotionPort, NotionSearchResultItem } from "../../ports/notion.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const DOMAIN_PROVIDER: Record<Domain, string> = {
	work: "notion_work",
	angus: "notion_personal",
};

export const notionSearchInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which workspace to search: 'work' (the Work workspace) or 'angus' (the personal one). No default — the two are separate Notion integrations that each see only their own workspace (ADR-054 §9), so a page missing from one may be sitting in the other.",
		),
	query: z
		.string()
		.optional()
		.describe(
			"Words to match against page and database TITLES. Notion's search does not index block text, so a phrase that appears INSIDE a page will not find it — search for what the page is called. Omit to list the most recently edited objects instead.",
		),
	type: z
		.enum(["page", "database", "data_source"])
		.optional()
		.describe("Restrict results to pages or to databases. Omit for both."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.optional()
		.describe(`Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("The next_cursor from a previous call, to fetch the following page of results."),
});

export type NotionSearchInput = z.infer<typeof notionSearchInputSchema>;

export const notionSearchResultItemSchema = z.object({
	id: z.string(),
	object: z.string(),
	title: z.string(),
	url: z.string().optional(),
	lastEditedTime: z.string().optional(),
	archived: z.boolean().optional(),
});

export type NotionSearchResultView = z.infer<typeof notionSearchResultItemSchema>;

export const notionSearchOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	query: z.string().optional(),
	type: z.enum(["page", "database"]).optional(),
	results: z.array(notionSearchResultItemSchema),
	totalResults: z.number(),
	hasMore: z.boolean(),
	next_cursor: z.string().nullable(),
	archivedCount: z.number(),
	limit: z.number(),
});

export type NotionSearchOutput = z.infer<typeof notionSearchOutputSchema>;

export function extractResultTitle(result: NotionSearchResultItem): string {
	const joinRuns = (runs?: unknown): string => {
		if (Array.isArray(runs)) {
			return runs
				.map((r) => {
					if (r && typeof r === "object") {
						if ("plain_text" in r) return String((r as any).plain_text ?? "");
						if (
							"text" in r &&
							(r as any).text &&
							typeof (r as any).text === "object" &&
							"content" in (r as any).text
						) {
							return String((r as any).text.content ?? "");
						}
					}
					return "";
				})
				.join("")
				.trim();
		}
		if (typeof runs === "string") {
			return runs.trim();
		}
		return "";
	};

	// Database / data_source: top-level title rich text array (or name fallback)
	if (result.object === "database" || result.object === "data_source" || result.title !== undefined) {
		const dbTitle = joinRuns(result.title) || joinRuns(result.name);
		if (dbTitle) return dbTitle;
	}

	// Page: the property whose type is "title"
	const props = (result.properties ?? {}) as Record<string, any>;
	for (const prop of Object.values(props)) {
		if (prop && typeof prop === "object" && prop.type === "title") {
			const pageTitle = joinRuns(prop.title);
			if (pageTitle) return pageTitle;
		}
	}

	return "Untitled";
}

function renderResult(result: NotionSearchResultView, index: number): string {
	const kind = result.object === "database" ? "database" : "page";
	const edited = result.lastEditedTime ? result.lastEditedTime.slice(0, 10) : "?";
	const lines = [`${index + 1}. ${result.title} — ${kind}, edited ${edited}`, `   id: ${result.id}`];
	if (result.url) lines.push(`   ${result.url}`);
	return lines.join("\n");
}

export function formatNotionSearchMcp(result: NotionSearchOutput): string {
	const domain = result.domain;
	const other = DOMAINS.find((d) => d !== domain);
	const scope = result.query ? `titles matching '${result.query}'` : "most recently edited";
	const typeNote = result.type ? ` (${result.type}s only)` : "";

	if (result.results.length === 0) {
		return [
			`No results in the '${domain}' workspace for ${scope}${typeNote}.`,
			"This does NOT mean the page does not exist. Three things it can mean:",
			`1. The words do not match the TITLE. Notion search never looks inside a page — try what the page is actually called.`,
			`2. The page lives in the other workspace — retry with domain='${other}'.`,
			`3. The page exists but has not been shared with the ahKMS Notion integration (provider '${DOMAIN_PROVIDER[domain]}'), which is the only thing this token can see. A human has to share it from the Notion UI.`,
			"If none of those apply, ask for the page URL rather than reporting the page as missing.",
		].join("\n");
	}

	const lines = [
		`Notion search: ${scope}${typeNote} in the '${domain}' workspace — ${result.results.length} result(s).`,
		...result.results.map(renderResult),
	];
	if (result.hasMore) {
		lines.push(
			result.next_cursor
				? `… more matches; pass cursor '${result.next_cursor}' to fetch the next page rather than treating this list as complete.`
				: `… more matches; pass cursor to fetch the next page or narrow the query rather than treating this list as complete.`,
		);
	}
	if (result.archivedCount > 0) {
		lines.push(`(${result.archivedCount} archived object(s) matched and were not listed.)`);
	}
	lines.push(
		`Pass an id straight into notion_page_get({ domain: '${domain}', page_id }) to read one.`,
	);
	if (!result.query) {
		lines.push("Titles only: pass `query` to search by name, and note it never matches text inside a page.");
	}

	return lines.join("\n");
}

export function createNotionSearchAction(
	port: NotionPort,
): ActionDefinition<typeof notionSearchInputSchema, NotionSearchOutput> {
	return defineAction({
		id: "notion_search",
		name: "notion_search",
		description:
			"Find a page or database by TITLE in either Notion workspace — the discovery half, since " +
			"notion_page_get and notion_page_update both need an id. `domain` ('work' or 'angus') is " +
			"REQUIRED, no default. Titles only: Notion's search does not index block text. Full notes: " +
			"docs/guides/tools/notion_search.md",
		domain: "integrations",
		schema: notionSearchInputSchema,
		outputSchema: notionSearchOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionSearchMcp(result);
		},
		async run(input: NotionSearchInput, _context: ActionContext): Promise<NotionSearchOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to search Notion — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}

			await port.resolveToken(input.domain);

			const limit = input.limit ?? DEFAULT_LIMIT;
			const query = input.query?.trim();

			const { results, has_more, next_cursor } = await port.search({
				workspace: input.domain,
				query,
				objectType: input.type,
				pageSize: Math.min(MAX_LIMIT, limit + 10),
				...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
			});

			const live = results.filter((r) => !r.archived);
			const archivedCount = results.length - live.length;
			const shown = live.slice(0, limit);

			const hasMoreMatches = has_more || live.length > shown.length;

			const normalizedType = input.type === "data_source" ? "database" : input.type;

			return {
				domain: input.domain,
				query,
				type: normalizedType,
				results: shown.map((r) => ({
					id: r.id,
					object: r.object === "database" || r.object === "data_source" ? "database" : "page",
					title: extractResultTitle(r),
					url: r.url,
					lastEditedTime: r.last_edited_time,
					archived: r.archived,
				})),
				totalResults: shown.length,
				hasMore: hasMoreMatches,
				next_cursor: next_cursor ?? null,
				archivedCount,
				limit,
			};
		},
	});
}
