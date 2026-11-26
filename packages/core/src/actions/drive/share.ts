import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	PERMISSION_CREATE_FIELDS,
	type DrivePermission,
	type DrivePort,
} from "../../ports/drive.js";
import { googleAccountInput } from "../appsscript/account.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const driveShareInput = {
	file_id: z.string().min(1).describe("File or folder id to share."),
	role: z
		.enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"])
		.describe("Access level to grant."),
	type: z
		.enum(["user", "group", "domain", "anyone"])
		.describe("Grantee type. Use 'anyone' for link sharing."),
	email_address: z
		.string()
		.email()
		.optional()
		.describe("Required for type 'user' or 'group'."),
	grantee_domain: z
		.string()
		.optional()
		.describe(
			"Required for type 'domain' (e.g. 'example.com'). The Workspace domain to grant access TO \u2014 not `domain`, which selects the account acting.",
		),
	send_notification: z
		.boolean()
		.optional()
		.describe("Email the grantee (default false; ignored for anyone/domain)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveShareSchema = z.object(driveShareInput);
export type DriveShareInput = z.infer<typeof driveShareSchema>;

export interface DriveShareOutput {
	domain: Domain;
	file_id: string;
	permission: DrivePermission;
}

function validateShareGrantee(args: {
	type?: string;
	email_address?: string;
	grantee_domain?: string;
}): string | null {
	if ((args.type === "user" || args.type === "group") && !args.email_address?.trim()) {
		return `type '${args.type}' requires email_address.`;
	}
	if (args.type === "domain" && !args.grantee_domain?.trim()) {
		return "type 'domain' requires grantee_domain (the Workspace domain to grant access to, e.g. 'example.com').";
	}
	return null;
}

function canResolveShareDomain(args: {
	domain?: string;
	account?: string;
}): boolean {
	try {
		reconcileDomain(args.domain, args.account, "account");
		return true;
	} catch {
		return false;
	}
}

export function createDriveShareAction(
	port: DrivePort,
): ActionDefinition<typeof driveShareSchema, DriveShareOutput> {
	return defineAction({
		id: "drive_share",
		name: "Share Google Drive File",
		description:
			'Share a Google Drive file/folder: grant a role to a user, group, domain, or anyone. role: "owner" transfers ownership; type: "anyone" publishes to anyone with the link. Parks for the owner\'s approval when type is "anyone" or "domain", or role is "owner".',
		domain: "integrations",
		needsApproval: (input) => {
			if (validateShareGrantee(input) !== null || !canResolveShareDomain(input)) {
				return false;
			}
			return input.type === "anyone" || input.type === "domain" || input.role === "owner";
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveShareSchema,
		async run(args: DriveShareInput) {
			const validationError = validateShareGrantee(args);
			if (validationError !== null) {
				throw new Error(validationError);
			}
			const domain = reconcileDomain(args.domain, args.account, "account") ?? "angus";
			if (!port.createPermission) {
				throw new Error("DrivePort.createPermission is not implemented");
			}
			const permission = await port.createPermission({
				domain,
				fileId: args.file_id,
				role: args.role,
				type: args.type,
				emailAddress: args.email_address,
				granteeDomain: args.grantee_domain,
				sendNotificationEmail: args.send_notification ?? false,
				transferOwnership: args.role === "owner" ? true : undefined,
				fields: PERMISSION_CREATE_FIELDS,
			});
			return {
				domain,
				file_id: args.file_id,
				permission,
			};
		},
		formatMcp: (out) => {
			const p = out.permission;
			return `Shared ${out.file_id}: granted ${p.role} to ${
				p.emailAddress ?? p.domain ?? p.type
			} (permission id ${p.id}).`;
		},
	});
}
