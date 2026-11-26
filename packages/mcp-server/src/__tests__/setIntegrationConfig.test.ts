import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const setIntegrationConfigHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("integration_set")!).handler(args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
});

/**
 * Stub `user_integrations` for both the read (select…maybeSingle) and write
 * (insert/update…select…single) paths setIntegrationConfigHandler exercises,
 * keyed by the `user_id`/`provider` the handler filters on so we can assert
 * scoping. `row` is the pre-existing DB row (or undefined -> no row).
 */
function stubUserIntegrations(
	row: { config: Record<string, unknown>; enabled: boolean } | undefined,
	opts: { onInsert?: (payload: any) => void; onUpdate?: (payload: any) => void } = {},
) {
	const seen = { userId: undefined as string | undefined, provider: undefined as string | undefined };

	const b: any = {
		select() {
			return this;
		},
		eq(this: any, col: string, value: string) {
			if (col === "user_id") seen.userId = value;
			if (col === "provider") seen.provider = value;
			return this;
		},
		maybeSingle() {
			return Promise.resolve(row ? { data: row, error: null } : { data: null, error: null });
		},
		insert(this: any, payload: any) {
			opts.onInsert?.(payload);
			this._result = { ...payload };
			return this;
		},
		update(this: any, payload: any) {
			opts.onUpdate?.(payload);
			this._result = { ...(row ?? {}), ...payload };
			return this;
		},
		single() {
			return Promise.resolve({ data: this._result, error: null });
		},
	};

	(supabase as any).from = vi.fn(() => Object.create(b));
	return seen;
}

