import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import type {
	GmailAccount,
	GmailLabel,
	GmailPort,
} from "../../ports/gmail.js";
import { defineAction } from "../defineAction.js";

export const gmailLabelsInput = {
	action: z
		.enum(["list", "ensure"])
		.describe(
			"'list' returns every label with its id. 'ensure' creates `name` if missing and returns it either way (idempotent, safe to re-run).",
		),
	name: z
		.string()
		.optional()
		.describe("Label name, required for action='ensure'. e.g. 'meeting_note'."),
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		),
	domain: optionalDomainInput,
};

export const gmailLabelsInputSchema = z.object(gmailLabelsInput);
export const gmailLabelsSchema = gmailLabelsInputSchema;

export type GmailLabelsInput = z.infer<typeof gmailLabelsInputSchema>;

export interface GmailLabelsReceipt {
	account: GmailAccount;
	action: "list" | "ensure";
	label_ids: string[];
	count: number;
	created?: boolean;
}

export type GmailLabelsOutput =
	| {
			action: "list";
			domain: Domain;
			account: GmailAccount;
			labels: GmailLabel[];
			receipt: GmailLabelsReceipt;
	  }
	| {
			action: "ensure";
			domain: Domain;
			account: GmailAccount;
			label: GmailLabel;
			created: boolean;
			receipt: GmailLabelsReceipt;
	  };

export function formatGmailLabelsMcp(out: GmailLabelsOutput): string {
	if (out.action === "ensure") {
		return `${out.created ? "Created" : "Already existed"}: label '${out.label.name}' (id ${out.label.id}) in the '${out.account}' mailbox.`;
	}
	const body = out.labels
		.map((l) => `• [${l.id}] ${l.name}${l.type === "system" ? " (system)" : ""}`)
		.join("\n");
	return `${out.labels.length} label(s) in the '${out.account}' mailbox:\n${body}`;
}

export function createGmailLabelsAction(port: GmailPort) {
	return defineAction<typeof gmailLabelsInputSchema, GmailLabelsOutput>({
		id: "gmail_labels",
		domain: "integrations",
		description:
			"List a mailbox's Gmail labels with their ids, or idempotently create one by name (action='ensure'). Label ids, not names, are what gmail_modify takes.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: gmailLabelsInputSchema,
		formatMcp: formatGmailLabelsMcp,
		async run(input) {
			const domain: Domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;

			if (input.action === "ensure") {
				if (!input.name) throw new Error("action='ensure' requires a label name.");
				const { label, created } = await port.ensureLabel({
					domain,
					name: input.name,
				});
				return {
					action: "ensure",
					domain,
					account,
					label,
					created,
					receipt: {
						account,
						action: "ensure",
						label_ids: [label.id],
						count: 1,
						created,
					},
				};
			}

			const labels = await port.listLabels({ domain });
			return {
				action: "list",
				domain,
				account,
				labels,
				receipt: {
					account,
					action: "list",
					label_ids: labels.map((l) => l.id),
					count: labels.length,
				},
			};
		},
	});
}
