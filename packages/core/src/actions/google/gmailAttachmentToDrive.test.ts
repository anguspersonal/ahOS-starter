import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import {
	createGmailAttachmentToDriveAction,
	gmailAttachmentToDriveSchema,
	type GmailAttachmentToDrivePort,
} from "./gmailAttachmentToDrive.js";

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const EXPECTED_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

function makePort(overrides?: Partial<GmailAttachmentToDrivePort>): GmailAttachmentToDrivePort {
	return {
		getAttachment: vi.fn(async ({ attachmentId, filename }) => ({
			attachmentId: attachmentId ?? "att-resolved-1",
			filename: filename ?? "invoice.pdf",
			mimeType: "application/pdf",
			size: PDF_BYTES.byteLength,
			data: PDF_BYTES,
		})),
		uploadToDrive: vi.fn(async ({ name, folderId, mimeType, data }) => ({
			id: "drive-file-123",
			name,
			mimeType,
			size: String(data.byteLength),
			webViewLink: `https://drive.google.com/file/d/drive-file-123/view`,
			parents: [folderId],
		})),
		...overrides,
	};
}

describe("gmail_attachment_to_drive action", () => {
	it("resolves attachment by attachment_id and uploads binary bytes to Drive folder", async () => {
		const port = makePort();
		const action = createGmailAttachmentToDriveAction(port);

		const result = await executeAction(
			action,
			{
				message_id: "msg-100",
				attachment_id: "att-100",
				folder_id: "folder-abc",
			},
			{ auditSink: () => {} },
		);

		expect(port.getAttachment).toHaveBeenCalledWith({
			domain: "work",
			messageId: "msg-100",
			attachmentId: "att-100",
			filename: undefined,
		});
		expect(port.uploadToDrive).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "work",
				name: "invoice.pdf",
				folderId: "folder-abc",
				mimeType: "application/pdf",
			}),
		);
		expect(result).toEqual({
			id: "drive-file-123",
			file_id: "drive-file-123",
			name: "invoice.pdf",
			mimeType: "application/pdf",
			mime_type: "application/pdf",
			size: 8,
			sha256: EXPECTED_SHA256,
			webViewLink: "https://drive.google.com/file/d/drive-file-123/view",
			web_view_link: "https://drive.google.com/file/d/drive-file-123/view",
			folder_id: "folder-abc",
			message_id: "msg-100",
			attachment_id: "att-100",
			gmail_domain: "work",
			drive_domain: "work",
		});
		expect(action.formatMcp?.(result)).toContain("[drive-file-123] invoice.pdf");
	});

	it("accepts attachment_filename + name (issue #2002 acceptance test payload) and returns { id, name, mimeType, size, sha256, webViewLink }", async () => {
		const port = makePort();
		const action = createGmailAttachmentToDriveAction(port);

		const result = await executeAction(
			action,
			{
				message_id: "19e1d19030935244",
				attachment_filename: "NDA_Hiran_14_08_2026.pdf",
				folder_id: "17DfLLNKVKNWU9l76PcfsafULKBRgiPs7",
				name: "NDA_LogicRays-Hiran_2026-08-14_signed.pdf",
				domain: "work",
			},
			{ auditSink: () => {} },
		);

		expect(port.getAttachment).toHaveBeenCalledWith({
			domain: "work",
			messageId: "19e1d19030935244",
			attachmentId: undefined,
			filename: "NDA_Hiran_14_08_2026.pdf",
		});
		expect(port.uploadToDrive).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "work",
				name: "NDA_LogicRays-Hiran_2026-08-14_signed.pdf",
				folderId: "17DfLLNKVKNWU9l76PcfsafULKBRgiPs7",
				mimeType: "application/pdf",
			}),
		);
		expect(result).toMatchObject({
			id: "drive-file-123",
			name: "NDA_LogicRays-Hiran_2026-08-14_signed.pdf",
			mimeType: "application/pdf",
			size: 8,
			sha256: EXPECTED_SHA256,
			webViewLink: "https://drive.google.com/file/d/drive-file-123/view",
		});
		expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("resolves attachment by filename, applies drive_filename override, and supports cross-domain transfer", async () => {
		const port = makePort();
		const action = createGmailAttachmentToDriveAction(port);

		const result = await executeAction(
			action,
			{
				message_id: "msg-200",
				filename: "original.pdf",
				drive_filename: "2026-10-statement.pdf",
				folder_id: "folder-work",
				gmail_domain: "angus",
				drive_domain: "work",
			},
			{ auditSink: () => {} },
		);

		expect(port.getAttachment).toHaveBeenCalledWith({
			domain: "angus",
			messageId: "msg-200",
			attachmentId: undefined,
			filename: "original.pdf",
		});
		expect(port.uploadToDrive).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "work",
				name: "2026-10-statement.pdf",
				folderId: "folder-work",
			}),
		);
		expect(result.name).toBe("2026-10-statement.pdf");
		expect(result.gmail_domain).toBe("angus");
		expect(result.drive_domain).toBe("work");
	});

	it("rejects input when neither attachment_id, attachment_filename, nor filename is provided", async () => {
		const port = makePort();
		const action = createGmailAttachmentToDriveAction(port);

		expect(() =>
			gmailAttachmentToDriveSchema.parse({
				message_id: "msg-300",
				folder_id: "folder-xyz",
			}),
		).toThrow(/Provide at least one of attachment_id, attachment_filename, or filename/);

		await expect(
			executeAction(
				action,
				{
					message_id: "msg-300",
					folder_id: "folder-xyz",
				},
				{ auditSink: () => {} },
			),
		).rejects.toThrow(/Provide at least one of attachment_id, attachment_filename, or filename/);
	});
});
