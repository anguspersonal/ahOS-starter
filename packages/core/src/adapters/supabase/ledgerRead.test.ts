import { describe, expect, it } from "vitest";
import { createSupabaseLedgerReadAdapter } from "./ledgerRead.js";

function createFakeLedgerClient(options: {
	ledgerData?: unknown[];
	ledgerError?: { code?: string; message: string } | null;
	clientsData?: unknown[];
	clientsError?: { code?: string; message: string } | null;
	statsData?: unknown;
	statsError?: { code?: string; message: string } | null;
}) {
	const calls: Array<{
		table?: string;
		rpcName?: string;
		select?: string;
		eqs: Array<[string, unknown]>;
		gtes: Array<[string, unknown]>;
		lts: Array<[string, unknown]>;
		ins: Array<[string, unknown[]]>;
		orders: Array<[string, { ascending: boolean }]>;
		limit?: number;
	}> = [];

	return {
		calls,
		client: {
			from(table: string) {
				const record = {
					table,
					select: undefined as string | undefined,
					eqs: [] as Array<[string, unknown]>,
					gtes: [] as Array<[string, unknown]>,
					lts: [] as Array<[string, unknown]>,
					ins: [] as Array<[string, unknown[]]>,
					orders: [] as Array<[string, { ascending: boolean }]>,
					limit: undefined as number | undefined,
				};
				calls.push(record);

				const builder: any = {
					select(cols: string) {
						record.select = cols;
						return builder;
					},
					eq(col: string, val: unknown) {
						record.eqs.push([col, val]);
						return builder;
					},
					gte(col: string, val: unknown) {
						record.gtes.push([col, val]);
						return builder;
					},
					lt(col: string, val: unknown) {
						record.lts.push([col, val]);
						return builder;
					},
					in(col: string, vals: unknown[]) {
						record.ins.push([col, vals]);
						return builder;
					},
					order(col: string, opts: { ascending: boolean }) {
						record.orders.push([col, opts]);
						return builder;
					},
					limit(n: number) {
						record.limit = n;
						return builder;
					},
					then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
						const payload =
							table === "action_ledger"
								? { data: options.ledgerData ?? [], error: options.ledgerError ?? null }
								: { data: options.clientsData ?? [], error: options.clientsError ?? null };
						return Promise.resolve(payload).then(onFulfilled, onRejected);
					},
				};
				return builder;
			},
			async rpc(rpcName: string) {
				calls.push({
					rpcName,
					eqs: [],
					gtes: [],
					lts: [],
					ins: [],
					orders: [],
				});
				return {
					data: options.statsData ?? [{ row_estimate: 0, total_bytes: 0 }],
					error: options.statsError ?? null,
				};
			},
		} as any,
	};
}

describe("createSupabaseLedgerReadAdapter (#1476)", () => {
	it("2. issues one select on action_ledger with eq/gte/lt/order/limit and enriches client_name from one mcp_oauth_clients select", async () => {
		const { client, calls } = createFakeLedgerClient({
			ledgerData: [
				{
					id: "row-1",
					created_at: "2026-10-19T12:00:00Z",
					action_id: "capture",
					seam: "action",
					caller: "mcp",
					request_id: "req-1",
					parent_request_id: "req-0",
					trace_id: "trace-1",
					user_id: "user-1",
					client_id: "cid-1",
					session_id: "sess-1",
					outcome: "success",
					duration_ms: 15,
					error_message: null,
					input_keys: ["content"],
					input_sha256: "abc",
					decision_id: null,
				},
				{
					id: "row-2",
					created_at: "2026-10-19T11:00:00Z",
					action_id: "capture",
					seam: "action",
					caller: "mcp",
					request_id: "req-2",
					parent_request_id: "req-0",
					trace_id: "trace-1",
					user_id: "user-1",
					client_id: "cid-1",
					session_id: "sess-1",
					outcome: "success",
					duration_ms: 20,
					error_message: null,
					input_keys: ["content"],
					input_sha256: "def",
					decision_id: null,
				},
			],
			clientsData: [
				{
					client_id: "cid-1",
					client: { client_name: "Claude Auto-Task Routine" },
				},
			],
		});

		const adapter = createSupabaseLedgerReadAdapter(client);
		const rows = await adapter.queryRows({
			since: "2026-10-19T00:00:00Z",
			until: "2026-10-20T00:00:00Z",
			action_id: "capture",
			caller: "mcp",
			client_id: "cid-1",
			session_id: "sess-1",
			request_id: "req-1",
			trace_id: "trace-1",
			parent_request_id: "req-0",
			outcome: "success",
			limit: 50,
		});

		expect(calls).toHaveLength(2);
		expect(calls[0]?.table).toBe("action_ledger");
		expect(calls[0]?.eqs).toEqual([
			["action_id", "capture"],
			["caller", "mcp"],
			["client_id", "cid-1"],
			["session_id", "sess-1"],
			["request_id", "req-1"],
			["trace_id", "trace-1"],
			["parent_request_id", "req-0"],
			["outcome", "success"],
		]);
		expect(calls[0]?.gtes).toEqual([["created_at", "2026-10-19T00:00:00Z"]]);
		expect(calls[0]?.lts).toEqual([["created_at", "2026-10-20T00:00:00Z"]]);
		expect(calls[0]?.orders).toEqual([["created_at", { ascending: false }]]);
		expect(calls[0]?.limit).toBe(50);

		expect(calls[1]?.table).toBe("mcp_oauth_clients");
		expect(calls[1]?.ins).toEqual([["client_id", ["cid-1"]]]);

		expect(rows).toHaveLength(2);
		expect(rows[0]?.client_name).toBe("Claude Auto-Task Routine");
		expect(rows[1]?.client_name).toBe("Claude Auto-Task Routine");
	});

	it("3. summary returns by_action counts and row_estimate / total_bytes from rpc('action_ledger_stats')", async () => {
		const { client, calls } = createFakeLedgerClient({
			ledgerData: [
				{ action_id: "capture", outcome: "success" },
				{ action_id: "capture", outcome: "success" },
				{ action_id: "capture", outcome: "error" },
				{ action_id: "entity_get", outcome: "success" },
			],
			statsData: [{ row_estimate: 420, total_bytes: 131072 }],
		});

		const adapter = createSupabaseLedgerReadAdapter(client);
		const summary = await adapter.querySummary({
			since: "2026-10-18T00:00:00Z",
		});

		expect(calls).toHaveLength(2);
		expect(calls[0]?.table).toBe("action_ledger");
		expect(calls[1]?.rpcName).toBe("action_ledger_stats");
		expect(summary).toEqual({
			by_action: [
				{ action_id: "capture", outcome: "error", count: 1 },
				{ action_id: "capture", outcome: "success", count: 2 },
				{ action_id: "entity_get", outcome: "success", count: 1 },
			],
			row_estimate: 420,
			total_bytes: 131072,
		});
	});

	it("4. rejects with a message naming action_ledger and the PostgREST error code", async () => {
		const { client } = createFakeLedgerClient({
			ledgerError: { code: "42P01", message: "relation action_ledger does not exist" },
		});
		const adapter = createSupabaseLedgerReadAdapter(client);
		await expect(adapter.queryRows({})).rejects.toThrow(
			/action_ledger query failed \[42P01\]: relation action_ledger does not exist/,
		);
	});
});
