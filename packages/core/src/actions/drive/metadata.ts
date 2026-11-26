import { z } from "zod";
import { domainInput, optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	ABOUT_FIELDS,
	FILE_FIELDS,
	PERMISSION_FIELDS,
	formatFile,
	type DriveFile,
	type DrivePermission,
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

// ---- drive_get_metadata ---------------------------------------------------

export const driveGetMetadataInput = {
	file_id: z.string().min(1).describe("Drive file id to fetch metadata for."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveGetMetadataInputSchema = z.object(driveGetMetadataInput);
export const driveGetMetadataSchema = driveGetMetadataInputSchema;
export type DriveGetMetadataInput = z.infer<typeof driveGetMetadataInputSchema>;
export type DriveGetMetadataOutput = DriveFile;

export function formatDriveGetMetadataMcp(f: DriveFile): string {
	const lines = [
		formatFile(f),
		f.version ? `Version: ${f.version}` : null,
		f.webViewLink ? `Link: ${f.webViewLink}` : null,
		f.parents?.length ? `Parents: ${f.parents.join(", ")}` : null,
		f.createdTime ? `Created: ${f.createdTime}` : null,
		typeof f.shared === "boolean" ? `Shared: ${f.shared}` : null,
	].filter((l): l is string => l !== null);
	return lines.join("\n");
}

export function createDriveGetMetadataAction(
	port: DrivePort,
): ActionDefinition<typeof driveGetMetadataInputSchema, DriveGetMetadataOutput> {
	return defineAction({
		id: "drive_get_metadata",
		domain: "integrations",
		description: "Get metadata for one Google Drive file (name, type, size, parents, link, sharing).",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveGetMetadataInputSchema,
		formatMcp: formatDriveGetMetadataMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			return port.getFile({ domain, fileId: input.file_id, fields: FILE_FIELDS });
		},
	});
}

// ---- drive_list_permissions -----------------------------------------------

export const driveListPermissionsInput = {
	file_id: z.string().min(1).describe("Drive file id to list sharing permissions for."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveListPermissionsInputSchema = z.object(driveListPermissionsInput);
export const driveListPermissionsSchema = driveListPermissionsInputSchema;
export type DriveListPermissionsInput = z.infer<typeof driveListPermissionsInputSchema>;
export interface DriveListPermissionsOutput {
	domain: Domain;
	file_id: string;
	file_ids: string[];
	permissions: DrivePermission[];
	count: number;
	pages_fetched: number;
	truncated: boolean;
}

const DEFAULT_PERMISSION_MAX_PAGES = 10;

export function formatDriveListPermissionsMcp(
	out: DrivePermission[] | { permissions?: DrivePermission[] | null; truncated?: boolean; pages_fetched?: number },
): string {
	const perms = Array.isArray(out) ? out : (out.permissions ?? []);
	const truncated = !Array.isArray(out) && Boolean(out.truncated);
	const pagesFetched = !Array.isArray(out) ? (out.pages_fetched ?? DEFAULT_PERMISSION_MAX_PAGES) : 1;
	if (perms.length === 0) {
		return truncated
			? `Drive returned no permissions in ${pagesFetched} pages; more permissions exist on Drive.`
			: "Drive returned no permissions.";
	}
	const body = perms
		.map(
			(p) =>
				`• [${p.id}] ${p.role} — ${p.type}${
					p.emailAddress ? ` ${p.emailAddress}` : p.domain ? ` ${p.domain}` : ""
				}`,
		)
		.join("\n");
	const cutNotice = truncated ? `\nStopped after ${pagesFetched} pages; more permissions exist on Drive.` : "";
	return `${perms.length} permission(s):\n${body}${cutNotice}`;
}

export function createDriveListPermissionsAction(
	port: DrivePort,
	opts?: { maxPages?: number },
): ActionDefinition<typeof driveListPermissionsInputSchema, DriveListPermissionsOutput> {
	const maxPages = opts?.maxPages ?? DEFAULT_PERMISSION_MAX_PAGES;
	return defineAction({
		id: "drive_list_permissions",
		domain: "integrations",
		description: "List the sharing permissions on a Google Drive file or folder.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveListPermissionsInputSchema,
		formatMcp: formatDriveListPermissionsMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			if (!port.listPermissionsPage) {
				const permissions = await port.listPermissions({ domain, fileId: input.file_id, fields: PERMISSION_FIELDS });
				return {
					domain, file_id: input.file_id, file_ids: [input.file_id],
					permissions, count: permissions.length, pages_fetched: 1, truncated: false,
				};
			}
			const permissions: DrivePermission[] = [];
			let pageToken: string | undefined;
			let pagesFetched = 0;
			for (let page = 0; page < maxPages; page++) {
				const res = await port.listPermissionsPage({
					domain, fileId: input.file_id, ...(pageToken ? { pageToken } : {}), fields: PERMISSION_FIELDS,
				});
				pagesFetched++;
				permissions.push(...(res.permissions ?? []));
				pageToken = res.nextPageToken ?? undefined;
				if (!pageToken) break;
			}
			return {
				domain, file_id: input.file_id, file_ids: [input.file_id],
				permissions, count: permissions.length, pages_fetched: pagesFetched, truncated: Boolean(pageToken),
			};
		},
	});
}

// ---- drive_about ----------------------------------------------------------

export const driveAboutInputSchema = z.object({ domain: domainInput });
export type DriveAboutInput = z.infer<typeof driveAboutInputSchema>;
export interface DriveAboutOutput {
	domain: Domain;
	email: string | null;
	quota_limit_bytes: number | null;
	usage_bytes: number;
	usage_in_drive_bytes: number;
	usage_in_trash_bytes: number;
	usage_percent: number | null;
}

export function formatDriveAboutMcp(out: DriveAboutOutput): string {
	const who = out.email ? `${out.domain} (${out.email})` : out.domain;
	if (out.quota_limit_bytes === null) {
		return `Drive quota for ${who}: ${out.usage_bytes} bytes used, unlimited quota (drive=${out.usage_in_drive_bytes}, trash=${out.usage_in_trash_bytes}).`;
	}
	return `Drive quota for ${who}: ${out.usage_bytes} / ${out.quota_limit_bytes} bytes (${out.usage_percent}% used; drive=${out.usage_in_drive_bytes}, trash=${out.usage_in_trash_bytes}).`;
}

export function createDriveAboutAction(
	port: DrivePort,
): ActionDefinition<typeof driveAboutInputSchema, DriveAboutOutput> {
	return defineAction({
		id: "drive_about",
		name: "Get Google Drive Storage Quota",
		domain: "integrations",
		description:
			"Read account email and Google Drive storage quota (limit, total usage, Drive usage, Trash usage, and percent used; limit and percent are null on unlimited accounts). Requires domain ('work' or 'angus'). Full notes: docs/guides/tools/drive_about.md",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		schema: driveAboutInputSchema,
		formatMcp: formatDriveAboutMcp,
		async run(input) {
			const res = await port.getAbout!({ domain: input.domain, fields: ABOUT_FIELDS });
			const q = res.storageQuota;
			const rawLimit = q?.limit != null && q.limit !== "" ? Number(q.limit) : null;
			const quota_limit_bytes = rawLimit !== null && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;
			const usage_bytes = Number(q?.usage ?? 0);
			const usage_in_drive_bytes = Number(q?.usageInDrive ?? 0);
			const usage_in_trash_bytes = Number(q?.usageInDriveTrash ?? 0);
			const usage_percent =
				quota_limit_bytes !== null ? Math.round((usage_bytes / quota_limit_bytes) * 10000) / 100 : null;
			return {
				domain: input.domain,
				email: res.user?.emailAddress ?? null,
				quota_limit_bytes,
				usage_bytes,
				usage_in_drive_bytes,
				usage_in_trash_bytes,
				usage_percent,
			};
		},
	});
}
