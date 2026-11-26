import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { AppsScriptPort, ScriptOperation } from "../../ports/appsscript.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { type GoogleAccount, googleAccountInput, resolveAppsScriptAccount } from "./account.js";

export const appsscriptRunFunctionInput = {
	script_id: z.string().min(1).describe("Apps Script project ID."),
	function_name: z.string().min(1).describe("Name of the function to execute in the script."),
	parameters: z
		.array(z.unknown())
		.optional()
		.describe("Array of arguments to pass to the function."),
	dev_mode: z
		.boolean()
		.optional()
		.describe(
			"If true, runs against head/most recently saved code instead of deployed code (default false).",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const appsscriptRunFunctionInputSchema = z.object(appsscriptRunFunctionInput);
export const appsscriptRunFunctionSchema = appsscriptRunFunctionInputSchema;
export type AppsscriptRunFunctionInput = z.infer<typeof appsscriptRunFunctionInputSchema>;

export interface AppsscriptRunFunctionOutput {
	account: GoogleAccount;
	script_id: string;
	function_name: string;
	operation: ScriptOperation;
}

export function formatAppsscriptRunFunctionMcp(out: AppsscriptRunFunctionOutput): string {
	const op = out.operation;
	if (op.error) {
		const details = JSON.stringify(op.error, null, 2);
		return `Execution failed for function '${out.function_name}' on script '${out.script_id}':\n${op.error.message ?? "Error"}\n\nDetails:\n${details}`;
	}

	const res = op.response as { result?: unknown } | undefined;
	const resultText = res && res.result !== undefined ? JSON.stringify(res.result, null, 2) : "void (null)";

	return `Function '${out.function_name}' executed successfully on script '${out.script_id}':\n${resultText}`;
}

export function createAppsscriptRunFunctionAction(
	port: AppsScriptPort,
): ActionDefinition<typeof appsscriptRunFunctionInputSchema, AppsscriptRunFunctionOutput> {
	return defineAction({
		id: "appsscript_run_function",
		domain: "integrations",
		description:
			"Execute a function in an Apps Script project via the Google Apps Script Execution API. Supports domain='angus' (default) and 'work'.",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		schema: appsscriptRunFunctionInputSchema,
		formatMcp: formatAppsscriptRunFunctionMcp,
		async run(args) {
			const { account, domain } = resolveAppsScriptAccount(args);
			const operation = await port.run({
				domain,
				scriptId: args.script_id,
				functionName: args.function_name,
				parameters: args.parameters ?? [],
				devMode: args.dev_mode ?? false,
			});
			return {
				account,
				script_id: args.script_id,
				function_name: args.function_name,
				operation,
			};
		},
	});
}
