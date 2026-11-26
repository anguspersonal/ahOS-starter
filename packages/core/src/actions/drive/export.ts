import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	FILE_FIELDS,
	formatFile,
	GOOGLE_DOC_MIME_TYPE,
	isFolder,
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

// drive_export (#1220): render a Google Doc to PDF or DOCX and write the result back
// to Drive as a NEW file beside the source, returning its link.
//
// Why a sibling Drive file rather than an artifact, the other shape #1220 allowed:
// the caller this exists for is the unattended CV render, which has to put a link in
// a plain-text email (gmail_draft carries no attachments). A Drive file has that link
// the moment it exists, while bytes in Supabase Storage would need a signed URL that
// expires. drive_import_file stays the path for a caller who does want the bytes
// stored.
//
// What this choice does NOT do is keep the render out of the knowledge store. The
// scheduled Drive discover cadence (schedule/driveDiscoverCadence.ts) inventories
// the whole estate every day in prod, with no folder or type filter. It picks up
// both the export and the Doc it came from as `discovered_gdrive` pointers, and the
// enrich cadence then stores and extracts them. Neither carries a `cv_render`
// content_subtype. A caller that must keep a render out of evidence (ADR-051 §9)
// has to act on those pointers after discovery. The guide says how, and what is
// still missing.
//
// It writes, but never destructively: the source Doc is only read, and each call
// creates exactly one new file. Drive allows duplicate names, so a re-run adds a
// second copy rather than replacing the first, which is why it is not idempotent.
// Long form: docs/guides/tools/drive_export.md.

export const DRIVE_EXPORT_FORMATS = {
	pdf: { mimeType: "application/pdf", extension: "pdf" },
	docx: {
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		extension: "docx",
	},
} as const;

