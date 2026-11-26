import { describe, expect, it, vi } from "vitest";
import { createIntegrationListAction, formatIntegrationListMcp } from "./integrationList.js";
import type { ConfigRepository } from "../../ports/config.js";

describe("createIntegrationListAction", () => {
	const mockRepo = (integrations: Awaited<ReturnType<ConfigRepository["listIntegrations"]>>): ConfigRepository => ({
		loadConfigDetailed: vi.fn(),
		loadConfig: vi.fn(),
		loadIntegration: vi.fn(),
		listByFamily: vi.fn(),
		updateConfig: vi.fn(),
		listIntegrations: vi.fn().mockResolvedValue(integrations),
	});

	it("returns integrations from ConfigRepository and formats empty list", async () => {
		const action = createIntegrationListAction(mockRepo([]));
		const out = await action.run({}, { surface: "mcp" });
		expect(out).toEqual({ integrations: [] });
		expect(formatIntegrationListMcp(out)).toBe(
			"No integrations configured. Add rows to user_integrations (e.g. provider 'notion_work' with { tasks_database_id }).",
		);
	});

	it("formats integrations with routing, status, disabled flag, keys, and Notion page-access note", async () => {
		const action = createIntegrationListAction(
			mockRepo([
				{
					provider: "notion_work",
					routing: "native",
					status: "connected",
					enabled: true,
					config_keys: ["tasks_database_id", "state_doc_page_id"],
				},
				{
					provider: "google:personal",
					routing: "own_substrate",
					status: "expired",
					enabled: false,
					config_keys: [],
				},
			]),
		);
		const out = await action.run({}, { surface: "mcp" });
		const text = formatIntegrationListMcp(out);
		expect(text).toContain("• notion_work [native] — keys: tasks_database_id, state_doc_page_id");
		expect(text).toContain("• google:personal [own_substrate, expired] (disabled) — keys: (none)");
		expect(text).toContain("Notion page access (#625/#818):");
	});

	it("filters by provider and renders redacted non-secret config when include_config or provider is supplied (#2001)", async () => {
		const action = createIntegrationListAction(
			mockRepo([
				{
					provider: "github",
					routing: "native",
					status: "connected",
					enabled: true,
					config_keys: ["issue_repos", "read_repos", "api_token"],
					config: {
						issue_repos: ["anguspersonal/ahOS"],
						read_repos: ["anguspersonal/ahOS"],
						api_token: "ghp_secret_value",
					},
				},
				{
					provider: "notion_work",
					routing: "native",
					status: "connected",
					enabled: true,
					config_keys: ["tasks_database_id"],
					config: { tasks_database_id: "db-1" },
				},
			]),
		);

		const defaultOut = await action.run({}, { caller: "mcp", requestId: "req-default" });
		expect(defaultOut.integrations).toHaveLength(2);
		expect(formatIntegrationListMcp(defaultOut)).not.toContain("config:");

		const filteredOut = await action.run(
			{ provider: "github", include_config: true },
			{ caller: "mcp", requestId: "req-github" },
		);
		expect(filteredOut.integrations).toEqual([
			{
				provider: "github",
				routing: "native",
				status: "connected",
				enabled: true,
				config_keys: ["issue_repos", "read_repos", "api_token"],
				config: {
					issue_repos: ["anguspersonal/ahOS"],
					read_repos: ["anguspersonal/ahOS"],
					api_token: "[REDACTED]",
				},
			},
		]);

		const text = formatIntegrationListMcp(filteredOut);
		expect(text).toContain("• github [native] — keys: issue_repos, read_repos, api_token");
		expect(text).toContain(
			'config: {"issue_repos":["anguspersonal/ahOS"],"read_repos":["anguspersonal/ahOS"],"api_token":"[REDACTED]"}',
		);
		expect(text).not.toContain("ghp_secret_value");
		expect(text).not.toContain("notion_work");
	});
});
