import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import {
	createDriveHygieneHealAction,
	formatDriveHygieneHealMcp,
	isSafeAutoDeleteOsJunk,
	planBand1DriveHygieneOperations,
	selectCanonicalKeeper,
	type DriveHygieneHealPorts,
	type ScannedDriveFile,
} from "./driveHygieneHeal.js";

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

function createFakePorts(): {
	ports: DriveHygieneHealPorts;
	deleteItems: ReturnType<typeof vi.fn>;
	updateItem: ReturnType<typeof vi.fn>;
	trashFile: ReturnType<typeof vi.fn>;
} {
	const deleteItems = vi.fn().mockImplementation(async ({ itemIds }) => ({
		deletedItemIds: itemIds,
		failed: [],
	}));
	const updateItem = vi.fn().mockImplementation(async ({ itemId, name }) => ({
		id: itemId,
		name: name ?? "updated",
	}));
	const trashFile = vi.fn().mockResolvedValue({ id: "gd-dup-2", trashed: true });

	const ports: DriveHygieneHealPorts = {
		onedrive: {
			listChildren: vi.fn().mockImplementation(async ({ path }) => {
				if (!path) {
					return {
						items: [
							{
								id: "od-folder-tosort",
								name: "8.To Sort",
								folder: { childCount: 3 },
							},
							{
								id: "od-root-junk",
								name: ".DS_Store",
								size: 6148,
								parentReference: { id: "od-root" },
								file: { hashes: { sha256Hash: "hash-ds" } },
							},
							{
								id: "od-root-loose",
								name: "Unfiled Receipt (1).pdf",
								size: 120_000,
								parentReference: { id: "od-root" },
								file: { hashes: { sha256Hash: "hash-receipt" } },
							},
						],
					};
				}
				if (path === "8.To Sort") {
					return {
						items: [
							{
								id: "od-keep-1",
								name: "Contract.pdf",
								size: 500_000,
								createdDateTime: "2026-01-01T00:00:00Z",
								parentReference: { id: "od-folder-tosort" },
								file: { hashes: { sha256Hash: "hash-contract" } },
							},
							{
								id: "od-dup-1",
								name: "Contract 1.pdf",
								size: 500_000,
								createdDateTime: "2026-01-02T00:00:00Z",
								parentReference: { id: "od-folder-tosort" },
								file: { hashes: { sha256Hash: "hash-contract" } },
							},
							{
								id: "od-orphan-copy",
								name: "Orphan Note (1).txt",
								size: 4_096,
								parentReference: { id: "od-folder-tosort" },
								file: { hashes: { sha256Hash: "hash-orphan" } },
							},
						],
					};
				}
				return { items: [] };
			}),
			deleteItems,
			updateItem,
		} as unknown as DriveHygieneHealPorts["onedrive"],
		drive: {
			listFiles: vi.fn().mockResolvedValue({
				files: [
					{
						id: "gd-keep-1",
						name: "Deck.pdf",
						mimeType: "application/pdf",
						size: "1000000",
						parents: ["gd-folder-1"],
						sha256Checksum: "hash-deck",
						createdTime: "2026-01-01T00:00:00Z",
					},
					{
						id: "gd-dup-2",
						name: "Deck (1).pdf",
						mimeType: "application/pdf",
						size: "1000000",
						parents: ["gd-folder-1"],
						sha256Checksum: "hash-deck",
						createdTime: "2026-01-03T00:00:00Z",
					},
				],
			}),
			trashFile,
		} as unknown as DriveHygieneHealPorts["drive"],
	};

	return { ports, deleteItems, updateItem, trashFile };
}

