import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort, ScriptFile } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	type GoogleAccount,
	googleAccountInput,
	resolveAppsScriptAccount,
} from "./account.js";
import {
	type FormattedScriptFile,
	formatScriptFile,
	formatScriptFiles,
} from "./format.js";

export const appsscriptGetContentInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	version_number: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Optional immutable version number to fetch. If omitted, retrieves current head/working copy.",
		),
	file_name: z
		.string()
		.optional()
		.describe(
			"Optional file name to fetch alone (e.g. 'Code' or 'appsscript'). If omitted, returns all files in the project.",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptGetContentInputSchema = z.object(appsscriptGetContentInput);
export const appsscriptGetContentSchema = appsscriptGetContentInputSchema;
export type AppsscriptGetContentInput = z.infer<typeof appsscriptGetContentInputSchema>;

export interface AppsscriptGetContentOutput {
	account: GoogleAccount;
	script_id: string;
	version_number: number | null;
	file_count: number;
	files: FormattedScriptFile[];
}

export function formatAppsscriptGetContentMcp(
	out: AppsscriptGetContentOutput,
): string {
	const requestedFileName = (out as { _requestedFileName?: string })._requestedFileName;
	if (requestedFileName && out.files.length === 0) {
		const allFiles = (out as { _allFiles?: ScriptFile[] })._allFiles ?? [];
		return `File '${requestedFileName}' not found in script '${out.script_id}'. Available files:\n${formatScriptFiles(allFiles)}`;
	}

	const sections = out.files.map((f) => {
		const ext = f.type === "HTML" ? "html" : f.type === "JSON" ? "json" : "javascript";
		const fullName = `${f.name}.${f.type === "HTML" ? "html" : f.type === "JSON" ? "json" : "gs"}`;
		return `### ${fullName} (${f.type})\n\`\`\`${ext}\n${f.source ?? ""}\n\`\`\``;
	});

	const versionStr = out.version_number ? ` (v${out.version_number})` : " (head)";
	return `Project files for '${out.script_id}'${versionStr} [${out.files.length} file(s)]:\n\n${sections.join("\n\n")}`;
}

export function createAppsscriptGetContentAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptGetContentInputSchema, AppsscriptGetContentOutput> {
	return defineAction({
		id: "appsscript_get_content",
		domain: "integrations",
		description:
			"Retrieve all source files (.gs, .html, appsscript.json manifest) for an Apps Script project, or filter for a single file. Supports domain='angus' (default) and 'work'.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: appsscriptGetContentInputSchema,
		formatMcp: formatAppsscriptGetContentMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const { files } = await port.getContent({
				domain,
				scriptId: args.script_id,
				versionNumber: args.version_number,
			});

			let selectedFiles = files;
			if (args.file_name) {
				const rawLower = args.file_name.toLowerCase();
				const targetLower = args.file_name
					.replace(/\.(gs|js|html|json)$/i, "")
					.toLowerCase();
				selectedFiles = files.filter((f) => {
					const nameLower = (f.name ?? "").toLowerCase();
					const strippedLower = nameLower.replace(/\.(gs|js|html|json)$/i, "");
					return (
						strippedLower === targetLower ||
						nameLower === targetLower ||
						nameLower === rawLower
					);
				});
			}

			const formattedFiles = selectedFiles.map(formatScriptFile);
			const out: AppsscriptGetContentOutput = {
				account,
				script_id: args.script_id,
				version_number: args.version_number ?? null,
				file_count: formattedFiles.length,
				files: formattedFiles,
			};
			Object.defineProperty(out, "_requestedFileName", {
				value: args.file_name,
				enumerable: false,
			});
			Object.defineProperty(out, "_allFiles", {
				value: files,
				enumerable: false,
			});
			return out;
		},
	});
}
