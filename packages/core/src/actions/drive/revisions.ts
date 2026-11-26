import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { DriveApiError, isGoogleDoc, type DrivePort, type DriveRevision } from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const domainField = z.enum(DOMAINS).describe("Domain library owning the Drive file ('work' or 'angus')");
const TEXT_MIMES = new Set([
	"application/json", "application/ld+json", "application/xml", "application/javascript",
	"application/typescript", "application/x-yaml", "application/yaml", "application/sql",
	"application/toml", "image/svg+xml",
]);
const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|toml|ini|log)$/i;

export interface DriveRevisionMetadata {
	id: string; modified_at: string | null; last_modifying_user: string | null;
	keep_forever: boolean; size: number | null; md5: string | null;
	mime_type: string | null; original_filename: string | null;
}

function mapRevision(r: DriveRevision, fallbackId = ""): DriveRevisionMetadata {
	return {
		id: r.id ?? fallbackId,
		modified_at: r.modifiedTime ?? null,
		last_modifying_user: r.lastModifyingUser?.displayName ?? r.lastModifyingUser?.emailAddress ?? null,
		keep_forever: Boolean(r.keepForever),
		size: r.size != null ? Number(r.size) : null,
		md5: r.md5Checksum ?? null,
		mime_type: r.mimeType ?? null,
		original_filename: r.originalFilename ?? null,
	};
}

function isTextualBinary(mimeType: string | null | undefined, filename: string | null | undefined): boolean {
	const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
	return mime.startsWith("text/") || TEXT_MIMES.has(mime) || TEXT_EXT_RE.test(filename ?? "");
}

export const driveRevisionListInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	limit: z.number().int().min(1).max(200).optional().describe("Maximum revisions to return (1-200, default 50)"),
	cursor: z.string().min(1).optional().describe("Pagination cursor from a previous drive_revision_list call"),
});
export type DriveRevisionListInput = z.infer<typeof driveRevisionListInputSchema>;
export interface DriveRevisionListOutput {
	domain: Domain; file_id: string; revisions: DriveRevisionMetadata[]; next_cursor: string | null;
}

export function createDriveRevisionListAction(
	port: DrivePort,
): ActionDefinition<typeof driveRevisionListInputSchema, DriveRevisionListOutput> {
	return defineAction({
		id: "drive_revision_list",
		name: "List Google Drive File Revisions",
		description: "List revisions for a Google Drive file with modification timestamps, authors, keepForever flags, sizes, and MD5 checksums.",
		domain: "integrations",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		schema: driveRevisionListInputSchema,
		run: async (input) => {
			const res = await port.listRevisions({
				domain: input.domain, fileId: input.file_id, pageSize: input.limit ?? 50, pageToken: input.cursor,
			});
			return {
				domain: input.domain, file_id: input.file_id,
				revisions: res.revisions.map((r) => mapRevision(r)),
				next_cursor: res.nextPageToken ?? null,
			};
		},
		formatMcp: (out) =>
			`Listed ${out.revisions.length} revision(s) for ${out.domain}:${out.file_id}${out.next_cursor ? ` (next_cursor=${out.next_cursor})` : ""}.`,
	});
}

export const driveRevisionGetInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	revision_id: z.string().min(1).describe("Google Drive revision ID"),
	include_text: z.boolean().optional().describe("Download or export textual revision content when true (default false)"),
	max_chars: z.number().int().min(1).max(200_000).optional().describe("Character cap when include_text is true (default 20000)"),
});
export type DriveRevisionGetInput = z.infer<typeof driveRevisionGetInputSchema>;
export interface DriveRevisionGetOutput extends DriveRevisionMetadata {
	domain: Domain; file_id: string; readable?: boolean; reason?: string;
	text?: string; truncated?: boolean; total_chars?: number;
}

export function createDriveRevisionGetAction(
	port: DrivePort,
): ActionDefinition<typeof driveRevisionGetInputSchema, DriveRevisionGetOutput> {
	return defineAction({
		id: "drive_revision_get",
		name: "Get Google Drive File Revision",
		description: "Fetch metadata for a specific Google Drive revision and optionally read its plain-text content.",
		domain: "integrations",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		schema: driveRevisionGetInputSchema,
		run: async (input): Promise<DriveRevisionGetOutput> => {
			const rev = await port.getRevision({ domain: input.domain, fileId: input.file_id, revisionId: input.revision_id });
			const base = { domain: input.domain, file_id: input.file_id, ...mapRevision(rev, input.revision_id) };
			if (!input.include_text) return base;

			const maxChars = input.max_chars ?? 20_000;
			let bytes: Uint8Array;
			if (isGoogleDoc(rev.mimeType)) {
				const exportUrl = rev.exportLinks?.["text/plain"];
				if (!exportUrl) return { ...base, readable: false, reason: `Google-native revision (${rev.mimeType}) has no text/plain export link.` };
				bytes = await port.downloadRevision({ domain: input.domain, fileId: input.file_id, revisionId: input.revision_id, exportUrl });
			} else if (isTextualBinary(rev.mimeType, rev.originalFilename)) {
				bytes = await port.downloadRevision({ domain: input.domain, fileId: input.file_id, revisionId: input.revision_id });
			} else {
				return { ...base, readable: false, reason: `Revision has non-textual binary MIME type '${rev.mimeType ?? "application/octet-stream"}'.` };
			}

			const fullText = new TextDecoder("utf-8").decode(bytes);
			const truncated = fullText.length > maxChars;
			return { ...base, readable: true, text: truncated ? fullText.slice(0, maxChars) : fullText, truncated, total_chars: fullText.length };
		},
		formatMcp: (out) =>
			`Revision ${out.id} of ${out.domain}:${out.file_id} (mime=${out.mime_type ?? "unknown"}, keep_forever=${out.keep_forever}` +
			(out.readable === undefined ? ")." : out.readable ? `, readable=true, chars=${out.text?.length ?? 0}/${out.total_chars ?? 0}, truncated=${out.truncated ?? false}).` : `, readable=false, reason=${out.reason}).`),
	});
}

