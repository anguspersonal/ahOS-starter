import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GmailLabel, GmailPort, ParsedMessage } from "../../ports/gmail.js";
import type { CandidateGmailArtifactRow, GmailReconcileStore } from "../../ports/gmailReconcile.js";
import type { NotionPort } from "../../ports/notion.js";
import { executeAction } from "../adapters/direct.js";
import { setActionApprovalStore, type ActionApprovalStore } from "../gate.js";
import type { ActionContext } from "../types.js";
import { createGmailReconcileAction, formatGmailReconcileMcp, gmailReconcileInput } from "./reconcile.js";
import type { GmailReconcileSummary } from "./reconcileRules.js";

const CTX: ActionContext = { userId: "user-123", caller: "mcp", requestId: "req-1" };

const LEGACY_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		account: {
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
			type: "string",
			enum: ["personal", "work"],
		},
		domain: {
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
			type: "string",
			enum: ["work", "angus"],
		},
		thread_id: {
			description: "Specific Gmail thread ID to reconcile. If omitted, reconciles all threads with captured artifacts.",
			type: "string",
		},
		dry_run: {
			default: false,
			description: "If true, preview decisions and label changes without modifying Gmail labels or archiving threads.",
			type: "boolean",
		},
		limit: {
			default: 50,
			description: "Maximum number of threads to inspect and reconcile in this sweep.",
			type: "integer",
			exclusiveMinimum: 0,
			maximum: 9007199254740991,
		},
	},
	required: ["dry_run", "limit"],
	additionalProperties: false,
};

const LABELS: GmailLabel[] = [
	{ id: "L_AHOS", name: "AhOS", type: "user" },
	{ id: "L_PROC", name: "AhOSProcessed", type: "user" },
	{ id: "L_PEND", name: "Pending Action", type: "user" },
	{ id: "L_WAIT", name: "6: awaiting reply", type: "user" },
];

const msg = (threadId: string, from: string, labelIds: string[]): ParsedMessage => ({
	id: `m-${threadId}`, threadId, from, to: "owner@example.com", subject: "Subj",
	date: "2026-10-15T10:00:00Z", labelIds, snippet: "", body: "", links: [], attachments: [],
});

const art = (id: string, threadId: string, account: "personal" | "work"): CandidateGmailArtifactRow => ({
	id, source_channel: "gmail", processing_metadata: { gmail: { thread_id: threadId, account } },
});

function makePorts(opts: {
	artifacts?: CandidateGmailArtifactRow[];
	hasEntityLinks?: (ids: string[]) => Promise<boolean>;
	taskLinks?: (ids: string[]) => Promise<Array<{ external_id: string; provider: string; kind: string }>>;
	getThread?: GmailPort["getThread"];
	listLabels?: GmailPort["listLabels"];
	retrievePage?: NotionPort["retrievePage"];
} = {}) {
	const listLabels = vi.fn(opts.listLabels ?? (async () => LABELS));
	const modifyLabels = vi.fn(async (p: { target: { id: string }; addLabelIds?: string[] }) => ({
		id: p.target.id, labelIds: p.addLabelIds ?? [],
	}));
	const getThread = vi.fn(opts.getThread ?? (async ({ threadId }) => [msg(threadId, "x@example.com", ["INBOX", "UNREAD"])]));
	const gmail: Pick<GmailPort, "listLabels" | "ensureLabel" | "getThread" | "modifyLabels"> = {
		listLabels,
		ensureLabel: async ({ name }) => ({ label: { id: `L_${name}`, name, type: "user" }, created: false }),
		getThread,
		modifyLabels,
	};
	const notion: Pick<NotionPort, "retrievePage"> = {
		retrievePage: opts.retrievePage ?? (async ({ pageId }) => ({ id: pageId, archived: false, properties: {} })),
	};
	const listArtifacts = vi.fn(async () => opts.artifacts ?? []);
	const listExtLinks = vi.fn(async () => []);
	const store: GmailReconcileStore = {
		listCandidateGmailArtifacts: listArtifacts,
		listCandidateGmailExternalLinks: listExtLinks,
		hasEntityLinksForArtifacts: opts.hasEntityLinks ?? (async () => false),
		listTaskExternalLinksForArtifacts: opts.taskLinks ?? (async () => []),
	};
	return { ports: { gmail, notion, store }, listLabels, getThread, modifyLabels, listArtifacts, listExtLinks };
}

