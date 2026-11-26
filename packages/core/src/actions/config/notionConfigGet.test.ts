import { describe, expect, it, vi } from "vitest";
import { notionConfigSchema, notionPersonalConfigSchema } from "../../domain/integrations.js";
import type { ConfigRepository } from "../../ports/config.js";
import { createNotionConfigGetAction, formatNotionConfigGetMcp } from "./notionConfigGet.js";

describe("createNotionConfigGetAction (#1598)", () => {
	function mockRepo(rows: {
		notion_work?: Record<string, unknown> | null;
		notion_personal?: Record<string, unknown> | null;
	}): ConfigRepository {
		return {
			loadConfigDetailed: vi.fn(),
			loadConfig: vi.fn(async (provider: string) => {
				if (provider === "notion_work") {
					const raw = rows.notion_work;
					return raw ? (notionConfigSchema.parse(raw) as any) : null;
				}
				if (provider === "notion_personal") {
					const raw = rows.notion_personal;
					return raw ? (notionPersonalConfigSchema.parse(raw) as any) : null;
				}
				return null;
			}),
			loadIntegration: vi.fn(),
			listByFamily: vi.fn(),
			updateConfig: vi.fn(),
			listIntegrations: vi.fn(),
		};
	}

	it("returns both Notion configs when provider is omitted and formats MCP output", async () => {
		const action = createNotionConfigGetAction(
			mockRepo({
				notion_work: {
					tasks_database_id: "db-hl",
					meetings_source_data_source_id: "pub-meetings",
					private_meetings_source_data_source_id: "priv-meetings",
				},
				notion_personal: {
					tasks_database_id: "db-personal",
					state_doc_page_id: "sdp-personal",
				},
			}),
		);
		const out = await action.run({}, { caller: "mcp", requestId: "req-1" });
		expect(out.notion_work?.tasks_database_id).toBe("db-hl");
		expect(out.notion_personal?.tasks_database_id).toBe("db-personal");

		const text = formatNotionConfigGetMcp(out);
		expect(text).toContain("notion_work (Work workspace):");
		expect(text).toContain("dos may read: pub-meetings, priv-meetings");
		expect(text).toContain("Recent Communications projects from: pub-meetings");
		expect(text).toContain("notion_personal (personal workspace):");
		expect(text).toContain("state_doc_page_id: sdp-personal");
	});

	it("filters by provider and prints not-configured hint when absent", async () => {
		const action = createNotionConfigGetAction(mockRepo({ notion_work: null }));
		const out = await action.run({ provider: "notion_work" }, { caller: "mcp", requestId: "req-2" });
		expect(out.notion_work).toBeNull();
		expect(out.notion_personal).toBeUndefined();

		const text = formatNotionConfigGetMcp(out);
		expect(text).toContain("notion_work: not configured");
		expect(text).not.toContain("notion_personal");
	});
});
