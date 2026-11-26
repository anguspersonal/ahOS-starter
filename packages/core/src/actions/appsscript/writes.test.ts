import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import type { ActionContext } from "../types.js";
import { appsscriptCreateProjectInput, createAppsscriptCreateProjectAction } from "./createProject.js";
import { appsscriptUpdateContentInput, createAppsscriptUpdateContentAction } from "./updateContent.js";

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
		run: vi.fn(async () => ({ done: true })),
		...overrides,
	};
}

describe("appsscript write actions - contract and behaviour (#1637)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("1. appsscript_create_project contract matches legacy tool", () => {
		const action = createAppsscriptCreateProjectAction(makePort());
		expect(action.id).toBe("appsscript_create_project");
		expect(action.description).toBe(
			"Create a new Apps Script project, either standalone or bound to a Google Sheet/Doc container. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				title: { type: "string", minLength: 1, description: "Title of the new Apps Script project." },
				parent_id: {
					type: "string",
					description:
						"Optional Drive ID of the container document (e.g. Google Sheet or Doc) to bind this script to. If omitted, creates a standalone script.",
				},
				folder_id: {
					type: "string",
					description: "Optional Drive folder ID where the new standalone script file should be placed.",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["title"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(appsscriptCreateProjectInput)));
	});

	it("2. appsscript_update_content contract matches legacy tool including destructiveHint: true", () => {
		const action = createAppsscriptUpdateContentAction(makePort());
		expect(action.id).toBe("appsscript_update_content");
		expect(action.description).toBe(
			"Write or update code files in an Apps Script project. By default merges incoming files and preserves the appsscript.json manifest. Supports domain='angus' (default) and 'work'.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(appsscriptUpdateContentInput)));
	});

	it("3. appsscript_create_project reports folder move when folder_id is given without parent_id, and states failed move warning", async () => {
		const okPort = makePort({
			createProject: vi.fn(async () => ({ scriptId: "new-proj", title: "Work Webhook" })),
		});
		const okAction = createAppsscriptCreateProjectAction(okPort);
		const okOut = await okAction.run(
			{ title: "Work Webhook", folder_id: "fld-9", account: "work" },
			TEST_CONTEXT,
		);
		expect(okPort.createProject).toHaveBeenCalledWith({
			domain: "work",
			title: "Work Webhook",
			parentId: undefined,
			folderId: "fld-9",
		});
		expect(okOut.moved_to_folder).toBe("fld-9");
		expect(okOut.move_warning).toBeNull();
		const okText = okAction.formatMcp!(okOut);
		expect(okText).toContain("Created new Apps Script project in 'work' account:");
		expect(okText).toContain("[new-proj] Work Webhook");
		expect(okText).toContain("Moved to folder: fld-9");

		const warnPort = makePort({
			createProject: vi.fn(async () => ({
				scriptId: "new-proj",
				title: "Work Webhook",
				moveWarning: "Could not move new script new-proj to folder fld-9: HTTP 500",
			})),
		});
		const warnAction = createAppsscriptCreateProjectAction(warnPort);
		const warnOut = await warnAction.run(
			{ title: "Work Webhook", folder_id: "fld-9" },
			TEST_CONTEXT,
		);
		expect(warnOut.moved_to_folder).toBeNull();
		expect(warnOut.move_warning).toContain("Could not move new script new-proj to folder fld-9");
		expect(warnAction.formatMcp!(warnOut)).toContain("Warning: Could not move new script new-proj to folder fld-9");

		await expect(
			okAction.run({ title: "X", domain: "angus", account: "work" }, TEST_CONTEXT),
		).rejects.toThrow(/different domains/);
	});

	it("4. appsscript_update_content merges incoming files and preserves manifest in merge and overwrite_all modes", async () => {
		const mergePort = makePort({
			getContent: vi.fn(async () => ({
				scriptId: "proj-1",
				files: [
					{ name: "appsscript", type: "JSON", source: '{"runtimeVersion":"V8"}' },
					{ name: "Code", type: "SERVER_JS", source: "old" },
				],
			})),
		});
		const mergeAction = createAppsscriptUpdateContentAction(mergePort);
		const mergeOut = await mergeAction.run(
			{ script_id: "proj-1", files: [{ name: "Util.gs", source: "util" }] },
			TEST_CONTEXT,
		);
		expect(mergePort.getContent).toHaveBeenCalledTimes(1);
		expect(mergePort.updateContent).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			files: [
				{ name: "appsscript", type: "JSON", source: '{"runtimeVersion":"V8"}' },
				{ name: "Code", type: "SERVER_JS", source: "old" },
				{ name: "Util", type: "SERVER_JS", source: "util" },
			],
		});
		expect(mergeOut.files).toHaveLength(3);
		expect(mergeAction.formatMcp!(mergeOut)).toContain("Successfully updated content in project 'proj-1'");

		const overwritePort = makePort({
			getContent: vi.fn(async () => ({
				scriptId: "proj-1",
				files: [{ name: "Code", type: "SERVER_JS", source: "gone" }],
			})),
		});
		const overwriteAction = createAppsscriptUpdateContentAction(overwritePort);
		await overwriteAction.run(
			{
				script_id: "proj-1",
				files: [{ name: "Fresh.gs", source: "fresh" }],
				overwrite_all: true,
			},
			TEST_CONTEXT,
		);
		expect(overwritePort.updateContent).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			files: [
				expect.objectContaining({ name: "appsscript", type: "JSON" }),
				{ name: "Fresh", type: "SERVER_JS", source: "fresh" },
			],
		});
	});
});
