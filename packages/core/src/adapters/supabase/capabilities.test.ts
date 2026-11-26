import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseCapabilityRepository } from "./capabilities.js";
import type { CapabilityEntityRow } from "../../ports/capabilities.js";

const SAMPLE_ROWS: CapabilityEntityRow[] = [
	{
		id: "cap-1",
		title: "retro",
		description: "Run session retrospective",
		properties: { kind: ["skill"], surface: ["claude-code"], storage_location: "kms-db" },
		tags: [],
		archived: false,
		created_at: "2026-10-01T00:00:00Z",
		updated_at: "2026-10-10T00:00:00Z",
	},
	{
		id: "cap-2",
		title: "OldSkill",
		description: "Archived capability",
		properties: { kind: ["skill"], surface: ["api"], storage_location: "kms-repo" },
		tags: ["legacy"],
		archived: true,
		created_at: "2026-09-01T00:00:00Z",
		updated_at: "2026-09-10T00:00:00Z",
	},
];

describe("createSupabaseCapabilityRepository (issue #1540)", () => {
	it("list({ includeArchived }) selects expected columns for injected owner and capability entity_type ordered by updated_at desc nulls last", async () => {
		const fake = createFakeSupabase(() => ({ data: SAMPLE_ROWS, error: null }));
		const ownerId = vi.fn(() => "owner-123");
		const repo = createSupabaseCapabilityRepository({ client: fake.client, ownerId });

		const activeOnly = await repo.list({ includeArchived: false });
		expect(activeOnly).toHaveLength(1);
		expect(activeOnly[0].id).toBe("cap-1");

		const call = fake.calls[0];
		expect(call.table).toBe("entities");
		expect(call.op).toBe("select");
		expect(call.selected).toBe(
			"id, title, description, properties, tags, archived, created_at, updated_at",
		);
		expect(fake.filtersOf(call, "eq")).toEqual([
			["user_id", "owner-123"],
			["entity_type", "capability"],
		]);
		expect(fake.filtersOf(call, "order")).toEqual([
			["updated_at", { ascending: false, nullsFirst: false }],
		]);

		const withArchived = await repo.list({ includeArchived: true });
		expect(withArchived).toHaveLength(2);
	});

	it("findByName(name) matches title case-insensitively and scopes to injected ownerId", async () => {
		const fake = createFakeSupabase(() => ({ data: SAMPLE_ROWS, error: null }));
		const repo = createSupabaseCapabilityRepository({
			client: fake.client,
			ownerId: () => "owner-abc",
		});

		const found = await repo.findByName("OLDSKILL");
		expect(found?.id).toBe("cap-2");

		const missing = await repo.findByName("nonexistent");
		expect(missing).toBeNull();

		const call = fake.calls[0];
		expect(call.selected).toBe(
			"id, title, description, properties, tags, archived, created_at, updated_at",
		);
		expect(fake.filtersOf(call, "eq")).toEqual([
			["user_id", "owner-abc"],
			["entity_type", "capability"],
		]);
	});

	it("insert(row) and update(id, patch) write legacy columns and throw with capability_register ... failed: prefix on error", async () => {
		const fake = createFakeSupabase(() => ({ data: null, error: null }));
		const repo = createSupabaseCapabilityRepository({
			client: fake.client,
			ownerId: () => "owner-xyz",
		});

		const { id } = await repo.insert({
			title: "groom-issues",
			description: "Groom backlog",
			properties: { kind: ["skill"], surface: ["claude-code"], storage_location: "kms-db" },
			domain_override: "angus",
		});
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);

		const insertCall = fake.calls[0];
		expect(insertCall.table).toBe("entities");
		expect(insertCall.op).toBe("insert");
		expect(insertCall.payload).toEqual([
			{
				id,
				entity_type: "capability",
				title: "groom-issues",
				description: "Groom backlog",
				properties: { kind: ["skill"], surface: ["claude-code"], storage_location: "kms-db" },
				tags: [],
				archived: false,
				archived_at: null,
				user_id: "owner-xyz",
				team_id: null,
				domain_override: "angus",
			},
		]);

		await repo.update(id, {
			title: "groom-issues",
			description: null,
			properties: { kind: ["skill"], surface: ["api"], storage_location: "kms-db" },
			tags: ["cleaned"],
			domain_override: "angus",
		});

		const updateCall = fake.calls[1];
		expect(updateCall.table).toBe("entities");
		expect(updateCall.op).toBe("update");
		expect(updateCall.payload).toEqual({
			title: "groom-issues",
			description: null,
			properties: { kind: ["skill"], surface: ["api"], storage_location: "kms-db" },
			tags: ["cleaned"],
			domain_override: "angus",
		});
		expect(fake.filtersOf(updateCall, "eq")).toEqual([
			["id", id],
			["user_id", "owner-xyz"],
		]);

		const failingFake = createFakeSupabase(() => ({
			data: null,
			error: { message: "db exploded" },
		}));
		const failingRepo = createSupabaseCapabilityRepository({
			client: failingFake.client,
			ownerId: () => "owner-xyz",
		});

		await expect(
			failingRepo.insert({ title: "x", properties: {} }),
		).rejects.toThrow("capability_register create failed: db exploded");
		await expect(
			failingRepo.update("id-1", { title: "x", properties: {}, tags: [] }),
		).rejects.toThrow("capability_register update failed: db exploded");
		await expect(failingRepo.findByName("x")).rejects.toThrow(
			"capability_register lookup failed: db exploded",
		);
	});

	it("calls ownerId() dynamically on every operation without reading process.env", async () => {
		let currentOwner = "user-first";
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		const repo = createSupabaseCapabilityRepository({
			client: fake.client,
			ownerId: () => currentOwner,
		});

		await repo.list();
		currentOwner = "user-second";
		await repo.findByName("retro");

		expect(fake.filtersOf(fake.calls[0], "eq")).toContainEqual(["user_id", "user-first"]);
		expect(fake.filtersOf(fake.calls[1], "eq")).toContainEqual(["user_id", "user-second"]);
	});
});
