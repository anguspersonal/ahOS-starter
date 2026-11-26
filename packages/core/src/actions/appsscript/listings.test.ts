import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import type { ActionContext } from "../types.js";
import {
	formatDeployment,
	formatDeployments,
	formatVersion,
	formatVersions,
} from "./format.js";
import {
	appsscriptListDeploymentsInput,
	createAppsscriptListDeploymentsAction,
} from "./listDeployments.js";
import {
	appsscriptListVersionsInput,
	createAppsscriptListVersionsAction,
} from "./listVersions.js";

const TEST_CONTEXT: ActionContext = {
	userId: "user-1",
	caller: "mcp",
	requestId: "req-1",
};

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

function makePort(overrides?: Partial<AppsScriptPort>): AppsScriptPort {
	return {
		listProjects: vi.fn(async () => []),
		getProject: vi.fn(async () => ({ scriptId: "proj-1", title: "Automations" })),
		createProject: vi.fn(async () => ({ scriptId: "proj-1", title: "Automations" })),
		getContent: vi.fn(async () => ({ scriptId: "proj-1", files: [] })),
		updateContent: vi.fn(async () => ({ scriptId: "proj-1", files: [] })),
		createVersion: vi.fn(async () => ({ versionNumber: 1 })),
		listVersions: vi.fn(async () => []),
		listDeployments: vi.fn(async () => []),
		createDeployment: vi.fn(async () => ({ deploymentId: "dep-1" })),
		run: vi.fn(async () => ({ done: true })),
		...overrides,
	};
}

