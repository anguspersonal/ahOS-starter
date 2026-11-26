import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	buildRawMessage,
	type GmailAccount,
	type GmailPort,
	type ParsedMessage,
} from "../../ports/gmail.js";
import { defineAction } from "../defineAction.js";

export const gmailDraftInput = {
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'). Which Google account to send AS: personal | work.",
		),
	domain: optionalDomainInput,
	to: z
		.array(z.string().min(3))
		.optional()
		.describe(
			"Recipients. Optional ONLY when reply_to_message_id is given, in which case it defaults to that message's sender and the reply goes to them alone. There is no reply-all: name every recipient you want.",
		),
	cc: z.array(z.string().min(3)).optional().describe("Cc recipients."),
	bcc: z.array(z.string().min(3)).optional().describe("Bcc recipients."),
	subject: z
		.string()
		.optional()
		.describe(
			"Subject. Optional only when replying, where it defaults to the original subject with 'Re: ' prefixed.",
		),
	body: z.string().min(1).describe("Plain-text body. Sent as UTF-8; no HTML."),
	reply_to_message_id: z
		.string()
		.optional()
		.describe(
			"Message id being replied to. Sets In-Reply-To, References and the Gmail threadId, so the reply threads properly in every mail client rather than only in Gmail.",
		),
	draft_id: z
		.string()
		.optional()
		.describe("Update this existing draft instead of creating a new one."),
};

export const gmailDraftInputSchema = z.object(gmailDraftInput);
export const gmailDraftSchema = gmailDraftInputSchema;

export type GmailDraftInput = z.infer<typeof gmailDraftInputSchema>;

export interface GmailDraftReceipt {
	account: GmailAccount;
	draft_id: string;
	message_id: string;
	thread_id?: string;
	updated: boolean;
	recipient_count: number;
}

export interface GmailDraftOutput {
	domain: Domain;
	account: GmailAccount;
	updated: boolean;
	draftId: string;
	messageId: string;
	threadId?: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	stored: ParsedMessage;
	notes: string[];
	receipt: GmailDraftReceipt;
}

export function formatGmailDraftMcp(out: GmailDraftOutput): string {
	return [
		`${out.updated ? "Updated" : "Created"} draft ${out.draftId} in the '${out.account}' mailbox. Nothing has been sent.`,
		"",
		`To: ${out.stored.to || out.to.join(", ")}`,
		out.cc?.length ? `Cc: ${out.cc.join(", ")}` : null,
		out.bcc?.length ? `Bcc: ${out.bcc.join(", ")}` : null,
		`Subject: ${out.stored.subject || out.subject}`,
		out.threadId ? `Thread: ${out.threadId} (reply)` : "Thread: new conversation",
		"",
		out.stored.body || out.body,
		"",
		...out.notes,
		out.notes.length ? "" : null,
		`Send it with gmail_send_draft({ account: '${out.account}', draft_id: '${out.draftId}' }), or open it in Gmail and send it by hand.`,
	]
		.filter((l): l is string => l !== null)
		.join("\n");
}

export function createGmailDraftAction(port: GmailPort) {
	return defineAction<typeof gmailDraftInputSchema, GmailDraftOutput>({
		id: "gmail_draft",
		domain: "integrations",
		description:
			"Compose a draft in a Gmail mailbox, or update an existing one. Does NOT send: it leaves a real draft that can be read, edited in Gmail, sent by hand, or sent with gmail_send_draft. Pass `reply_to_message_id` to reply in-thread. Full notes: docs/guides/tools/gmail_draft.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: gmailDraftInputSchema,
		formatMcp: formatGmailDraftMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account");
			if (!domain) {
				throw new Error(
					"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
				);
			}
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;

			let threadId: string | undefined;
			let inReplyTo: string | undefined;
			let references: string | undefined;
			let to = input.to;
			let subject = input.subject;
			const notes: string[] = [];

			if (input.reply_to_message_id) {
				const ctx = await port.getReplyContext({
					domain,
					messageId: input.reply_to_message_id,
				});
				threadId = ctx.threadId;
				inReplyTo = ctx.messageIdHeader || undefined;
				references = ctx.references || undefined;
				if (!to?.length) {
					to = [ctx.from];
					notes.push(`Recipient defaulted to the original sender: ${ctx.from}`);
				}
				if (!subject) subject = ctx.replySubject;
				if (!inReplyTo) {
					notes.push(
						"The original message carries no Message-ID header, so In-Reply-To could not be set. This will thread in Gmail but may appear as a new conversation elsewhere.",
					);
				}
			}

			if (!to?.length) {
				throw new Error(
					"`to` is required unless reply_to_message_id is given (where it defaults to the original sender).",
				);
			}
			if (!subject) {
				throw new Error(
					"`subject` is required unless reply_to_message_id is given (where it defaults to 'Re: ' plus the original subject).",
				);
			}

			const raw = buildRawMessage({
				to,
				cc: input.cc,
				bcc: input.bcc,
				subject,
				body: input.body,
				inReplyTo,
				references,
			});

			const summary = input.draft_id
				? await port.updateDraft({ domain, draftId: input.draft_id, raw, threadId })
				: await port.createDraft({ domain, raw, threadId });

			const stored = await port.getDraft({ domain, draftId: summary.draftId });

			return {
				domain,
				account,
				updated: Boolean(input.draft_id),
				draftId: summary.draftId,
				messageId: summary.messageId,
				threadId,
				to,
				cc: input.cc,
				bcc: input.bcc,
				subject,
				body: input.body,
				stored,
				notes,
				receipt: {
					account,
					draft_id: summary.draftId,
					message_id: summary.messageId,
					...(threadId ? { thread_id: threadId } : {}),
					updated: Boolean(input.draft_id),
					recipient_count: to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
				},
			};
		},
	});
}
