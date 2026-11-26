import { describe, expect, it, vi } from "vitest";
import type { ConfigPreferencesRepository, UserPreferencesRow } from "../../ports/config.js";
import {
	createConfigPreferencesUpdateAction,
	formatConfigPreferencesUpdateMcp,
} from "./preferencesUpdate.js";

describe("createConfigPreferencesUpdateAction", () => {
	const makeRepo = (initialRow: UserPreferencesRow | null) => {
		let state = initialRow ? structuredClone(initialRow) : null;
		const updatePreferencesRow = vi.fn(async (patch: Record<string, unknown>) => {
			state = {
				...(state ?? {}),
				...patch,
				updated_at: "2026-10-30T12:00:00Z",
			};
			return state;
		});
		const repo: ConfigPreferencesRepository = {
			loadConfigDetailed: vi.fn(),
			loadConfig: vi.fn(),
			loadIntegration: vi.fn(),
			listByFamily: vi.fn(),
			updateConfig: vi.fn(),
			listIntegrations: vi.fn(),
			loadPreferencesRow: vi.fn(async () => state),
			updatePreferencesRow,
		};
		return { repo, updatePreferencesRow, getState: () => state };
	};

	const baseRow: UserPreferencesRow = {
		user_id: "user-1",
		user_mode: "casual",
		automation_level: "manual",
		global_confidence_threshold: 80,
		show_lifecycle_details: false,
		safe_mode: true,
		has_completed_onboarding: true,
		updated_at: "2026-10-01T00:00:00Z",
		confidence_thresholds: {
			task_creation: { block: 40, review: 70, auto_apply: 90 },
			entity_creation: { block: 50, review: 75, auto_apply: 95 },
		},
		notification_preferences: {
			review_items: true,
			task_reminders: false,
		},
		dos_config: {
			tone: ["Direct and concise", "Never use filler preamble"],
			operating_principles: [
				"Never guess Notion option values",
				{ key: "append-only-pillars", description: "Retire pillars without renaming options" },
			],
			handshake_instructions: ["Read dos_config before writing Daily Log"],
			types: [
				{ key: "decision", description: "Committed choice with rationale" },
				{ key: "task", description: "Tracked action item" },
			],
			audiences: [
				{
					key: "team",
					role: "engineering",
					domain: "work",
					register: "direct technical",
					standing_exclusions: ["personal finance"],
					examples: ["Sprint recap"],
				},
			],
			by_domain: {
				work: {
					topics: ["Product", "Hiring"],
					domain_signals: ["Work", "Advisor"],
					pillars: [
						{
							key: "Pillar 1",
							label: "Launch",
							description: "Ship public beta",
							notion_option: "P1 Launch",
						},
					],
					artefact_registers: [{ key: "investor_update", tone: "measured and metric-led" }],
					state_doc_rules: {
						max_words: 2000,
						open_actions_cap: 10,
						communications_cap: 10,
					},
					daily_log_schema: {
						properties: [
							{ name: "Title", notion_type: "title", required: true },
							{
								name: "Pillars",
								notion_type: "multi_select",
								required: false,
								role: "pillars",
							},
						],
						body_sections: ["Highlights", "Blockers"],
					},
				},
			},
			pasted_instructions: {
				sha256: "abc123",
				pasted_at: "2026-10-01T00:00:00Z",
			},
		},
	};

	it("returns no-op message when no fields are supplied", async () => {
		const { repo, updatePreferencesRow } = makeRepo(baseRow);
		const action = createConfigPreferencesUpdateAction(repo);

		const out = await action.run({}, { caller: "mcp", requestId: "req-noop" });
		expect(out.updated).toBe(false);
		expect(out.changedKeys).toEqual([]);
		expect(updatePreferencesRow).not.toHaveBeenCalled();
		expect(formatConfigPreferencesUpdateMcp(out)).toContain("No fields supplied.");
	});

	it("throws when user_preferences row does not exist", async () => {
		const { repo } = makeRepo(null);
		const action = createConfigPreferencesUpdateAction(repo);

		await expect(
			action.run({ user_mode: "power" }, { caller: "mcp", requestId: "req-missing" }),
		).rejects.toThrow(/No user_preferences row found for this user/);
	});

	it("merges scalar fields and performs CRUD on user_preferences.dos_config sections", async () => {
		const { repo, updatePreferencesRow } = makeRepo(baseRow);
		const action = createConfigPreferencesUpdateAction(repo);

		// 1. Add, update, and remove across dos_config sections + merge scalars & JSONB maps
		const res1 = await action.run(
			{
				user_mode: "power",
				automation_level: "balanced",
				confidence_thresholds: {
					task_creation: { auto_apply: 85 },
				},
				notification_preferences: {
					task_reminders: true,
				},
				dos_config: {
					tone: {
						add: "Prefer tables for comparisons",
						update: {
							match: "Direct and concise",
							value: "Direct, concise, and concrete",
						},
						remove: "Never use filler preamble",
					},
					operating_principles: {
						add: { key: "verify-first", description: "Run local checks before claiming done" },
						update: {
							key: "append-only-pillars",
							description: "Never rename Notion pillar options (#692)",
						},
						remove: "Never guess Notion option values",
					},
					handshake_instructions: {
						op: "add",
						item: "Check domain routing signals on every atom",
					},
					types: {
						add: { key: "lesson", description: "Operational lesson learned" },
						update: { key: "task", description: "Concrete deliverable with owner" },
						remove: "decision",
					},
					audiences: {
						add: {
							key: "investors",
							register: "concise executive summary",
							standing_exclusions: ["internal debugging"],
						},
						update: {
							key: "team",
							register: "high-context engineering",
						},
					},
					by_domain: {
						work: {
							topics: {
								add: ["Fundraising"],
								remove: ["Hiring"],
							},
							domain_signals: {
								op: "add",
								item: "Lina",
							},
							pillars: {
								add: {
									key: "Pillar 2",
									label: "Retention",
									description: "Improve week-4 retention",
									notion_option: "P2 Retention",
								},
								update: {
									key: "Pillar 1",
									description: "Ship public beta and onboarding",
								},
							},
							artefact_registers: {
								add: { key: "board_memo", tone: "structured narrative" },
							},
							state_doc_rules: {
								max_words: 1500,
							},
							daily_log_schema: {
								properties: {
									add: {
										name: "Covers",
										notion_type: "date",
										required: true,
										role: "covers",
									},
								},
								body_sections: {
									replace: ["Summary", "Decisions", "Next"],
								},
							},
							waiting_on_status: "Waiting",
						},
					},
					pasted_instructions: {
						sha256: "def456",
						pasted_at: "2026-10-30T12:00:00Z",
					},
				},
			},
			{ caller: "mcp", requestId: "req-crud-1" },
		);

		expect(res1.updated).toBe(true);
		expect(res1.changedKeys).toEqual([
			"user_mode",
			"automation_level",
			"confidence_thresholds",
			"notification_preferences",
			"dos_config",
		]);
		expect(updatePreferencesRow).toHaveBeenCalledTimes(1);

		const row = res1.row!;
		expect(row.user_mode).toBe("power");
		expect(row.automation_level).toBe("balanced");
		expect(row.confidence_thresholds).toEqual({
			task_creation: { block: 40, review: 70, auto_apply: 85 },
			entity_creation: { block: 50, review: 75, auto_apply: 95 },
		});
		expect(row.notification_preferences).toEqual({
			review_items: true,
			task_reminders: true,
		});

		const dos = row.dos_config as Record<string, any>;
		expect(dos.tone).toEqual([
			"Direct, concise, and concrete",
			"Prefer tables for comparisons",
		]);
		expect(dos.operating_principles).toEqual([
			{
				key: "append-only-pillars",
				description: "Never rename Notion pillar options (#692)",
			},
			{
				key: "verify-first",
				description: "Run local checks before claiming done",
			},
		]);
		expect(dos.handshake_instructions).toEqual([
			"Read dos_config before writing Daily Log",
			"Check domain routing signals on every atom",
		]);
		expect(dos.types).toEqual([
			{ key: "task", description: "Concrete deliverable with owner" },
			{ key: "lesson", description: "Operational lesson learned" },
		]);
		expect(dos.audiences).toEqual([
			{
				key: "team",
				role: "engineering",
				domain: "work",
				register: "high-context engineering",
				standing_exclusions: ["personal finance"],
				examples: ["Sprint recap"],
			},
			{
				key: "investors",
				register: "concise executive summary",
				standing_exclusions: ["internal debugging"],
			},
		]);
		expect(dos.by_domain.work.topics).toEqual(["Product", "Fundraising"]);
		expect(dos.by_domain.work.domain_signals).toEqual(["Work", "Advisor", "Lina"]);
		expect(dos.by_domain.work.pillars).toEqual([
			{
				key: "Pillar 1",
				label: "Launch",
				description: "Ship public beta and onboarding",
				notion_option: "P1 Launch",
			},
			{
				key: "Pillar 2",
				label: "Retention",
				description: "Improve week-4 retention",
				notion_option: "P2 Retention",
			},
		]);
		expect(dos.by_domain.work.artefact_registers).toEqual([
			{ key: "investor_update", tone: "measured and metric-led" },
			{ key: "board_memo", tone: "structured narrative" },
		]);
		expect(dos.by_domain.work.state_doc_rules).toEqual({
			max_words: 1500,
			open_actions_cap: 10,
			communications_cap: 10,
		});
		expect(dos.by_domain.work.daily_log_schema.body_sections).toEqual([
			"Summary",
			"Decisions",
			"Next",
		]);
		expect(dos.by_domain.work.daily_log_schema.properties).toHaveLength(3);
		expect(dos.by_domain.work.waiting_on_status).toBe("Waiting");
		expect(dos.pasted_instructions).toEqual({
			sha256: "def456",
			pasted_at: "2026-10-30T12:00:00Z",
		});

		const formatted = formatConfigPreferencesUpdateMcp(res1);
		expect(formatted).toContain("Updated user_preferences");
		expect(formatted).toContain("dos_config:");
	});

	it("enforces the #692 append-only pillar rule unless allow_pillar_removal: true is supplied", async () => {
		const { repo } = makeRepo(baseRow);
		const action = createConfigPreferencesUpdateAction(repo);

		// Removing an existing pillar without allow_pillar_removal fails
		await expect(
			action.run(
				{
					dos_config: {
						by_domain: {
							work: {
								pillars: {
									remove: "Pillar 1",
								},
							},
						},
					},
				},
				{ caller: "mcp", requestId: "req-pillar-remove-blocked" },
			),
		).rejects.toThrow(/append-only \(#692\)/);

		// Renaming a pillar's notion_option without allow_pillar_removal fails
		await expect(
			action.run(
				{
					dos_config: {
						by_domain: {
							work: {
								pillars: {
									update: {
										key: "Pillar 1",
										notion_option: "P1 Renamed Option",
									},
								},
							},
						},
					},
				},
				{ caller: "mcp", requestId: "req-pillar-rename-blocked" },
			),
		).rejects.toThrow(/append-only \(#692\)/);

		// Passing allow_pillar_removal: true permits retiring a pillar from active config
		const allowed = await action.run(
			{
				allow_pillar_removal: true,
				dos_config: {
					by_domain: {
						work: {
							pillars: {
								remove: "Pillar 1",
							},
						},
					},
				},
			},
			{ caller: "mcp", requestId: "req-pillar-remove-allowed" },
		);
		expect(allowed.updated).toBe(true);
		expect((allowed.row!.dos_config as any).by_domain.work.pillars).toEqual([]);
	});

	it("preserves legacy notion_property on untouched and updated pillars during pillars.add / pillars.update (#692)", async () => {
		const legacyRow: UserPreferencesRow = {
			...structuredClone(baseRow),
			dos_config: {
				by_domain: {
					work: {
						pillars: [
							{
								key: "Pillar 1",
								label: "Launch",
								description: "Legacy pillar with notion_property",
								notion_property: "P1 Legacy Launch",
							},
						],
					},
				},
			},
		};
		const { repo } = makeRepo(legacyRow);
		const action = createConfigPreferencesUpdateAction(repo);

		// Adding a new pillar and updating the existing pillar's description succeeds when notion_property is preserved
		const res = await action.run(
			{
				dos_config: {
					by_domain: {
						work: {
							pillars: {
								add: {
									key: "Pillar 2",
									label: "Growth",
									description: "Acquisition loop",
									notion_option: "P2 Growth",
								},
								update: {
									key: "Pillar 1",
									description: "Updated description preserving legacy notion_property",
								},
							},
						},
					},
				},
			},
			{ caller: "mcp", requestId: "req-legacy-notion-property" },
		);

		expect(res.updated).toBe(true);
		expect((res.row!.dos_config as any).by_domain.work.pillars).toEqual([
			{
				key: "Pillar 1",
				label: "Launch",
				description: "Updated description preserving legacy notion_property",
				notion_property: "P1 Legacy Launch",
			},
			{
				key: "Pillar 2",
				label: "Growth",
				description: "Acquisition loop",
				notion_option: "P2 Growth",
			},
		]);

		// Renaming the legacy pillar's option without allow_pillar_removal / allow_pillar_option_removal still fails
		await expect(
			action.run(
				{
					dos_config: {
						by_domain: {
							work: {
								pillars: {
									update: {
										key: "Pillar 1",
										notion_option: "P1 Different Option",
									},
								},
							},
						},
					},
				},
				{ caller: "mcp", requestId: "req-legacy-notion-property-rename-blocked" },
			),
		).rejects.toThrow(/append-only \(#692\)/);
	});

	it("rejects renaming an item's key to a duplicate of another existing entry on update", async () => {
		const { repo } = makeRepo(baseRow);
		const action = createConfigPreferencesUpdateAction(repo);

		await expect(
			action.run(
				{
					dos_config: {
						types: {
							update: [
								{
									match: "task",
									key: "decision",
									description: "Collides with existing decision key",
								},
							],
						},
					},
				},
				{ caller: "mcp", requestId: "req-dup-key-types" },
			),
		).rejects.toThrow(/duplicate key 'decision' already exists/i);

		await expect(
			action.run(
				{
					dos_config: {
						operating_principles: {
							update: [
								{
									match: "Never guess Notion option values",
									key: "append-only-pillars",
									description: "Collides with existing principle key",
								},
							],
						},
					},
				},
				{ caller: "mcp", requestId: "req-dup-key-principles" },
			),
		).rejects.toThrow(/duplicate key 'append-only-pillars' already exists/i);
	});
});