describe("appsscript listing actions - contract and behaviour (#1635)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("1. appsscript_list_versions contract matches legacy tool", () => {
		const action = createAppsscriptListVersionsAction(makePort());

		expect(action.id).toBe("appsscript_list_versions");
		expect(action.description).toBe(
			"List historical versions of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				script_id: {
					type: "string",
					minLength: 1,
					description: "Apps Script project ID.",
				},
				page_size: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					description: "Max versions to return (default 50).",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(appsscriptListVersionsInput)),
		);
	});

	it("2. appsscript_list_deployments contract matches legacy tool", () => {
		const action = createAppsscriptListDeploymentsAction(makePort());

		expect(action.id).toBe("appsscript_list_deployments");
		expect(action.description).toBe(
			"List deployments (web apps, add-ons, API executables) of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				script_id: {
					type: "string",
					minLength: 1,
					description: "Apps Script project ID.",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(appsscriptListDeploymentsInput)),
		);
	});

	it("3. appsscript_list_versions defaults page_size to 50, clamps to 1..100, reconciles domain/account, and formats header and version lines", async () => {
		const rawVersions = [
			{
				scriptId: "proj-1",
				versionNumber: 2,
				description: "Bugfix release",
				createTime: "2026-09-14T06:30:00Z",
			},
			{
				scriptId: "proj-1",
				versionNumber: 1,
				createTime: "2026-09-01T00:00:00Z",
			},
		];
		const port = makePort({
			listVersions: vi.fn(async () => rawVersions),
		});
		const action = createAppsscriptListVersionsAction(port);

		const defaultOut = await action.run({ script_id: "proj-1" }, TEST_CONTEXT);
		expect(port.listVersions).toHaveBeenLastCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			pageSize: 50,
		});
		expect(defaultOut).toEqual({
			account: "personal",
			script_id: "proj-1",
			count: 2,
			versions: rawVersions.map(formatVersion),
		});
		expect(action.formatMcp!(defaultOut)).toBe(
			"Versions for script 'proj-1' (personal account):\n" +
				"• v2: Bugfix release (created 2026-09-14T06:30:00Z)\n" +
				"• v1 (created 2026-09-01T00:00:00Z)",
		);

		const workOut = await action.run(
			{ script_id: "proj-1", page_size: 250, domain: "work" },
			TEST_CONTEXT,
		);
		expect(port.listVersions).toHaveBeenLastCalledWith({
			domain: "work",
			scriptId: "proj-1",
			pageSize: 100,
		});
		expect(workOut.account).toBe("work");
		expect(action.formatMcp!(workOut)).toContain(
			"Versions for script 'proj-1' (work account):",
		);

		await action.run(
			{ script_id: "proj-1", page_size: 0, account: "work" },
			TEST_CONTEXT,
		);
		expect(port.listVersions).toHaveBeenLastCalledWith({
			domain: "work",
			scriptId: "proj-1",
			pageSize: 1,
		});

		await expect(
			action.run(
				{ script_id: "proj-1", domain: "angus", account: "work" },
				TEST_CONTEXT,
			),
		).rejects.toThrow(/different domains/);

		const emptyPort = makePort({ listVersions: vi.fn(async () => []) });
		const emptyAction = createAppsscriptListVersionsAction(emptyPort);
		const emptyOut = await emptyAction.run({ script_id: "proj-1" }, TEST_CONTEXT);
		expect(emptyOut).toEqual({
			account: "personal",
			script_id: "proj-1",
			count: 0,
			versions: [],
		});
		expect(emptyAction.formatMcp!(emptyOut)).toBe(
			"Versions for script 'proj-1' (personal account):\nNo versions found.",
		);
	});

	it("4. appsscript_list_deployments reconciles domain/account, returns structured deployments, and formats header and deployment lines", async () => {
		const rawDeployments = [
			{
				deploymentId: "dep-123",
				deploymentConfig: {
					scriptId: "proj-1",
					versionNumber: 3,
					description: "Production webhook",
					manifestFileName: "appsscript",
				},
				updateTime: "2026-09-14T07:00:00Z",
				entryPoints: [
					{
						entryPointType: "WEB_APP",
						webApp: { url: "https://script.google.com/macros/s/dep-123/exec" },
					},
					{
						entryPointType: "EXECUTION_API",
					},
				],
			},
			{
				deploymentId: "dep-head",
				deploymentConfig: {
					scriptId: "proj-1",
				},
			},
		];
		const port = makePort({
			listDeployments: vi.fn(async () => rawDeployments),
		});
		const action = createAppsscriptListDeploymentsAction(port);

		const out = await action.run(
			{ script_id: "proj-1", domain: "work" },
			TEST_CONTEXT,
		);
		expect(port.listDeployments).toHaveBeenCalledWith({
			domain: "work",
			scriptId: "proj-1",
		});
		expect(out).toEqual({
			account: "work",
			script_id: "proj-1",
			count: 2,
			deployments: rawDeployments.map(formatDeployment),
		});
		expect(action.formatMcp!(out)).toBe(
			"Deployments for script 'proj-1' (work account):\n" +
				"• [dep-123] v3 - Production webhook [WEB_APP, EXECUTION_API] (updated 2026-09-14T07:00:00Z)\n" +
				"• [dep-head] head (updated unknown)",
		);

		await expect(
			action.run(
				{ script_id: "proj-1", domain: "work", account: "personal" },
				TEST_CONTEXT,
			),
		).rejects.toThrow(/different domains/);

		const emptyPort = makePort({ listDeployments: vi.fn(async () => []) });
		const emptyAction = createAppsscriptListDeploymentsAction(emptyPort);
		const emptyOut = await emptyAction.run({ script_id: "proj-1" }, TEST_CONTEXT);
		expect(emptyOut).toEqual({
			account: "personal",
			script_id: "proj-1",
			count: 0,
			deployments: [],
		});
		expect(emptyAction.formatMcp!(emptyOut)).toBe(
			"Deployments for script 'proj-1' (personal account):\nNo deployments found.",
		);
	});

	it("5. formatVersions and formatDeployments accept both raw Script* and Formatted* shapes", () => {
		expect(formatVersions([])).toBe("No versions found.");
		expect(
			formatVersions([{ versionNumber: 1, description: "Initial", createTime: "t1" }]),
		).toBe("• v1: Initial (created t1)");

		expect(formatDeployments([])).toBe("No deployments found.");
		expect(
			formatDeployments([
				{
					deploymentId: "d1",
					deploymentConfig: { versionNumber: 2, description: "Prod" },
					updateTime: "t2",
					entryPoints: [{ entryPointType: "WEB_APP" }],
				},
			]),
		).toBe("• [d1] v2 - Prod [WEB_APP] (updated t2)");
	});
});
