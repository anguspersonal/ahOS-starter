import { describe, expect, it, vi } from "vitest";
import type { GmailPort } from "../../ports/gmail.js";
import type { GmailReconcileStore } from "../../ports/gmailReconcile.js";
import type { NotionPageResponse, NotionPort } from "../../ports/notion.js";
import {
	checkNotionTaskStatus,
	findCapturedGmailThreads,
	resolveWorkflowLabels,
} from "./reconcileLookups.js";
import { GMAIL_RECONCILE_LABEL_NAMES, GMAIL_RECONCILE_PERSONAL_LABEL_IDS } from "./reconcileRules.js";

function notionFake(handler: NotionPort["retrievePage"]): Pick<NotionPort, "retrievePage"> {
	return { retrievePage: handler };
}

function notionError(message: string, status?: number): Error {
	return Object.assign(new Error(message), { name: "NotionApiError" as const, ...(status !== undefined ? { status } : {}) });
}

describe("checkNotionTaskStatus", () => {
	it("case 1: archived page is closed and not waiting", async () => {
		const notion = notionFake(async () => ({ id: "p1", archived: true, properties: {} }));
		expect(await checkNotionTaskStatus(notion, "p1", "notion_personal")).toEqual({ isOpen: false, isWaitingOn: false });
	});

	it("case 2: first status or select property with a name decides closed / waiting / open", async () => {
		const makePage = (properties: NotionPageResponse["properties"]): NotionPageResponse => ({
			id: "p2",
			archived: false,
			properties,
		});
		const statusProp = (name: string) => ({ Status: { type: "status", status: { name } } });
		const selectProp = (name: string) => ({ Stage: { type: "select", select: { name } } });

		expect(await checkNotionTaskStatus(notionFake(async () => makePage(statusProp("  DONE "))), "p2", "notion_personal"))
			.toEqual({ isOpen: false, isWaitingOn: false });
		expect(await checkNotionTaskStatus(notionFake(async () => makePage(selectProp("Cancelled"))), "p2", "notion_personal"))
			.toEqual({ isOpen: false, isWaitingOn: false });
		expect(await checkNotionTaskStatus(notionFake(async () => makePage(statusProp("Waiting On"))), "p2", "notion_personal"))
			.toEqual({ isOpen: true, isWaitingOn: true });
		expect(await checkNotionTaskStatus(notionFake(async () => makePage(statusProp("In progress"))), "p2", "notion_personal"))
			.toEqual({ isOpen: true, isWaitingOn: false });
	});

	it("case 3: page with no status or select property is open and not waiting", async () => {
		const notion = notionFake(async () => ({
			id: "p3",
			archived: false,
			properties: { Name: { type: "title", title: [] } },
		}));
		expect(await checkNotionTaskStatus(notion, "p3", "notion_personal")).toEqual({ isOpen: true, isWaitingOn: false });
	});

	it("case 4: NotionApiError 404 is closed; other errors (including missing token or text with 404) are open", async () => {
		expect(await checkNotionTaskStatus(notionFake(async () => { throw notionError("Not found", 404); }), "p4", "notion_personal"))
			.toEqual({ isOpen: false, isWaitingOn: false });
		expect(await checkNotionTaskStatus(notionFake(async () => { throw notionError("Rate limited", 429); }), "p4", "notion_personal"))
			.toEqual({ isOpen: true, isWaitingOn: false });
		expect(await checkNotionTaskStatus(notionFake(async () => { throw new Error("Missing token; ref 404"); }), "p4", "notion_personal"))
			.toEqual({ isOpen: true, isWaitingOn: false });
	});

	it("case 5: maps notion_personal to angus, and notion_work or other providers to work", async () => {
		const calls: Array<{ workspace: string; pageId: string }> = [];
		const notion = notionFake(async (params) => {
			calls.push(params);
			return { id: params.pageId, archived: false, properties: {} };
		});
		await checkNotionTaskStatus(notion, "id-1", "notion_personal");
		await checkNotionTaskStatus(notion, "id-2", "notion_work");
		await checkNotionTaskStatus(notion, "id-3", "other_provider");
		expect(calls).toEqual([
			{ workspace: "angus", pageId: "id-1" },
			{ workspace: "work", pageId: "id-2" },
			{ workspace: "work", pageId: "id-3" },
		]);
	});
});

