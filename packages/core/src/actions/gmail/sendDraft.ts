import { z } from "zod";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import type { CapturePort, CaptureResult } from "../../ports/artifacts.js";
import {
	parseAddressList,
	type GmailAccount,
	type GmailPort,
} from "../../ports/gmail.js";
import { executeAction } from "../adapters/direct.js";
import { createCaptureAction } from "../artifacts/capture.js";
import { defineAction } from "../defineAction.js";
import type { captureSchema } from "../domain/capture.js";
import type { ActionDefinition } from "../types.js";

export const EMAIL_SENT_CONTENT_SUBTYPE = "email_sent" as const;

export const GMAIL_SEND_DRAFT_DESCRIPTION =
	"Send an existing draft by id. Irreversible. Cannot compose; every send passes through a mailbox " +
	"draft first (use gmail_draft to make one), and the sent message is captured. Parks for the " +
	"owner's approval unless every recipient is one of the owner's own addresses. Full notes: " +
	"docs/guides/tools/gmail_send_draft.md";

export const gmailSendDraftInput = {
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'). Which Google account to send AS: personal | work.",
		),
	domain: optionalDomainInput,
	draft_id: z
		.string()
		.min(1)
		.describe("The draft to send, from gmail_draft or from Gmail's own draft list."),
};

export const gmailSendDraftInputSchema = z.object(gmailSendDraftInput);
export const gmailSendDraftSchema = gmailSendDraftInputSchema;

export type GmailSendDraftInput = z.infer<typeof gmailSendDraftInputSchema>;

export interface GmailSendDraftReceipt {
	account: GmailAccount;
	draft_id: string;
	message_id: string;
	thread_id: string;
	sent_count: number;
}

export interface GmailSendDraftOutput {
	domain: Domain;
	account: GmailAccount;
	draftId: string;
	to: string;
	subject: string;
	messageId: string;
	threadId: string;
	provenance: string;
	receipt: GmailSendDraftReceipt;
}

export interface GmailSendDraftDeps {
	gmail: GmailPort;
	capture: CapturePort | ActionDefinition<typeof captureSchema, CaptureResult>;
	ownerAddresses?: () => Promise<ReadonlySet<string>>;
}

export function formatGmailSendDraftMcp(out: GmailSendDraftOutput): string {
	return [
		`Sent draft ${out.draftId} from the '${out.account}' mailbox. This cannot be undone.`,
		`To: ${out.to}`,
		`Subject: ${out.subject || "(no subject)"}`,
		`Message ${out.messageId} in thread ${out.threadId}.`,
		out.provenance,
	].join("\n");
}

function requireSendDomain(input: { domain?: Domain; account?: GmailAccount }): Domain {
	const domain = reconcileDomain(input.domain, input.account, "account");
	if (!domain) {
		throw new Error(
			"`domain` is required to send \u2014 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
	}
	return domain;
}

export function createGmailSendDraftAction(deps: GmailSendDraftDeps) {
	const captureAction: ActionDefinition<typeof captureSchema, CaptureResult> =
		typeof (deps.capture as ActionDefinition<typeof captureSchema, CaptureResult>).id === "string"
			? (deps.capture as ActionDefinition<typeof captureSchema, CaptureResult>)
			: createCaptureAction(deps.capture as CapturePort);

	return defineAction<typeof gmailSendDraftInputSchema, GmailSendDraftOutput>({
		id: "gmail_send_draft",
		domain: "integrations",
		description: GMAIL_SEND_DRAFT_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: gmailSendDraftInputSchema,
		formatMcp: formatGmailSendDraftMcp,
		async needsApproval(input) {
			const domain = requireSendDomain(input);
			if (!input.draft_id) return true;
			if (!deps.ownerAddresses) return true;
			const [draft, owners] = await Promise.all([
				deps.gmail.getDraft({ domain, draftId: input.draft_id, format: "metadata" }),
				deps.ownerAddresses(),
			]);
			const all = [
				...parseAddressList(draft.to),
				...parseAddressList(draft.cc ?? ""),
				...parseAddressList(draft.bcc ?? ""),
			];
			if (all.length === 0) return true;
			return !all.every((r) => r.address !== null && owners.has(r.address.toLowerCase()));
		},
		async run(input, ctx) {
			const domain = requireSendDomain(input);
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;

			const draft = await deps.gmail.getDraft({ domain, draftId: input.draft_id });
			const sent = await deps.gmail.sendDraft({ domain, draftId: input.draft_id });

			let provenance: string;
			try {
				const tags = ["email", "sent", `account:${account}`];
				const subjectLower = (draft.subject || "").toLowerCase();
				if (
					subjectLower.includes("[auto-task]") ||
					subjectLower.includes("auto-task") ||
					subjectLower.includes("scheduled routine") ||
					Boolean(draft.body && draft.body.includes("Scheduled routine completed"))
				) {
					tags.push("robot_authored");
				}
				const captured = await executeAction(
					captureAction,
					{
						title: `Email sent: ${draft.subject || "(no subject)"}`,
						text: [
							`From account: ${account}`,
							`To: ${draft.to}`,
							`Subject: ${draft.subject}`,
							`Thread: ${sent.threadId}`,
							"",
							draft.body,
						].join("\n"),
						content_subtype: EMAIL_SENT_CONTENT_SUBTYPE,
						surface: ARTIFACT_SURFACES.actReceipt,
						captured_by: "gmail_send_draft",
						tags,
					},
					{ context: { caller: "internal", userId: ctx.userId } },
				);
				provenance = `Captured as artifact ${captured.id} (content_subtype='${EMAIL_SENT_CONTENT_SUBTYPE}').`;
			} catch (err) {
				provenance = `Sent, but the ahKMS capture failed, so this send is not in the knowledge store: ${
					err instanceof Error ? err.message : String(err)
				}`;
			}

			return {
				domain,
				account,
				draftId: input.draft_id,
				to: draft.to,
				subject: draft.subject,
				messageId: sent.messageId,
				threadId: sent.threadId,
				provenance,
				receipt: {
					account,
					draft_id: input.draft_id,
					message_id: sent.messageId,
					thread_id: sent.threadId,
					sent_count: 1,
				},
			};
		},
	});
}
