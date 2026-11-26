import { describe, expect, it, vi } from "vitest";
import {
	GMAIL_INTEGRATION_ENTITY,
	GMAIL_TRIAGE_SCHEME,
	GMAIL_SCRIPTS,
	seedGmailAutomationEntities,
} from "../automations/gmailAutomations.js";

describe("Gmail Automations and Triage Scheme representation (#357)", () => {
	it("defines a valid Gmail Integration parent entity", () => {
		expect(GMAIL_INTEGRATION_ENTITY.title).toBe("Gmail Integration");
		expect(GMAIL_INTEGRATION_ENTITY.entity_type).toBe("resource");
		expect(GMAIL_INTEGRATION_ENTITY.properties.kind).toBe("system");
		expect(GMAIL_INTEGRATION_ENTITY.properties.provider).toBe("gmail");
		expect(GMAIL_INTEGRATION_ENTITY.properties.accounts).toContain("owner@example.com");
	});

	it("defines the 8-tier triage scheme with Pending Action", () => {
		expect(GMAIL_TRIAGE_SCHEME.title).toBe("Gmail Numbered Triage System");
		expect(GMAIL_TRIAGE_SCHEME.properties.kind).toBe("automation");
		expect(GMAIL_TRIAGE_SCHEME.properties.system_type).toBe("label_scheme");

		const labelNames = GMAIL_TRIAGE_SCHEME.properties.labels.map((l) => l.name);
		expect(labelNames).toEqual([
			"1: to respond",
			"2: FYI",
			"3: comment",
			"4: notification",
			"5: meeting update",
			"6: awaiting reply",
			"7: actioned",
			"8: marketing",
			"Pending Action",
		]);

		const awaitingReply = GMAIL_TRIAGE_SCHEME.properties.labels.find((l) => l.name === "6: awaiting reply");
		expect(awaitingReply?.label_id).toBe("Label_314");

		const pendingAction = GMAIL_TRIAGE_SCHEME.properties.labels.find((l) => l.name === "Pending Action");
		expect(pendingAction?.label_id).toBe("Label_331");
	});

	it("defines all existing Gmail automation scripts", () => {
		expect(GMAIL_SCRIPTS.length).toBe(10);

		const titles = GMAIL_SCRIPTS.map((s) => s.title);
		expect(titles).toContain("Script: Tier 1 (Nuclear)");
		expect(titles).toContain("Script: Tier 2 (Category)");
		expect(titles).toContain("Script: Tier 3 (Bulk Reduce)");
		expect(titles).toContain("Script: Tier 3 (Keep)");
		expect(titles).toContain("Script: Tier 4 (Focus)");
		expect(titles).toContain("Script: Stale Blitz (Auto)");
		expect(titles).toContain("Script: Stale Blitz (Claude)");
		expect(titles).toContain("Script: Morning Briefing Archive");
		expect(titles).toContain("Script: Archive Low Signal");
		expect(titles).toContain("Script: Archived by Script");

		for (const script of GMAIL_SCRIPTS) {
			expect(script.properties.kind).toBe("automation");
			expect(script.properties.owned_labels.length).toBeGreaterThan(0);
		}
	});

	it("seedGmailAutomationEntities creates parent, children, and edges when starting empty", async () => {
		const insertedEntities: any[] = [];
		const insertedEdges: any[] = [];

		const mockSupabase = {
			from: vi.fn((table: string) => {
				if (table === "entities") {
					return {
						select: vi.fn(() => ({
							eq: vi.fn(() => ({
								eq: vi.fn(() => ({
									maybeSingle: vi.fn(async () => ({ data: null, error: null })),
								})),
							})),
						})),
						insert: vi.fn((entity: any) => {
							const id = `entity-${insertedEntities.length + 1}`;
							const record = { id, ...entity };
							insertedEntities.push(record);
							return {
								select: vi.fn(() => ({
									single: vi.fn(async () => ({ data: record, error: null })),
								})),
							};
						}),
					};
				}
				if (table === "entity_relationships") {
					return {
						select: vi.fn(() => ({
							eq: vi.fn(() => ({
								eq: vi.fn(() => ({
									eq: vi.fn(() => ({
										eq: vi.fn(() => ({
											maybeSingle: vi.fn(async () => ({ data: null, error: null })),
										})),
									})),
								})),
							})),
						})),
						insert: vi.fn(async (edge: any) => {
							insertedEdges.push(edge);
							return { error: null };
						}),
					};
				}
				throw new Error(`Unexpected table ${table}`);
			}),
		} as any;

		const result = await seedGmailAutomationEntities(mockSupabase, "user-test-123");

		expect(result.integrationEntityId).toBe("entity-1");
		expect(result.triageSchemeEntityId).toBe("entity-2");
		expect(Object.keys(result.scriptEntityIds).length).toBe(10);
		expect(insertedEntities.length).toBe(12); // 1 parent + 1 scheme + 10 scripts
		expect(insertedEdges.length).toBe(11); // 1 scheme + 10 scripts -> parent
		expect(result.edgesCreated).toBe(11);

		for (const edge of insertedEdges) {
			expect(edge.relationship_type).toBe("is_part_of");
			expect(edge.target_id).toBe("entity-1");
			expect(edge.user_id).toBe("user-test-123");
		}
	});

	it("seedGmailAutomationEntities is idempotent when entities already exist", async () => {
		const mockSupabase = {
			from: vi.fn((table: string) => {
				if (table === "entities") {
					return {
						select: vi.fn(() => ({
							eq: vi.fn(() => ({
								eq: vi.fn(() => ({
									maybeSingle: vi.fn(async () => ({
										data: { id: "existing-entity-id" },
										error: null,
									})),
								})),
							})),
						})),
						insert: vi.fn(() => {
							throw new Error("Should not insert existing entity");
						}),
					};
				}
				if (table === "entity_relationships") {
					return {
						select: vi.fn(() => ({
							eq: vi.fn(() => ({
								eq: vi.fn(() => ({
									eq: vi.fn(() => ({
										eq: vi.fn(() => ({
											maybeSingle: vi.fn(async () => ({
												data: { id: "existing-edge-id" },
												error: null,
											})),
										})),
									})),
								})),
							})),
						})),
						insert: vi.fn(async () => {
							throw new Error("Should not insert existing edge");
						}),
					};
				}
				throw new Error(`Unexpected table ${table}`);
			}),
		} as any;

		const result = await seedGmailAutomationEntities(mockSupabase, "user-test-123");
		expect(result.integrationEntityId).toBe("existing-entity-id");
		expect(result.triageSchemeEntityId).toBe("existing-entity-id");
		expect(result.edgesCreated).toBe(0);
	});
});
