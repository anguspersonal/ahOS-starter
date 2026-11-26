import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_MEETING_NOTE_SOURCES } from "../../domain/ingest/meetingNoteEmails.js";
import { createSupabaseConfigRepository } from "./config.js";

describe("createSupabaseConfigRepository", () => {
	const testSchema = z.object({ tasks_database_id: z.string() });

	function mockTable(response: { data: any; error: any }, onUpdate?: (payload: any) => void) {
		const seen: { userId?: string; provider?: string; likePattern?: string } = {};
		const chain: any = {
			select: () => chain,
			eq: (col: string, val: string) => {
				if (col === "user_id") seen.userId = val;
				if (col === "provider") seen.provider = val;
				return chain;
			},
			like: (_col: string, val: string) => {
				seen.likePattern = val;
				return chain;
			},
			order: () => Promise.resolve(response),
			maybeSingle: () => Promise.resolve(response),
			update: (payload: any) => {
				onUpdate?.(payload);
				return chain;
			},
			then: (resolve: any) => resolve(response),
		};
		return { client: { from: vi.fn(() => chain) } as any, seen };
	}

	it("loadConfigDetailed returns ok for valid enabled row and unwired when disabled or invalid", async () => {
		const { client, seen } = mockTable({
			data: { config: { tasks_database_id: "db-1" }, enabled: true },
			error: null,
		});
		const repo = createSupabaseConfigRepository({ client, ownerId: () => "user-1" });
		const res = await repo.loadConfigDetailed("notion_work", testSchema);
		expect(res).toEqual({ status: "ok", data: { tasks_database_id: "db-1" } });
		expect(seen.userId).toBe("user-1");
		expect(seen.provider).toBe("notion_work");

		const disabled = createSupabaseConfigRepository({
			client: mockTable({ data: { config: { tasks_database_id: "db-1" }, enabled: false }, error: null }).client,
			ownerId: "user-1",
		});
		expect(await disabled.loadConfigDetailed("notion_work", testSchema)).toEqual({ status: "unwired" });
		expect(await disabled.loadConfig("notion_work", testSchema)).toBeNull();
	});

	it("listByFamily filters out disabled rows and defaults routing to own_substrate", async () => {
		const { client, seen } = mockTable({
			data: [
				{ provider: "google:personal", enabled: true, config: { a: 1 } },
				{ provider: "google:disabled", enabled: false, config: {} },
			],
			error: null,
		});
		const repo = createSupabaseConfigRepository({ client, ownerId: "user-1" });
		const rows = await repo.listByFamily("google");
		expect(seen.likePattern).toBe("google:%");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("google:personal");
		expect(rows[0]?.routing).toBe("own_substrate");
	});

	it("updateConfig merges patch into existing config and listIntegrations returns redacted non-secret config", async () => {
		let updatedPayload: any;
		const { client } = mockTable(
			{
				data: {
					provider: "notion_work",
					routing: "native",
					status: "connected",
					enabled: true,
					credential_ref: null,
					config: { tasks_database_id: "secret-db", title_property: "Name" },
				},
				error: null,
			},
			(p) => (updatedPayload = p),
		);
		const repo = createSupabaseConfigRepository({ client, ownerId: "user-1" });
		await repo.updateConfig("notion_work", { status_property: "Status" });
		expect(updatedPayload).toEqual({
			config: { tasks_database_id: "secret-db", title_property: "Name", status_property: "Status" },
		});

		const listRepo = createSupabaseConfigRepository({
			client: mockTable({
				data: [
					{
						provider: "notion_work",
						enabled: true,
						routing: "native",
						status: "connected",
						config: {
							tasks_database_id: "db-123",
							access_token: "tok-123",
							webhook_secret: "sec-456",
							api_key: "key-789",
						},
					},
				],
				error: null,
			}).client,
			ownerId: "user-1",
		});
		expect(await listRepo.listIntegrations()).toEqual([
			{
				provider: "notion_work",
				enabled: true,
				routing: "native",
				status: "connected",
				config_keys: ["tasks_database_id", "access_token", "webhook_secret", "api_key"],
				config: {
					tasks_database_id: "db-123",
					access_token: "[REDACTED]",
					webhook_secret: "[REDACTED]",
					api_key: "[REDACTED]",
				},
			},
		]);
	});

	it("loadPreferencesRow and loadCapturePreferences read user_preferences for owner", async () => {
		const row = { user_id: "user-1", user_mode: "solo", capture_preferences: { default_tags: ["ops"] } };
		const repo = createSupabaseConfigRepository({
			client: mockTable({ data: row, error: null }).client,
			ownerId: "user-1",
		});
		expect(await repo.loadPreferencesRow()).toEqual(row);
		expect((await repo.loadCapturePreferences()).default_tags).toEqual(["ops"]);

		const emptyRepo = createSupabaseConfigRepository({
			client: mockTable({ data: null, error: null }).client,
			ownerId: "user-1",
		});
		expect(await emptyRepo.loadPreferencesRow()).toBeNull();
		expect((await emptyRepo.loadCapturePreferences()).default_source_channel).toBe("mcp");
	});

	it("readIntegrationConfig, insertIntegrationConfig, and updateIntegrationConfigRow round-trip user_integrations (#1598)", async () => {
		let inserted: any;
		let updated: any;
		const chain: any = {
			select: () => chain,
			eq: () => chain,
			maybeSingle: () => Promise.resolve({ data: { config: { a: "1" }, enabled: true }, error: null }),
			insert: (payload: any) => {
				inserted = payload;
				return chain;
			},
			update: (payload: any) => {
				updated = payload;
				return chain;
			},
			single: () =>
				Promise.resolve({
					data: { provider: "github", enabled: true, config: { a: "1" } },
					error: null,
				}),
		};
		const repo = createSupabaseConfigRepository({
			client: { from: vi.fn(() => chain) } as any,
			ownerId: "user-1",
		});

		expect(await repo.readIntegrationConfig("github")).toEqual({ config: { a: "1" }, enabled: true });
		await repo.insertIntegrationConfig("github", { config: { a: "1" }, enabled: true });
		expect(inserted).toEqual({ user_id: "user-1", provider: "github", config: { a: "1" }, enabled: true });
		await repo.updateIntegrationConfigRow("github", { config: { a: "2" }, enabled: false });
		expect(updated).toEqual({ config: { a: "2" }, enabled: false });
	});

	it("loadDosConfigRow returns raw dos_config when present and null when absent or errored (#1603)", async () => {
		const rawDosConfig = { by_domain: { work: { topics: ["Round"] } }, tone: ["Rule 1"] };
		const { client, seen } = mockTable({
			data: { dos_config: rawDosConfig },
			error: null,
		});
		const repo = createSupabaseConfigRepository({ client, ownerId: "user-1" });
		expect(await repo.loadDosConfigRow()).toEqual(rawDosConfig);
		expect(seen.userId).toBe("user-1");

		const emptyRepo = createSupabaseConfigRepository({
			client: mockTable({ data: null, error: null }).client,
			ownerId: "user-1",
		});
		expect(await emptyRepo.loadDosConfigRow()).toBeNull();

		const errRepo = createSupabaseConfigRepository({
			client: mockTable({ data: { dos_config: rawDosConfig }, error: new Error("db err") }).client,
			ownerId: "user-1",
		});
		expect(await errRepo.loadDosConfigRow()).toBeNull();
	});

	it("loadPastedInstructions prefers system_instructions_sync, falls back to legacy keys, and returns null when absent (#1601)", async () => {
		const syncRecord = { sha256: "a".repeat(64), pasted_at: "2026-04-12T10:00:00.000Z" };
		const legacyRecord = { sha256: "b".repeat(64), pasted_at: "2026-04-11T10:00:00.000Z" };

		const preferredRepo = createSupabaseConfigRepository({
			client: mockTable({
				data: {
					dos_config: {
						system_instructions_sync: syncRecord,
						pasted_instructions: legacyRecord,
					},
				},
				error: null,
			}).client,
			ownerId: "user-1",
		});
		expect(await preferredRepo.loadPastedInstructions()).toEqual(syncRecord);

		const legacyRepo = createSupabaseConfigRepository({
			client: mockTable({
				data: {
					dos_config: {
						pasted_instructions: legacyRecord,
					},
				},
				error: null,
			}).client,
			ownerId: "user-1",
		});
		expect(await legacyRepo.loadPastedInstructions()).toEqual(legacyRecord);

		const emptyRepo = createSupabaseConfigRepository({
			client: mockTable({ data: { dos_config: {} }, error: null }).client,
			ownerId: "user-1",
		});
		expect(await emptyRepo.loadPastedInstructions()).toBeNull();
	});

	it("savePastedInstructions merges system_instructions_sync and pasted_instructions into dos_config (#1601)", async () => {
		let updatedPayload: any;
		const { client, seen } = mockTable(
			{
				data: { dos_config: { tone: ["Concise"] } },
				error: null,
			},
			(p) => (updatedPayload = p),
		);
		const repo = createSupabaseConfigRepository({ client, ownerId: "user-1" });
		await repo.savePastedInstructions("c".repeat(64), "2026-04-12T12:00:00.000Z");
		expect(seen.userId).toBe("user-1");
		expect(updatedPayload).toEqual({
			dos_config: {
				tone: ["Concise"],
				system_instructions_sync: {
					sha256: "c".repeat(64),
					pasted_at: "2026-04-12T12:00:00.000Z",
				},
				pasted_instructions: {
					sha256: "c".repeat(64),
					pasted_at: "2026-04-12T12:00:00.000Z",
				},
			},
		});
	});

	it("meetingNoteSources returns stored, default, or invalid-stored rules (#1538)", async () => {
		const customRule = [
			{
				id: "granola",
				label: "Granola Notes",
				from: ["notes@example.com"],
				subject_contains: "Notes:",
				enabled: true,
			},
		];
		const { client, seen } = mockTable({
			data: { meeting_note_sources: customRule },
			error: null,
		});
		const repo = createSupabaseConfigRepository({ client, ownerId: "user-1" });
		expect(await repo.meetingNoteSources("user-override")).toEqual({
			sources: customRule,
			origin: "stored",
		});
		expect(seen.userId).toBe("user-override");

		const absentRepo = createSupabaseConfigRepository({
			client: mockTable({ data: { user_mode: "solo" }, error: null }).client,
			ownerId: "user-1",
		});
		expect(await absentRepo.meetingNoteSources()).toEqual({
			sources: DEFAULT_MEETING_NOTE_SOURCES,
			origin: "default",
		});

		const invalidRepo = createSupabaseConfigRepository({
			client: mockTable({ data: { meeting_note_sources: [{ bad: true }] }, error: null }).client,
			ownerId: "user-1",
		});
		expect(await invalidRepo.meetingNoteSources("user-1")).toEqual({
			sources: DEFAULT_MEETING_NOTE_SOURCES,
			origin: "invalid-stored",
		});
	});
});

