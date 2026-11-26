import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type GoogleAccount, googleAccountInput, resolveAppsScriptAccount } from "./account.js";
import { type FormattedScriptVersion, formatVersion } from "./format.js";

export const appsscriptCreateVersionInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	description: z.string().optional().describe("Description for this immutable version snapshot."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptCreateVersionInputSchema = z.object(appsscriptCreateVersionInput);
export const appsscriptCreateVersionSchema = appsscriptCreateVersionInputSchema;
export type AppsscriptCreateVersionInput = z.infer<typeof appsscriptCreateVersionInputSchema>;

export interface AppsscriptCreateVersionOutput {
	account: GoogleAccount;
	script_id: string;
	version: FormattedScriptVersion;
}

export function formatAppsscriptCreateVersionMcp(out: AppsscriptCreateVersionOutput): string {
	const v = out.version;
	return (
		`Created version v${v.version_number ?? undefined} for project '${out.script_id}':\n` +
		`${v.description ? `Description: ${v.description}\n` : ""}Created at: ${v.create_time ?? "now"}`
	);
}

export function createAppsscriptCreateVersionAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptCreateVersionInputSchema, AppsscriptCreateVersionOutput> {
	return defineAction({
		id: "appsscript_create_version",
		domain: "integrations",
		description:
			"Create an immutable version snapshot of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: appsscriptCreateVersionInputSchema,
		formatMcp: formatAppsscriptCreateVersionMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const rawVersion = await port.createVersion({
				domain,
				scriptId: args.script_id,
				description: args.description,
			});
			return { account, script_id: args.script_id, version: formatVersion(rawVersion) };
		},
	});
}
