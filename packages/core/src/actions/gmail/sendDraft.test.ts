import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GmailApiError,
	type GmailPort,
	type ParsedMessage,
} from "../../ports/gmail.js";
import type { CapturePort, CaptureResult } from "../../ports/artifacts.js";
import { executeAction } from "../adapters/direct.js";
import { actionResolver, executeApproved } from "../approvals.js";
import { createCaptureAction } from "../artifacts/capture.js";
import type { CaptureInput } from "../domain/capture.js";
import {
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import type { ActionContext } from "../types.js";
import { createGmailSendDraftAction } from "./sendDraft.js";

function makeDraft(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		id: "m9",
		threadId: "t1",
		from: "owner@work.example.com",
		to: "owner@work.example.com",
		subject: "Budget",
		date: "Mon, 12 Oct 2026 09:00:00 +0000",
		labelIds: ["DRAFT"],
		snippet: "sure",
		body: "sure",
		links: [],
		attachments: [],
		...overrides,
	};
}

function fakeCaptureResult(input: CaptureInput): CaptureResult {
	return {
		id: "artifact-123",
		storage_path: "u/email.md",
		content_type: "text",
		content_subtype: input.content_subtype ?? "email_sent",
		surface: input.surface ?? "act_receipt",
		captured_at: "2026-10-12T00:00:00Z",
		captured_at_declared: false,
		embedded: false,
	};
}

function makeGmailPort(overrides: Partial<GmailPort> = {}): GmailPort {
	return {
		searchMessages: vi.fn(),
		getMessage: vi.fn(),
		getThread: vi.fn(),
		getProfile: vi.fn(),
		listLabels: vi.fn(),
		ensureLabel: vi.fn(),
		getReplyContext: vi.fn(),
		createDraft: vi.fn(),
		updateDraft: vi.fn(),
		getDraft: vi.fn(async () => makeDraft()),
		sendDraft: vi.fn(async () => ({ messageId: "m10", threadId: "t1" })),
		modifyLabels: vi.fn(),
		...overrides,
	};
}

function makeApprovalStore() {
	const parked: ApprovalRequest[] = [];
	const store: ActionApprovalLifecycleStore = {
		park: vi.fn(async (req: ApprovalRequest) => {
			parked.push(req);
			return { decisionId: `dec-${parked.length}` };
		}),
		claim: vi.fn(async (decisionId: string) => {
			const req = parked[Number(decisionId.replace("dec-", "")) - 1];
			return req
				? {
						decisionId,
						actionId: req.actionId,
						input: req.input,
						inputSha256: req.inputSha256,
						caller: req.caller,
						userId: req.userId ?? "u-1",
					}
				: null;
		}),
		finish: vi.fn(async () => {}),
		reject: vi.fn(async () => true),
	};
	return { store, parked };
}

