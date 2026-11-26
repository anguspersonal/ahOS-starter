import { describe, expect, it, vi } from "vitest";
import {
	DISCOVER_INSERT_BATCH_SIZE,
	DISCOVER_LOOKUP_BATCH_SIZE,
} from "../../ports/discover.js";
import {
	createSupabaseDiscoverRepository,
	type DiscoverSupabaseClient,
} from "./discover.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function createFakeClient(overrides?: {
	lookupError?: string;
	insertError?: string;
	updateError?: string;
	rpcError?: string;
	rpcData?: unknown;
}) {
	const lookups: Array<{
		table: string;
		columns: string;
		filters: Record<string, unknown>;
		inSources: string[];
	}> = [];
	const inserts: Record<string, unknown>[][] = [];
	const updates: Array<{
		patch: Record<string, unknown>;
		filters: Record<string, unknown>;
	}> = [];
	const rpcs: Array<{ fn: string; params: Record<string, unknown> }> = [];

	const client: DiscoverSupabaseClient = {
		from: vi.fn((table: string) => ({
			select: (columns: string) => {
				const filters: Record<string, unknown> = {};
				const builder: any = {
					eq: (col: string, val: unknown) => {
						filters[col] = val;
						return builder;
					},
					in: (_col: string, values: string[]) => {
						lookups.push({ table, columns, filters: { ...filters }, inSources: values });
						if (overrides?.lookupError) {
							return Promise.resolve({
								data: null,
								error: { message: overrides.lookupError },
							});
						}
						return Promise.resolve({
							data: values.map((s, idx) => ({ id: `id-${idx}`, source: s })),
							error: null,
						});
					},
				};
				return builder;
			},
			insert: (batch: Record<string, unknown>[]) => {
				inserts.push(batch);
				if (overrides?.insertError) {
					return Promise.resolve({ error: { message: overrides.insertError } });
				}
				return Promise.resolve({ error: null });
			},
			update: (patch: Record<string, unknown>) => {
				const filters: Record<string, unknown> = {};
				const builder: any = {
					eq: (col: string, val: unknown) => {
						filters[col] = val;
						return builder;
					},
					then: (resolve: (v: unknown) => unknown) => {
						updates.push({ patch, filters: { ...filters } });
						if (overrides?.updateError) {
							return resolve({ error: { message: overrides.updateError } });
						}
						return resolve({ error: null });
					},
				};
				return builder;
			},
		})) as any,
		rpc: vi.fn((fn: string, params: Record<string, unknown>) => {
			rpcs.push({ fn, params });
			if (overrides?.rpcError) {
				return Promise.resolve({
					data: null,
					error: { message: overrides.rpcError },
				});
			}
			const rows = (params.p_rows as unknown[]) ?? [];
			return Promise.resolve({
				data: overrides?.rpcData !== undefined ? overrides.rpcData : rows.length,
				error: null,
			});
		}) as any,
	};

	return { client, lookups, inserts, updates, rpcs };
}

describe("createSupabaseDiscoverRepository (#1625)", () => {
	it("findKnown queries artifacts in batches of 50 scoped to userId and source_channel", async () => {
		const { client, lookups } = createFakeClient();
		const repo = createSupabaseDiscoverRepository({ client, ownerId: USER_ID });
		const sources = Array.from({ length: DISCOVER_LOOKUP_BATCH_SIZE * 2 + 5 }, (_, i) => `src-${i}`);

		const rows = await repo.findKnown(USER_ID, "discovered_gdrive", sources);

		expect(rows).toHaveLength(105);
		expect(lookups).toHaveLength(3);
		expect(lookups[0].inSources).toHaveLength(50);
		expect(lookups[1].inSources).toHaveLength(50);
		expect(lookups[2].inSources).toHaveLength(5);
		for (const lookup of lookups) {
			expect(lookup.table).toBe("artifacts");
			expect(lookup.columns).toBe("id, source, processing_metadata, archived, archived_reason");
			expect(lookup.filters).toEqual({
				user_id: USER_ID,
				source_channel: "discovered_gdrive",
			});
		}
	});

	it("findKnown surfaces PostgREST errors with Discovery lookup failed prefix", async () => {
		const { client } = createFakeClient({ lookupError: "statement timeout" });
		const repo = createSupabaseDiscoverRepository({ client, ownerId: USER_ID });

		await expect(
			repo.findKnown(USER_ID, "discovered_notion", ["n1"]),
		).rejects.toThrow("Discovery lookup failed: statement timeout");
	});

	it("insert chunks rows by DISCOVER_INSERT_BATCH_SIZE (25) and surfaces errors", async () => {
		const { client, inserts } = createFakeClient();
		const repo = createSupabaseDiscoverRepository({ client, ownerId: USER_ID });
		const rows = Array.from({ length: DISCOVER_INSERT_BATCH_SIZE * 2 + 3 }, (_, i) => ({
			id: `row-${i}`,
		}));

		await repo.insert(rows);

		expect(inserts).toHaveLength(3);
		expect(inserts[0]).toHaveLength(25);
		expect(inserts[1]).toHaveLength(25);
		expect(inserts[2]).toHaveLength(3);

		const failing = createSupabaseDiscoverRepository({
			client: createFakeClient({ insertError: "duplicate key" }).client,
			ownerId: USER_ID,
		});
		await expect(failing.insert([{ id: "r1" }])).rejects.toThrow(
			"Discovery insert failed: duplicate key",
		);
	});

	it("update scopes by id and ownerId and formats failure with externalId", async () => {
		const { client, updates } = createFakeClient();
		const repo = createSupabaseDiscoverRepository({
			client,
			ownerId: () => USER_ID,
		});

		await repo.update("row-1", { title: "Updated" }, "ext-1");
		expect(updates).toEqual([
			{
				patch: { title: "Updated" },
				filters: { id: "row-1", user_id: USER_ID },
			},
		]);

		const failing = createSupabaseDiscoverRepository({
			client: createFakeClient({ updateError: "connection reset" }).client,
			ownerId: USER_ID,
		});
		await expect(
			failing.update(
				"row-1",
				{ processing_metadata: { discovery: { external_id: "ext-from-meta" } } },
			),
		).rejects.toThrow("Discovery update failed for ext-from-meta: connection reset");
	});

	it("refreshEnvelopes skips RPC when empty, calls discover_envelope_refresh when non-empty, and surfaces errors", async () => {
		const { client, rpcs } = createFakeClient();
		const repo = createSupabaseDiscoverRepository(client, USER_ID);

		expect(await repo.refreshEnvelopes([])).toBe(0);
		expect(rpcs).toHaveLength(0);

		const refreshRow = {
			id: "row-1",
			envelope: { mime_type: "application/pdf" },
			drive_file_id: "d1",
			parent_ids: ["p1"],
			dequeue: false,
		};
		expect(await repo.refreshEnvelopes([refreshRow])).toBe(1);
		expect(rpcs).toEqual([
			{
				fn: "discover_envelope_refresh",
				params: { p_user_id: USER_ID, p_rows: [refreshRow] },
			},
		]);

		const failing = createSupabaseDiscoverRepository({
			client: createFakeClient({ rpcError: "missing rpc" }).client,
			ownerId: USER_ID,
		});
		await expect(failing.refreshEnvelopes([refreshRow])).rejects.toThrow(
			"Discovery envelope refresh failed for 1 row(s): missing rpc",
		);
	});
});
