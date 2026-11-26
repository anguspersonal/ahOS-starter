import { describe, expect, it, vi } from "vitest";
import type { GmailModifyLabelsParams, GmailPort, ParsedMessage } from "../../ports/gmail.js";
import type { GmailReconcileStore, TaskExternalLinkRow } from "../../ports/gmailReconcile.js";
import type { NotionPageResponse, NotionPort } from "../../ports/notion.js";
import type { GmailReconcileLabels } from "./reconcileRules.js";
import { reconcileGmailThread, type ReconcileGmailThreadPorts } from "./reconcileThread.js";

const LABELS: GmailReconcileLabels = {
	ahosId: "Label_329",
	ahosProcessedId: "Label_330",
	pendingActionId: "Label_331",
	awaitingReplyId: "Label_314",
};

const msg = (id: string, from: string, labelIds: string[]): ParsedMessage => ({
	id, threadId: "th-default", from, to: "owner@example.com", subject: "Test",
	date: "2026-10-15T10:00:00Z", labelIds, snippet: "", body: "", links: [], attachments: [],
});

const notionStatus = (id: string, name: string): NotionPageResponse => ({
	id, archived: false, properties: { Status: { type: "status", status: { name } } },
});

function makePorts(opts: {
	messages?: ParsedMessage[] | (() => Promise<ParsedMessage[]>);
	modifyLabels?: GmailPort["modifyLabels"];
	hasEntityLinks?: boolean;
	taskLinks?: TaskExternalLinkRow[];
	retrievePage?: NotionPort["retrievePage"];
}): { ports: ReconcileGmailThreadPorts; modifyCalls: GmailModifyLabelsParams[] } {
	const modifyCalls: GmailModifyLabelsParams[] = [];
	const gmail: Pick<GmailPort, "getThread" | "modifyLabels"> = {
		getThread: async () => (typeof opts.messages === "function" ? opts.messages() : (opts.messages ?? [])),
		modifyLabels: opts.modifyLabels ?? (async (params) => {
			modifyCalls.push(params);
			return { id: params.target.id, labelIds: params.addLabelIds ?? [] };
		}),
	};
	const notion: Pick<NotionPort, "retrievePage"> = {
		retrievePage: opts.retrievePage ?? (async ({ pageId }) => ({ id: pageId, archived: false, properties: {} })),
	};
	const store: Pick<GmailReconcileStore, "hasEntityLinksForArtifacts" | "listTaskExternalLinksForArtifacts"> = {
		hasEntityLinksForArtifacts: async () => opts.hasEntityLinks ?? false,
		listTaskExternalLinksForArtifacts: async () => opts.taskLinks ?? [],
	};
	return { ports: { gmail, notion, store }, modifyCalls };
}

