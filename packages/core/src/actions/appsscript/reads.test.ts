import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import type { ActionContext } from "../types.js";
import { resolveAppsScriptAccount } from "./account.js";
import { formatDriveFile, formatProject, formatScriptFile } from "./format.js";
import {
	appsscriptGetContentInput,
	createAppsscriptGetContentAction,
} from "./getContent.js";
import {
	appsscriptGetProjectInput,
	createAppsscriptGetProjectAction,
} from "./getProject.js";
import {
	appsscriptListProjectsInput,
	createAppsscriptListProjectsAction,
} from "./listProjects.js";

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

describe("appsscript read actions — contract and behaviour (#1634)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("1. appsscript_list_projects contract matches legacy tool", () => {
		const action = createAppsscriptListProjectsAction(makePort());

		expect(action.id).toBe("appsscript_list_projects");
		expect(action.description).toBe(
			"List Apps Script projects from Google Drive, optionally filtered by name query or parent folder. Supports domain='angus' (default) and 'work'.",
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
				query: {
					type: "string",
					description: "Optional text substring to search for in Apps Script project titles.",
				},
				folder_id: {
					type: "string",
					description: "Optional Google Drive folder ID to limit search to.",
				},
				page_size: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					description: "Max projects to return (default 25).",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(appsscriptListProjectsInput)),
		);
	});

	it("2. appsscript_get_project contract matches legacy tool", () => {
		const action = createAppsscriptGetProjectAction(makePort());

		expect(action.id).toBe("appsscript_get_project");
		expect(action.description).toBe(
			"Get metadata for an Apps Script project by its script ID (title, create/update time, container parent). Supports domain='angus' (default) and 'work'.",
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
					description: "Apps Script project ID (Google Drive file ID).",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(appsscriptGetProjectInput)),
		);
	});

	it("3. appsscript_get_content contract matches legacy tool", () => {
		const action = createAppsscriptGetContentAction(makePort());

		expect(action.id).toBe("appsscript_get_content");
		expect(action.description).toBe(
			"Retrieve all source files (.gs, .html, appsscript.json manifest) for an Apps Script project, or filter for a single file. Supports domain='angus' (default) and 'work'.",
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
				version_number: {
					type: "integer",
					minimum: 1,
					maximum: 9007199254740991,
					description:
						"Optional immutable version number to fetch. If omitted, retrieves current head/working copy.",
				},
				file_name: {
					type: "string",
					description:
						"Optional file name to fetch alone (e.g. 'Code' or 'appsscript'). If omitted, returns all files in the project.",
				},
				account: ACCOUNT_SCHEMA_PROP,
				domain: DOMAIN_SCHEMA_PROP,
			},
			required: ["script_id"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(appsscriptGetContentInput)),
		);
	});

	it("4. reconciles domain and account: defaults to personal ('angus'), maps work on either axis, and refuses conflicting values", async () => {
		expect(resolveAppsScriptAccount({})).toEqual({ account: "personal", domain: "angus" });
		expect(resolveAppsScriptAccount({ domain: "work" })).toEqual({
			account: "work",
			domain: "work",
		});
		expect(resolveAppsScriptAccount({ account: "work" })).toEqual({
			account: "work",
			domain: "work",
		});
		expect(() => resolveAppsScriptAccount({ domain: "angus", account: "work" })).toThrow(
			/different domains/,
		);

		const driveFile = {
			id: "proj-1",
			name: "Automations",
			mimeType: "application/vnd.google-apps.script",
			modifiedTime: "2026-09-14T06:00:00Z",
		};
		const port = makePort({
			listProjects: vi.fn(async () => [driveFile]),
		});
		const listAction = createAppsscriptListProjectsAction(port);

		const defaultOut = await listAction.run({}, TEST_CONTEXT);
		expect(port.listProjects).toHaveBeenLastCalledWith({
			domain: "angus",
			query: undefined,
			folderId: undefined,
			pageSize: 25,
		});
		expect(defaultOut).toEqual({
			account: "personal",
			count: 1,
			projects: [formatDriveFile(driveFile)],
		});
		expect(listAction.formatMcp!(defaultOut)).toContain(
			"Found 1 Apps Script project(s) in the 'personal' account:",
		);
		expect(listAction.formatMcp!(defaultOut)).toContain("[proj-1] Automations");

		const domainOut = await listAction.run({ domain: "work" }, TEST_CONTEXT);
		expect(port.listProjects).toHaveBeenLastCalledWith({
			domain: "work",
			query: undefined,
			folderId: undefined,
			pageSize: 25,
		});
		expect(domainOut.account).toBe("work");
		expect(listAction.formatMcp!(domainOut)).toContain("in the 'work' account:");

		const accountOut = await listAction.run({ account: "work" }, TEST_CONTEXT);
		expect(port.listProjects).toHaveBeenLastCalledWith({
			domain: "work",
			query: undefined,
			folderId: undefined,
			pageSize: 25,
		});
		expect(accountOut.account).toBe("work");
		expect(listAction.formatMcp!(accountOut)).toContain("in the 'work' account:");

		await expect(
			listAction.run({ domain: "angus", account: "work" }, TEST_CONTEXT),
		).rejects.toThrow(/different domains/);
	});

	it("5. appsscript_list_projects clamps page_size to 1..100 (default 25), forwards query and folder_id, returns structured output, and formats MCP text", async () => {
		const files = [
			{
				id: "proj-1",
				name: "Automations",
				mimeType: "application/vnd.google-apps.script",
				modifiedTime: "2026-09-14T06:00:00Z",
				createdTime: "2026-09-01T00:00:00Z",
				parents: ["folder-1"],
				webViewLink: "https://script.google.com/d/proj-1/edit",
			},
		];
		const port = makePort({ listProjects: vi.fn(async () => files) });
		const action = createAppsscriptListProjectsAction(port);

		const out = await action.run(
			{ query: "Auto", folder_id: "folder-1", page_size: 250 },
			TEST_CONTEXT,
		);
		expect(port.listProjects).toHaveBeenLastCalledWith({
			domain: "angus",
			query: "Auto",
			folderId: "folder-1",
			pageSize: 100,
		});
		expect(out).toEqual({
			account: "personal",
			count: 1,
			projects: files.map(formatDriveFile),
		});
		expect(action.formatMcp!(out)).toBe(
			"Found 1 Apps Script project(s) in the 'personal' account:\n" +
				"• [proj-1] Automations (application/vnd.google-apps.script, modified 2026-09-14T06:00:00Z)",
		);

		await action.run({ page_size: 0 }, TEST_CONTEXT);
		expect(port.listProjects).toHaveBeenLastCalledWith({
			domain: "angus",
			query: undefined,
			folderId: undefined,
			pageSize: 1,
		});

		const emptyPort = makePort({ listProjects: vi.fn(async () => []) });
		const emptyAction = createAppsscriptListProjectsAction(emptyPort);

		const noQuery = await emptyAction.run({}, TEST_CONTEXT);
		expect(noQuery).toEqual({ account: "personal", count: 0, projects: [] });
		expect(emptyAction.formatMcp!(noQuery)).toBe(
			"No Apps Script projects found in the 'personal' account.",
		);

		const withQuery = await emptyAction.run(
			{ domain: "work", query: "Webhook" },
			TEST_CONTEXT,
		);
		expect(withQuery).toEqual({ account: "work", count: 0, projects: [] });
		expect(emptyAction.formatMcp!(withQuery)).toBe(
			"No Apps Script projects found in the 'work' account matching 'Webhook'.",
		);
	});

	it("6. appsscript_get_project returns structured project metadata and formats MCP text ending with the edit URL", async () => {
		const rawProject = {
			scriptId: "proj-1",
			title: "Automations",
			parentId: "sheet-123",
			createTime: "2026-09-01T00:00:00Z",
			updateTime: "2026-09-14T06:00:00Z",
		};
		const port = makePort({
			getProject: vi.fn(async () => rawProject),
		});
		const action = createAppsscriptGetProjectAction(port);

		const out = await action.run({ script_id: "proj-1", account: "work" }, TEST_CONTEXT);
		expect(port.getProject).toHaveBeenCalledWith({
			domain: "work",
			scriptId: "proj-1",
		});
		expect(out).toEqual({
			account: "work",
			project: formatProject(rawProject),
		});
		expect(out.project).toEqual({
			script_id: "proj-1",
			title: "Automations",
			create_time: "2026-09-01T00:00:00Z",
			update_time: "2026-09-14T06:00:00Z",
			parent_id: "sheet-123",
		});

		const mcpText = action.formatMcp!(out);
		expect(mcpText).toBe(
			"Project metadata for 'proj-1' (work account):\n" +
				"• [proj-1] Automations (created: 2026-09-01T00:00:00Z, modified: 2026-09-14T06:00:00Z, container: sheet-123)\n\n" +
				"Edit URL: https://script.google.com/d/proj-1/edit",
		);
		expect(mcpText.endsWith("https://script.google.com/d/proj-1/edit")).toBe(true);
	});

	it("7. appsscript_get_content returns structured files with line_count, filters file_name case-insensitively after stripping .gs/.html/.json, and formats MCP code blocks or miss message", async () => {
		const rawFiles = [
			{ name: "Code", type: "SERVER_JS", source: "function doGet() {\n  return 1;\n}" },
			{ name: "Index", type: "HTML", source: "<div>Hello</div>" },
			{ name: "appsscript", type: "JSON", source: '{"timeZone":"UTC"}' },
		];
		const port = makePort({
			getContent: vi.fn(async () => ({
				scriptId: "proj-1",
				files: rawFiles,
			})),
		});
		const action = createAppsscriptGetContentAction(port);

		const allOut = await action.run({ script_id: "proj-1" }, TEST_CONTEXT);
		expect(port.getContent).toHaveBeenCalledWith({
			domain: "angus",
			scriptId: "proj-1",
			versionNumber: undefined,
		});
		expect(allOut).toEqual({
			account: "personal",
			script_id: "proj-1",
			version_number: null,
			file_count: 3,
			files: rawFiles.map(formatScriptFile),
		});
		expect(allOut.files[0]?.line_count).toBe(3);
		expect(allOut.files[1]?.line_count).toBe(1);
		expect(allOut.files[2]?.line_count).toBe(1);

		const allMcp = action.formatMcp!(allOut);
		expect(allMcp).toContain("Project files for 'proj-1' (head) [3 file(s)]:");
		expect(allMcp).toContain(
			"### Code.gs (SERVER_JS)\n```javascript\nfunction doGet() {\n  return 1;\n}\n```",
		);
		expect(allMcp).toContain("### Index.html (HTML)\n```html\n<div>Hello</div>\n```");
		expect(allMcp).toContain('### appsscript.json (JSON)\n```json\n{"timeZone":"UTC"}\n```');

		const singleOut = await action.run(
			{ script_id: "proj-1", file_name: "code.GS", version_number: 3, domain: "work" },
			TEST_CONTEXT,
		);
		expect(port.getContent).toHaveBeenLastCalledWith({
			domain: "work",
			scriptId: "proj-1",
			versionNumber: 3,
		});
		expect(singleOut).toEqual({
			account: "work",
			script_id: "proj-1",
			version_number: 3,
			file_count: 1,
			files: [formatScriptFile(rawFiles[0]!)],
		});
		expect(action.formatMcp!(singleOut)).toBe(
			"Project files for 'proj-1' (v3) [1 file(s)]:\n\n### Code.gs (SERVER_JS)\n```javascript\nfunction doGet() {\n  return 1;\n}\n```",
		);

		const htmlOut = await action.run(
			{ script_id: "proj-1", file_name: "INDEX.HTML" },
			TEST_CONTEXT,
		);
		expect(htmlOut.file_count).toBe(1);
		expect(htmlOut.files[0]?.name).toBe("Index");

		const manifestOut = await action.run(
			{ script_id: "proj-1", file_name: "APPSSCRIPT.JSON" },
			TEST_CONTEXT,
		);
		expect(manifestOut.file_count).toBe(1);
		expect(manifestOut.files[0]?.name).toBe("appsscript");

		const missOut = await action.run(
			{ script_id: "proj-1", file_name: "Missing.gs" },
			TEST_CONTEXT,
		);
		expect(missOut).toEqual({
			account: "personal",
			script_id: "proj-1",
			version_number: null,
			file_count: 0,
			files: [],
		});
		expect(action.formatMcp!(missOut)).toBe(
			"File 'Missing.gs' not found in script 'proj-1'. Available files:\n" +
				"• Code.gs (SERVER_JS, 3 lines)\n" +
				"• Index.html (HTML, 1 lines)\n" +
				"• appsscript.json (JSON, 1 lines)",
		);
	});
});
