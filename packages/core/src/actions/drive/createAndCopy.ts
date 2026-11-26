import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import { FOLDER_MIME_TYPE, formatFile, type DriveFile, type DrivePort } from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const driveCreateFolderInput = {
	name: z.string().min(1).describe("Name for the new folder."),
	parent_id: z
		.string()
		.optional()
		.describe("Parent folder id (default: My Drive root)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveCreateFolderInputSchema = z.object(driveCreateFolderInput);
export const driveCreateFolderSchema = driveCreateFolderInputSchema;
export type DriveCreateFolderInput = z.infer<typeof driveCreateFolderInputSchema>;
export type DriveCreateFolderOutput = DriveFile;

export function formatDriveCreateFolderMcp(file: DriveFile): string {
	return `Created folder:\n${formatFile(file)}`;
}

export function createDriveCreateFolderAction(
	port: DrivePort,
): ActionDefinition<typeof driveCreateFolderInputSchema, DriveCreateFolderOutput> {
	return defineAction({
		id: "drive_create_folder",
		domain: "integrations",
		description: "Create a new folder in Google Drive, optionally inside a parent folder.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: driveCreateFolderInputSchema,
		formatMcp: formatDriveCreateFolderMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			return port.createFile({
				domain,
				name: input.name,
				mimeType: FOLDER_MIME_TYPE,
				...(input.parent_id ? { parents: [input.parent_id] } : {}),
			});
		},
	});
}

export const driveCopyInput = {
	file_id: z.string().min(1).describe("File id to copy (folders cannot be copied)."),
	name: z.string().optional().describe("Name for the copy (default: 'Copy of …')."),
	parent_id: z
		.string()
		.optional()
		.describe("Destination folder id (default: same as source)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveCopyInputSchema = z.object(driveCopyInput);
export const driveCopySchema = driveCopyInputSchema;
export type DriveCopyInput = z.infer<typeof driveCopyInputSchema>;
export type DriveCopyOutput = DriveFile;

export function formatDriveCopyMcp(file: DriveFile): string {
	return `Copied to:\n${formatFile(file)}`;
}

export function createDriveCopyAction(
	port: DrivePort,
): ActionDefinition<typeof driveCopyInputSchema, DriveCopyOutput> {
	return defineAction({
		id: "drive_copy",
		domain: "integrations",
		description: "Make a copy of a Google Drive file, optionally renamed and/or placed in another folder.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: driveCopyInputSchema,
		formatMcp: formatDriveCopyMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			return port.copyFile({
				domain,
				fileId: input.file_id,
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.parent_id ? { parents: [input.parent_id] } : {}),
			});
		},
	});
}
