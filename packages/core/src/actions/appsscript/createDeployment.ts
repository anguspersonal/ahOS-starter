import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type GoogleAccount, googleAccountInput, resolveAppsScriptAccount } from "./account.js";
import { type FormattedScriptDeployment, formatDeployment } from "./format.js";

export const appsscriptCreateDeploymentInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	version_number: z.number().int().min(1).describe("Project version number to deploy."),
	description: z.string().optional().describe("Description for the deployment."),
	manifest_file_name: z.string().optional().describe("Manifest file name (defaults to 'appsscript')."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptCreateDeploymentInputSchema = z.object(appsscriptCreateDeploymentInput);
export const appsscriptCreateDeploymentSchema = appsscriptCreateDeploymentInputSchema;
export type AppsscriptCreateDeploymentInput = z.infer<typeof appsscriptCreateDeploymentInputSchema>;

export interface AppsscriptCreateDeploymentOutput {
	account: GoogleAccount;
	script_id: string;
	deployment: FormattedScriptDeployment;
}

export function formatAppsscriptCreateDeploymentMcp(out: AppsscriptCreateDeploymentOutput): string {
	const d = out.deployment;
	const epList = d.entry_points.map((ep) => ep.entry_point_type).filter(Boolean);
	return (
		`Successfully created deployment for script '${out.script_id}' (${out.account} account):\n` +
		`• Deployment ID: ${d.deployment_id ?? undefined}\n` +
		`• Version: v${d.version_number ?? undefined}\n` +
		`• Description: ${d.description ?? "(none)"}\n` +
		(epList.length ? `• Entry Points: ${epList.join(", ")}\n` : "") +
		`• Updated: ${d.update_time ?? "now"}`
	);
}

export function createAppsscriptCreateDeploymentAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptCreateDeploymentInputSchema, AppsscriptCreateDeploymentOutput> {
	return defineAction({
		id: "appsscript_create_deployment",
		domain: "integrations",
		description:
			"Create a new deployment for a specific version of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: appsscriptCreateDeploymentInputSchema,
		formatMcp: formatAppsscriptCreateDeploymentMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const rawDeployment = await port.createDeployment({
				domain,
				scriptId: args.script_id,
				versionNumber: args.version_number,
				description: args.description,
				manifestFileName: args.manifest_file_name ?? "appsscript",
			});
			return { account, script_id: args.script_id, deployment: formatDeployment(rawDeployment) };
		},
	});
}
