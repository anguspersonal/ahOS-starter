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
	type FormattedScriptDeployment,
	formatDeployment,
	formatDeployments,
} from "./format.js";

export const appsscriptListDeploymentsInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptListDeploymentsInputSchema = z.object(appsscriptListDeploymentsInput);
export const appsscriptListDeploymentsSchema = appsscriptListDeploymentsInputSchema;
export type AppsscriptListDeploymentsInput = z.infer<typeof appsscriptListDeploymentsInputSchema>;

export interface AppsscriptListDeploymentsOutput {
	account: GoogleAccount;
	script_id: string;
	count: number;
	deployments: FormattedScriptDeployment[];
}

export function formatAppsscriptListDeploymentsMcp(
	out: AppsscriptListDeploymentsOutput,
): string {
	return `Deployments for script '${out.script_id}' (${out.account} account):\n${formatDeployments(out.deployments)}`;
}

export function createAppsscriptListDeploymentsAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptListDeploymentsInputSchema, AppsscriptListDeploymentsOutput> {
	return defineAction({
		id: "appsscript_list_deployments",
		domain: "integrations",
		description:
			"List deployments (web apps, add-ons, API executables) of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: appsscriptListDeploymentsInputSchema,
		formatMcp: formatAppsscriptListDeploymentsMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const rawDeployments = await port.listDeployments({
				domain,
				scriptId: args.script_id,
			});

			const deployments = rawDeployments.map(formatDeployment);
			return {
				account,
				script_id: args.script_id,
				count: deployments.length,
				deployments,
			};
		},
	});
}