describe("setIntegrationConfigHandler", () => {
	it("inserts a new row when none exists (config + default enabled=true)", async () => {
		let inserted: any;
		const seen = stubUserIntegrations(undefined, {
			onInsert: (payload) => (inserted = payload),
		});

		const out = await setIntegrationConfigHandler({
			provider: "unknown_provider",
			config: { some_id: "abc123" },
		});

		expect(inserted.provider).toBe("unknown_provider");
		expect(inserted.config).toEqual({ some_id: "abc123" });
		expect(inserted.enabled).toBe(true);
		expect(seen.provider).toBe("unknown_provider");
		expect(out.content[0].text).toContain("Created integration 'unknown_provider'");
	});

	it("merges the patch into existing config, preserving keys not mentioned", async () => {
		let updated: any;
		stubUserIntegrations(
			{ config: { alpha: "1", beta: "2" }, enabled: true },
			{ onUpdate: (payload) => (updated = payload) },
		);

		const out = await setIntegrationConfigHandler({
			provider: "unknown_provider",
			config: { beta: "changed", gamma: "3" },
		});

		expect(updated.config).toEqual({ alpha: "1", beta: "changed", gamma: "3" });
		expect(out.content[0].text).toContain("Updated integration 'unknown_provider'");
	});

	it("toggles enabled without requiring a config patch", async () => {
		let updated: any;
		stubUserIntegrations(
			{ config: { alpha: "1" }, enabled: true },
			{ onUpdate: (payload) => (updated = payload) },
		);

		await setIntegrationConfigHandler({ provider: "unknown_provider", enabled: false });

		expect(updated.enabled).toBe(false);
		// config unchanged (still merged from existing, no patch supplied)
		expect(updated.config).toEqual({ alpha: "1" });
	});

	it("scopes every read/write to env.userId and the given provider", async () => {
		const seen = stubUserIntegrations({ config: {}, enabled: true });

		await setIntegrationConfigHandler({ provider: "notion_work", config: { tasks_database_id: "db1" } });

		expect(seen.userId).toBeTruthy();
		expect(seen.provider).toBe("notion_work");
	});

	it("rejects a merged config that fails a known provider's schema (notion_work requires tasks_database_id)", async () => {
		stubUserIntegrations(undefined);

		await expect(
			setIntegrationConfigHandler({
				provider: "notion_work",
				config: { title_property: "Name" }, // missing required tasks_database_id
			}),
		).rejects.toThrow(/does not match its schema/);
	});

	it("accepts a merged config that satisfies a known provider's schema", async () => {
		let inserted: any;
		stubUserIntegrations(undefined, { onInsert: (payload) => (inserted = payload) });

		const out = await setIntegrationConfigHandler({
			provider: "notion_work",
			config: { tasks_database_id: "db1" },
		});

		expect(inserted.config.tasks_database_id).toBe("db1");
		expect(out.content[0].text).toContain("Created integration 'notion_work'");
	});

	// Issue #299 (capture consolidation slice 4): the capture routing DB pointers are
	// accepted by the provider schemas, so the operator can persist them via this tool
	// instead of a skill body ever hardcoding them. IDs below are obviously fake.
	it("accepts capture routing destinations on notion_work (#299: dos_inbox_data_source_id)", async () => {
		let updated: any;
		stubUserIntegrations(
			{ config: { tasks_database_id: "db1" }, enabled: true },
			{ onUpdate: (payload) => (updated = payload) },
		);

		const out = await setIntegrationConfigHandler({
			provider: "notion_work",
			config: {
				dos_inbox_data_source_id: "00000000-fake-dos-inbox",
				meetings_source_data_source_id: "00000000-fake-meetings",
			},
		});

		expect(updated.config.dos_inbox_data_source_id).toBe("00000000-fake-dos-inbox");
		expect(updated.config.meetings_source_data_source_id).toBe("00000000-fake-meetings");
		expect(updated.config.tasks_database_id).toBe("db1"); // merge preserves existing keys
		expect(out.content[0].text).toContain("Updated integration 'notion_work'");
	});

	// #617 / ADR-053 §6: the private meetings pointer is per-user wiring like every
	// other pointer — set at runtime by the owner, never hardcoded in a skill body
	// (ADR-030). The merge must leave the existing public/write pointer untouched.
	it("accepts private_meetings_source_data_source_id on notion_work without disturbing the public one (#617)", async () => {
		let updated: any;
		stubUserIntegrations(
			{
				config: {
					tasks_database_id: "db1",
					meetings_source_data_source_id: "00000000-fake-public-meetings",
				},
				enabled: true,
			},
			{ onUpdate: (payload) => (updated = payload) },
		);

		const out = await setIntegrationConfigHandler({
			provider: "notion_work",
			config: {
				private_meetings_source_data_source_id: "00000000-fake-private-meetings",
			},
		});

		expect(updated.config.private_meetings_source_data_source_id).toBe(
			"00000000-fake-private-meetings",
		);
		expect(updated.config.meetings_source_data_source_id).toBe(
			"00000000-fake-public-meetings",
		);
		expect(updated.config.tasks_database_id).toBe("db1");
		expect(out.content[0].text).toContain("Updated integration 'notion_work'");
	});

	it("accepts capture routing destinations on notion_personal (#299: inbox/resources)", async () => {
		let updated: any;
		stubUserIntegrations(
			{ config: { tasks_database_id: "db2" }, enabled: true },
			{ onUpdate: (payload) => (updated = payload) },
		);

		await setIntegrationConfigHandler({
			provider: "notion_personal",
			config: {
				inbox_database_id: "00000000-fake-personal-inbox",
				resources_database_id: "00000000-fake-personal-resources",
			},
		});

		expect(updated.config.inbox_database_id).toBe("00000000-fake-personal-inbox");
		expect(updated.config.resources_database_id).toBe("00000000-fake-personal-resources");
	});

	it("rejects a non-string routing destination (#299 keys stay schema-validated)", async () => {
		stubUserIntegrations({ config: { tasks_database_id: "db1" }, enabled: true });

		await expect(
			setIntegrationConfigHandler({
				provider: "notion_work",
				config: { dos_inbox_data_source_id: 123 },
			}),
		).rejects.toThrow(/does not match its schema/);
	});

	// Issue #126: google_calendar's config schema (calendarConfigSchema) validates on
	// write, mirroring the notion_work coverage above.
	it("rejects a google_calendar config with a non-string calendar_id", async () => {
		stubUserIntegrations(undefined);

		await expect(
			setIntegrationConfigHandler({
				provider: "google_calendar",
				config: { calendar_id: 12345 as unknown as string },
			}),
		).rejects.toThrow(/does not match its schema/);
	});

	it("accepts a google_calendar config with a string calendar_id", async () => {
		let inserted: any;
		stubUserIntegrations(undefined, { onInsert: (payload) => (inserted = payload) });

		const out = await setIntegrationConfigHandler({
			provider: "google_calendar",
			config: { calendar_id: "someone@example.com" },
		});

		expect(inserted.config.calendar_id).toBe("someone@example.com");
		expect(out.content[0].text).toContain("Created integration 'google_calendar'");
	});

	it("accepts an empty google_calendar config (calendar_id's zod default of 'primary' is applied at read time by loadIntegrationConfig, not persisted here)", async () => {
		let inserted: any;
		stubUserIntegrations(undefined, { onInsert: (payload) => (inserted = payload) });

		const out = await setIntegrationConfigHandler({
			provider: "google_calendar",
			config: {},
		});

		expect(inserted.config).toEqual({});
		expect(out.content[0].text).toContain("Created integration 'google_calendar'");
	});

	it("rejects a non-scalar config value for an unknown provider", async () => {
		stubUserIntegrations(undefined);

		await expect(
			setIntegrationConfigHandler({
				provider: "some_new_provider",
				config: { nested: { not: "allowed" } },
			}),
		).rejects.toThrow(/Invalid config for unknown provider/);
	});

	it("accepts a github config with issue_repos and default_repo", async () => {
		let inserted: any;
		stubUserIntegrations(undefined, { onInsert: (payload) => (inserted = payload) });

		const out = await setIntegrationConfigHandler({
			provider: "github",
			config: {
				issue_repos: ["anguspersonal/ahOS"],
				default_repo: "anguspersonal/ahOS",
			},
		});

		expect(inserted.config.issue_repos).toEqual(["anguspersonal/ahOS"]);
		expect(inserted.config.default_repo).toBe("anguspersonal/ahOS");
		expect(out.content[0].text).toContain("Created integration 'github'");
	});

	it("rejects invalid repo format in github config", async () => {
		stubUserIntegrations(undefined);

		await expect(
			setIntegrationConfigHandler({
				provider: "github",
				config: { issue_repos: ["invalid-repo-format"] },
			}),
		).rejects.toThrow(/does not match its schema/);
	});

	it("returns early with no-op message when neither config nor enabled is supplied", async () => {
		stubUserIntegrations({ config: {}, enabled: true });

		const out = await setIntegrationConfigHandler({ provider: "notion_work" });

		expect(out.content[0].text).toContain("No fields supplied");
	});
});
