import { z } from "zod";
import type {
	OneDriveBatchDeleteFailure,
	OneDriveItem,
	OneDrivePort,
} from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { onedriveConflictBehaviorSchema } from "./write.js";

const MAX_DELETE_BATCH_SIZE = 100;

export const PROTECTED_ONEDRIVE_TOP_LEVEL_FOLDERS = [
	"1.Projects",
	"2.Areas",
	"3.Resources",
	"4.Archive",
	"8.To Sort",
	"Backup - Google Drive",
] as const;

const PROTECTED_TOP_LEVEL_LOWER = new Set(
	PROTECTED_ONEDRIVE_TOP_LEVEL_FOLDERS.map((name) => name.toLowerCase()),
);

function isRootParentPath(parentPath: string | undefined): boolean {
	if (!parentPath) return false;
	const normalized = parentPath.trim().replace(/\/+$/, "").toLowerCase();
	return normalized === "/drive/root:" || normalized === "/drive/root";
}

function isOneDriveRootItem(requestedId: string, item: OneDriveItem): boolean {
	if (requestedId.trim().toLowerCase() === "root") {
		return true;
	}
	if (item.id.trim().toLowerCase() === "root") {
		return true;
	}
	if (!item.parentReference || !item.parentReference.path) {
		return true;
	}
	return false;
}

export const onedriveMoveInputSchema = z.object({
	item_id: z.string().min(1).describe("OneDrive item ID to move."),
	new_parent_id: z
		.string()
		.min(1)
		.describe("Destination parent folder item ID (or 'root')."),
	new_name: z
		.string()
		.min(1)
		.optional()
		.describe("Optional new name for the item in the destination folder."),
	conflict_behavior: onedriveConflictBehaviorSchema
		.optional()
		.describe(
			"Conflict behavior if an item with the same name exists in the destination ('fail', 'replace', or 'rename'; default 'fail').",
		),
});

export type OnedriveMoveInput = z.infer<typeof onedriveMoveInputSchema>;

/**
 * Create the `onedrive_move` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveMoveAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveMoveInputSchema, OneDriveItem> {
	return defineAction({
		id: "onedrive_move",
		name: "onedrive_move",
		description:
			"Move a personal OneDrive item to new_parent_id (optionally renaming it via new_name).",
		domain: "integrations",
		schema: onedriveMoveInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveMoveInput,
			_context: ActionContext,
		): Promise<OneDriveItem> {
			return port.updateItem({
				itemId: input.item_id,
				newParentId: input.new_parent_id,
				name: input.new_name,
				conflictBehavior: input.conflict_behavior ?? "fail",
			});
		},
	});
}

export const onedriveRenameInputSchema = z.object({
	item_id: z.string().min(1).describe("OneDrive item ID to rename."),
	name: z.string().min(1).describe("New name for the item."),
	conflict_behavior: onedriveConflictBehaviorSchema
		.optional()
		.describe(
			"Conflict behavior if an item with the new name already exists ('fail', 'replace', or 'rename'; default 'fail').",
		),
});

export type OnedriveRenameInput = z.infer<typeof onedriveRenameInputSchema>;

/**
 * Create the `onedrive_rename` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveRenameAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveRenameInputSchema, OneDriveItem> {
	return defineAction({
		id: "onedrive_rename",
		name: "onedrive_rename",
		description: "Rename a personal OneDrive file or folder in place.",
		domain: "integrations",
		schema: onedriveRenameInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveRenameInput,
			_context: ActionContext,
		): Promise<OneDriveItem> {
			const name = input.name.trim();
			if (!name) {
				throw new Error("onedrive_rename requires a non-empty name");
			}
			return port.updateItem({
				itemId: input.item_id,
				name,
				conflictBehavior: input.conflict_behavior ?? "fail",
			});
		},
	});
}

export const onedriveDeleteInputSchema = z.object({
	item_ids: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_DELETE_BATCH_SIZE)
		.describe(
			`1 to ${MAX_DELETE_BATCH_SIZE} OneDrive item IDs to move to the OneDrive Recycle Bin (soft-delete).`,
		),
	dry_run: z
		.boolean()
		.optional()
		.describe(
			"When true, inspects item metadata and returns the deletion preview without deleting anything (default false).",
		),
	allow_non_empty_folder: z
		.boolean()
		.optional()
		.describe(
			"When true, permits soft-deleting folders with folder.childCount > 0 (default false).",
		),
});

export type OnedriveDeleteInput = z.infer<typeof onedriveDeleteInputSchema>;

export interface OnedriveDeleteOutput {
	dry_run: boolean;
	items: OneDriveItem[];
	deleted_item_ids: string[];
	failed: OneDriveBatchDeleteFailure[];
}

/**
 * Create the `onedrive_delete` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveDeleteAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveDeleteInputSchema, OnedriveDeleteOutput> {
	return defineAction({
		id: "onedrive_delete",
		name: "onedrive_delete",
		description:
			"Soft-delete 1 to 100 personal OneDrive items to the Recycle Bin with root/PARA protection, non-empty folder guard, and dry_run preview.",
		domain: "integrations",
		schema: onedriveDeleteInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveDeleteInput,
			_context: ActionContext,
		): Promise<OnedriveDeleteOutput> {
			const dryRun = input.dry_run ?? false;
			const allowNonEmptyFolder = input.allow_non_empty_folder ?? false;
			const uniqueIds = Array.from(
				new Set(input.item_ids.map((id) => id.trim()).filter(Boolean)),
			);

			if (uniqueIds.length === 0) {
				throw new Error("onedrive_delete requires at least 1 non-empty item_id");
			}
			if (uniqueIds.length > MAX_DELETE_BATCH_SIZE) {
				throw new Error(
					`onedrive_delete accepts at most ${MAX_DELETE_BATCH_SIZE} item_ids per call`,
				);
			}

			for (const requestedId of uniqueIds) {
				if (requestedId.toLowerCase() === "root") {
					throw new Error(
						"onedrive_delete refuses to delete the OneDrive root folder",
					);
				}
			}

			const inspectedItems: OneDriveItem[] = [];
			for (const requestedId of uniqueIds) {
				const item = await port.getItemMetadata({ itemId: requestedId });

				if (isOneDriveRootItem(requestedId, item)) {
					throw new Error(
						`onedrive_delete refuses to delete the OneDrive root folder (${item.id})`,
					);
				}

				if (
					isRootParentPath(item.parentReference?.path) &&
					PROTECTED_TOP_LEVEL_LOWER.has(item.name.trim().toLowerCase())
				) {
					throw new Error(
						`onedrive_delete refuses to delete protected top-level folder "${item.name}" (${item.id})`,
					);
				}

				const childCount = item.folder?.childCount ?? 0;
				if (item.folder && childCount > 0 && !allowNonEmptyFolder) {
					throw new Error(
						`onedrive_delete refuses to delete non-empty folder "${item.name}" (${item.id}, childCount=${childCount}); pass allow_non_empty_folder: true to confirm`,
					);
				}

				inspectedItems.push(item);
			}

			if (dryRun) {
				return {
					dry_run: true,
					items: inspectedItems,
					deleted_item_ids: [],
					failed: [],
				};
			}

			const result = await port.deleteItems({
				itemIds: inspectedItems.map((item) => item.id),
			});

			return {
				dry_run: false,
				items: inspectedItems,
				deleted_item_ids: result.deletedItemIds,
				failed: result.failed,
			};
		},
	});
}