describe("gmail_reconcile action", () => {
	afterEach(() => setActionApprovalStore(null));

	it("1. contract: id, schema snapshot, description and annotations match legacy tool", () => {
		const action = createGmailReconcileAction(makePorts().ports);
		expect(action.id).toBe("gmail_reconcile");
		expect(z.toJSONSchema(action.schema)).toEqual(LEGACY_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(
			"Reconcile Gmail labels for threads captured into ahOS (issue #356). " +
				"Applies AhOS on capture, AhOSProcessed on entity sync, and evaluates linked tasks: " +
				"archives and marks read when no open tasks exist; applies 'Pending Action' if the next move is on Angus; " +
				"or applies '6: awaiting reply' if waiting on someone else. Supports dry_run preview.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
		});
	});

	it("2. defaults dry_run=false and limit=50; rejects limit=0 and limit=1.5", () => {
		const schema = z.object(gmailReconcileInput);
		expect(schema.parse({})).toEqual({ dry_run: false, limit: 50 });
		expect(() => schema.parse({ limit: 0 })).toThrow();
		expect(() => schema.parse({ limit: 1.5 })).toThrow();
	});

	it("3. thread_id without account reconciles as personal with empty artifactIds and no store listing", async () => {
		const { ports, getThread, listArtifacts, listExtLinks } = makePorts();
		const action = createGmailReconcileAction(ports);
		const out = await action.run({ thread_id: "th-single", dry_run: true, limit: 50 }, CTX);
		expect(listArtifacts).not.toHaveBeenCalled();
		expect(listExtLinks).not.toHaveBeenCalled();
		expect(getThread).toHaveBeenCalledWith({ domain: "angus", threadId: "th-single" });
		expect(out.scanned).toBe(1);
		expect(out.details[0]).toMatchObject({ threadId: "th-single", account: "personal", hasEntityLinks: false });
	});

	it("4. without thread_id: scans all 3 threads, filters by account/domain=work, respects limit=2", async () => {
		const artifacts = [art("a1", "th-1", "personal"), art("a2", "th-2", "work"), art("a3", "th-3", "work")];
		const action = createGmailReconcileAction(makePorts({ artifacts }).ports);
		expect((await action.run({ dry_run: true, limit: 50 }, CTX)).scanned).toBe(3);
		const byAcc = await action.run({ account: "work", dry_run: true, limit: 50 }, CTX);
		expect(byAcc.details.map((d) => d.threadId)).toEqual(["th-2", "th-3"]);
		const byDom = await action.run({ domain: "work", dry_run: true, limit: 50 }, CTX);
		expect(byDom.details.map((d) => d.threadId)).toEqual(["th-2", "th-3"]);
		expect((await action.run({ dry_run: true, limit: 2 }, CTX)).scanned).toBe(2);
	});

	it("5. caches labels per account; label resolution error marks that account's threads as errors while others run", async () => {
		const artifacts = [art("a1", "th-1", "personal"), art("a2", "th-2", "personal"), art("a3", "th-3", "work")];
		const { ports, listLabels } = makePorts({
			artifacts,
			listLabels: async ({ domain }) => {
				if (domain === "angus") throw new Error("boom");
				return LABELS;
			},
		});
		// ensureLabel also throws for angus so resolveWorkflowLabels fails
		ports.gmail.ensureLabel = async ({ domain, name }) => {
			if (domain === "angus") throw new Error("labels unavailable");
			return { label: { id: `L_${name}`, name, type: "user" }, created: false };
		};
		const out = await createGmailReconcileAction(ports).run({ dry_run: true, limit: 50 }, CTX);
		expect(listLabels).toHaveBeenCalledTimes(3); // 2 failed personal attempts + 1 cached work
		expect(out.errors).toBe(2);
		expect(out.capturedOnly).toBe(1);
		expect(out.details[2]).toMatchObject({ threadId: "th-3", account: "work", decision: "captured_only" });

		const cached = makePorts({ artifacts: [art("a1", "th-1", "personal"), art("a2", "th-2", "personal")] });
		await createGmailReconcileAction(cached.ports).run({ dry_run: true, limit: 50 }, CTX);
		expect(cached.listLabels).toHaveBeenCalledTimes(1);
	});

	it("6. tallies archived, pendingAction, awaitingReply, capturedOnly, updated, unchanged and errors", async () => {
		const artifacts = [
			art("a-arch", "th-arch", "personal"),
			art("a-pend", "th-pend", "personal"),
			art("a-wait", "th-wait", "personal"),
			art("a-cap", "th-cap", "personal"),
			art("a-err", "th-err", "personal"),
		];
		const { ports } = makePorts({
			artifacts,
			hasEntityLinks: async (ids) => ids[0] !== "a-cap",
			taskLinks: async (ids) =>
				ids[0] === "a-pend" || ids[0] === "a-wait"
					? [{ external_id: `t-${ids[0]}`, provider: "notion_personal", kind: "task" }]
					: [],
			retrievePage: async ({ pageId }) => ({
				id: pageId, archived: false, properties: { Status: { type: "status", status: { name: "In Progress" } } },
			}),
			getThread: async ({ threadId }) => {
				if (threadId === "th-err") throw new Error("fetch failed");
				if (threadId === "th-pend") return [msg(threadId, "owner@example.com", ["INBOX", "L_AHOS", "L_PROC", "L_PEND"])];
				if (threadId === "th-wait") return [msg(threadId, "client@example.com", ["INBOX", "L_AHOS"])];
				return [msg(threadId, "client@example.com", ["INBOX", "UNREAD"])];
			},
		});
		const out = await createGmailReconcileAction(ports).run({ dry_run: false, limit: 50 }, CTX);
		expect(out).toMatchObject({
			scanned: 5, updated: 3, unchanged: 1, archived: 1, pendingAction: 1, awaitingReply: 1, capturedOnly: 1, errors: 1,
		});
	});

	it("7. passes ctx.userId to store listing methods", async () => {
		const { ports, listArtifacts, listExtLinks } = makePorts();
		await createGmailReconcileAction(ports).run({ dry_run: true, limit: 50 }, CTX);
		expect(listArtifacts).toHaveBeenCalledWith("user-123");
		expect(listExtLinks).toHaveBeenCalledWith("user-123");
	});

	it("8. formatGmailReconcileMcp matches legacy text line for line", () => {
		const summary: GmailReconcileSummary = {
			scanned: 2, updated: 1, archived: 1, pendingAction: 0, awaitingReply: 0, capturedOnly: 0, unchanged: 0, errors: 1, dryRun: true,
			details: [
				{ threadId: "t1", account: "personal", decision: "archive_read", addLabelIds: ["L1"], removeLabelIds: ["INBOX"], applied: false, hasEntityLinks: true, hasOpenTask: false, lastMessageFromAngus: false },
				{ threadId: "t2", account: "work", decision: "captured_only", addLabelIds: [], removeLabelIds: [], applied: false, hasEntityLinks: false, hasOpenTask: false, lastMessageFromAngus: false, error: "boom" },
			],
		};
		expect(formatGmailReconcileMcp(summary)).toBe([
			"[DRY RUN] Gmail workflow reconciliation complete:",
			"• Scanned: 2 thread(s)", "• Updated: 1", "• Unchanged: 0", "• Archived & marked read: 1",
			"• Pending Action (Angus owes move): 0", "• Awaiting Reply (waiting on someone else): 0",
			"• Captured only (not yet processed): 0", "• Errors: 1", "", "Details:",
			"• Thread t1 (personal): archive_read [+labels: L1; -labels: INBOX]",
			"• Thread t2 (work): captured_only [no label changes] (error: boom)",
		].join("\n"));
		expect(formatGmailReconcileMcp({ ...summary, dryRun: false, details: [] })).not.toContain("Details:");
	});

	it("9. runs under caller mcp without parking when an approval store is installed", async () => {
		const approvalStore: ActionApprovalStore = { park: vi.fn(async () => ({ decisionId: "dec-1" })) };
		setActionApprovalStore(approvalStore);
		const action = createGmailReconcileAction(makePorts().ports);
		const res = await executeAction(action, { dry_run: true, limit: 50 }, { context: CTX });
		expect(approvalStore.park).not.toHaveBeenCalled();
		expect(res).toMatchObject({ scanned: 0 });
	});

	it("10. expose turns off http and ui_agent only with owner_decision_pending", () => {
		const action = createGmailReconcileAction(makePorts().ports);
		expect(action.expose).toEqual({
			mcp: true, http: false, ui_agent: false, worker: true, cli: false, a2a: false,
			reason: "owner_decision_pending",
			note: "http and ui_agent off: it archives threads and marks them read; widening is a separate owner decision (ruling of 21 Nov 2026 on #1338)",
		});
	});
});
