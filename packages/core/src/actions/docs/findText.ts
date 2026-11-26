import { z } from "zod";
import { domainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import type { DocsPort } from "../../ports/docs.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { findTextInDoc, type TextMatch } from "./outline.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const docsFindTextInput = {
	document_id: z.string().min(1).describe("The Google Doc ID to search in."),
	domain: domainInput,
	account: googleAccountInput,
	text: z.string().min(1).describe("The text string to search for."),
	match_case: z
		.boolean()
		.optional()
		.describe("Whether the search is case-sensitive (default true)."),
	tab_id: z
		.string()
		.optional()
		.describe(
			"Optional tab ID to restrict search to. If omitted, searches all tabs.",
		),
};

export const docsFindTextInputSchema = z.object(docsFindTextInput);
export const docsFindTextSchema = docsFindTextInputSchema;
export type DocsFindTextInput = z.infer<typeof docsFindTextInputSchema>;

export interface DocsFindTextOutput {
	documentId: string;
	title: string;
	revisionId: string | undefined;
	query: string;
	tabId?: string;
	matches: TextMatch[];
}

export function formatDocsFindTextMcp(out: DocsFindTextOutput): string {
	if (out.matches.length === 0) {
		return `No occurrences of "${out.query}" found in document "${out.title}"${
			out.tabId ? ` (in tab '${out.tabId}')` : ""
		}.`;
	}

	const lines: string[] = [
		`Found ${out.matches.length} occurrence(s) of "${out.query}" in document "${out.title}":`,
		`Current revisionId: ${out.revisionId ?? "(unknown)"}`,
		"",
	];

	for (let i = 0; i < out.matches.length; i++) {
		const m = out.matches[i];
		lines.push(`Occurrence [${i + 1}]:`);
		lines.push(`  Tab:          ${m.tabTitle} (tabId: '${m.tabId}')`);
		lines.push(`  Range:        startIndex: ${m.startIndex}, endIndex: ${m.endIndex}`);
		lines.push(`  Matched text: "${m.matchedText}"`);
		lines.push(`  Context:      "…${m.surroundingText}…"`);
		lines.push("");
	}

	lines.push(
		"Use these startIndex and endIndex values directly in docs_batch_update operations (e.g. deleteContentRange, insertText, updateTextStyle).",
	);

	return lines.join("\n");
}

export function createDocsFindTextAction(
	port: DocsPort,
): ActionDefinition<typeof docsFindTextInputSchema, DocsFindTextOutput> {
	return defineAction({
		id: "docs_find_text",
		domain: "integrations",
		description:
			"Find the exact UTF-16 start and end indexes of text matches across tabs and paragraphs in a Google Doc. Full notes: docs/guides/tools/docs_find_text.md",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: docsFindTextInputSchema,
		formatMcp: formatDocsFindTextMcp,
		async run(args): Promise<DocsFindTextOutput> {
			const domain = reconcileDomain(args.domain, args.account, "account");
			if (!domain) {
				throw new Error(MISSING_DOMAIN_ERROR);
			}

			const doc = await port.getDocument({
				domain,
				documentId: args.document_id,
				includeTabsContent: true,
			});

			const matches = findTextInDoc(doc, args.text, {
				matchCase: args.match_case,
				tabIdFilter: args.tab_id,
			});

			return {
				documentId: doc.documentId ?? args.document_id,
				title: doc.title ?? args.document_id,
				revisionId: doc.revisionId ?? undefined,
				query: args.text,
				tabId: args.tab_id,
				matches,
			};
		},
	});
}
