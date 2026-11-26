import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFakeSupabase, type RecordedCall } from "../fakeSupabase.testkit.js";
import { createSupabaseEntityMergeAdapter } from "./entityMerge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(__dirname, "../../../..");

function createMergeFakeSupabase(
	respond?: Parameters<typeof createFakeSupabase>[0],
) {
	const fake = createFakeSupabase(respond);
	const origFrom = fake.client.from;
	fake.client.from = (table: string) => {
		const api = origFrom(table);
		const call: RecordedCall = fake.calls[fake.calls.length - 1];
		api.contains = (...args: unknown[]) => {
			call.filters.push({ method: "contains", args });
			return api;
		};
		api.filter = (...args: unknown[]) => {
			call.filters.push({ method: "filter", args });
			return api;
		};
		return api;
	};
	return fake;
}

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", "dist", "build", ".turbo"].includes(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
			if (entry.name === "entityMerge.test.ts") continue;
			out.push(full);
		}
	}
	return out;
}

describe("createSupabaseEntityMergeAdapter (#1498)", () => {
	const USER_ID = "00000000-0000-0000-0000-000000000000";
	const LOSER_ID = "22222222-2222-4222-8222-222222222222";
	const WINNER_ID = "33333333-3333-4333-8333-333333333333";
	const OP_ID = "11111111-1111-4111-8111-111111111111";

	it("findLoserById filters by id and user_id so another user's entity reads as null", async () => {
		const fake = createMergeFakeSupabase((call) => {
			const eqs = Object.fromEntries(
				call.filters.filter((f) => f.method === "eq").map((f) => f.args as [string, string]),
			);
			if (eqs.id === LOSER_ID && eqs.user_id === USER_ID) {
				return { data: [{ id: LOSER_ID, title: "Owned Loser", user_id: USER_ID }], error: null };
			}
			return { data: [], error: null };
		});

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});

		const otherRes = await adapter.findLoserById(LOSER_ID, "other-user-id");
		expect(otherRes).toBeNull();
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", LOSER_ID],
			["user_id", "other-user-id"],
		]);

		const ownRes = await adapter.findLoserById(LOSER_ID, USER_ID);
		expect(ownRes?.id).toBe(LOSER_ID);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["id", LOSER_ID],
			["user_id", USER_ID],
		]);
	});

	it("findLoserByOpId tries .contains() first and retries with .filter('properties->_merge->>op_id', 'eq', opId) when empty", async () => {
		let callCount = 0;
		const fake = createMergeFakeSupabase(() => {
			callCount++;
			if (callCount === 1) {
				return { data: [], error: null };
			}
			return {
				data: [
					{
						id: LOSER_ID,
						title: "Loser via fallback filter",
						user_id: USER_ID,
						properties: { _merge: { op_id: OP_ID, winner_id: WINNER_ID } },
					},
				],
				error: null,
			};
		});

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});

		const loser = await adapter.findLoserByOpId(OP_ID, USER_ID);
		expect(loser?.id).toBe(LOSER_ID);
		expect(fake.calls).toHaveLength(2);
		expect(fake.filtersOf(fake.calls[0], "contains")).toEqual([
			["properties", { _merge: { op_id: OP_ID } }],
		]);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[1], "filter")).toEqual([
			["properties->_merge->>op_id", "eq", OP_ID],
		]);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["user_id", USER_ID]]);
	});

	it("findLoserByOpId surfaces a real DB error on the fallback query", async () => {
		let callCount = 0;
		const fake = createMergeFakeSupabase(() => {
			callCount++;
			if (callCount === 1) {
				return { data: [], error: null };
			}
			return {
				data: null,
				error: { message: "permission denied for relation entities" },
			};
		});

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});

		await expect(adapter.findLoserByOpId(OP_ID, USER_ID)).rejects.toThrow(
			`Failed to query merge record for op_id ${OP_ID} (fallback filter): permission denied for relation entities`,
		);
	});

	it("unmerge calls unmerge_entities RPC with p_loser_id and p_user_id and rejects with the RPC's message on error (including schema-cache miss)", async () => {
		const fake = createMergeFakeSupabase();
		fake.setRpcResponder((fn, args) => {
			expect(fn).toBe("unmerge_entities");
			expect(args).toEqual({ p_loser_id: LOSER_ID, p_user_id: USER_ID });
			return {
				data: null,
				error: {
					code: "PGRST202",
					message: "Could not find the function public.unmerge_entities in the schema cache",
				},
			};
		});

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});

		await expect(adapter.unmerge(LOSER_ID, USER_ID)).rejects.toThrow(
			"Could not find the function public.unmerge_entities in the schema cache",
		);
		expect(fake.rpcCalls).toEqual([
			{
				fn: "unmerge_entities",
				args: { p_loser_id: LOSER_ID, p_user_id: USER_ID },
			},
		]);
		expect(fake.calls).toHaveLength(0);
	});

	it("no client-side unmerge fallback exists in packages/", () => {
		const files = collectSourceFiles(packagesDir);
		const matches: string[] = [];
		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			if (content.includes("executeClientSideEntityUnmerge")) {
				matches.push(path.relative(packagesDir, file));
			}
		}
		expect(matches).toEqual([]);
	});

	it("merge resolves ownerId callback when params.userId is omitted (#1663)", async () => {
		const fake = createMergeFakeSupabase();
		fake.setRpcResponder((fn, args) => {
			expect(fn).toBe("merge_entities");
			expect((args as Record<string, unknown>).p_user_id).toBe(USER_ID);
			expect((args as Record<string, unknown>).p_resolved_by).toBe(USER_ID);
			return { data: { merge_op: { op_id: OP_ID } }, error: null };
		});

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: () => USER_ID,
		});
		const res = await adapter.merge({
			winnerId: WINNER_ID,
			loserId: LOSER_ID,
			winnerRow: { entity_type: "people" },
			loserRow: { entity_type: "people" },
			finalWinnerProps: {},
			winnerAliases: [],
			aliasesAdded: [],
			propertiesCarried: [],
			propertiesSkipped: {},
			resolutionNotes: "Approved by user",
			survivorOverridden: false,
		});
		expect(res).toEqual({ op_id: OP_ID });
	});
});
