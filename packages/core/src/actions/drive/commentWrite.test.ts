import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveApiError, type DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import {
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import type { ActionLedgerEntry } from "../types.js";
import {
	createDriveCommentCreateAction,
	createDriveCommentDeleteAction,
	createDriveCommentReplyAction,
	createDriveCommentUpdateAction,
} from "./commentWrite.js";

const makePort = (overrides: Partial<DrivePort> = {}): DrivePort =>
	({
		createComment: vi.fn().mockResolvedValue({
			id: "c-new-1",
			content: "SECRET_COMMENT_BODY",
			resolved: false,
			createdTime: "2026-11-20T10:00:00Z",
		}),
		createReply: vi.fn().mockResolvedValue({
			id: "r-new-1",
			content: "SECRET_REPLY_BODY",
			action: "resolve",
			createdTime: "2026-11-20T10:01:00Z",
		}),
		updateComment: vi.fn().mockResolvedValue({
			id: "c-1",
			content: "SECRET_UPDATED_BODY",
			resolved: false,
			modifiedTime: "2026-11-20T10:02:00Z",
		}),
		deleteComment: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}) as unknown as DrivePort;

function makeCapturingSink() {
	const entries: ActionLedgerEntry[] = [];
	return {
		entries,
		sink: {
			record: vi.fn(async (entry: ActionLedgerEntry) => {
				entries.push(entry);
			}),
		},
	};
}

function makeInMemoryApprovalStore() {
	const parked: ApprovalRequest[] = [];
	const store: ActionApprovalLifecycleStore = {
		park: vi.fn(async (req: ApprovalRequest) => {
			parked.push(req);
			return { decisionId: `dec-${parked.length}` };
		}),
		claim: vi.fn(async () => null),
		finish: vi.fn(async () => {}),
		reject: vi.fn(async () => true),
	};
	return { parked, store };
}

describe("drive_comment_create, drive_comment_reply, drive_comment_update, drive_comment_delete (#1646)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("case 1: caller mcp parks drive_comment_delete without calling port, while drive_comment_create runs immediately", async () => {
		const deleteComment = vi.fn().mockResolvedValue(undefined);
		const createComment = vi.fn().mockResolvedValue({
			id: "c-10",
			content: "Hello world",
			resolved: false,
			createdTime: "2026-11-20T10:00:00Z",
		});
		const port = makePort({ deleteComment, createComment });
		const { store, parked } = makeInMemoryApprovalStore();
		setActionApprovalStore(store);

		const { sink } = makeCapturingSink();

		await expect(
			executeAction(
				createDriveCommentDeleteAction(port),
				{ domain: "work", file_id: "file-1", comment_id: "c-10" },
				{ context: { caller: "mcp", userId: "u-1" }, sink },
			),
		).rejects.toThrow(PendingApprovalError);
		expect(deleteComment).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);
		expect(parked[0]?.actionId).toBe("drive_comment_delete");

		const created = await executeAction(
			createDriveCommentCreateAction(port),
			{ domain: "work", file_id: "file-1", content: "Hello world", quoted_text: "anchor" },
			{ context: { caller: "mcp", userId: "u-1" }, sink },
		);
		expect(createComment).toHaveBeenCalledWith({
			domain: "work",
			fileId: "file-1",
			content: "Hello world",
			quotedFileContent: { value: "anchor", mimeType: "text/plain" },
		});
		expect(created).toEqual({
			domain: "work",
			file_id: "file-1",
			comment_id: "c-10",
			resolved: false,
			created_at: "2026-11-20T10:00:00Z",
		});
	});

	it("case 2: drive_comment_reply with neither content nor action fails validation; with action: 'resolve' has resolved: true", async () => {
		const createReply = vi.fn().mockResolvedValue({
			id: "r-42",
			action: "resolve",
			createdTime: "2026-11-20T10:05:00Z",
		});
		const replyAction = createDriveCommentReplyAction(makePort({ createReply }));
		const { sink } = makeCapturingSink();

		await expect(
			executeAction(
				replyAction,
				{ domain: "angus", file_id: "file-2", comment_id: "c-2" } as any,
				{ context: { caller: "mcp" }, sink },
			),
		).rejects.toThrow(/Either content or action/);
		expect(createReply).not.toHaveBeenCalled();

		const resolved = await executeAction(
			replyAction,
			{ domain: "angus", file_id: "file-2", comment_id: "c-2", action: "resolve" },
			{ context: { caller: "mcp" }, sink },
		);
		expect(createReply).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "file-2",
			commentId: "c-2",
			action: "resolve",
		});
		expect(resolved).toMatchObject({
			domain: "angus",
			file_id: "file-2",
			comment_id: "c-2",
			reply_id: "r-42",
			action: "resolve",
			resolved: true,
		});
	});

	it("case 3: a 403 on drive_comment_update maps to 'only the author can edit this'", async () => {
		const updateComment = vi.fn().mockRejectedValue(
			new DriveApiError("Forbidden", 403, "forbidden", "PERMISSION_DENIED"),
		);
		const updateAction = createDriveCommentUpdateAction(makePort({ updateComment }));

		await expect(
			executeAction(
				updateAction,
				{ domain: "work", file_id: "file-3", comment_id: "c-3", content: "New text" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			message: expect.stringContaining("only the author can edit this"),
		});
	});

	it("case 4: caller ui drive_comment_delete answered 404 resolves { deleted: false }", async () => {
		const deleteComment = vi.fn().mockRejectedValue(
			new DriveApiError("Not found", 404, "notFound", "NOT_FOUND"),
		);
		const deleteAction = createDriveCommentDeleteAction(makePort({ deleteComment }));
		const { sink } = makeCapturingSink();

		const out = await executeAction(
			deleteAction,
			{ domain: "angus", file_id: "file-4", comment_id: "c-missing" },
			{ context: { caller: "ui" }, sink },
		);
		expect(deleteComment).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "file-4",
			commentId: "c-missing",
		});
		expect(out).toMatchObject({ deleted: false });
		expect(deleteAction.formatMcp!(out)).toContain("deleted=false");
	});

	it("case 5: no result or receipt contains content", async () => {
		const sentinelCreate = "SENSITIVE_CREATE_CONTENT_XYZ";
		const sentinelReply = "SENSITIVE_REPLY_CONTENT_XYZ";
		const sentinelUpdate = "SENSITIVE_UPDATE_CONTENT_XYZ";

		const port = makePort({
			createComment: vi.fn().mockResolvedValue({
				id: "c-1",
				content: sentinelCreate,
				resolved: false,
				createdTime: "2026-11-20T10:00:00Z",
			}),
			createReply: vi.fn().mockResolvedValue({
				id: "r-1",
				content: sentinelReply,
				createdTime: "2026-11-20T10:01:00Z",
			}),
			updateComment: vi.fn().mockResolvedValue({
				id: "c-1",
				content: sentinelUpdate,
				resolved: true,
				modifiedTime: "2026-11-20T10:02:00Z",
			}),
			deleteComment: vi.fn().mockResolvedValue(undefined),
		});

		const createAction = createDriveCommentCreateAction(port);
		const replyAction = createDriveCommentReplyAction(port);
		const updateAction = createDriveCommentUpdateAction(port);
		const deleteAction = createDriveCommentDeleteAction(port);
		const { sink } = makeCapturingSink();

		const created = await executeAction(
			createAction,
			{ domain: "work", file_id: "f-5", content: sentinelCreate },
			{ context: { caller: "mcp" }, sink },
		);
		const replied = await executeAction(
			replyAction,
			{ domain: "work", file_id: "f-5", comment_id: "c-1", content: sentinelReply },
			{ context: { caller: "mcp" }, sink },
		);
		const updated = await executeAction(
			updateAction,
			{ domain: "work", file_id: "f-5", comment_id: "c-1", content: sentinelUpdate },
			{ context: { caller: "mcp" }, sink },
		);
		const deleted = await executeAction(
			deleteAction,
			{ domain: "work", file_id: "f-5", comment_id: "c-1" },
			{ context: { caller: "ui" }, sink },
		);

		const results = [created, replied, updated, deleted];
		const receipts = [
			createAction.formatMcp!(created),
			replyAction.formatMcp!(replied),
			updateAction.formatMcp!(updated),
			deleteAction.formatMcp!(deleted),
		];

		for (const result of results) {
			expect(result).not.toHaveProperty("content");
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain(sentinelCreate);
			expect(serialized).not.toContain(sentinelReply);
			expect(serialized).not.toContain(sentinelUpdate);
		}
		for (const receipt of receipts) {
			expect(receipt).not.toContain("content");
			expect(receipt).not.toContain(sentinelCreate);
			expect(receipt).not.toContain(sentinelReply);
			expect(receipt).not.toContain(sentinelUpdate);
		}
	});
});
