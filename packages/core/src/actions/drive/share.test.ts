import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DriveApiError,
	PERMISSION_CREATE_FIELDS,
	type DrivePort,
} from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { actionResolver, executeApproved } from "../approvals.js";
import {
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import { createDriveShareAction } from "./share.js";

function makePort(overrides: Partial<DrivePort> = {}): DrivePort {
	return {
		getFile: vi.fn(),
		listFiles: vi.fn(),
		listPermissions: vi.fn(),
		createPermission: vi.fn(),
		createFile: vi.fn(),
		copyFile: vi.fn(),
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		exportFile: vi.fn(),
		updateFile: vi.fn(),
		trashFile: vi.fn(),
		deleteFile: vi.fn(),
		deletePermission: vi.fn(),
		listRevisions: vi.fn(),
		getRevision: vi.fn(),
		downloadRevision: vi.fn(),
		updateRevision: vi.fn(),
		deleteRevision: vi.fn(),
		...overrides,
	};
}

function makeLifecycleStore() {
	const parked: ApprovalRequest[] = [];
	const store: ActionApprovalLifecycleStore = {
		park: vi.fn(async (req: ApprovalRequest) => {
			parked.push(req);
			return { decisionId: `dec-${parked.length}` };
		}),
		claim: vi.fn(async (decisionId: string) => {
			const req = parked[Number(decisionId.replace("dec-", "")) - 1];
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
	return { store, parked };
}

describe("drive_share core action (#1505)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("runs user/reader and group/writer immediately without parking and formats dev receipts", async () => {
		const { store, parked } = makeLifecycleStore();
		setActionApprovalStore(store);

		const createPermission = vi
			.fn()
			.mockResolvedValueOnce({
				id: "perm-1",
				role: "reader",
				type: "user",
				emailAddress: "alice@example.com",
			})
			.mockResolvedValueOnce({
				id: "perm-2",
				role: "writer",
				type: "group",
				emailAddress: "eng@example.com",
			});
		const action = createDriveShareAction(makePort({ createPermission }));

		const userOut = await executeAction(
			action,
			{ file_id: "f1", type: "user", role: "reader", email_address: "alice@example.com" },
			{ context: { caller: "mcp", userId: "u-1" } },
		);
		const groupOut = await executeAction(
			action,
			{
				file_id: "f1",
				type: "group",
				role: "writer",
				email_address: "eng@example.com",
				account: "work",
				send_notification: true,
			},
			{ context: { caller: "mcp", userId: "u-1" } },
		);

		expect(parked).toHaveLength(0);
		expect(createPermission).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			fileId: "f1",
			role: "reader",
			type: "user",
			emailAddress: "alice@example.com",
			granteeDomain: undefined,
			sendNotificationEmail: false,
			transferOwnership: undefined,
			fields: PERMISSION_CREATE_FIELDS,
		});
		expect(createPermission).toHaveBeenNthCalledWith(2, {
			domain: "work",
			fileId: "f1",
			role: "writer",
			type: "group",
			emailAddress: "eng@example.com",
			granteeDomain: undefined,
			sendNotificationEmail: true,
			transferOwnership: undefined,
			fields: PERMISSION_CREATE_FIELDS,
		});
		expect(action.formatMcp!(userOut)).toBe(
			"Shared f1: granted reader to alice@example.com (permission id perm-1).",
		);
		expect(action.formatMcp!(groupOut)).toBe(
			"Shared f1: granted writer to eng@example.com (permission id perm-2).",
		);
	});

	it("parks anyone/reader, domain/reader, and user/owner with no Google call until approved", async () => {
		const { store, parked } = makeLifecycleStore();
		setActionApprovalStore(store);

		const createPermission = vi
			.fn()
			.mockResolvedValueOnce({ id: "perm-3", role: "reader", type: "anyone" })
			.mockResolvedValueOnce({
				id: "perm-4",
				role: "reader",
				type: "domain",
				domain: "example.com",
			})
			.mockResolvedValueOnce({
				id: "perm-5",
				role: "owner",
				type: "user",
				emailAddress: "alice@example.com",
			});
		const action = createDriveShareAction(makePort({ createPermission }));

		for (const input of [
			{ file_id: "f1", type: "anyone" as const, role: "reader" as const },
			{
				file_id: "f1",
				type: "domain" as const,
				role: "reader" as const,
				grantee_domain: "example.com",
			},
			{
				file_id: "f1",
				type: "user" as const,
				role: "owner" as const,
				email_address: "alice@example.com",
			},
		]) {
			await expect(
				executeAction(action, input, { context: { caller: "mcp", userId: "u-1" } }),
			).rejects.toThrow(PendingApprovalError);
		}
		expect(createPermission).not.toHaveBeenCalled();
		expect(parked).toHaveLength(3);

		const resolve = actionResolver((id) => (id === "drive_share" ? action : undefined));
		const r1 = await executeApproved("dec-1", {
			store,
			resolve,
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});
		const r2 = await executeApproved("dec-2", {
			store,
			resolve,
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});
		const r3 = await executeApproved("dec-3", {
			store,
			resolve,
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});

		expect(createPermission).toHaveBeenCalledTimes(3);
		expect(createPermission.mock.calls[2]?.[0]).toMatchObject({
			role: "owner",
			transferOwnership: true,
		});
		expect(action.formatMcp!((r1 as any).result)).toBe(
			"Shared f1: granted reader to anyone (permission id perm-3).",
		);
		expect(action.formatMcp!((r2 as any).result)).toBe(
			"Shared f1: granted reader to example.com (permission id perm-4).",
		);
		expect(action.formatMcp!((r3 as any).result)).toBe(
			"Shared f1: granted owner to alice@example.com (permission id perm-5).",
		);
	});

	it("refuses missing email_address, missing grantee_domain, and conflicting domain/account before any gate, and propagates DriveApiError", async () => {
		const { store, parked } = makeLifecycleStore();
		setActionApprovalStore(store);

		const createPermission = vi
			.fn()
			.mockRejectedValue(
				new DriveApiError(
					"Google Drive API error (HTTP 403): Insufficient permissions",
					403,
					"insufficientFilePermissions",
					"PERMISSION_DENIED",
				),
			);
		const action = createDriveShareAction(makePort({ createPermission }));

		await expect(
			executeAction(
				action,
				{ file_id: "f1", type: "user", role: "owner" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow("type 'user' requires email_address.");

		await expect(
			executeAction(
				action,
				{ file_id: "f1", type: "group", role: "writer" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow("type 'group' requires email_address.");

		await expect(
			executeAction(
				action,
				{ file_id: "f1", type: "domain", role: "reader" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(
			"type 'domain' requires grantee_domain (the Workspace domain to grant access to, e.g. 'example.com').",
		);

		await expect(
			executeAction(
				action,
				{ file_id: "f1", type: "anyone", role: "reader", domain: "work", account: "personal" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(/name different domains/);

		expect(parked).toHaveLength(0);
		expect(createPermission).not.toHaveBeenCalled();

		await expect(
			executeAction(
				action,
				{ file_id: "f1", type: "user", role: "reader", email_address: "alice@example.com" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			reason: "insufficientFilePermissions",
		});
	});
});
