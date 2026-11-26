import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { executeAction } from "../adapters/direct.js";
import { setActionApprovalStore, type ActionApprovalStore } from "../gate.js";
import type { ActionContext } from "../types.js";
import { appsscriptRunFunctionInput, createAppsscriptRunFunctionAction } from "./runFunction.js";

const TEST_CONTEXT: ActionContext = { userId: "user-1", caller: "mcp", requestId: "req-1" };

const ACCOUNT_SCHEMA_PROP = {
	type: "string",
	enum: ["personal", "work"],
	description:
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
};

const DOMAIN_SCHEMA_PROP = {
	type: "string",
	enum: ["work", "angus"],
	description:
		"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
};

const DEFAULT_EXPOSE = { mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false };

function makePort(overrides?: Partial<AppsScriptPort>): AppsScriptPort {
	return {
		listProjects: vi.fn(async () => []),
		getProject: vi.fn(async () => ({ scriptId: "proj-1", title: "Automations" })),
		createProject: vi.fn(async () => ({ scriptId: "proj-1", title: "Automations" })),
		getContent: vi.fn(async () => ({ scriptId: "proj-1", files: [] })),
		updateContent: vi.fn(async ({ scriptId, files }) => ({ scriptId, files })),
		createVersion: vi.fn(async () => ({ versionNumber: 1 })),
		listVersions: vi.fn(async () => []),
		listDeployments: vi.fn(async () => []),
		createDeployment: vi.fn(async () => ({ deploymentId: "dep-1" })),
		run: vi.fn(async () => ({ done: true, response: { result: { count: 42 } } })),
		...overrides,
	};
}

describe("appsscript_run_function action - contract and behaviour (#1638)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		setActionApprovalStore(null);
	});

	it("1. contract matches legacy tool including destructiveHint: true", () => {
		const action = createAppsscriptRunFunctionAction(makePort());
		expect(action.id).toBe("appsscript_run_function");
		expect(action.description).toBe(
			"Execute a function in an Apps Script project via the Google Apps Script Execution API. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				script_id: { type: "string", minLength: 1, description: "Apps Script project ID." },
				function_name: {
					type: "string",
					minLength: 1,
					description: "Name of the function to execute in the script.",
				},
				parameters: {
					type: "array",
					items: {},
					description: "Array of arguments to pass to the function.",
				},
				dev_mode: {
					type: "boolean",
					description:
						"If true, runs against head/most recently saved code instead of deployed code (default false).",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id", "function_name"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(appsscriptRunFunctionInput)));
	});

	it("2. parameters defaults to [] and dev_mode defaults to false", async () => {
		const port = makePort();
		const action = createAppsscriptRunFunctionAction(port);

		await action.run({ script_id: "proj-1", function_name: "calculateStats" }, TEST_CONTEXT);

		expect(port.run).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			functionName: "calculateStats",
			parameters: [],
			devMode: false,
		});
	});

	it("3. formats error operations and success results identically to legacy handler", async () => {
		const errPort = makePort({
			run: vi.fn(async () => ({
				done: true,
				error: {
					code: 3,
					message: "ScriptError: missing sheet",
					details: [{ errorMessage: "ReferenceError: x is not defined" }],
				},
			})),
		});
		const errAction = createAppsscriptRunFunctionAction(errPort);
		const errOut = await errAction.run(
			{ script_id: "proj-1", function_name: "syncData" },
			TEST_CONTEXT,
		);
		const errText = errAction.formatMcp!(errOut);
		expect(errText).toContain("Execution failed for function 'syncData' on script 'proj-1':");
		expect(errText).toContain("ScriptError: missing sheet");
		expect(errText).toContain("Details:");
		expect(errText).toContain("ReferenceError: x is not defined");

		const okPort = makePort({
			run: vi.fn(async () => ({
				done: true,
				response: { result: { count: 42 } },
			})),
		});
		const okAction = createAppsscriptRunFunctionAction(okPort);
		const okOut = await okAction.run(
			{ script_id: "proj-1", function_name: "calculateStats" },
			TEST_CONTEXT,
		);
		const okText = okAction.formatMcp!(okOut);
		expect(okText).toContain("Function 'calculateStats' executed successfully on script 'proj-1':");
		expect(okText).toContain('"count": 42');

		const voidPort = makePort({
			run: vi.fn(async () => ({ done: true, response: {} })),
		});
		const voidAction = createAppsscriptRunFunctionAction(voidPort);
		const voidOut = await voidAction.run(
			{ script_id: "proj-1", function_name: "noop" },
			TEST_CONTEXT,
		);
		expect(voidAction.formatMcp!(voidOut)).toContain("void (null)");
	});

	it("4. caller mcp runs without parking even with an approval store installed (not gated)", async () => {
		const approvalStore: ActionApprovalStore = {
			park: vi.fn(async () => ({ decisionId: "dec-never" })),
		};
		setActionApprovalStore(approvalStore);

		const port = makePort();
		const action = createAppsscriptRunFunctionAction(port);
		const res = await executeAction(
			action,
			{ script_id: "proj-1", function_name: "calculateStats", parameters: [1, "a"], dev_mode: true },
			{ context: TEST_CONTEXT },
		);

		expect(approvalStore.park).not.toHaveBeenCalled();
		expect(port.run).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			functionName: "calculateStats",
			parameters: [1, "a"],
			devMode: true,
		});
		expect(res.operation.response?.result).toEqual({ count: 42 });
	});
});