describe("drive_hygiene_heal action (Stage 7A Band 1 Self-Heal)", () => {
	it("selects canonical keeper deterministically (clean name -> earliest created -> shortest name)", () => {
		expect(isSafeAutoDeleteOsJunk(".DS_Store")).toBe(true);
		expect(isSafeAutoDeleteOsJunk("Thumbs.db")).toBe(true);
		expect(isSafeAutoDeleteOsJunk("desktop.ini")).toBe(true);
		expect(isSafeAutoDeleteOsJunk("~$LockFile.docx")).toBe(false);

		const { keeper, redundant } = selectCanonicalKeeper([
			{ id: "b", name: "Invoice (1).pdf", createdAt: "2026-01-01T00:00:00Z" },
			{ id: "a", name: "Invoice.pdf", createdAt: "2026-02-01T00:00:00Z" },
			{ id: "c", name: "Copy of Invoice.pdf", createdAt: "2026-01-01T00:00:00Z" },
		]);

		expect(keeper.id).toBe("a");
		expect(redundant.map((r) => r.id)).toEqual(["b", "c"]);
	});

	it("plans Band 1 operations across all 4 levers without colliding renames", () => {
		const files: ScannedDriveFile[] = [
			{
				provider: "onedrive",
				domain: "angus",
				id: "junk-1",
				name: ".DS_Store",
				parentKey: "p1",
				folderLabel: "8.To Sort",
				sizeBytes: 4096,
				hash: "h-junk",
				createdAt: null,
			},
			{
				provider: "onedrive",
				domain: "angus",
				id: "keep-1",
				name: "Report.pdf",
				parentKey: "p1",
				folderLabel: "8.To Sort",
				sizeBytes: 100_000,
				hash: "h-report",
				createdAt: "2026-01-01T00:00:00Z",
			},
			{
				provider: "onedrive",
				domain: "angus",
				id: "dup-1",
				name: "Report (1).pdf",
				parentKey: "p1",
				folderLabel: "8.To Sort",
				sizeBytes: 100_000,
				hash: "h-report",
				createdAt: "2026-01-02T00:00:00Z",
			},
			{
				provider: "onedrive",
				domain: "angus",
				id: "orphan-1",
				name: "Solo (1).pdf",
				parentKey: "p1",
				folderLabel: "8.To Sort",
				sizeBytes: 50_000,
				hash: "h-solo",
				createdAt: null,
			},
			{
				provider: "onedrive",
				domain: "angus",
				id: "root-1",
				name: "Loose.pdf",
				parentKey: "root-id",
				folderLabel: "root",
				sizeBytes: 25_000,
				hash: "h-loose",
				createdAt: null,
			},
		];

		const planned = planBand1DriveHygieneOperations({
			files,
			levers: [
				"delete_os_junk",
				"dedup_same_folder",
				"rename_orphan_counter_copies",
				"file_root_loose_to_sort",
			],
			oneDriveToSortFolderId: "tosort-id",
		});

		expect(planned.map((op) => ({ lever: op.lever, id: op.item_id }))).toEqual([
			{ lever: "delete_os_junk", id: "junk-1" },
			{ lever: "dedup_same_folder", id: "dup-1" },
			{ lever: "rename_orphan_counter_copies", id: "orphan-1" },
			{ lever: "file_root_loose_to_sort", id: "root-1" },
		]);
	});

	it("defaults to dry_run=true without mutating OneDrive or Google Drive", async () => {
		const { ports, deleteItems, updateItem, trashFile } = createFakePorts();
		const action = createDriveHygieneHealAction(ports);

		const result = await executeAction(
			action,
			{},
			{ context: { userId: TEST_USER_ID, caller: "test" }, auditSink: () => {} },
		);

		expect(result.dry_run).toBe(true);
		expect(result.summary.candidates_found).toBe(6);
		expect(result.summary.executed_count).toBe(0);
		expect(deleteItems).not.toHaveBeenCalled();
		expect(updateItem).not.toHaveBeenCalled();
		expect(trashFile).not.toHaveBeenCalled();

		const mcpText = formatDriveHygieneHealMcp(result);
		expect(mcpText).toContain("Drive Hygiene Self-Heal (DRY-RUN PREVIEW)");
	});

	it("executes bounded Band 1 mutations when dry_run=false and respects max_actions cap", async () => {
		const { ports, deleteItems, updateItem, trashFile } = createFakePorts();
		const action = createDriveHygieneHealAction(ports);

		const result = await executeAction(
			action,
			{ dry_run: false, max_actions: 4 },
			{ context: { userId: TEST_USER_ID, caller: "test" }, auditSink: () => {} },
		);

		expect(result.dry_run).toBe(false);
		expect(result.summary.candidates_found).toBe(6);
		expect(result.summary.planned_within_cap).toBe(4);
		expect(result.summary.executed_count).toBe(4);
		expect(result.summary.skipped_cap_count).toBe(2);

		// First 4 operations are:
		// 1. delete_os_junk (od-root-junk)
		// 2. dedup_same_folder (od-dup-1)
		// 3. dedup_same_folder (gd-dup-2)
		// 4. rename_orphan_counter_copies (od-root-loose -> Unfiled Receipt.pdf)
		expect(deleteItems).toHaveBeenCalledWith({
			itemIds: ["od-root-junk", "od-dup-1"],
		});
		expect(trashFile).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "gd-dup-2",
		});
		expect(updateItem).toHaveBeenCalledWith({
			itemId: "od-root-loose",
			name: "Unfiled Receipt.pdf",
			conflictBehavior: "fail",
		});
	});

	it("follows multi-page cursors and excludes Personal Vault system root item", async () => {
		const { ports, updateItem } = createFakePorts();
		ports.onedrive.listChildren = vi.fn().mockImplementation(async ({ path, cursor }) => {
			if (!path) {
				return {
					items: [
						{ id: "tosort-folder", name: "8.To Sort", folder: { childCount: 2 } },
						{ id: "vault-id", name: "Personal Vault", size: 0 },
					],
				};
			}
			if (path === "8.To Sort" && !cursor) {
				return {
					items: [
						{
							id: "page1-keep",
							name: "Contract.pdf",
							size: 5000,
							parentReference: { id: "tosort-folder" },
							file: { hashes: { sha256Hash: "hash-contract" } },
						},
					],
					nextCursor: "cursor-page-2",
				};
			}
			if (path === "8.To Sort" && cursor === "cursor-page-2") {
				return {
					items: [
						{
							id: "page2-dup",
							name: "Contract (1).pdf",
							size: 5000,
							parentReference: { id: "tosort-folder" },
							file: { hashes: { sha256Hash: "hash-contract" } },
						},
					],
				};
			}
			return { items: [] };
		});
		ports.drive.listFiles = vi.fn().mockResolvedValue({ files: [] });

		const action = createDriveHygieneHealAction(ports);
		const result = await executeAction(
			action,
			{ dry_run: false, max_actions: 10 },
			{ context: { userId: TEST_USER_ID, caller: "test" }, auditSink: () => {} },
		);

		// Personal Vault must NOT be moved to 8.To Sort; page2-dup from page 2 is deduplicated against page1-keep
		expect(updateItem).not.toHaveBeenCalled();
		expect(result.summary.by_lever.file_root_loose_to_sort.candidates).toBe(0);
		expect(result.summary.by_lever.dedup_same_folder.candidates).toBe(1);
	});

	it("treats 3-digit counter copies (100..999) as non-canonical so clean keepers win regardless of timestamp", () => {
		const { keeper, redundant } = selectCanonicalKeeper([
			{
				id: "dup-100",
				name: "About Us – TeamVine 100.pptx",
				createdAt: "2025-01-01T00:00:00Z",
			},
			{
				id: "clean",
				name: "About Us – TeamVine.pptx",
				createdAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "dup-155",
				name: "About Us – TeamVine 155.pptx",
				createdAt: "2025-01-01T00:00:00Z",
			},
		]);

		expect(keeper.id).toBe("clean");
		expect(redundant.map((r) => r.id)).toEqual(["dup-100", "dup-155"]);
	});

	it("pages beyond the 5-page minimum window when earlier pages are already clean keepers", async () => {
		const { ports, deleteItems } = createFakePorts();
		ports.onedrive.listChildren = vi.fn().mockImplementation(async ({ path, cursor }) => {
			if (!path) {
				return {
					items: [{ id: "tosort-folder", name: "8.To Sort", folder: { childCount: 10 } }],
				};
			}
			if (path === "8.To Sort") {
				const pageNum = cursor ? Number(cursor.replace("page-", "")) : 1;
				// Pages 1..6 contain only unique canonical keepers; page 7 has a duplicate pair
				if (pageNum <= 6) {
					return {
						items: [
							{
								id: `unique-${pageNum}`,
								name: `Unique-${pageNum}.pdf`,
								size: 4096,
								parentReference: { id: "tosort-folder" },
								file: { hashes: { sha256Hash: `hash-unique-${pageNum}` } },
							},
						],
						nextCursor: `page-${pageNum + 1}`,
					};
				}
				return {
					items: [
						{
							id: "deep-keep",
							name: "DeepFile.pptx",
							size: 8192,
							parentReference: { id: "tosort-folder" },
							file: { hashes: { sha256Hash: "hash-deep" } },
						},
						{
							id: "deep-dup-100",
							name: "DeepFile 100.pptx",
							size: 8192,
							parentReference: { id: "tosort-folder" },
							file: { hashes: { sha256Hash: "hash-deep" } },
						},
					],
				};
			}
			return { items: [] };
		});
		ports.drive.listFiles = vi.fn().mockResolvedValue({ files: [] });

		const action = createDriveHygieneHealAction(ports);
		const result = await executeAction(
			action,
			{ dry_run: false, max_actions: 10, provider: "onedrive" },
			{ context: { userId: TEST_USER_ID, caller: "test" }, auditSink: () => {} },
		);

		expect(result.summary.candidates_found).toBe(1);
		expect(result.summary.executed_count).toBe(1);
		expect(deleteItems).toHaveBeenCalledWith({ itemIds: ["deep-dup-100"] });
	});
});
