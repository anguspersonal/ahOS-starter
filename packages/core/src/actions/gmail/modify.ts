import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	LABEL_INBOX,
	LABEL_UNREAD,
	type GmailAccount,
	type GmailPort,
} from "../../ports/gmail.js";
import { defineAction } from "../defineAction.js";

export const gmailModifyInput = {
	message_id: z
		.string()
		.optional()
		.describe(
			"Message id to modify. Pass message_id / message_ids or thread_id / thread_ids (do not mix message and thread targets).",
		),
	message_ids: z
		.array(z.string().min(1))
		.min(1)
		.max(50)
		.optional()
		.describe("Batch message ids to modify (1..50)."),
	thread_id: z
		.string()
		.optional()
		.describe("Thread id to modify \u2014 applies the change to every message in it."),
	thread_ids: z
		.array(z.string().min(1))
		.min(1)
		.max(50)
		.optional()
		.describe(
			"Batch thread ids to modify (1..50) \u2014 applies the change to every message in each thread.",
		),
	add_labels: z
		.array(z.string())
		.optional()
		.describe(
			"Label IDS to add (not names \u2014 get ids from gmail_labels). Create a missing label with gmail_labels action='ensure' first.",
		),
	remove_labels: z.array(z.string()).optional().describe("Label ids to remove."),
	mark_read: z
		.boolean()
		.optional()
		.describe("true marks read (removes UNREAD); false marks unread (adds UNREAD)."),
	archive: z
		.boolean()
		.optional()
		.describe(
			"true archives (removes INBOX); false moves back to the inbox (adds INBOX). Archiving never deletes \u2014 there is no delete tool.",
		),
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		),
	domain: optionalDomainInput,
};

export const gmailModifyInputSchema = z.object(gmailModifyInput);
export const gmailModifySchema = gmailModifyInputSchema;

export type GmailModifyInput = z.infer<typeof gmailModifyInputSchema>;

export interface GmailModifyReceipt {
	account: GmailAccount;
	kind: "message" | "thread";
	ids: string[];
	modified_count: number;
	failed_count: number;
	added_label_ids: string[];
	removed_label_ids: string[];
}

export type GmailModifyOutput =
	| {
			batch: false;
			domain: Domain;
			account: GmailAccount;
			kind: "message" | "thread";
			id: string;
			added: string[];
			removed: string[];
			labelIds: string[];
			receipt: GmailModifyReceipt;
	  }
	| {
			batch: true;
			domain: Domain;
			account: GmailAccount;
			kind: "message" | "thread";
			total: number;
			added: string[];
			removed: string[];
			modifiedIds: string[];
			failures: { id: string; error: string }[];
			receipt: GmailModifyReceipt;
	  };

export function formatGmailModifyMcp(out: GmailModifyOutput): string {
	if (!out.batch) {
		return [
			`Modified ${out.kind} ${out.id} in the '${out.account}' mailbox.`,
			out.added.length ? `Added: ${out.added.join(", ")}` : null,
			out.removed.length ? `Removed: ${out.removed.join(", ")}` : null,
			`Labels now: ${out.labelIds.join(", ") || "(none)"}`,
		]
			.filter((l): l is string => l !== null)
			.join("\n");
	}
	return [
		`Modified ${out.modifiedIds.length}/${out.total} ${out.kind}(s) in the '${out.account}' mailbox${out.modifiedIds.length ? `: ${out.modifiedIds.join(", ")}` : "."}`,
		out.added.length ? `Added: ${out.added.join(", ")}` : null,
		out.removed.length ? `Removed: ${out.removed.join(", ")}` : null,
		out.failures.length
			? `Failed (${out.failures.length}): ${out.failures.map((f) => `${f.id} (${f.error})`).join("; ")}`
			: null,
	]
		.filter((l): l is string => l !== null)
		.join("\n");
}

export function createGmailModifyAction(port: GmailPort) {
	return defineAction<typeof gmailModifyInputSchema, GmailModifyOutput>({
		id: "gmail_modify",
		domain: "integrations",
		description:
			"Add or remove labels on a Gmail message or thread, mark it read/unread, and archive it or return it to the inbox. Cannot delete: there is no delete tool. Sending is a separate two-step path, gmail_draft then gmail_send_draft.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: gmailModifyInputSchema,
		formatMcp: formatGmailModifyMcp,
		async run(args: GmailModifyInput) {
			const hasMessageArg = Boolean(args.message_id || args.message_ids !== undefined);
			const hasThreadArg = Boolean(args.thread_id || args.thread_ids !== undefined);
			if (hasMessageArg && hasThreadArg) {
				throw new Error(
					"Cannot mix message targets (message_id / message_ids) and thread targets (thread_id / thread_ids) in the same call.",
				);
			}

			const rawIds = [
				...(args.message_id ? [args.message_id] : []),
				...(args.message_ids ?? []),
				...(args.thread_id ? [args.thread_id] : []),
				...(args.thread_ids ?? []),
			].filter((id) => id.trim().length > 0);

			if (rawIds.length === 0) {
				throw new Error(
					"Pass at least one target via message_id, message_ids, thread_id, or thread_ids.",
				);
			}
			if (
				(args.message_ids?.length ?? 0) > 50 ||
				(args.thread_ids?.length ?? 0) > 50 ||
				rawIds.length > 50
			) {
				throw new Error("Batch gmail_modify supports at most 50 targets per call.");
			}

			const kind = hasThreadArg ? ("thread" as const) : ("message" as const);
			const uniqueIds = [...new Set(rawIds)];
			const isBatch = Boolean(args.message_ids !== undefined || args.thread_ids !== undefined);
			const domain: Domain = reconcileDomain(args.domain, args.account, "account") ?? "angus";
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;

			const add = new Set<string>(args.add_labels ?? []);
			const remove = new Set<string>(args.remove_labels ?? []);
			if (args.mark_read === true) remove.add(LABEL_UNREAD);
			if (args.mark_read === false) add.add(LABEL_UNREAD);
			if (args.archive === true) remove.add(LABEL_INBOX);
			if (args.archive === false) add.add(LABEL_INBOX);

			if (add.size === 0 && remove.size === 0) {
				throw new Error(
					"Nothing to do \u2014 pass at least one of add_labels, remove_labels, mark_read or archive.",
				);
			}

			const added = [...add];
			const removed = [...remove];

			if (!isBatch) {
				const res = await port.modifyLabels({
					domain,
					target: { kind, id: uniqueIds[0] },
					addLabelIds: added,
					removeLabelIds: removed,
				});
				return {
					batch: false,
					domain,
					account,
					kind,
					id: res.id,
					added,
					removed,
					labelIds: res.labelIds,
					receipt: {
						account,
						kind,
						ids: [res.id],
						modified_count: 1,
						failed_count: 0,
						added_label_ids: added,
						removed_label_ids: removed,
					},
				};
			}

			const modifiedIds: string[] = [];
			const failures: { id: string; error: string }[] = [];
			for (const id of uniqueIds) {
				try {
					const res = await port.modifyLabels({
						domain,
						target: { kind, id },
						addLabelIds: added,
						removeLabelIds: removed,
					});
					modifiedIds.push(res.id || id);
				} catch (err) {
					failures.push({
						id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			return {
				batch: true,
				domain,
				account,
				kind,
				total: uniqueIds.length,
				added,
				removed,
				modifiedIds,
				failures,
				receipt: {
					account,
					kind,
					ids: modifiedIds,
					modified_count: modifiedIds.length,
					failed_count: failures.length,
					added_label_ids: added,
					removed_label_ids: removed,
				},
			};
		},
	});
}
