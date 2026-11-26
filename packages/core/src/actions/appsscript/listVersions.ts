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
	type FormattedScriptVersion,
	formatVersion,
	formatVersions,
} from "./format.js";

export const appsscriptListVersionsInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max versions to return (default 50)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptListVersionsInputSchema = z.object(appsscriptListVersionsInput);
export const appsscriptListVersionsSchema = appsscriptListVersionsInputSchema;
export type AppsscriptListVersionsInput = z.infer<typeof appsscriptListVersionsInputSchema>;

export interface AppsscriptListVersionsOutput {
	account: GoogleAccount;
	script_id: string;
	count: number;
	versions: FormattedScriptVersion[];
}

export function formatAppsscriptListVersionsMcp(
	out: AppsscriptListVersionsOutput,
): string {
	return `Versions for script '${out.script_id}' (${out.account} account):\n${formatVersions(out.versions)}`;
}

export function createAppsscriptListVersionsAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptListVersionsInputSchema, AppsscriptListVersionsOutput> {
	return defineAction({
		id: "appsscript_list_versions",
		domain: "integrations",
		description:
			"List historical versions of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: appsscriptListVersionsInputSchema,
		formatMcp: formatAppsscriptListVersionsMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const pageSize = Math.min(100, Math.max(1, args.page_size ?? 50));
			const rawVersions = await port.listVersions({
				domain,
				scriptId: args.script_id,
				pageSize,
			});

			const versions = rawVersions.map(formatVersion);
			return {
				account,
				script_id: args.script_id,
				count: versions.length,
				versions,
			};
		},
	});
}