describe("reconcileGmailThread", () => {
	it("case 1: captured-only (no entity links) adds AhOS, removes nothing, stays in inbox", async () => {
		const { ports, modifyCalls } = makePorts({ messages: [msg("m1", "someone@example.com", ["INBOX", "UNREAD"])], hasEntityLinks: false });
		const res = await reconcileGmailThread(ports, { threadId: "th-1", account: "personal", artifactIds: ["art-1"], labels: LABELS, dryRun: false });
		expect(res).toMatchObject({ decision: "captured_only", hasEntityLinks: false, addLabelIds: ["Label_329"], removeLabelIds: [], applied: true });
		expect(modifyCalls).toEqual([{ domain: "angus", target: { kind: "thread", id: "th-1" }, addLabelIds: ["Label_329"], removeLabelIds: [] }]);
	});

	it("case 2: processed with no open task archives and marks read", async () => {
		const { ports, modifyCalls } = makePorts({ messages: [msg("m1", "someone@example.com", ["INBOX", "UNREAD", "Label_329"])], hasEntityLinks: true });
		const res = await reconcileGmailThread(ports, { threadId: "th-2", account: "personal", artifactIds: ["art-2"], labels: LABELS, dryRun: false });
		expect(res).toMatchObject({ decision: "archive_read", hasEntityLinks: true, hasOpenTask: false, addLabelIds: ["Label_330"], removeLabelIds: ["INBOX", "UNREAD"], applied: true });
		expect(modifyCalls).toEqual([{ domain: "angus", target: { kind: "thread", id: "th-2" }, addLabelIds: ["Label_330"], removeLabelIds: ["INBOX", "UNREAD"] }]);
	});

	it("case 3: processed, open task, last message from owner -> pending_action", async () => {
		const { ports } = makePorts({
			messages: [msg("m1", "client@example.com", ["INBOX"]), msg("m2", "Angus Hally <owner@example.com>", ["INBOX", "Label_329"])],
			hasEntityLinks: true,
			taskLinks: [{ external_id: "notion-task-1", provider: "notion_personal", kind: "task" }],
			retrievePage: async () => notionStatus("notion-task-1", "In Progress"),
		});
		const res = await reconcileGmailThread(ports, { threadId: "th-3", account: "personal", artifactIds: ["art-3"], labels: LABELS, dryRun: false });
		expect(res).toMatchObject({ decision: "pending_action", hasEntityLinks: true, hasOpenTask: true, lastMessageFromAngus: true });
		expect(res.addLabelIds).toContain("Label_330");
		expect(res.addLabelIds).toContain("Label_331");
		expect(res.removeLabelIds).not.toContain("INBOX");
	});

	it("case 4: processed, open task, last message from someone else -> awaiting_reply", async () => {
		const { ports } = makePorts({
			messages: [msg("m1", "owner@example.com", ["INBOX"]), msg("m2", "Graeme Rodd <contact6@example.com>", ["INBOX", "Label_329", "Label_330"])],
			hasEntityLinks: true,
			taskLinks: [{ external_id: "notion-task-2", provider: "notion_personal", kind: "task" }],
			retrievePage: async () => notionStatus("notion-task-2", "In Progress"),
		});
		const res = await reconcileGmailThread(ports, { threadId: "th-4", account: "personal", artifactIds: ["art-4"], labels: LABELS, dryRun: false });
		expect(res).toMatchObject({ decision: "awaiting_reply", hasEntityLinks: true, hasOpenTask: true, lastMessageFromAngus: false, addLabelIds: ["Label_314"] });
		expect(res.removeLabelIds).not.toContain("INBOX");
	});

	it("case 5: processed, open task with Waiting On status, last message from owner -> awaiting_reply", async () => {
		const { ports } = makePorts({
			messages: [msg("m1", "owner@example.com", ["INBOX", "Label_329", "Label_330"])],
			hasEntityLinks: true,
			taskLinks: [{ external_id: "notion-task-3", provider: "notion_personal", kind: "task" }],
			retrievePage: async () => notionStatus("notion-task-3", "Waiting On"),
		});
		const res = await reconcileGmailThread(ports, { threadId: "th-5", account: "personal", artifactIds: ["art-5"], labels: LABELS, dryRun: false });
		expect(res.decision).toBe("awaiting_reply");
		expect(res.addLabelIds).toContain("Label_314");
	});

	it("case 6: thread already carrying desired labels -> empty deltas, modifyLabels not called, applied false", async () => {
		const { ports, modifyCalls } = makePorts({ messages: [msg("m1", "someone@example.com", ["Label_329", "Label_330"])], hasEntityLinks: true });
		const res = await reconcileGmailThread(ports, { threadId: "th-6", account: "personal", artifactIds: ["art-6"], labels: LABELS, dryRun: false });
		expect(res).toMatchObject({ decision: "archive_read", addLabelIds: [], removeLabelIds: [], applied: false });
		expect(modifyCalls).toHaveLength(0);
	});

	it("case 7: dry run returns planned deltas, does not call modifyLabels, applied false", async () => {
		const { ports, modifyCalls } = makePorts({ messages: [msg("m1", "someone@example.com", ["INBOX", "UNREAD"])], hasEntityLinks: true });
		const res = await reconcileGmailThread(ports, { threadId: "th-7", account: "personal", artifactIds: ["art-7"], labels: LABELS, dryRun: true });
		expect(res).toMatchObject({ decision: "archive_read", addLabelIds: ["Label_329", "Label_330"], removeLabelIds: ["INBOX", "UNREAD"], applied: false });
		expect(modifyCalls).toHaveLength(0);
	});

	it("case 8: modifyLabels receives target { kind: 'thread', id } and domain angus for personal, work for work", async () => {
		const personal = makePorts({ messages: [msg("m1", "a@example.com", ["INBOX"])] });
		await reconcileGmailThread(personal.ports, { threadId: "th-p", account: "personal", artifactIds: ["art-p"], labels: LABELS, dryRun: false });
		expect(personal.modifyCalls[0]).toMatchObject({ domain: "angus", target: { kind: "thread", id: "th-p" } });

		const work = makePorts({ messages: [msg("m2", "b@example.com", ["INBOX"])] });
		await reconcileGmailThread(work.ports, { threadId: "th-h", account: "work", artifactIds: ["art-h"], labels: LABELS, dryRun: false });
		expect(work.modifyCalls[0]).toMatchObject({ domain: "work", target: { kind: "thread", id: "th-h" } });
	});

	it("case 9: empty artifactIds list gives captured_only and adds only AhOS", async () => {
		const { ports } = makePorts({ messages: [msg("m1", "someone@example.com", ["INBOX"])], hasEntityLinks: true });
		const res = await reconcileGmailThread(ports, { threadId: "th-empty-art", account: "personal", artifactIds: [], labels: LABELS, dryRun: false });
		expect(res).toMatchObject({ decision: "captured_only", hasEntityLinks: false, addLabelIds: ["Label_329"], removeLabelIds: [] });
	});

	it("case 10: empty messages or thrown getThread/modifyLabels returns error result and resolves", async () => {
		const empty = makePorts({ messages: [] });
		await expect(reconcileGmailThread(empty.ports, { threadId: "th-empty", account: "personal", artifactIds: ["art-1"], labels: LABELS, dryRun: false }))
			.resolves.toMatchObject({ threadId: "th-empty", decision: "captured_only", addLabelIds: [], removeLabelIds: [], applied: false, error: "Thread returned no messages" });

		const getThrows = makePorts({ messages: async () => { throw new Error("Gmail API 503"); } });
		await expect(reconcileGmailThread(getThrows.ports, { threadId: "th-get-err", account: "personal", artifactIds: ["art-1"], labels: LABELS, dryRun: false }))
			.resolves.toMatchObject({ threadId: "th-get-err", decision: "captured_only", addLabelIds: [], removeLabelIds: [], applied: false, error: "Gmail API 503" });

		const modThrows = makePorts({ messages: [msg("m1", "a@example.com", ["INBOX"])], modifyLabels: vi.fn(async () => { throw new Error("Quota exceeded"); }) });
		await expect(reconcileGmailThread(modThrows.ports, { threadId: "th-mod-err", account: "personal", artifactIds: ["art-1"], labels: LABELS, dryRun: false }))
			.resolves.toMatchObject({ threadId: "th-mod-err", decision: "captured_only", addLabelIds: [], removeLabelIds: [], applied: false, error: "Quota exceeded" });
	});

	it("case 11: two task links (one closed, one open and waiting) -> hasOpenTask true, awaiting_reply; every link checked", async () => {
		const checkedIds: string[] = [];
		const { ports } = makePorts({
			messages: [msg("m1", "owner@example.com", ["INBOX", "Label_329"])],
			hasEntityLinks: true,
			taskLinks: [
				{ external_id: "task-closed", provider: "notion_personal", kind: "task" },
				{ external_id: "task-waiting", provider: "notion_personal", kind: "task" },
			],
			retrievePage: async ({ pageId }) => {
				checkedIds.push(pageId);
				return notionStatus(pageId, pageId === "task-closed" ? "Done" : "Waiting On");
			},
		});
		const res = await reconcileGmailThread(ports, { threadId: "th-multi-task", account: "personal", artifactIds: ["art-multi"], labels: LABELS, dryRun: false });
		expect(checkedIds).toEqual(["task-closed", "task-waiting"]);
		expect(res.hasOpenTask).toBe(true);
		expect(res.decision).toBe("awaiting_reply");
		expect(res.addLabelIds).toContain("Label_314");
	});
});
