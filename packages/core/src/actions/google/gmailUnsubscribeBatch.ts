/**
 * @ahkms/core/actions/google - gmail_unsubscribe_batch (ADR-118, ADR-104, #2134)
 *
 * Accepts a batch of `unsubscribe_candidate` Gmail thread descriptors, parks the
 * batch for a single owner approval (`needsApproval: () => true`), and upon approval
 * applies the `ahOS/Unsubscribe` label and archives (removes `INBOX` from) each thread.
 *
 * Isomorphic: zero Node imports.
 */

import { z } from "zod";
import { EMAIL_ROUTE_LABELS } from "../../domain/emailRouting.js";
import type { GmailAccountDomain } from "../../ports/gmailReconcile.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GmailPriorityTriageSweepTarget } from "./gmailPriorityTriage.js";

export const GMAIL_UNSUBSCRIBE_LABEL = EMAIL_ROUTE_LABELS.unsubscribe_candidate;

export const gmailUnsubscribeThreadItemSchema = z.object({
	thread_id: z
		.string()
		.min(1)
		.describe("Gmail thread ID to label ahOS/Unsubscribe and archive."),
	account: z
		.enum(["personal", "work"])
		.optional()
		.default("personal")
		.describe("Gmail account domain ('personal' or 'work'). Defaults to 'personal'."),
	domain: z
		.enum(["work", "angus", "personal"])
		.optional()
		.describe("Optional domain alias ('work' or 'angus'/'personal') when account is omitted."),
	message_id: z
		.string()
		.min(1)
		.optional()
		.describe("Optional Gmail message ID on the thread (defaults to thread_id)."),
	sender: z
		.string()
		.optional()
		.describe("Optional sender display name or address for audit and approval context."),
	subject: z
		.string()
		.optional()
		.describe("Optional subject line for audit and approval context."),
	list_unsubscribe: z
		.string()
		.nullable()
		.optional()
		.describe("Optional List-Unsubscribe header value if available."),
	decision_id: z
		.string()
		.optional()
		.describe("Optional system_decisions row ID associated with the triage decision."),
});

export type GmailUnsubscribeThreadItem = z.infer<
	typeof gmailUnsubscribeThreadItemSchema
>;

export const gmailUnsubscribeBatchInput = {
	threads: z
		.array(gmailUnsubscribeThreadItemSchema)
		.min(1)
		.max(100)
		.describe(
			"Batch of unsubscribe_candidate Gmail thread descriptors to label ahOS/Unsubscribe and archive after owner approval.",
		),
	dry_run: z
		.boolean()
		.optional()
		.default(false)
		.describe("When true, validates the batch without modifying Gmail."),
};

export const gmailUnsubscribeBatchInputSchema = z.object(
	gmailUnsubscribeBatchInput,
);

export const gmailUnsubscribeBatchSchema = gmailUnsubscribeBatchInputSchema;

export type GmailUnsubscribeBatchInput = z.infer<
	typeof gmailUnsubscribeBatchInputSchema
>;

export interface GmailUnsubscribeThreadResult {
	thread_id: string;
	message_id: string;
	account: GmailAccountDomain;
	labeled: boolean;
	archived: boolean;
	sender?: string;
	subject?: string;
	list_unsubscribe?: string | null;
	error?: string;
}

export interface GmailUnsubscribeBatchOutput {
	dry_run: boolean;
	label: string;
	requested_count: number;
	processed_count: number;
	labeled_count: number;
	archived_count: number;
	results: GmailUnsubscribeThreadResult[];
	errors: string[];
}

export interface GmailUnsubscribeBatchPort {
	/** Add and remove labels by name on a thread. */
	applyLabels?(
		target: GmailPriorityTriageSweepTarget,
		labels: { add: string[]; remove: string[] },
	): Promise<void>;
	/** Archive (remove `INBOX` from) a thread. */
	sweepThread?(
		target: GmailPriorityTriageSweepTarget,
		userId?: string,
	): Promise<void>;
	/** Optional hook to execute any header-based unsubscribe side-effect for a thread. */
	unsubscribeThread?(
		thread: GmailUnsubscribeThreadItem,
		userId?: string,
	): Promise<void>;
}

