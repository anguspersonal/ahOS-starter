import { describe, expect, it, vi } from "vitest";
import { createGmailModifyAction } from "./modify.js";
import {
	GmailApiError,
	type GmailModifyLabelsParams,
	type GmailModifyLabelsResult,
	type GmailPort,
} from "../../ports/gmail.js";

const ctx = { caller: "test", requestId: "r1" };

function fakePort(
	modifyLabels?: (params: GmailModifyLabelsParams) => Promise<GmailModifyLabelsResult>,
): GmailPort {
	return {
		modifyLabels: vi.fn(
			modifyLabels ??
				(async ({ target, addLabelIds = [] }) => ({
					id: target.id,
					labelIds: addLabelIds,
				})),
		),
	} as unknown as GmailPort;
}

describe("gmail_modify", () => {
	it("modifies a message, defaults to personal (angus), folds mark_read/archive, and matches dev text", async () => {
		const port = fakePort(async ({ target }) => ({
			id: target.id,
			labelIds: ["Label_1"],
		}));
		const action = createGmailModifyAction(port);
		const out = await action.run(
			{
				message_id: "m1",
				add_labels: ["Label_1"],
				remove_labels: ["Label_2"],
				mark_read: true,
				archive: true,
			},
			ctx,
		);

		expect(port.modifyLabels).toHaveBeenCalledWith({
			domain: "angus",
			target: { kind: "message", id: "m1" },
			addLabelIds: ["Label_1"],
			removeLabelIds: ["Label_2", "UNREAD", "INBOX"],
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"Modified message m1 in the 'personal' mailbox.",
				"Added: Label_1",
				"Removed: Label_2, UNREAD, INBOX",
				"Labels now: Label_1",
			].join("\n"),
		);
	});

	it("modifies a thread and folds mark_read=false and archive=false into added labels", async () => {
		const port = fakePort(async ({ target }) => ({
			id: target.id,
			labelIds: ["UNREAD", "INBOX"],
		}));
		const action = createGmailModifyAction(port);
		const out = await action.run(
			{
				thread_id: "t1",
				mark_read: false,
				archive: false,
				domain: "work",
			},
			ctx,
		);

		expect(port.modifyLabels).toHaveBeenCalledWith({
			domain: "work",
			target: { kind: "thread", id: "t1" },
			addLabelIds: ["UNREAD", "INBOX"],
			removeLabelIds: [],
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"Modified thread t1 in the 'work' mailbox.",
				"Added: UNREAD, INBOX",
				"Labels now: UNREAD, INBOX",
			].join("\n"),
		);
	});

	it("deduplicates batch targets and reports partial failures when one target 404s", async () => {
		const port = fakePort(async ({ target }) => {
			if (target.id === "t2") {
				throw new GmailApiError("Not found (404)", 404, "notFound", "NOT_FOUND");
			}
			return { id: target.id, labelIds: [] };
		});
		const action = createGmailModifyAction(port);
		const out = await action.run(
			{
				thread_ids: ["t1", "t2", "t1", "t3"],
				archive: true,
				account: "work",
			},
			ctx,
		);

		expect(port.modifyLabels).toHaveBeenCalledTimes(3);
		expect(action.formatMcp!(out)).toBe(
			[
				"Modified 2/3 thread(s) in the 'work' mailbox: t1, t3",
				"Removed: INBOX",
				"Failed (1): t2 (Not found (404))",
			].join("\n"),
		);
	});

	it("rejects invalid target/label combinations and propagates GmailApiError on single target", async () => {
		const err404 = new GmailApiError("Not found", 404, "notFound", "NOT_FOUND");
		const action = createGmailModifyAction(
			fakePort(async () => {
				throw err404;
			}),
		);

		await expect(action.run({ archive: true }, ctx)).rejects.toThrow(/at least one target/i);
		await expect(
			action.run({ message_id: "m1", thread_id: "t1", archive: true }, ctx),
		).rejects.toThrow(/mix message targets/i);
		await expect(action.run({ message_id: "m1" }, ctx)).rejects.toThrow(/Nothing to do/);
		await expect(
			action.run({ message_id: "m1", archive: true, domain: "work", account: "personal" }, ctx),
		).rejects.toThrow(/different domains/);
		await expect(
			action.run({ message_id: "m1", archive: true }, ctx),
		).rejects.toMatchObject({ name: "GmailApiError", status: 404, reason: "notFound" });
	});
});