export const driveRevisionKeepInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	revision_id: z.string().min(1).describe("Google Drive revision ID"),
	keep_forever: z.boolean().describe("Set true to pin the binary revision against automatic pruning, or false to unpin"),
});
export type DriveRevisionKeepInput = z.infer<typeof driveRevisionKeepInputSchema>;
export interface DriveRevisionKeepOutput extends DriveRevisionMetadata { domain: Domain; file_id: string }

export function createDriveRevisionKeepAction(
	port: DrivePort,
): ActionDefinition<typeof driveRevisionKeepInputSchema, DriveRevisionKeepOutput> {
	return defineAction({
		id: "drive_revision_keep",
		name: "Pin or Unpin Google Drive Binary Revision",
		description: "Set keepForever on a binary file revision in Google Drive so it is retained permanently.",
		domain: "integrations",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		schema: driveRevisionKeepInputSchema,
		run: async (input) => {
			const rev = await port.getRevision({ domain: input.domain, fileId: input.file_id, revisionId: input.revision_id });
			if (isGoogleDoc(rev.mimeType)) {
				throw new Error(`drive_revision_keep supports binary files only: Google Drive ignores keepForever on Google-native files (${rev.mimeType}).`);
			}
			try {
				const updated = await port.updateRevision({
					domain: input.domain, fileId: input.file_id, revisionId: input.revision_id, keepForever: input.keep_forever,
				});
				return { domain: input.domain, file_id: input.file_id, ...mapRevision(updated, input.revision_id) };
			} catch (err) {
				if (err instanceof DriveApiError && err.status === 403) {
					throw new DriveApiError(
						"Google Drive allows at most 200 pinned (keepForever) revisions per file (HTTP 403). Unpin an older revision before pinning another.",
						403, err.reason, err.googleStatus,
					);
				}
				throw err;
			}
		},
		formatMcp: (out) => `Set keep_forever=${out.keep_forever} on revision ${out.id} of ${out.domain}:${out.file_id}.`,
	});
}

export const driveRevisionDeleteInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	revision_id: z.string().min(1).describe("Google Drive revision ID to permanently delete"),
});
export type DriveRevisionDeleteInput = z.infer<typeof driveRevisionDeleteInputSchema>;
export interface DriveRevisionDeleteOutput { domain: Domain; file_id: string; revision_id: string; deleted: boolean }

export function createDriveRevisionDeleteAction(
	port: DrivePort,
): ActionDefinition<typeof driveRevisionDeleteInputSchema, DriveRevisionDeleteOutput> {
	return defineAction({
		id: "drive_revision_delete",
		name: "Delete Google Drive Binary Revision",
		description: "Permanently delete a binary file revision from Google Drive after owner approval.",
		domain: "integrations",
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		schema: driveRevisionDeleteInputSchema,
		run: async (input): Promise<DriveRevisionDeleteOutput> => {
			const rev = await port.getRevision({ domain: input.domain, fileId: input.file_id, revisionId: input.revision_id });
			if (isGoogleDoc(rev.mimeType)) {
				throw new Error(`drive_revision_delete supports binary files only: Google Drive does not allow deleting Google-native revisions (${rev.mimeType}).`);
			}
			try {
				await port.deleteRevision({ domain: input.domain, fileId: input.file_id, revisionId: input.revision_id });
				return { domain: input.domain, file_id: input.file_id, revision_id: input.revision_id, deleted: true };
			} catch (err) {
				if (err instanceof DriveApiError && err.status === 400) {
					throw new DriveApiError(
						"Google Drive refuses to delete the last remaining revision of a file (HTTP 400). Trash the file itself to remove it.",
						400, err.reason, err.googleStatus,
					);
				}
				throw err;
			}
		},
		formatMcp: (out) => `Deleted revision ${out.revision_id} of ${out.domain}:${out.file_id}.`,
	});
}
