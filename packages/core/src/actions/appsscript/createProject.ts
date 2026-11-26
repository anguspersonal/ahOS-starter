import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type GoogleAccount, googleAccountInput, resolveAppsScriptAccount } from "./account.js";
import { type FormattedScriptProject, formatProject, formatProjectLine } from "./format.js";

export const appsscriptCreateProjectInput = {
	title: z.string().min(1).describe("Title of the new Apps Script project."),
	parent_id: z
		.string()
		.optional()
		.describe(
			"Optional Drive ID of the container document (e.g. Google Sheet or Doc) to bind this script to. If omitted, creates a standalone script.",
		),
	folder_id: z
		.string()
		.optional()
		.describe(
			"Optional Drive folder ID where the new standalone script file should be placed.",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptCreateProjectInputSchema = z.object(appsscriptCreateProjectInput);
export const appsscriptCreateProjectSchema = appsscriptCreateProjectInputSchema;
export type AppsscriptCreateProjectInput = z.infer<typeof appsscriptCreateProjectInputSchema>;

export interface AppsscriptCreateProjectOutput {
	account: GoogleAccount;
	project: FormattedScriptProject;
	edit_url: string | null;
	moved_to_folder: string | null;
	move_warning: string | null;
}

export function formatAppsscriptCreateProjectMcp(out: AppsscriptCreateProjectOutput): string {
	const base =
		`Created new Apps Script project in '${out.account}' account:\n` +
		`${formatProjectLine(out.project)}\n\n` +
		`Edit URL: https://script.google.com/d/${out.project.script_id ?? undefined}/edit`;
	if (out.move_warning) {
		return `${base}\n\nWarning: ${out.move_warning}`;
	}
	if (out.moved_to_folder) {
		return `${base}\nMoved to folder: ${out.moved_to_folder}`;
	}
	return base;
}

export function createAppsscriptCreateProjectAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptCreateProjectInputSchema, AppsscriptCreateProjectOutput> {
	return defineAction({
		id: "appsscript_create_project",
		domain: "integrations",
		description:
			"Create a new Apps Script project, either standalone or bound to a Google Sheet/Doc container. Supports domain='angus' (default) and 'work'.",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: appsscriptCreateProjectInputSchema,
		formatMcp: formatAppsscriptCreateProjectMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const rawProject = await port.createProject({
				domain,
				title: args.title,
				parentId: args.parent_id,
				folderId: args.folder_id,
			});
			const project = formatProject(rawProject);
			const moveWarning = rawProject.moveWarning ?? null;
			const movedToFolder = !args.parent_id && args.folder_id && !moveWarning ? args.folder_id : null;
			return {
				account,
				project,
				edit_url: project.script_id ? `https://script.google.com/d/${project.script_id}/edit` : null,
				moved_to_folder: movedToFolder,
				move_warning: moveWarning,
			};
		},
	});
}
