import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import {
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalStore,
	type ApprovalRequest,
} from "../gate.js";
import { inputSha256 } from "../inputHash.js";
import type { ActionContext } from "../types.js";
import {
	createGmailUnsubscribeBatchAction,
	GMAIL_UNSUBSCRIBE_LABEL,
	type GmailUnsubscribeBatchPort,
} from "./gmailUnsubscribeBatch.js";

function makePort(
	overrides: Partial<GmailUnsubscribeBatchPort> = {},
): GmailUnsubscribeBatchPort {
	return {
		applyLabels: vi.fn().mockResolvedValue(undefined),
		sweepThread: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("gmail_unsubscribe_batch (ADR-104, ADR-118, #2134)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	it("defines gmail_unsubscribe_batch with needsApproval enabled and default surface exposure", () => {
		const action = createGmailUnsubscribeBatchAction(makePort());
		expect(action.id).toBe("gmail_unsubscribe_batch");
		expect(action.domain).toBe("integrations");
		expect(typeof action.needsApproval).toBe("function");
		expect(
			typeof action.needsApproval === "function"
				? action.needsApproval(
						{ threads: [{ thread_id: "th-1", account: "personal" }], dry_run: false },
						{ caller: "mcp", requestId: "req-1" },
					)
				: action.needsApproval,
		).toBe(true);
		expect(action.expose).toMatchObject({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("parks a single approval request for the batch when called from an agent surface without approval", async () => {
		const parkedRequests: ApprovalRequest[] = [];
		const approvalStore: ActionApprovalStore = {
			park: vi.fn(async (req) => {
				parkedRequests.push(req);
				return { decisionId: "dec-unsub-batch-1" };
			}),
		};
		setActionApprovalStore(approvalStore);

		const port = makePort();
		const action = createGmailUnsubscribeBatchAction(port);
		const ctx: ActionContext = {
			caller: "mcp",
			requestId: "req-unsub-park",
			userId: "user-angus",
		};

		await expect(
			executeAction(
				action,
				{
					threads: [
						{
							thread_id: "th-ck-1",
							account: "personal",
							sender: "Calvin Klein <news@example.com>",
							subject: "30% off sitewide",
							list_unsubscribe: "<mailto:unsub@example.com>",
						},
						{
							thread_id: "th-promo-2",
							account: "work",
							sender: "SaaS Promo <promo@saas.example>",
							subject: "Upgrade today",
						},
					],
				},
				{ context: ctx, auditSink: () => {} },
			),
		).rejects.toThrowError(PendingApprovalError);

		expect(approvalStore.park).toHaveBeenCalledTimes(1);
		expect(parkedRequests[0]?.actionId).toBe("gmail_unsubscribe_batch");
		expect(port.applyLabels).not.toHaveBeenCalled();
		expect(port.sweepThread).not.toHaveBeenCalled();
	});

	it("applies ahOS/Unsubscribe and archives every thread in the batch once approved", async () => {
		const port = makePort();
		const action = createGmailUnsubscribeBatchAction(port);
		const rawInput = {
			threads: [
				{
					thread_id: "th-ck-1",
					account: "personal" as const,
					message_id: "msg-ck-1",
					sender: "Calvin Klein <news@example.com>",
					subject: "30% off sitewide",
				},
				{
					thread_id: "th-hl-2",
					domain: "work" as const,
					sender: "Newsletter <news@example.com>",
					subject: "Monthly Digest",
				},
				// Duplicate thread in the same batch should be deduplicated
				{
					thread_id: "th-ck-1",
					account: "personal" as const,
				},
			],
		};
		const parsedInput = action.schema.parse(rawInput);
		const hash = await inputSha256(parsedInput);

		const approvedCtx: ActionContext = {
			caller: "mcp",
			requestId: "req-unsub-approved",
			userId: "user-angus",
			approval: {
				decisionId: "dec-unsub-batch-1",
				actionId: "gmail_unsubscribe_batch",
				inputSha256: hash,
			},
		};

		const result = await executeAction(action, rawInput, {
			context: approvedCtx,
			auditSink: () => {},
		});

		expect(result).toMatchObject({
			dry_run: false,
			label: GMAIL_UNSUBSCRIBE_LABEL,
			requested_count: 3,
			processed_count: 2,
			labeled_count: 2,
			archived_count: 2,
			errors: [],
		});
		expect(port.applyLabels).toHaveBeenCalledTimes(2);
		expect(port.applyLabels).toHaveBeenNthCalledWith(
			1,
			{ account: "personal", thread_id: "th-ck-1", message_id: "msg-ck-1" },
			{ add: ["ahOS/Unsubscribe"], remove: [] },
		);
		expect(port.applyLabels).toHaveBeenNthCalledWith(
			2,
			{ account: "work", thread_id: "th-hl-2", message_id: "th-hl-2" },
			{ add: ["ahOS/Unsubscribe"], remove: [] },
		);
		expect(port.sweepThread).toHaveBeenCalledTimes(2);
		expect(port.sweepThread).toHaveBeenNthCalledWith(
			1,
			{ account: "personal", thread_id: "th-ck-1", message_id: "msg-ck-1" },
			"user-angus",
		);
		expect(port.sweepThread).toHaveBeenNthCalledWith(
			2,
			{ account: "work", thread_id: "th-hl-2", message_id: "th-hl-2" },
			"user-angus",
		);
		expect(action.formatMcp!(result)).toContain(
			"Unsubscribed and archived 2 of 3 thread(s) with label ahOS/Unsubscribe.",
		);
	});

	it("performs zero Gmail writes when dry_run is true", async () => {
		const port = makePort();
		const action = createGmailUnsubscribeBatchAction(port);
		const result = await executeAction(
			action,
			{
				threads: [{ thread_id: "th-dry-1", account: "personal" }],
				dry_run: true,
			},
			{
				context: { caller: "ui", requestId: "req-ui-dry", userId: "user-angus" },
				auditSink: () => {},
			},
		);

		expect(result.dry_run).toBe(true);
		expect(result.processed_count).toBe(1);
		expect(result.labeled_count).toBe(0);
		expect(result.archived_count).toBe(0);
		expect(port.applyLabels).not.toHaveBeenCalled();
		expect(port.sweepThread).not.toHaveBeenCalled();
	});
});