describe("gmail_send_draft core action (#1578)", () => {
	const owners = async () => new Set(["owner@example.com", "owner@work.example.com"]);

	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("does not park owner-only drafts, reads draft before sending, captures with caller 'internal', and matches dev text byte-for-byte", async () => {
		const order: string[] = [];
		const getDraft = vi.fn(async ({ format }: { format?: "full" | "metadata" }) => {
			order.push(`getDraft:${format ?? "full"}`);
			return makeDraft({ to: "Angus <OWNER@work.example.com>" });
		});
		const sendDraft = vi.fn(async () => {
			order.push("sendDraft");
			return { messageId: "m10", threadId: "t1" };
		});
		const capturedCalls: Array<{ input: CaptureInput; ctx: ActionContext }> = [];
		const baseCapture = createCaptureAction({
			capture: vi.fn(async (input) => fakeCaptureResult(input)),
		});
		const captureAction = {
			...baseCapture,
			run: vi.fn(async (input: CaptureInput, ctx: ActionContext) => {
				order.push("capture");
				capturedCalls.push({ input, ctx });
				return baseCapture.run(input, ctx);
			}),
		};

		const { store, parked } = makeApprovalStore();
		setActionApprovalStore(store);

		const gmail = makeGmailPort({ getDraft, sendDraft });
		const action = createGmailSendDraftAction({
			gmail,
			capture: captureAction,
			ownerAddresses: owners,
		});

		const out = await executeAction(
			action,
			{ domain: "work", draft_id: "d1" },
			{ context: { caller: "mcp", userId: "u-1" } },
		);

		expect(parked).toHaveLength(0);
		expect(order).toEqual(["getDraft:metadata", "getDraft:full", "sendDraft", "capture"]);
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.ctx).toMatchObject({ caller: "internal", userId: "u-1" });
		expect(capturedCalls[0]?.input).toEqual({
			title: "Email sent: Budget",
			text: [
				"From account: work",
				"To: Angus <OWNER@work.example.com>",
				"Subject: Budget",
				"Thread: t1",
				"",
				"sure",
			].join("\n"),
			content_subtype: "email_sent",
			surface: "act_receipt",
			captured_by: "gmail_send_draft",
			tags: ["email", "sent", "account:work"],
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"Sent draft d1 from the 'work' mailbox. This cannot be undone.",
				"To: Angus <OWNER@work.example.com>",
				"Subject: Budget",
				"Message m10 in thread t1.",
				"Captured as artifact artifact-123 (content_subtype='email_sent').",
			].join("\n"),
		);
	});

	it("parks external Cc, external Bcc, spoofed display name, group, undisclosed-recipients, empty recipients, missing domain, and throwing lookups, then executes when approved", async () => {
		const { store, parked } = makeApprovalStore();
		setActionApprovalStore(store);

		const getDraft = vi.fn<GmailPort["getDraft"]>();
		const sendDraft = vi.fn(async () => ({ messageId: "m10", threadId: "t1" }));
		const ownerFn = vi.fn(owners);
		const capture: CapturePort = {
			capture: vi.fn(async (input) => fakeCaptureResult(input)),
		};
		const action = createGmailSendDraftAction({
			gmail: makeGmailPort({ getDraft, sendDraft }),
			capture,
			ownerAddresses: ownerFn,
		});

		const gatedDrafts: ParsedMessage[] = [
			makeDraft({ to: "owner@example.com", cc: "external@example.com" }),
			makeDraft({ to: "", bcc: "secret@example.com" }),
			makeDraft({ to: '"owner@example.com" <x@example.com>' }),
			makeDraft({ to: "owner@example.com, Friends: x@example.com;" }),
			makeDraft({ to: "undisclosed-recipients:;" }),
			makeDraft({ to: "" }),
		];

		for (const d of gatedDrafts) {
			getDraft.mockResolvedValueOnce(d);
			await expect(
				executeAction(
					action,
					{ account: "personal", draft_id: "d1" },
					{ context: { caller: "mcp", userId: "u-1" } },
				),
			).rejects.toThrow(PendingApprovalError);
		}

		getDraft.mockRejectedValueOnce(new GmailApiError("Not found", 404, "notFound"));
		await expect(
			executeAction(
				action,
				{ account: "personal", draft_id: "d1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		getDraft.mockResolvedValueOnce(makeDraft({ to: "owner@example.com" }));
		ownerFn.mockRejectedValueOnce(new Error("profile unavailable"));
		await expect(
			executeAction(
				action,
				{ account: "personal", draft_id: "d1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		await expect(
			executeAction(
				action,
				{ draft_id: "d1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		expect(sendDraft).not.toHaveBeenCalled();
		expect(parked).toHaveLength(9);

		getDraft.mockResolvedValue(makeDraft({ to: "external@example.com" }));
		const replay = await executeApproved("dec-1", {
			store,
			resolve: actionResolver((id) => (id === "gmail_send_draft" ? action : undefined)),
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});
		expect(replay.status).toBe("executed");
		expect(sendDraft).toHaveBeenCalledWith({ domain: "angus", draftId: "d1" });
	});

	it("skips approval gate for caller 'ui', tags robot_authored mail, reports capture failure after send, and enforces domain + GmailApiError contract", async () => {
		const getDraft = vi.fn(async () =>
			makeDraft({
				to: "external@example.com",
				subject: "",
				body: "Scheduled routine completed",
			}),
		);
		const sendDraft = vi.fn(async () => ({ messageId: "m11", threadId: "t2" }));
		const captureFn = vi
			.fn<CapturePort["capture"]>()
			.mockResolvedValueOnce(fakeCaptureResult({ text: "x" }))
			.mockRejectedValueOnce(new Error("supabase down"));

		const action = createGmailSendDraftAction({
			gmail: makeGmailPort({ getDraft, sendDraft }),
			capture: { capture: captureFn },
			ownerAddresses: owners,
		});

		const uiOut = await executeAction(
			action,
			{ account: "personal", draft_id: "d2" },
			{ context: { caller: "ui", userId: "u-1" } },
		);
		expect(sendDraft).toHaveBeenCalledWith({ domain: "angus", draftId: "d2" });
		expect(captureFn.mock.calls[0]?.[0].tags).toContain("robot_authored");
		expect(action.formatMcp!(uiOut)).toContain("Subject: (no subject)");

		const failedCaptureOut = await executeAction(
			action,
			{ account: "personal", draft_id: "d2" },
			{ context: { caller: "ui", userId: "u-1" } },
		);
		expect(action.formatMcp!(failedCaptureOut)).toBe(
			[
				"Sent draft d2 from the 'personal' mailbox. This cannot be undone.",
				"To: external@example.com",
				"Subject: (no subject)",
				"Message m11 in thread t2.",
				"Sent, but the ahKMS capture failed, so this send is not in the knowledge store: supabase down",
			].join("\n"),
		);

		await expect(
			executeAction(action, { draft_id: "d2" }, { context: { caller: "ui" } }),
		).rejects.toThrow(
			"`domain` is required to send \u2014 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);

		sendDraft.mockRejectedValueOnce(
			new GmailApiError("Gmail API POST /drafts/send failed", 403, "insufficientPermissions", "PERMISSION_DENIED"),
		);
		await expect(
			executeAction(
				action,
				{ domain: "work", draft_id: "d2" },
				{ context: { caller: "ui" } },
			),
		).rejects.toMatchObject({
			name: "GmailApiError",
			status: 403,
			reason: "insufficientPermissions",
		});
	});
});
