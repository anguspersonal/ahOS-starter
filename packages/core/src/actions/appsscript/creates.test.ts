import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import type { ActionContext } from "../types.js";
import { formatDeployment, formatVersion } from "./format.js";
import { appsscriptCreateDeploymentInput, createAppsscriptCreateDeploymentAction } from "./createDeployment.js";
import { appsscriptCreateVersionInput, createAppsscriptCreateVersionAction } from "./createVersion.js";

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
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

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

describe("appsscript create actions - contract and behaviour (#1636)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("1. appsscript_create_version contract matches legacy tool", () => {
		const action = createAppsscriptCreateVersionAction(makePort());
		expect(action.id).toBe("appsscript_create_version");
		expect(action.description).toBe(
			"Create an immutable version snapshot of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual(WRITE_ANNOTATIONS);
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				script_id: { type: "string", minLength: 1, description: "Apps Script project ID." },
				description: { type: "string", description: "Description for this immutable version snapshot." },
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(appsscriptCreateVersionInput)));
	});

	it("2. appsscript_create_deployment contract matches legacy tool", () => {
		const action = createAppsscriptCreateDeploymentAction(makePort());
		expect(action.id).toBe("appsscript_create_deployment");
		expect(action.description).toBe(
			"Create a new deployment for a specific version of an Apps Script project. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual(WRITE_ANNOTATIONS);
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				script_id: { type: "string", minLength: 1, description: "Apps Script project ID." },
				version_number: {
					type: "integer",
					minimum: 1,
					maximum: 9007199254740991,
					description: "Project version number to deploy.",
				},
				description: { type: "string", description: "Description for the deployment." },
				manifest_file_name: { type: "string", description: "Manifest file name (defaults to 'appsscript')." },
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id", "version_number"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(appsscriptCreateDeploymentInput)));
	});

	it("3. appsscript_create_version calls createVersion once with description and reports new version number", async () => {
		const rawVersion = {
			scriptId: "proj-1",
			versionNumber: 2,
			description: "Bugfix release",
			createTime: "2026-09-14T06:30:00Z",
		};
		const port = makePort({ createVersion: vi.fn(async () => rawVersion) });
		const action = createAppsscriptCreateVersionAction(port);

		const out = await action.run({ script_id: "proj-1", description: "Bugfix release" }, TEST_CONTEXT);
		expect(port.createVersion).toHaveBeenCalledTimes(1);
		expect(port.createVersion).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			description: "Bugfix release",
		});
		expect(out).toEqual({ account: "personal", script_id: "proj-1", version: formatVersion(rawVersion) });
		expect(action.formatMcp!(out)).toBe(
			"Created version v2 for project 'proj-1':\nDescription: Bugfix release\nCreated at: 2026-09-14T06:30:00Z",
		);

		const minimalPort = makePort({ createVersion: vi.fn(async () => ({ versionNumber: 3 })) });
		const minimalAction = createAppsscriptCreateVersionAction(minimalPort);
		const minimalOut = await minimalAction.run({ script_id: "proj-1", domain: "work" }, TEST_CONTEXT);
		expect(minimalPort.createVersion).toHaveBeenCalledTimes(1);
		expect(minimalPort.createVersion).toHaveBeenCalledWith({
			domain: "work",
			scriptId: "proj-1",
			description: undefined,
		});
		expect(minimalOut.account).toBe("work");
		expect(minimalAction.formatMcp!(minimalOut)).toBe("Created version v3 for project 'proj-1':\nCreated at: now");

		await expect(
			action.run({ script_id: "proj-1", domain: "angus", account: "work" }, TEST_CONTEXT),
		).rejects.toThrow(/different domains/);
	});

	it("4. appsscript_create_deployment calls createDeployment once with version number and manifest file name and reports deployment id and entry points", async () => {
		const rawDeployment = {
			deploymentId: "dep-123",
			deploymentConfig: {
				scriptId: "proj-1",
				versionNumber: 3,
				description: "Production webhook",
				manifestFileName: "custom_manifest",
			},
			updateTime: "2026-09-14T07:00:00Z",
			entryPoints: [
				{ entryPointType: "WEB_APP", webApp: { url: "https://script.google.com/macros/s/dep-123/exec" } },
				{ entryPointType: "EXECUTION_API" },
			],
		};
		const port = makePort({ createDeployment: vi.fn(async () => rawDeployment) });
		const action = createAppsscriptCreateDeploymentAction(port);

		const out = await action.run(
			{
				script_id: "proj-1",
				version_number: 3,
				description: "Production webhook",
				manifest_file_name: "custom_manifest",
				domain: "work",
			},
			TEST_CONTEXT,
		);
		expect(port.createDeployment).toHaveBeenCalledTimes(1);
		expect(port.createDeployment).toHaveBeenCalledWith({
			domain: "work",
			scriptId: "proj-1",
			versionNumber: 3,
			description: "Production webhook",
			manifestFileName: "custom_manifest",
		});
		expect(out).toEqual({ account: "work", script_id: "proj-1", deployment: formatDeployment(rawDeployment) });
		expect(action.formatMcp!(out)).toBe(
			"Successfully created deployment for script 'proj-1' (work account):\n" +
				"• Deployment ID: dep-123\n• Version: v3\n• Description: Production webhook\n" +
				"• Entry Points: WEB_APP, EXECUTION_API\n• Updated: 2026-09-14T07:00:00Z",
		);

		const defaultPort = makePort({
			createDeployment: vi.fn(async () => ({
				deploymentId: "dep-456",
				deploymentConfig: { scriptId: "proj-1", versionNumber: 1 },
			})),
		});
		const defaultAction = createAppsscriptCreateDeploymentAction(defaultPort);
		const defaultOut = await defaultAction.run({ script_id: "proj-1", version_number: 1 }, TEST_CONTEXT);
		expect(defaultPort.createDeployment).toHaveBeenCalledTimes(1);
		expect(defaultPort.createDeployment).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			versionNumber: 1,
			description: undefined,
			manifestFileName: "appsscript",
		});
		expect(defaultAction.formatMcp!(defaultOut)).toBe(
			"Successfully created deployment for script 'proj-1' (personal account):\n" +
				"• Deployment ID: dep-456\n• Version: v1\n• Description: (none)\n• Updated: now",
		);

		await expect(
			action.run({ script_id: "proj-1", version_number: 1, domain: "work", account: "personal" }, TEST_CONTEXT),
		).rejects.toThrow(/different domains/);
	});
});
