import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import {
	detectOfficeOpenXmlKind,
	extractOfficeOpenXmlText,
} from "../../domain/extract/office.js";
import {
	GOOGLE_EXPORT,
	isGoogleDoc,
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

export const driveReadFileInput = {
	file_id: z.string().min(1).describe("Drive file id to read."),
	max_chars: z
		.number()
		.int()
		.min(100)
		.max(200_000)
		.optional()
		.describe("Truncate returned text to this many characters (default 50000)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveReadFileInputSchema = z.object(driveReadFileInput);
export const driveReadFileSchema = driveReadFileInputSchema;
export type DriveReadFileInput = z.infer<typeof driveReadFileInputSchema>;

export interface DriveReadFileOutput {
	id?: string | null;
	name: string;
	mimeType: string;
	text: string;
	truncated: boolean;
	totalChars: number;
	refused?: boolean;
	formatted: string;
}

function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "image/svg+xml"
	);
}

export function formatDriveReadFileMcp(out: DriveReadFileOutput | string): string {
	if (typeof out === "string") return out;
	return out.formatted;
}

export function createDriveReadFileAction(
	port: DrivePort,
): ActionDefinition<typeof driveReadFileInputSchema, DriveReadFileOutput> {
	return defineAction({
		id: "drive_read_file",
		domain: "integrations",
		description:
			"Read a Drive file's content inline as text. Google Docs and Sheets are read as Markdown with every tab (use `sheets_read` to list tabs or read one range of a large Sheet); binary files should use ingest_drive instead.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveReadFileInputSchema,
		formatMcp: formatDriveReadFileMcp,
		async run(input): Promise<DriveReadFileOutput> {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const meta = await port.getFile({
				domain,
				fileId: input.file_id,
				fields: "id, name, mimeType",
			});
			const name = meta.name ?? "";
			const mimeType = meta.mimeType ?? "";
			const officeKind = detectOfficeOpenXmlKind(mimeType, name);

			if (
				isGoogleDoc(mimeType) &&
				(!GOOGLE_EXPORT[mimeType] || !isTextual(GOOGLE_EXPORT[mimeType].mimeType))
			) {
				const formatted = `"${name}" is a Google-native type (${mimeType}) that can't be exported as text. Use ingest_drive instead.`;
				return {
					id: meta.id,
					name,
					mimeType,
					text: "",
					truncated: false,
					totalChars: 0,
					refused: true,
					formatted,
				};
			}

			if (!isGoogleDoc(mimeType) && !isTextual(mimeType) && !officeKind) {
				const formatted = `"${name}" is binary (${mimeType}) and can't be read as text. Use ingest_drive to bring it into the knowledge store, then artifact_extract_text.`;
				return {
					id: meta.id,
					name,
					mimeType,
					text: "",
					truncated: false,
					totalChars: 0,
					refused: true,
					formatted,
				};
			}

			const downloaded = await port.downloadFile(domain, input.file_id, mimeType);
			const full = officeKind
				? await extractOfficeOpenXmlText(downloaded.bytes, officeKind)
				: new TextDecoder("utf-8").decode(downloaded.bytes);
			const limit = input.max_chars ?? 50_000;
			const truncated = full.length > limit;
			const text = truncated ? full.slice(0, limit) : full;
			const formatted = `${name} (${mimeType}):\n\n${text}${
				truncated ? `\n\n… [truncated at ${limit} chars of ${full.length}]` : ""
			}`;

			return {
				id: meta.id,
				name,
				mimeType,
				text,
				truncated,
				totalChars: full.length,
				formatted,
			};
		},
	});
}
