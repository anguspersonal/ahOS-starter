/**
 * Regression tests for migration-052 re-key fallout.
 *
 * Migration 052 widened the unique constraint on artifact_entity_links from
 * (artifact_id, entity_id, link_type) to (user_id, artifact_id, entity_id, link_type)
 * and made user_id NOT NULL. The ensureLink() helper in artifactEntitySync was
 * updated to stamp user_id on the upsert row and use the user-scoped onConflict key.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";

const artifactEntitySyncHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("artifact_sync_entities")!).handler(args);

/** Must match vitest.config.ts env.KMS_USER_ID */
const TEST_USER = "00000000-0000-0000-0000-000000000000";
const ART_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ENTITY_ID = "bbbbbbbb-0000-0000-0000-000000000001";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/**
 * A chainable query-builder stub whose methods all return `this`, so any `.select()
 * .eq().eq().maybeSingle()` chain resolves to `result`.
 */
function chainBuilder(result: unknown) {
	const b: any = {
		select: () => b,
		eq: () => b,
		in: () => b,
		limit: () => b,
		insert: () => b,
		maybeSingle: () => Promise.resolve(result),
		then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
	};
	return b;
}

// ---------------------------------------------------------------------------
// artifactEntitySyncHandler (people entity)
// ---------------------------------------------------------------------------

describe("artifactEntitySyncHandler (people) — ensureLink after migration 052 re-key", () => {
	it("stamps user_id on the upsert row and uses the user-scoped onConflict key", async () => {
		const mockPerson = {
			id: ENTITY_ID,
			entity_type: "people",
			title: "Alice",
			description: null,
			archived: false,
			properties: null,
			tags: [],
		};

		// upsert returns a builder with .select() so the chained .select() call succeeds.
		const upsertLink = vi.fn().mockReturnValue({
			select: vi.fn().mockResolvedValue({
				data: [{ id: "link-001", artifact_id: ART_ID, entity_id: ENTITY_ID, link_type: "mentioned" }],
				error: null,
			}),
		});

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			return chainBuilder({ data: mockPerson, error: null });
		});

		await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [{ id: ENTITY_ID, entity_type: "people", title: "Alice" }],
		});

		expect(upsertLink).toHaveBeenCalledOnce();
		const [rows, options] = upsertLink.mock.calls[0] as [Record<string, unknown>[], { onConflict: string }];
		expect(rows[0]).toMatchObject({
			user_id: TEST_USER,
			artifact_id: ART_ID,
			entity_id: ENTITY_ID,
			link_type: "mentioned",
		});
		expect(options).toEqual({ onConflict: "user_id,artifact_id,entity_id,link_type" });
	});
});


// ---------------------------------------------------------------------------
// artifactEntitySyncHandler
// ---------------------------------------------------------------------------

describe("artifactEntitySyncHandler — ensureLink after migration 052 re-key", () => {
	it("stamps user_id on the upsert row and uses the user-scoped onConflict key", async () => {
		const mockEntity = {
			id: ENTITY_ID,
			entity_type: "organization",
			title: "Acme Corp",
			description: null,
			archived: false,
			properties: null,
			tags: [],
		};

		const upsertLink = vi.fn().mockReturnValue({
			select: vi.fn().mockResolvedValue({
				data: [{ id: "link-002", artifact_id: ART_ID, entity_id: ENTITY_ID, link_type: "mentioned" }],
				error: null,
			}),
		});

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			// "entities" — source has an id so findExactEntity resolves immediately
			return chainBuilder({ data: mockEntity, error: null });
		});

		await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [{ id: ENTITY_ID, entity_type: "organization", title: "Acme Corp" }],
		});

		expect(upsertLink).toHaveBeenCalledOnce();
		const [rows, options] = upsertLink.mock.calls[0] as [Record<string, unknown>[], { onConflict: string }];
		expect(rows[0]).toMatchObject({
			user_id: TEST_USER,
			artifact_id: ART_ID,
			entity_id: ENTITY_ID,
			link_type: "mentioned",
		});
		expect(options).toEqual({ onConflict: "user_id,artifact_id,entity_id,link_type" });
	});
});
