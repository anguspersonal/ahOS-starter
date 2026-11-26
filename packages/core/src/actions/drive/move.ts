import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import {
	FILE_FIELDS,
	formatFile,
	type DriveFile,
	type DrivePort,
} from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const driveMoveInput = {
	file_id: z.string().min(1).describe("File or folder id to move."),
	new_parent_id: z.string().min(1).describe("Destination folder id."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveMoveInputSchema = z.object(driveMoveInput);
export const driveMoveSchema = driveMoveInputSchema;
export type DriveMoveInput = z.infer<typeof driveMoveInputSchema>;
export type DriveMoveOutput = DriveFile;

export function formatDriveMoveMcp(file: DriveFile): string {
	return `Moved:\n${formatFile(file)}`;
}

export function createDriveMoveAction(
	port: DrivePort,
): ActionDefinition<typeof driveMoveInputSchema, DriveMoveOutput> {
	return defineAction({
		id: "drive_move",
		domain: "integrations",
		description: "Move a Google Drive file or folder into a different parent folder.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveMoveInputSchema,
		formatMcp: formatDriveMoveMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const current = await port.getFile({
				domain,
				fileId: input.file_id,
				fields: "parents",
			});
			const removeParents = (current.parents ?? []).join(",");
			return port.updateFile({
				domain,
				fileId: input.file_id,
				addParents: input.new_parent_id,
				removeParents: removeParents || undefined,
				fields: FILE_FIELDS,
			});
		},
	});
}
