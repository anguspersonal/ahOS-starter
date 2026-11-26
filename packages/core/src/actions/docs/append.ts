import { z } from "zod";
import { domainInput } from "../../domain/domainInput.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type DocsLockedWritePorts, runDocsLockedWrite } from "./lockedWrite.js";

const REQUIRED_REVISION_ID_ERROR =
	"required_revision_id is required for docs_append. Read the document first with docs_get and pass its revisionId.";

export const docsAppendInputSchema = z.object({
	document_id: z.string().min(1).describe("The Google Doc ID to append to."),
	domain: domainInput,
	required_revision_id: z
		.string()
		.min(1, REQUIRED_REVISION_ID_ERROR)
		.describe("Required. The revisionId from docs_get. The write is refused if the Doc changed since."),
	text: z
		.string()
		.min(1)
		.describe(
			"The text to append, exactly as given. No newline is added: start it with \\n to begin a new paragraph, or it joins the last one.",
		),
	tab_id: z.string().min(1).optional().describe("Optional. The tab to append to. Omit for the first tab."),
	suggest: z
		.boolean()
		.optional()
		.describe(
			"Optional. If true, proposes the text in suggestion mode (writeMode 'SUGGEST'). If Google refuses it, returns an error and never falls back to a direct edit.",
		),
});
export type DocsAppendInput = z.infer<typeof docsAppendInputSchema>;

export interface DocsAppendOutput {
	document_id: string;
	characters_appended: number;
	revision_before: string;
	revision_after: string | undefined;
	suggest: boolean;
}

export function formatDocsAppendMcp(out: DocsAppendOutput): string {
	return [
		`Appended ${out.characters_appended} character(s) to the end of document ${out.document_id}.`,
		`Revision before: ${out.revision_before}`,
		`Revision after:  ${out.revision_after ?? "(unknown)"}`,
		out.suggest ? "Mode: Suggestion (writeMode: 'SUGGEST')" : "Mode: Direct edit (writeMode: 'EDIT')",
	].join("\n");
}

export function createDocsAppendAction(
	ports: DocsLockedWritePorts,
): ActionDefinition<typeof docsAppendInputSchema, DocsAppendOutput> {
	return defineAction({
		id: "docs_append",
		domain: "integrations",
		description:
			"Append text to the end of a Google Doc (or one tab), under the revision lock (required_revision_id from docs_get). Appends exactly the text given; no newline is added. Full notes: docs/guides/tools/docs_append.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: docsAppendInputSchema,
		formatMcp: formatDocsAppendMcp,
		async run(args): Promise<DocsAppendOutput> {
			if (!args.required_revision_id.trim()) throw new Error(REQUIRED_REVISION_ID_ERROR);

			const endOfSegmentLocation = args.tab_id ? { tabId: args.tab_id } : {};
			const res = await runDocsLockedWrite(ports, {
				tool: "docs_append",
				domain: args.domain,
				documentId: args.document_id,
				requiredRevisionId: args.required_revision_id,
				requests: [{ insertText: { endOfSegmentLocation, text: args.text } }],
				suggest: args.suggest,
			});

			return {
				document_id: args.document_id,
				characters_appended: args.text.length,
				revision_before: res.revisionBefore,
				revision_after: res.revisionAfter,
				suggest: res.suggest,
			};
		},
	});
}
