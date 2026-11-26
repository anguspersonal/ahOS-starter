import { z } from "zod";
import { domainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import type { DocsPort, GetDocumentParams } from "../../ports/docs.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	extractStructuralOutline,
	flattenDocumentTabs,
	type TabOutline,
} from "./outline.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const docsGetInput = {
	document_id: z.string().min(1).describe("The Google Doc ID to read."),
	domain: domainInput,
	account: googleAccountInput,
	tab_id: z
		.string()
		.optional()
		.describe(
			"Optional single tab ID to read. If omitted, returns an outline for all tabs (or the main document body if no tabs exist).",
		),
	field_mask: z
		.string()
		.optional()
		.describe(
			"Optional Google Docs API field mask (e.g. 'title,revisionId,body.content'). Limits the payload for large docs.",
		),
	include_suggestions: z
		.boolean()
		.optional()
		.describe(
			"Optional. If true, suggestions are included inline in the structure (suggestionsViewMode = 'SUGGESTIONS_INLINE').",
		),
	max_chars: z
		.number()
		.int()
		.min(100)
		.max(200_000)
		.optional()
		.describe(
			"Truncate returned outline text to this many characters (default 50,000).",
		),
};

export const docsGetInputSchema = z.object(docsGetInput);
export const docsGetSchema = docsGetInputSchema;
export type DocsGetInput = z.infer<typeof docsGetInputSchema>;

export interface DocsGetOutput {
	documentId: string;
	title: string;
	revisionId: string | undefined;
	selectedTabId?: string;
	allTabs: Array<{ tabId: string; title: string; depth: number }>;
	selectedTabs: TabOutline[];
	maxChars?: number;
}

export function formatDocsGetMcp(out: DocsGetOutput): string {
	const lines: string[] = [
		`# Document: ${out.title}`,
		`Document ID: ${out.documentId}`,
		`Revision ID: ${out.revisionId ?? "(unknown)"}`,
		`Note: Provide required_revision_id='${out.revisionId ?? ""}' when calling docs_batch_update to prevent concurrency conflicts.`,
		"",
		"## Tabs",
	];

	for (const t of out.allTabs) {
		const prefix = "  ".repeat(t.depth);
		const currentMarker =
			out.selectedTabId && t.tabId === out.selectedTabId ? " [SELECTED]" : "";
		lines.push(
			`${prefix}- ${t.title} (tabId: '${t.tabId}')${currentMarker}`,
		);
	}

	lines.push("");
	lines.push("## Structural Outline");
	lines.push(
		"(Indexes are UTF-16 code unit offsets [startIndex..endIndex] for targeted batchUpdate operations.)",
	);
	lines.push("");

	for (const tab of out.selectedTabs) {
		lines.push(`### Tab: ${tab.title} (tabId: '${tab.tabId}')`);
		const outline = tab.elements;

		if (outline.length === 0) {
			lines.push("  (no content elements found)");
		} else {
			for (const el of outline) {
				if (el.type === "heading") {
					lines.push(
						`  [${el.startIndex}..${el.endIndex}] ${el.level}: "${el.text}"`,
					);
				} else if (el.type === "paragraph") {
					lines.push(
						`  [${el.startIndex}..${el.endIndex}] PARAGRAPH: "${el.textPreview}"`,
					);
				} else if (el.type === "table") {
					lines.push(
						`  [${el.startIndex}..${el.endIndex}] TABLE (${el.rows} rows x ${el.columns} cols)`,
					);
				}
			}
		}
		lines.push("");
	}

	const fullText = lines.join("\n");
	const limit = out.maxChars ?? 50_000;
	const truncated = fullText.length > limit;
	const finalText = truncated ? fullText.slice(0, limit) : fullText;

	return `${finalText}${
		truncated
			? `\n\n… [truncated at ${limit} chars of ${fullText.length}]`
			: ""
	}`;
}

export function createDocsGetAction(
	port: DocsPort,
): ActionDefinition<typeof docsGetInputSchema, DocsGetOutput> {
	return defineAction({
		id: "docs_get",
		domain: "integrations",
		description:
			"Read a Google Doc's structural outline and tabs via the Google Docs API. Returns revisionId (required for concurrency lock on edits) and element start/end indexes. Full notes: docs/guides/tools/docs_get.md",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: docsGetInputSchema,
		formatMcp: formatDocsGetMcp,
		async run(args): Promise<DocsGetOutput> {
			const domain = reconcileDomain(args.domain, args.account, "account");
			if (!domain) {
				throw new Error(MISSING_DOMAIN_ERROR);
			}

			const params: GetDocumentParams = {
				domain,
				documentId: args.document_id,
				includeTabsContent: true,
			};
			if (args.include_suggestions) {
				params.suggestionsViewMode = "SUGGESTIONS_INLINE";
			}
			if (args.field_mask) {
				params.fields = args.field_mask;
			}

			const doc = await port.getDocument(params);
			const allTabs = flattenDocumentTabs(doc);

			if (args.tab_id) {
				const found = allTabs.find((t) => t.tabId === args.tab_id);
				if (!found) {
					const available = allTabs
						.map((t) => `'${t.tabId || "(root)"}' (${t.title})`)
						.join(", ");
					throw new Error(
						`Tab '${args.tab_id}' not found in document '${doc.title ?? args.document_id}'. Available tabs: ${available}.`,
					);
				}
			}

			const selectedTabs = args.tab_id
				? allTabs.filter((t) => t.tabId === args.tab_id)
				: allTabs;

			return {
				documentId: doc.documentId ?? args.document_id,
				title: doc.title ?? "(untitled)",
				revisionId: doc.revisionId ?? undefined,
				selectedTabId: args.tab_id,
				allTabs: allTabs.map((t) => ({
					tabId: t.tabId,
					title: t.title,
					depth: t.depth,
				})),
				selectedTabs: selectedTabs.map((t) => ({
					tabId: t.tabId,
					title: t.title,
					depth: t.depth,
					elements: extractStructuralOutline(t.content),
				})),
				maxChars: args.max_chars,
			};
		},
	});
}
