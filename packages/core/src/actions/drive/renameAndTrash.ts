import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import { formatFile, type DriveFile, type DrivePort } from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const driveRenameInput = {
	file_id: z.string().min(1).describe("File or folder id to rename."),
	name: z.string().min(1).describe("New name."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveRenameInputSchema = z.object(driveRenameInput);
export const driveRenameSchema = driveRenameInputSchema;
export type DriveRenameInput = z.infer<typeof driveRenameInputSchema>;
export type DriveRenameOutput = DriveFile;

export function formatDriveRenameMcp(file: DriveFile): string {
	return `Renamed:\n${formatFile(file)}`;
}

export function createDriveRenameAction(
	port: DrivePort,
): ActionDefinition<typeof driveRenameInputSchema, DriveRenameOutput> {
	return defineAction({
		id: "drive_rename",
		domain: "integrations",
		description: "Rename a Google Drive file or folder.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveRenameInputSchema,
		formatMcp: formatDriveRenameMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			return port.updateFile(domain, input.file_id, { name: input.name });
		},
	});
}

export const driveTrashInput = {
	file_id: z.string().min(1).describe("File or folder id to move to Trash."),
	restore: z
		.boolean()
		.optional()
		.describe("Set true to restore a trashed item instead of trashing it."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveTrashInputSchema = z.object(driveTrashInput);
export const driveTrashSchema = driveTrashInputSchema;
export type DriveTrashInput = z.infer<typeof driveTrashInputSchema>;
export interface DriveTrashOutput extends DriveFile {
	file: DriveFile;
	restored: boolean;
}

export function formatDriveTrashMcp(out: DriveTrashOutput | DriveFile): string {
	const file = "file" in out && out.file ? out.file : out;
	const restored =
		"restored" in out && typeof out.restored === "boolean"
			? out.restored
			: file.trashed === false;
	return `${restored ? "Restored" : "Trashed"}:\n${formatFile(file)}`;
}

export function createDriveTrashAction(
	port: DrivePort,
): ActionDefinition<typeof driveTrashInputSchema, DriveTrashOutput> {
	return defineAction({
		id: "drive_trash",
		domain: "integrations",
		description:
			"Move a Google Drive file/folder to Trash (reversible). Set restore=true to bring it back.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveTrashInputSchema,
		formatMcp: formatDriveTrashMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const restored = Boolean(input.restore);
			const file = await port.updateFile(domain, input.file_id, { trashed: !restored });
			return { ...file, file, restored };
		},
	});
}
