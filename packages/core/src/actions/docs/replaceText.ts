import { z } from "zod";
import { domainInput } from "../../domain/domainInput.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type DocsLockedWritePorts, runDocsLockedWrite } from "./lockedWrite.js";

const REQUIRED_REVISION_ID_ERROR =
	"required_revision_id is required for docs_replace_text. Read the document first with docs_get and pass its revisionId.";

export const docsReplaceTextInputSchema = z.object({
	document_id: z.string().min(1).describe("The Google Doc ID to edit."),
	domain: domainInput,
	required_revision_id: z
		.string()
		.min(1, REQUIRED_REVISION_ID_ERROR)
		.describe("Required. The revisionId from docs_get. The write is refused if the Doc changed since."),
	find: z.string().min(1).describe("The text to find. Every occurrence is replaced."),
	replace: z.string().describe("The replacement text. An empty string deletes each match."),
	match_case: z.boolean().optional().describe("Match case exactly. Default true."),
	tab_ids: z
		.array(z.string().min(1))
		.min(1)
		.optional()
		.describe("Optional. Limit the replacement to these tab IDs. Omit for every tab."),
	suggest: z
		.boolean()
		.optional()
		.describe(
			"Optional. If true, proposes the change in suggestion mode (writeMode 'SUGGEST'). If Google refuses it, returns an error and never falls back to a direct edit.",
		),
});
export type DocsReplaceTextInput = z.infer<typeof docsReplaceTextInputSchema>;

export interface DocsReplaceTextOutput {
	document_id: string;
	find: string;
	occurrences_changed: number;
	revision_before: string;
	revision_after: string | undefined;
	suggest: boolean;
}

export function formatDocsReplaceTextMcp(out: DocsReplaceTextOutput): string {
	const head =
		out.occurrences_changed === 0
			? `No match: "${out.find}" was not found in document ${out.document_id}. Nothing was replaced.`
			: `Replaced ${out.occurrences_changed} occurrence(s) of "${out.find}" in document ${out.document_id}.`;
	return [
		head,
		`Revision before: ${out.revision_before}`,
		`Revision after:  ${out.revision_after ?? "(unknown)"}`,
		out.suggest ? "Mode: Suggestion (writeMode: 'SUGGEST')" : "Mode: Direct edit (writeMode: 'EDIT')",
	].join("\n");
}

export function createDocsReplaceTextAction(
	ports: DocsLockedWritePorts,
): ActionDefinition<typeof docsReplaceTextInputSchema, DocsReplaceTextOutput> {
	return defineAction({
		id: "docs_replace_text",
		domain: "integrations",
		description:
			"Replace every occurrence of a string in a Google Doc, under the revision lock (required_revision_id from docs_get). Returns how many occurrences changed; zero is reported as no match. Full notes: docs/guides/tools/docs_replace_text.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: docsReplaceTextInputSchema,
		formatMcp: formatDocsReplaceTextMcp,
		async run(args): Promise<DocsReplaceTextOutput> {
			if (!args.required_revision_id.trim()) throw new Error(REQUIRED_REVISION_ID_ERROR);

			const replaceAllText: Record<string, unknown> = {
				containsText: { text: args.find, matchCase: args.match_case ?? true },
				replaceText: args.replace,
			};
			if (args.tab_ids && args.tab_ids.length > 0) {
				replaceAllText.tabsCriteria = { tabIds: args.tab_ids };
			}

			const res = await runDocsLockedWrite(ports, {
				tool: "docs_replace_text",
				domain: args.domain,
				documentId: args.document_id,
				requiredRevisionId: args.required_revision_id,
				requests: [{ replaceAllText }],
				suggest: args.suggest,
			});

			const reply = res.replies[0]?.replaceAllText as { occurrencesChanged?: number } | undefined;
			return {
				document_id: args.document_id,
				find: args.find,
				occurrences_changed: reply?.occurrencesChanged ?? 0,
				revision_before: res.revisionBefore,
				revision_after: res.revisionAfter,
				suggest: res.suggest,
			};
		},
	});
}
