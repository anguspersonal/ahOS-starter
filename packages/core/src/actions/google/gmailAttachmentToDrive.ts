import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { DriveFile } from "../../ports/drive.js";

export interface GmailAttachmentPayload {
	attachmentId: string | null;
	filename: string;
	mimeType: string;
	size: number;
	data: Uint8Array;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const gmailAttachmentToDriveInput = {
	message_id: z
		.string()
		.min(1)
		.describe("Gmail message ID containing the attachment."),
	attachment_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Gmail attachment ID (from gmail_read). Provide attachment_id, attachment_filename, or filename.",
		),
	attachment_filename: z
		.string()
		.min(1)
		.optional()
		.describe("Exact attachment filename on the Gmail message when attachment_id is omitted."),
	filename: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Alias for attachment_filename: exact attachment filename on the message when attachment_id is omitted.",
		),
	folder_id: z
		.string()
		.min(1)
		.describe("Destination Google Drive folder ID."),
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional target filename for the uploaded Drive file (defaults to the Gmail attachment filename).",
		),
	drive_filename: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Alias for name: optional override filename for the uploaded Drive file (defaults to the Gmail attachment filename).",
		),
	domain: optionalDomainInput,
	gmail_domain: z
		.enum(DOMAINS)
		.optional()
		.describe("Optional Gmail domain override ('work' or 'angus'); defaults to domain or 'work'."),
	drive_domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Optional Google Drive domain override ('work' or 'angus'); defaults to domain or 'work'.",
		),
};

export const gmailAttachmentToDriveSchema = z
	.object(gmailAttachmentToDriveInput)
	.refine((val) => Boolean(val.attachment_id || val.attachment_filename || val.filename), {
		message: "Provide at least one of attachment_id, attachment_filename, or filename.",
		path: ["attachment_id"],
	});

export type GmailAttachmentToDriveInput = z.infer<typeof gmailAttachmentToDriveSchema>;

export interface GmailAttachmentToDriveOutput {
	id: string;
	file_id: string;
	name: string;
	mimeType: string;
	mime_type: string;
	size: number;
	sha256: string;
	webViewLink: string | null;
	web_view_link: string | null;
	folder_id: string;
	message_id: string;
	attachment_id: string | null;
	gmail_domain: Domain;
	drive_domain: Domain;
}

export interface GmailAttachmentToDrivePort {
	getAttachment(params: {
		domain: Domain;
		messageId: string;
		attachmentId?: string;
		filename?: string;
	}): Promise<GmailAttachmentPayload>;
	uploadToDrive(params: {
		domain: Domain;
		name: string;
		folderId: string;
		mimeType: string;
		data: Uint8Array;
	}): Promise<DriveFile>;
}

export function createGmailAttachmentToDriveAction(
	port: GmailAttachmentToDrivePort,
): ActionDefinition<typeof gmailAttachmentToDriveSchema, GmailAttachmentToDriveOutput> {
	return defineAction({
		id: "gmail_attachment_to_drive",
		name: "gmail_attachment_to_drive",
		description:
			"Stream an email attachment directly from Gmail to a Google Drive folder server-side without base64 round-tripping through the model context. Resolves the attachment by attachment_id or exact filename and returns the uploaded Drive file metadata.",
		domain: "integrations",
		schema: gmailAttachmentToDriveSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		run: async (args, ctx) => {
			const resolvedAttachmentFilename = args.attachment_filename ?? args.filename;
			if (!args.attachment_id && !resolvedAttachmentFilename) {
				throw new Error("Provide at least one of attachment_id, attachment_filename, or filename.");
			}
			const baseDomain: Domain = args.domain ?? ctx.domain ?? "work";
			const gmailDomain: Domain = args.gmail_domain ?? baseDomain;
			const driveDomain: Domain = args.drive_domain ?? baseDomain;

			const attachment = await port.getAttachment({
				domain: gmailDomain,
				messageId: args.message_id,
				attachmentId: args.attachment_id,
				filename: resolvedAttachmentFilename,
			});

			const sha256 = await sha256Hex(attachment.data);
			const targetName = args.name ?? args.drive_filename ?? attachment.filename;
			const uploaded = await port.uploadToDrive({
				domain: driveDomain,
				name: targetName,
				folderId: args.folder_id,
				mimeType: attachment.mimeType,
				data: attachment.data,
			});

			const fileId = uploaded.id ?? "";
			const finalName = uploaded.name ?? targetName;
			const finalMimeType = uploaded.mimeType ?? attachment.mimeType;
			const finalSize =
				uploaded.size !== undefined && uploaded.size !== null
					? Number(uploaded.size)
					: attachment.size;
			const finalWebViewLink = uploaded.webViewLink ?? null;

			return {
				id: fileId,
				file_id: fileId,
				name: finalName,
				mimeType: finalMimeType,
				mime_type: finalMimeType,
				size: finalSize,
				sha256,
				webViewLink: finalWebViewLink,
				web_view_link: finalWebViewLink,
				folder_id: args.folder_id,
				message_id: args.message_id,
				attachment_id: attachment.attachmentId,
				gmail_domain: gmailDomain,
				drive_domain: driveDomain,
			};
		},
		formatMcp: (out) =>
			`Saved Gmail attachment to Drive:\n• [${out.file_id}] ${out.name} (${out.mime_type}, ${out.size} bytes, sha256: ${out.sha256}) -> folder ${out.folder_id}${out.web_view_link ? `\n  ${out.web_view_link}` : ""}`,
	});
}
