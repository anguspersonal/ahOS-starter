import { z } from "zod";
import { mergeFiles } from "../../domain/appsscript/mergeFiles.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type GoogleAccount, googleAccountInput, resolveAppsScriptAccount } from "./account.js";
import { type FormattedScriptFile, formatScriptFile, formatScriptFiles } from "./format.js";

export const appsscriptUpdateContentInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	files: z
		.array(
			z.object({
				name: z
					.string()
					.min(1)
					.describe("File name. Can include extension (.gs, .html, .json) or bare name."),
				source: z.string().describe("Source code content for the file."),
				type: z
					.enum(["SERVER_JS", "HTML", "JSON"])
					.optional()
					.describe("Optional file type (SERVER_JS for .gs, HTML for .html, JSON for manifest)."),
			}),
		)
		.min(1)
		.describe("Array of files to write into the script project."),
	overwrite_all: z
		.boolean()
		.optional()
		.describe(
			"If true, removes any existing files not specified in `files` (manifest is always preserved). If false (default), merges incoming files into existing files.",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptUpdateContentInputSchema = z.object(appsscriptUpdateContentInput);
export const appsscriptUpdateContentSchema = appsscriptUpdateContentInputSchema;
export type AppsscriptUpdateContentInput = z.infer<typeof appsscriptUpdateContentInputSchema>;

export interface AppsscriptUpdateContentOutput {
	account: GoogleAccount;
	script_id: string;
	files: FormattedScriptFile[];
	edit_url: string;
}

export function formatAppsscriptUpdateContentMcp(out: AppsscriptUpdateContentOutput): string {
	return (
		`Successfully updated content in project '${out.script_id}' (${out.account} account).\n\n` +
		`Current project files (${out.files.length}):\n${formatScriptFiles(out.files)}\n\n` +
		`Edit URL: ${out.edit_url}`
	);
}

export function createAppsscriptUpdateContentAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptUpdateContentInputSchema, AppsscriptUpdateContentOutput> {
	return defineAction({
		id: "appsscript_update_content",
		domain: "integrations",
		description:
			"Write or update code files in an Apps Script project. By default merges incoming files and preserves the appsscript.json manifest. Supports domain='angus' (default) and 'work'.",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		schema: appsscriptUpdateContentInputSchema,
		formatMcp: formatAppsscriptUpdateContentMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const overwriteAll = args.overwrite_all ?? false;
			const incomingHasManifest = args.files.some(
				(f: { name: string }) => f.name === "appsscript" || f.name === "appsscript.json",
			);
			const existing =
				!overwriteAll || !incomingHasManifest
					? (await port.getContent({ domain, scriptId: args.script_id })).files
					: [];
			const finalFiles = mergeFiles({ existing, incoming: args.files, overwriteAll });
			const updated = await port.updateContent({
				domain,
				scriptId: args.script_id,
				files: finalFiles,
			});
			const scriptId = updated.scriptId ?? args.script_id;
			return {
				account,
				script_id: scriptId,
				files: updated.files.map(formatScriptFile),
				edit_url: `https://script.google.com/d/${scriptId}/edit`,
			};
		},
	});
}