function resolveThreadAccount(item: {
	account?: "personal" | "work";
	domain?: "work" | "angus" | "personal";
}): GmailAccountDomain {
	if (item.domain === "work" || item.account === "work") {
		return "work";
	}
	return "personal";
}

export function createGmailUnsubscribeBatchAction(
	port: GmailUnsubscribeBatchPort,
): ActionDefinition<
	typeof gmailUnsubscribeBatchInputSchema,
	GmailUnsubscribeBatchOutput
> {
	return defineAction({
		id: "gmail_unsubscribe_batch",
		name: "Batch Unsubscribe and Archive Gmail Threads",
		description:
			"Label a batch of unsubscribe_candidate Gmail threads with ahOS/Unsubscribe and archive them out of the inbox after a single owner approval.",
		domain: "integrations",
		needsApproval: () => true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: gmailUnsubscribeBatchInputSchema,
		formatMcp: (out) =>
			out.dry_run
				? `Dry run: validated ${out.processed_count} thread(s) for ${out.label} + archive.`
				: `Unsubscribed and archived ${out.processed_count} of ${out.requested_count} thread(s) with label ${out.label}.`,
		run: async (input, ctx): Promise<GmailUnsubscribeBatchOutput> => {
			const dryRun = input.dry_run ?? false;
			const userId = ctx?.userId;
			const results: GmailUnsubscribeThreadResult[] = [];
			const errors: string[] = [];
			const seen = new Set<string>();
			let labeledCount = 0;
			let archivedCount = 0;
			let processedCount = 0;

			for (const item of input.threads) {
				const account = resolveThreadAccount(item);
				const threadId = item.thread_id.trim();
				const dedupKey = `${account}:${threadId}`;
				if (seen.has(dedupKey)) {
					continue;
				}
				seen.add(dedupKey);

				const messageId = item.message_id?.trim() || threadId;
				const target: GmailPriorityTriageSweepTarget = {
					account,
					thread_id: threadId,
					message_id: messageId,
				};

				let labeled = false;
				let archived = false;
				let itemError: string | undefined;

				if (!dryRun) {
					try {
						if (port.applyLabels) {
							await port.applyLabels(target, {
								add: [GMAIL_UNSUBSCRIBE_LABEL],
								remove: [],
							});
							labeled = true;
							labeledCount += 1;
						}
						if (port.sweepThread) {
							await port.sweepThread(target, userId);
							archived = true;
							archivedCount += 1;
						}
						if (port.unsubscribeThread) {
							await port.unsubscribeThread({ ...item, account }, userId);
						}
						processedCount += 1;
					} catch (err) {
						if (err instanceof Error && err.name === "AdapterUnavailableError") {
							throw err;
						}
						itemError = err instanceof Error ? err.message : String(err);
						errors.push(`${account}:${threadId}: ${itemError}`);
					}
				} else {
					processedCount += 1;
				}

				results.push({
					thread_id: threadId,
					message_id: messageId,
					account,
					labeled,
					archived,
					...(item.sender !== undefined ? { sender: item.sender } : {}),
					...(item.subject !== undefined ? { subject: item.subject } : {}),
					...(item.list_unsubscribe !== undefined
						? { list_unsubscribe: item.list_unsubscribe }
						: {}),
					...(itemError ? { error: itemError } : {}),
				});
			}

			return {
				dry_run: dryRun,
				label: GMAIL_UNSUBSCRIBE_LABEL,
				requested_count: input.threads.length,
				processed_count: processedCount,
				labeled_count: labeledCount,
				archived_count: archivedCount,
				results,
				errors,
			};
		},
	});
}