describe("resolveWorkflowLabels", () => {
	it("case 6: matches names case-insensitively and falls back for 6: awaiting reply", async () => {
		const ensureLabel = vi.fn();
		const gmail: Pick<GmailPort, "listLabels" | "ensureLabel"> = {
			listLabels: async () => [
				{ id: "id-a", name: "ahos" },
				{ id: "id-p", name: "AHOSPROCESSED" },
				{ id: "id-pa", name: "pending action" },
				{ id: "id-w", name: "Waiting On" },
			],
			ensureLabel,
		};
		expect(await resolveWorkflowLabels(gmail, "work")).toEqual({
			ahosId: "id-a", ahosProcessedId: "id-p", pendingActionId: "id-pa", awaitingReplyId: "id-w",
		});
		const gmail2: Pick<GmailPort, "listLabels" | "ensureLabel"> = {
			listLabels: async () => [
				{ id: "id-a", name: "AhOS" },
				{ id: "id-p", name: "AhOSProcessed" },
				{ id: "id-pa", name: "Pending Action" },
				{ id: "id-ar", name: "Awaiting Reply" },
			],
			ensureLabel,
		};
		expect((await resolveWorkflowLabels(gmail2, "work")).awaitingReplyId).toBe("id-ar");
		expect(ensureLabel).not.toHaveBeenCalled();
	});

	it("case 7: personal account falls back to GMAIL_RECONCILE_PERSONAL_LABEL_IDS when present; work does not", async () => {
		const listed = Object.values(GMAIL_RECONCILE_PERSONAL_LABEL_IDS).map((id, i) => ({ id, name: `Renamed_${i}` }));
		const created: string[] = [];
		const makeGmail = (): Pick<GmailPort, "listLabels" | "ensureLabel"> => ({
			listLabels: async () => listed,
			ensureLabel: async ({ name }) => {
				created.push(name);
				return { label: { id: `new-${name}`, name }, created: true };
			},
		});

		expect(await resolveWorkflowLabels(makeGmail(), "personal")).toEqual({
			ahosId: GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AHOS,
			ahosProcessedId: GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AHOS_PROCESSED,
			pendingActionId: GMAIL_RECONCILE_PERSONAL_LABEL_IDS.PENDING_ACTION,
			awaitingReplyId: GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AWAITING_REPLY,
		});
		expect(created).toEqual([]);

		expect(await resolveWorkflowLabels(makeGmail(), "work")).toEqual({
			ahosId: `new-${GMAIL_RECONCILE_LABEL_NAMES.AHOS}`,
			ahosProcessedId: `new-${GMAIL_RECONCILE_LABEL_NAMES.AHOS_PROCESSED}`,
			pendingActionId: `new-${GMAIL_RECONCILE_LABEL_NAMES.PENDING_ACTION}`,
			awaitingReplyId: `new-${GMAIL_RECONCILE_LABEL_NAMES.AWAITING_REPLY}`,
		});
	});

	it("case 8 & 9: creates missing labels in order and falls back to ensureLabel when listLabels throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const calls: Array<{ domain: string; name: string }> = [];
		const gmail: Pick<GmailPort, "listLabels" | "ensureLabel"> = {
			listLabels: async () => { throw new Error("boom"); },
			ensureLabel: async (params) => {
				calls.push(params);
				return { label: { id: `created:${params.name}`, name: params.name }, created: true };
			},
		};
		const result = await resolveWorkflowLabels(gmail, "personal");
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();

		expect(calls).toEqual([
			{ domain: "angus", name: GMAIL_RECONCILE_LABEL_NAMES.AHOS },
			{ domain: "angus", name: GMAIL_RECONCILE_LABEL_NAMES.AHOS_PROCESSED },
			{ domain: "angus", name: GMAIL_RECONCILE_LABEL_NAMES.PENDING_ACTION },
			{ domain: "angus", name: GMAIL_RECONCILE_LABEL_NAMES.AWAITING_REPLY },
		]);
		expect(result).toEqual({
			ahosId: "created:AhOS",
			ahosProcessedId: "created:AhOSProcessed",
			pendingActionId: "created:Pending Action",
			awaitingReplyId: "created:6: awaiting reply",
		});
	});
});

describe("findCapturedGmailThreads", () => {
	it("case 10 & 11: deduplicates threads, keeps first account and row order, skips non-matches, forwards userId", async () => {
		const seenUserIds: Array<string | undefined> = [];
		const store: Pick<GmailReconcileStore, "listCandidateGmailArtifacts" | "listCandidateGmailExternalLinks"> = {
			listCandidateGmailArtifacts: async (userId) => {
				seenUserIds.push(userId);
				return [
					{ id: "art-1", text: "Thread: 18f1111111111111", tags: ["account:work"] },
					{ id: "art-skip", text: "No thread ref" },
					{ id: "art-2", text: "Thread: 18f2222222222222" },
					{ id: "art-1-dup", text: "Thread: 18f1111111111111", tags: ["account:personal"] },
					{ id: "art-1", text: "Thread: 18f1111111111111" },
				];
			},
			listCandidateGmailExternalLinks: async (userId) => {
				seenUserIds.push(userId);
				return [];
			},
		};

		const map1 = await findCapturedGmailThreads(store, "user-42");
		expect(seenUserIds).toEqual(["user-42", "user-42"]);
		expect([...map1.entries()]).toEqual([
			["18f1111111111111", { threadId: "18f1111111111111", account: "work", artifactIds: ["art-1", "art-1-dup"] }],
			["18f2222222222222", { threadId: "18f2222222222222", account: "personal", artifactIds: ["art-2"] }],
		]);

		seenUserIds.length = 0;
		await findCapturedGmailThreads(store);
		expect(seenUserIds).toEqual([undefined, undefined]);
	});
});
