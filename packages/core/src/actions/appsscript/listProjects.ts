import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	type GoogleAccount,
	googleAccountInput,
	resolveAppsScriptAccount,
} from "./account.js";
import {
	type FormattedDriveFile,
	formatDriveFile,
	formatDriveFileLine,
} from "./format.js";

export const appsscriptListProjectsInput = {
	query: z
		.string()
		.optional()
		.describe("Optional text substring to search for in Apps Script project titles."),
	folder_id: z
		.string()
		.optional()
		.describe("Optional Google Drive folder ID to limit search to."),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max projects to return (default 25)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptListProjectsInputSchema = z.object(appsscriptListProjectsInput);
export const appsscriptListProjectsSchema = appsscriptListProjectsInputSchema;
export type AppsscriptListProjectsInput = z.infer<typeof appsscriptListProjectsInputSchema>;

export interface AppsscriptListProjectsOutput {
	account: GoogleAccount;
	count: number;
	projects: FormattedDriveFile[];
}

export function formatAppsscriptListProjectsMcp(
	out: AppsscriptListProjectsOutput,
): string {
	const query =
		(out as { query?: string; _query?: string }).query ??
		(out as { _query?: string })._query;
	if (out.projects.length === 0) {
		return `No Apps Script projects found in the '${out.account}' account${query ? ` matching '${query}'` : ""}.`;
	}
	const formatted = out.projects.map(formatDriveFileLine).join("\n");
	return `Found ${out.projects.length} Apps Script project(s) in the '${out.account}' account:\n${formatted}`;
}

export function createAppsscriptListProjectsAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptListProjectsInputSchema, AppsscriptListProjectsOutput> {
	return defineAction({
		id: "appsscript_list_projects",
		domain: "integrations",
		description:
			"List Apps Script projects from Google Drive, optionally filtered by name query or parent folder. Supports domain='angus' (default) and 'work'.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: appsscriptListProjectsInputSchema,
		formatMcp: formatAppsscriptListProjectsMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const pageSize = Math.min(100, Math.max(1, args.page_size ?? 25));
			const files = await port.listProjects({
				domain,
				query: args.query,
				folderId: args.folder_id,
				pageSize,
			});

			const projects = files.map(formatDriveFile);
			const out: AppsscriptListProjectsOutput = {
				account,
				count: projects.length,
				projects,
			};
			Object.defineProperty(out, "_query", {
				value: args.query,
				enumerable: false,
			});
			return out;
		},
	});
}
