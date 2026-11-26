import { describe, expect, it, vi } from "vitest";
import type { ConfigRepository } from "../../ports/config.js";
import { createIntegrationSetAction, formatIntegrationSetMcp } from "./integrationSet.js";

describe("createIntegrationSetAction (#1598)", () => {
	function mockRepo(existing: { config: Record<string, unknown>; enabled: boolean } | null = null) {
		const readIntegrationConfig = vi.fn().mockResolvedValue(existing);
		const insertIntegrationConfig = vi.fn().mockImplementation(async (provider, row) => ({
			provider,
			enabled: row.enabled,
			config: row.config,
		}));
		const updateIntegrationConfigRow = vi.fn().mockImplementation(async (provider, patch) => ({
			provider,
			enabled: patch.enabled ?? existing?.enabled ?? true,
			config: patch.config,
		}));
		const repo: ConfigRepository = {
			loadConfigDetailed: vi.fn(),
			loadConfig: vi.fn(),
			loadIntegration: vi.fn(),
			listByFamily: vi.fn(),
			updateConfig: vi.fn(),
			listIntegrations: vi.fn(),
			readIntegrationConfig,
			insertIntegrationConfig,
			updateIntegrationConfigRow,
		};
		return { repo, readIntegrationConfig, insertIntegrationConfig, updateIntegrationConfigRow };
	}

	it("inserts a new row when absent and formats created MCP output with key names only", async () => {
		const { repo, insertIntegrationConfig } = mockRepo(null);
		const action = createIntegrationSetAction(repo);
		const out = await action.run(
			{ provider: "notion_work", config: { tasks_database_id: "db-1" } },
			{ caller: "mcp", requestId: "req-1" },
		);

		expect(insertIntegrationConfig).toHaveBeenCalledWith("notion_work", {
			config: { tasks_database_id: "db-1" },
			enabled: true,
		});
		expect(out).toEqual({
			status: "created",
			provider: "notion_work",
			enabled: true,
			config_keys: ["tasks_database_id"],
			config: { tasks_database_id: "db-1" },
		});
		expect(formatIntegrationSetMcp(out)).toBe(
			"Created integration 'notion_work' (enabled: true).\nconfig keys: tasks_database_id",
		);
	});

	it("merges patch into existing config and rejects invalid schema or non-scalar unknown provider config", async () => {
		const { repo, updateIntegrationConfigRow } = mockRepo({
			config: { tasks_database_id: "db-1" },
			enabled: true,
		});
		const action = createIntegrationSetAction(repo);
		const out = await action.run(
			{ provider: "notion_work", config: { state_doc_page_id: "sdp-1" } },
			{ caller: "mcp", requestId: "req-2" },
		);

		expect(updateIntegrationConfigRow).toHaveBeenCalledWith("notion_work", {
			config: { tasks_database_id: "db-1", state_doc_page_id: "sdp-1" },
			enabled: undefined,
		});
		expect(out.config_keys).toEqual(["tasks_database_id", "state_doc_page_id"]);

		await expect(
			action.run(
				{ provider: "notion_work", config: { tasks_database_id: "" } },
				{ caller: "mcp", requestId: "req-3" },
			),
		).rejects.toThrow(/does not match its schema/);

		await expect(
			action.run(
				{ provider: "custom_unknown", config: { nested: { bad: true } } },
				{ caller: "mcp", requestId: "req-4" },
			),
		).rejects.toThrow(/Invalid config for unknown provider 'custom_unknown'/);
	});

	it("returns noop when neither config nor enabled is supplied", async () => {
		const { repo, readIntegrationConfig } = mockRepo(null);
		const action = createIntegrationSetAction(repo);
		const out = await action.run({ provider: "notion_work" }, { caller: "mcp", requestId: "req-5" });
		expect(readIntegrationConfig).not.toHaveBeenCalled();
		expect(out.status).toBe("noop");
		expect(formatIntegrationSetMcp(out)).toContain("No fields supplied");
	});

	it("appends and deduplicates array keys when merge_arrays is true (#2001)", async () => {
		const { repo, updateIntegrationConfigRow } = mockRepo({
			config: {
				issue_repos: ["anguspersonal/ahOS"],
				read_repos: ["anguspersonal/ahOS", "anguspersonal/shared"],
			},
			enabled: true,
		});
		const action = createIntegrationSetAction(repo);
		const out = await action.run(
			{
				provider: "github",
				config: {
					issue_repos: ["anguspersonal/other"],
					read_repos: ["anguspersonal/shared", "anguspersonal/other"],
				},
				merge_arrays: true,
			},
			{ caller: "mcp", requestId: "req-6" },
		);

		expect(updateIntegrationConfigRow).toHaveBeenCalledWith("github", {
			config: {
				issue_repos: ["anguspersonal/ahOS", "anguspersonal/other"],
				read_repos: ["anguspersonal/ahOS", "anguspersonal/shared", "anguspersonal/other"],
			},
			enabled: undefined,
		});
		expect(out).toEqual({
			status: "updated",
			provider: "github",
			enabled: true,
			config_keys: ["issue_repos", "read_repos"],
			config: {
				issue_repos: ["anguspersonal/ahOS", "anguspersonal/other"],
				read_repos: ["anguspersonal/ahOS", "anguspersonal/shared", "anguspersonal/other"],
			},
		});
	});
});
