import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveApiError, type DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { actionResolver, executeApproved } from "../approvals.js";
import {
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import { createDriveDeleteAction, createDriveUnshareAction } from "./deleteAndUnshare.js";

function makePort(overrides: Partial<DrivePort> = {}): DrivePort {
	return {
		getFile: vi.fn(),
		listFiles: vi.fn(),
		listPermissions: vi.fn(),
		createFile: vi.fn(),
		copyFile: vi.fn(),
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		exportFile: vi.fn(),
		updateFile: vi.fn(),
		trashFile: vi.fn(),
		deleteFile: vi.fn().mockResolvedValue(undefined),
		deletePermission: vi.fn().mockResolvedValue(undefined),
		listRevisions: vi.fn(),
		getRevision: vi.fn(),
		downloadRevision: vi.fn(),
		updateRevision: vi.fn(),
		deleteRevision: vi.fn(),
		...overrides,
	};
}

describe("drive_delete and drive_unshare core actions (#1496)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("drive_delete from caller 'mcp' parks for approval without calling deleteFile, and replays via executeApproved", async () => {
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const port = makePort({ deleteFile });
		const action = createDriveDeleteAction(port);

		const parked: ApprovalRequest[] = [];
		const lifecycleStore: ActionApprovalLifecycleStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
			claim: vi.fn(async (decisionId: string) => {
				const idx = Number(decisionId.replace("dec-", "")) - 1;
				const req = parked[idx];
				if (!req) return null;
				return {
					decisionId,
					actionId: req.actionId,
					input: req.input,
					inputSha256: req.inputSha256,
					caller: req.caller,
					userId: req.userId ?? "u-1",
				};
			}),
			finish: vi.fn(async () => {}),
			reject: vi.fn(async () => true),
		};
		setActionApprovalStore(lifecycleStore);

		await expect(
			executeAction(
				action,
				{ file_id: "file-del-1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);
		expect(deleteFile).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);
		expect(parked[0]?.actionId).toBe("drive_delete");

		const replay = await executeApproved("dec-1", {
			store: lifecycleStore,
			resolve: actionResolver((id) => (id === "drive_delete" ? action : undefined)),
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});
		expect(replay).toEqual({
			status: "executed",
			result: { domain: "angus", file_id: "file-del-1", deleted: true },
		});
		expect(deleteFile).toHaveBeenCalledWith("angus", "file-del-1");
		expect(action.formatMcp!((replay as any).result)).toBe(
			"Permanently deleted file-del-1 (not recoverable).",
		);
	});

	it("drive_delete from caller 'ui' executes immediately and formats receipt", async () => {
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const action = createDriveDeleteAction(makePort({ deleteFile }));

		const out = await executeAction(
			action,
			{ file_id: "file-del-2", domain: "work" },
			{ context: { caller: "ui" } },
		);

		expect(deleteFile).toHaveBeenCalledWith("work", "file-del-2");
		expect(out).toEqual({ domain: "work", file_id: "file-del-2", deleted: true });
		expect(action.formatMcp!(out)).toBe(
			"Permanently deleted file-del-2 (not recoverable).",
		);
	});

	it("drive_unshare from caller 'mcp' executes immediately without parking and formats receipt", async () => {
		const deletePermission = vi.fn().mockResolvedValue(undefined);
		const action = createDriveUnshareAction(makePort({ deletePermission }));

		const out = await executeAction(
			action,
			{ file_id: "file-77", permission_id: "perm-9", account: "work" },
			{ context: { caller: "mcp" } },
		);

		expect(deletePermission).toHaveBeenCalledWith("work", "file-77", "perm-9");
		expect(out).toEqual({
			domain: "work",
			file_id: "file-77",
			permission_id: "perm-9",
			revoked: true,
		});
		expect(action.formatMcp!(out)).toBe(
			"Revoked permission perm-9 on file-77.",
		);
	});

	it("rejects conflicting domain and account and propagates DriveApiError status and reason", async () => {
		const deleteFile = vi.fn().mockRejectedValue(
			new DriveApiError("Google Drive API error (HTTP 404): File not found", 404, "notFound", "NOT_FOUND"),
		);
		const deletePermission = vi.fn().mockRejectedValue(
			new DriveApiError("Google Drive API error (HTTP 403): Insufficient permissions", 403, "insufficientFilePermissions", "PERMISSION_DENIED"),
		);
		const deleteAction = createDriveDeleteAction(makePort({ deleteFile }));
		const unshareAction = createDriveUnshareAction(makePort({ deletePermission }));

		await expect(
			executeAction(
				deleteAction,
				{ file_id: "file-1", domain: "work", account: "personal" },
				{ context: { caller: "ui" } },
			),
		).rejects.toThrow(/name different domains/);

		await expect(
			executeAction(
				deleteAction,
				{ file_id: "missing-id" },
				{ context: { caller: "ui" } },
			),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 404,
			reason: "notFound",
		});

		await expect(
			executeAction(
				unshareAction,
				{ file_id: "file-1", permission_id: "perm-1" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			reason: "insufficientFilePermissions",
		});
	});
});
