import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import type { DrivePort } from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const accountParam = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

const domainParam = optionalDomainInput;

function resolveDriveDomain(args: {
	domain?: Domain;
	account?: "personal" | "work";
}): Domain {
	return reconcileDomain(args.domain, args.account, "account") ?? "angus";
}

export const driveDeleteInput = {
	file_id: z.string().min(1).describe("File or folder id to permanently delete."),
	account: accountParam,
	domain: domainParam,
};

export const driveDeleteSchema = z.object(driveDeleteInput);
export type DriveDeleteInput = z.infer<typeof driveDeleteSchema>;

export interface DriveDeleteOutput {
	domain: Domain;
	file_id: string;
	deleted: true;
}

export function createDriveDeleteAction(
	port: DrivePort,
): ActionDefinition<typeof driveDeleteSchema, DriveDeleteOutput> {
	return defineAction({
		id: "drive_delete",
		name: "Delete Google Drive File",
		description:
			"Permanently delete a Google Drive file/folder, bypassing Trash (not recoverable). Parks for the owner's approval on every agent call.",
		domain: "integrations",
		needsApproval: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: driveDeleteSchema,
		async run(args: DriveDeleteInput) {
			const domain = resolveDriveDomain(args);
			await port.deleteFile!(domain, args.file_id);
			return { domain, file_id: args.file_id, deleted: true as const };
		},
		formatMcp: (out) => `Permanently deleted ${out.file_id} (not recoverable).`,
	});
}

export const driveUnshareInput = {
	file_id: z.string().min(1).describe("File or folder id to revoke access on."),
	permission_id: z
		.string()
		.min(1)
		.describe("Permission id to remove (from drive_list_permissions)."),
	account: accountParam,
	domain: domainParam,
};

export const driveUnshareSchema = z.object(driveUnshareInput);
export type DriveUnshareInput = z.infer<typeof driveUnshareSchema>;

export interface DriveUnshareOutput {
	domain: Domain;
	file_id: string;
	permission_id: string;
	revoked: true;
}

export function createDriveUnshareAction(
	port: DrivePort,
): ActionDefinition<typeof driveUnshareSchema, DriveUnshareOutput> {
	return defineAction({
		id: "drive_unshare",
		name: "Unshare Google Drive File",
		description: "Revoke a sharing permission from a Google Drive file/folder by permission id.",
		domain: "integrations",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveUnshareSchema,
		async run(args: DriveUnshareInput) {
			const domain = resolveDriveDomain(args);
			await port.deletePermission!(domain, args.file_id, args.permission_id);
			return {
				domain,
				file_id: args.file_id,
				permission_id: args.permission_id,
				revoked: true as const,
			};
		},
		formatMcp: (out) => `Revoked permission ${out.permission_id} on ${out.file_id}.`,
	});
}
