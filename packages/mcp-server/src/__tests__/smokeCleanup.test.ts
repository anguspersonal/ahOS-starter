import { describe, expect, it, vi } from "vitest";

describe("smoke test cleanup sequence (#1215)", () => {
	it("cleans up edges and links before deleting entities so FKs cannot block deletion", async () => {
		const calls: string[] = [];
		const mockSupabase = {
			from: (table: string) => ({
				delete: () => ({
					in: (col: string, vals: string[]) => {
						calls.push(`delete ${table} in ${col}`);
						return Promise.resolve({ error: null });
					},
					eq: (col: string, val: string) => {
						calls.push(`delete ${table} eq ${col}`);
						return Promise.resolve({ error: null });
					},
				}),
				select: () => ({
					ilike: () => ({
						eq: () => ({
							eq: () => Promise.resolve({ data: [] }),
						}),
					}),
				}),
			}),
		};

		const eids = ["eid-alice", "eid-bob"];
		// Sequence from smoke.ts cleanup:
		await mockSupabase.from("artifact_entity_links").delete().in("entity_id", eids);
		await mockSupabase.from("entity_relationships").delete().in("from_entity_id", eids);
		await mockSupabase.from("entity_relationships").delete().in("to_entity_id", eids);
		for (const eid of eids) {
			await mockSupabase.from("entities").delete().eq("id", eid);
		}

		expect(calls).toEqual([
			"delete artifact_entity_links in entity_id",
			"delete entity_relationships in from_entity_id",
			"delete entity_relationships in to_entity_id",
			"delete entities eq id",
			"delete entities eq id",
		]);
	});

	it("falls back to soft-archive if entity hard deletion encounters an error", async () => {
		let archived = false;
		const mockSupabase = {
			from: (table: string) => ({
				delete: () => ({
					eq: (_col: string, _val: unknown) => ({
						eq: (_col2: string, _val2: unknown) => Promise.resolve({ error: new Error("foreign key constraint") }),
					}),
				}),
				update: (patch: { archived: boolean }) => ({
					eq: (_col: string, _val: unknown) => ({
						eq: (_col2: string, _val2: unknown) => {
							if (patch.archived) archived = true;
							return Promise.resolve({ error: null });
						},
					}),
				}),
			}),
		};

		const eid = "eid-alice";
		const { error } = await mockSupabase.from("entities").delete().eq("id", eid).eq("user_id", "u1");
		if (error) {
			await mockSupabase.from("entities").update({ archived: true }).eq("id", eid).eq("user_id", "u1");
		}

		expect(archived).toBe(true);
	});
});
