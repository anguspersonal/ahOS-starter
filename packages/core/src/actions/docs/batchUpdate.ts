import { z } from "zod";
import { domainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import type { DocsBatchUpdateReply, DocsPort } from "../../ports/docs.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type DocsLockedWritePorts, runDocsLockedWrite } from "./lockedWrite.js";

export { toDocsRevisionMismatchError } from "./lockedWrite.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send \u2014 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const REQUIRED_REVISION_ID_ERROR =
	"required_revision_id is required for docs_batch_update. Read the document first with docs_get to obtain its current revisionId, and pass it here to guarantee your edits do not overwrite concurrent changes.";

const EMPTY_REQUESTS_ERROR =
	"Nothing to do \u2014 pass a non-empty array of batchUpdate requests.";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const docsBatchUpdateInput = {
	document_id: z.string().min(1).describe("The Google Doc ID to update."),
	domain: domainInput,
	account: googleAccountInput,
	required_revision_id: z
		.string()
		.min(1, REQUIRED_REVISION_ID_ERROR)
		.describe(
			"Required. The revision ID obtained from docs_get. Prevents concurrent overwrite conflicts by asserting the doc has not changed since you read it.",
		),
	requests: z
		.array(z.record(z.string(), z.unknown()))
		.min(1, EMPTY_REQUESTS_ERROR)
		.describe(
			"List of Google Docs API batchUpdate request objects (e.g. insertText, deleteContentRange, replaceAllText, insertTable, updateParagraphStyle, updateTextStyle, createParagraphBullets).",
		),
	suggest: z
		.boolean()
		.optional()
		.describe(
			"Optional. If true, submits edits in suggestion mode (writeControl.writeMode = 'SUGGEST'). If Google refuses it, returns an error and never falls back to direct edit.",
		),
};

export const docsBatchUpdateInputSchema = z.object(docsBatchUpdateInput);
export const docsBatchUpdateSchema = docsBatchUpdateInputSchema;
export type DocsBatchUpdateInput = z.infer<typeof docsBatchUpdateInputSchema>;

export interface DocsBatchUpdateOutput {
	documentId: string;
	requestCount: number;
	revisionBefore: string;
	revisionAfter: string | undefined;
	suggest: boolean;
	replies: DocsBatchUpdateReply[];
}

export type DocsBatchUpdatePorts = DocsLockedWritePorts;

function resolvePorts(
	portsOrDocs: DocsBatchUpdatePorts | DocsPort,
): DocsBatchUpdatePorts {
	if (Object.prototype.hasOwnProperty.call(portsOrDocs, "docs")) {
		return portsOrDocs as DocsBatchUpdatePorts;
	}
	return { docs: portsOrDocs as DocsPort };
}

export function formatDocsBatchUpdateMcp(out: DocsBatchUpdateOutput): string {
	const lines: string[] = [
		`Successfully applied ${out.requestCount} batchUpdate request(s) to document ${out.documentId}.`,
		`Revision before: ${out.revisionBefore}`,
		`Revision after:  ${out.revisionAfter ?? "(unknown)"}`,
		out.suggest
			? "Mode: Suggestion (writeMode: 'SUGGEST')"
			: "Mode: Direct edit (writeMode: 'EDIT')",
	];

	if (out.replies.length > 0) {
		lines.push("");
		lines.push("Replies summary:");
		for (let i = 0; i < out.replies.length; i++) {
			const r = out.replies[i]!;
			const replyKey = Object.keys(r)[0] ?? "reply";
			lines.push(`  [${i + 1}] ${replyKey}: ${JSON.stringify(r)}`);
		}
	}

	return lines.join("\n");
}

export function createDocsBatchUpdateAction(
	portsOrDocs: DocsBatchUpdatePorts | DocsPort,
): ActionDefinition<typeof docsBatchUpdateInputSchema, DocsBatchUpdateOutput> {
	const { docs, artifacts } = resolvePorts(portsOrDocs);

	return defineAction({
		id: "docs_batch_update",
		domain: "integrations",
		description:
			"Apply in-place structural updates to a Google Doc (insertText, deleteContentRange, replaceAllText, insertTable, etc.). Requires required_revision_id from docs_get. Full notes: docs/guides/tools/docs_batch_update.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: docsBatchUpdateInputSchema,
		formatMcp: formatDocsBatchUpdateMcp,
		async run(args): Promise<DocsBatchUpdateOutput> {
			if (!args.required_revision_id || !args.required_revision_id.trim()) {
				throw new Error(REQUIRED_REVISION_ID_ERROR);
			}
			if (!args.requests || args.requests.length === 0) {
				throw new Error(EMPTY_REQUESTS_ERROR);
			}

			const domain = reconcileDomain(args.domain, args.account, "account");
			if (!domain) {
				throw new Error(MISSING_DOMAIN_ERROR);
			}

			const res = await runDocsLockedWrite(
				{ docs, artifacts },
				{
					tool: "docs_batch_update",
					domain,
					documentId: args.document_id,
					requiredRevisionId: args.required_revision_id,
					requests: args.requests,
					suggest: args.suggest,
				},
			);

			return {
				documentId: args.document_id,
				requestCount: args.requests.length,
				revisionBefore: res.revisionBefore,
				revisionAfter: res.revisionAfter,
				suggest: res.suggest,
				replies: res.replies,
			};
		},
	});
}
