import { describe, expect, it, vi } from "vitest";
import { createGmailLabelsAction } from "./labels.js";
import {
	GmailApiError,
	type GmailEnsureLabelResult,
	type GmailLabel,
	type GmailPort,
} from "../../ports/gmail.js";

const ctx = { caller: "test", requestId: "r1" };

const labelsFixture: GmailLabel[] = [
	{ id: "INBOX", name: "INBOX", type: "system" },
	{ id: "UNREAD", name: "UNREAD", type: "system" },
	{ id: "Label_9", name: "Meeting_Note", type: "user" },
];

function fakePort(overrides: {
	listLabels?: (params: any) => Promise<GmailLabel[]>;
	ensureLabel?: (params: any) => Promise<GmailEnsureLabelResult>;
}): GmailPort {
	return {
		listLabels: vi.fn(overrides.listLabels ?? (async () => labelsFixture)),
		ensureLabel: vi.fn(
			overrides.ensureLabel ??
				(async ({ name }) => ({
					label: { id: "Label_10", name, type: "user" },
					created: true,
				})),
		),
	} as unknown as GmailPort;
}

describe("gmail_labels", () => {
	it("lists labels defaulting to personal (angus) and renders dev's text byte-for-byte", async () => {
		const port = fakePort({});
		const action = createGmailLabelsAction(port);
		const out = await action.run({ action: "list" }, ctx);

		expect(port.listLabels).toHaveBeenCalledWith({ domain: "angus" });
		expect(out).toEqual({
			action: "list",
			domain: "angus",
			account: "personal",
			labels: labelsFixture,
			receipt: {
				account: "personal",
				action: "list",
				label_ids: ["INBOX", "UNREAD", "Label_9"],
				count: 3,
			},
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"3 label(s) in the 'personal' mailbox:",
				"• [INBOX] INBOX (system)",
				"• [UNREAD] UNREAD (system)",
				"• [Label_9] Meeting_Note",
			].join("\n"),
		);
	});

	it("ensures an existing label matched case-insensitively without creating", async () => {
		const port = fakePort({
			ensureLabel: async () => ({
				label: { id: "Label_9", name: "Meeting_Note", type: "user" },
				created: false,
			}),
		});
		const action = createGmailLabelsAction(port);
		const out = await action.run(
			{ action: "ensure", name: "meeting_note", domain: "work" },
			ctx,
		);

		expect(port.ensureLabel).toHaveBeenCalledWith({
			domain: "work",
			name: "meeting_note",
		});
		expect(action.formatMcp!(out)).toBe(
			"Already existed: label 'Meeting_Note' (id Label_9) in the 'work' mailbox.",
		);
	});

	it("creates a missing label once when action='ensure' and renders Created message", async () => {
		const port = fakePort({
			ensureLabel: async ({ name }) => ({
				label: { id: "Label_10", name, type: "user" },
				created: true,
			}),
		});
		const action = createGmailLabelsAction(port);
		const out = await action.run(
			{ action: "ensure", name: "action_required", account: "work" },
			ctx,
		);

		expect(port.ensureLabel).toHaveBeenCalledTimes(1);
		expect(port.ensureLabel).toHaveBeenCalledWith({
			domain: "work",
			name: "action_required",
		});
		expect(action.formatMcp!(out)).toBe(
			"Created: label 'action_required' (id Label_10) in the 'work' mailbox.",
		);
	});

	it("rejects action='ensure' without name, conflicting domain/account, and propagates GmailApiError with status", async () => {
		const err404 = new GmailApiError(
			"Gmail API GET /labels failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const action = createGmailLabelsAction(
			fakePort({
				listLabels: async () => {
					throw err404;
				},
			}),
		);

		await expect(action.run({ action: "ensure" }, ctx)).rejects.toThrow(
			"action='ensure' requires a label name.",
		);

		await expect(
			action.run({ action: "list", domain: "work", account: "personal" }, ctx),
		).rejects.toThrow(/different domains/);

		await expect(action.run({ action: "list" }, ctx)).rejects.toMatchObject({
			name: "GmailApiError",
			status: 404,
			reason: "notFound",
			message: expect.stringContaining("account 'personal'"),
		});
	});
});
