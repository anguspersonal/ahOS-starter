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
	type FormattedScriptProject,
	formatProject,
	formatProjectLine,
} from "./format.js";

export const appsscriptGetProjectInput = {
	script_id: z.string().min(1).describe("Apps Script project ID (Google Drive file ID)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptGetProjectInputSchema = z.object(appsscriptGetProjectInput);
export const appsscriptGetProjectSchema = appsscriptGetProjectInputSchema;
export type AppsscriptGetProjectInput = z.infer<typeof appsscriptGetProjectInputSchema>;

export interface AppsscriptGetProjectOutput {
	account: GoogleAccount;
	project: FormattedScriptProject;
}

export function formatAppsscriptGetProjectMcp(
	out: AppsscriptGetProjectOutput,
): string {
	const scriptId =
		(out as { _scriptId?: string })._scriptId ?? out.project.script_id ?? "";
	return `Project metadata for '${scriptId}' (${out.account} account):\n${formatProjectLine(out.project)}\n\nEdit URL: https://script.google.com/d/${scriptId}/edit`;
}

export function createAppsscriptGetProjectAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptGetProjectInputSchema, AppsscriptGetProjectOutput> {
	return defineAction({
		id: "appsscript_get_project",
		domain: "integrations",
		description:
			"Get metadata for an Apps Script project by its script ID (title, create/update time, container parent). Supports domain='angus' (default) and 'work'.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: appsscriptGetProjectInputSchema,
		formatMcp: formatAppsscriptGetProjectMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const rawProject = await port.getProject({
				domain,
				scriptId: args.script_id,
			});

			const project = formatProject({
				...rawProject,
				scriptId: rawProject.scriptId ?? args.script_id,
			});
			const out: AppsscriptGetProjectOutput = {
				account,
				project,
			};
			Object.defineProperty(out, "_scriptId", {
				value: args.script_id,
				enumerable: false,
			});
			return out;
		},
	});
}