export const driveExportInput = {
	file_id: z.string().min(1).describe("Google Doc id to export. Other file types are refused."),
	format: z.enum(["pdf", "docx"]).describe("Export format: 'pdf' or 'docx'."),
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Name for the exported file (default: the Doc's name). .pdf or .docx is appended when the name lacks it.",
		),
	parent_id: z
		.string()
		.optional()
		.describe("Destination folder id (default: the source Doc's own folder, so the export sits beside it)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveExportInputSchema = z.object(driveExportInput);
export const driveExportSchema = driveExportInputSchema;
export type DriveExportInput = z.infer<typeof driveExportInputSchema>;
export interface DriveExportOutput {
	file: DriveFile;
	link: string;
	sourceLink: string;
	text: string;
}

const UTF8_DECODER = new TextDecoder();

function textOf(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return UTF8_DECODER.decode(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) {
		return UTF8_DECODER.decode(
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

/**
 * True when Drive refused an export for size.
 *
 * `files.export` caps its output at 10 MB and answers a larger render with a 403
 * whose reason is `exportSizeLimitExceeded`. The export is requested as an
 * arraybuffer, and on that path the error body can arrive as raw bytes rather than
 * parsed JSON, so every place the reason can surface is read, not only `errors`.
 */
export function isExportSizeLimitError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { reason?: unknown; errors?: unknown; response?: { data?: unknown } };
	if (e.reason === "exportSizeLimitExceeded") return true;
	return [e.errors, e.response?.data]
		.map(textOf)
		.some((t) => /exportSizeLimitExceeded/i.test(t));
}

/**
 * The line the reply carries about tabs: empty for a single-tab Doc, a warning when
 * the file is partial. Drive's export renders the default tab only, and silently, so
 * a tabbed Doc (a hand-edited master CV, say) would otherwise come back as a short
 * PDF with nothing to say so. Best-effort: a failed count never blocks the export,
 * it only turns the warning into the general caveat.
 */
async function tabNote(port: DrivePort, domain: Domain, fileId: string): Promise<string> {
	try {
		if (!port.countDocumentTabs) {
			throw new Error("countDocumentTabs is not available on this DrivePort");
		}
		const tabs = await port.countDocumentTabs({ domain, fileId });
		if (tabs <= 1) return "";
		const rest = tabs === 2 ? "the other tab is" : `the other ${tabs - 1} tabs are`;
		return `\nWarning: only the default tab was exported. This Doc has ${tabs} tabs, and Drive's export renders the default tab only; ${rest} not in this file.`;
	} catch {
		return "\nNote: could not count this Doc's tabs. Drive's export renders the default tab only, so if the Doc has several tabs, this file is partial.";
	}
}

export function formatDriveExportMcp(out: DriveExportOutput): string {
	return out.text;
}

export function createDriveExportAction(
	port: DrivePort,
): ActionDefinition<typeof driveExportInputSchema, DriveExportOutput> {
	return defineAction({
		id: "drive_export",
		domain: "integrations",
		description:
			"Export a Google Doc to PDF or DOCX and save it as a new file beside the source (or in " +
			"parent_id), returning its link. The source Doc is only read; each call creates another " +
			"file. Google Docs only, and Drive refuses exports over 10 MB. A tabbed Doc exports its " +
			"default tab only (the reply warns). Full notes: " +
			"docs/guides/tools/drive_export.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: driveExportInputSchema,
		formatMcp: formatDriveExportMcp,
		async run(args: DriveExportInput) {
			const domain = reconcileDomain(args.domain, args.account, "account") ?? "angus";
			const target = DRIVE_EXPORT_FORMATS[args.format];

			const source = await port.getFile({
				domain,
				fileId: args.file_id,
				fields: "id, name, mimeType, parents, webViewLink",
			});
			const sourceName = source.name ?? args.file_id;
			const sourceMime = source.mimeType ?? "";
			if (sourceMime !== GOOGLE_DOC_MIME_TYPE) {
				const what = isFolder(sourceMime) ? "a folder" : sourceMime || "of unknown type";
				throw new Error(
					`drive_export exports Google Docs only; ${args.file_id} ("${sourceName}") is ${what}. Nothing was written.`,
				);
			}

			const tabs = await tabNote(port, domain, args.file_id);

			let bytes: Uint8Array;
			try {
				bytes = await port.exportFile({
					domain,
					fileId: args.file_id,
					mimeType: target.mimeType,
				});
			} catch (err) {
				// The only size ceiling on this path. Nothing is written to ahKMS Storage, so
				// ADR-091's 25 MB store cap never applies, and any render over 25 MB is over
				// this 10 MB limit first: it is refused here, with nothing written anywhere.
				if (isExportSizeLimitError(err)) {
					throw new Error(
						`Drive refused to export "${sourceName}" as ${args.format.toUpperCase()}: the render is over Drive's 10 MB export limit. Nothing was written. Shrink the Doc (large images are the usual cause) or download it from the Docs editor instead.`,
					);
				}
				throw err;
			}

			// The format's extension, on a default AND an explicit name: a PDF called
			// "CV 2026-09" downloads from an emailed link as a file some clients will not open
			// as a PDF. Case-insensitive, so "Report.PDF" is not doubled.
			const suffix = `.${target.extension}`;
			const base = args.name ?? sourceName;
			const name = base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`;
			const sourceParents = source.parents ?? [];
			const parents = args.parent_id ? [args.parent_id] : sourceParents;

			const created = await port.createFile({
				domain,
				name,
				// Same type as the media, so Drive stores the bytes as-is (no conversion).
				mimeType: target.mimeType,
				parents: parents.length > 0 ? parents : undefined,
				media: { mimeType: target.mimeType, body: bytes },
				fields: FILE_FIELDS,
			});

			// A Doc shared with this account from someone else's Drive can come back with no
			// parent this account can see; the export then lands in My Drive root, and says so.
			const where = args.parent_id
				? `in folder ${args.parent_id}`
				: sourceParents.length > 0
					? "beside the source, in the same folder"
					: "in My Drive root (the source has no parent folder visible to this account)";
			const link = created.webViewLink ?? `https://drive.google.com/file/d/${created.id}/view`;
			const sourceLink = source.webViewLink ?? args.file_id;
			const text = `Exported "${sourceName}" to ${args.format.toUpperCase()} (${bytes.byteLength} bytes) and saved it ${where}:\n${formatFile(created)}\nLink: ${link}\nSource Doc (unchanged): ${sourceLink}${tabs}`;

			return {
				file: created,
				link,
				sourceLink,
				text,
			};
		},
	});
}
