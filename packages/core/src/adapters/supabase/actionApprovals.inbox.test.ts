import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseActionApprovalStore } from "./actionApprovals.js";

describe("createSupabaseActionApprovalStore listPending (#1422)", () => {
	const fixedNow = new Date("2026-10-19T12:00:00.000Z");

	it("makes one select on system_decisions with exact filters, order and limit, and maps rows with absent payload fields as null (Case 9)", async () => {
		const fake = createFakeSupabase(() => ({
			data: [
				{
					id: "dec-newest",
					created_at: "2026-10-19T11:30:00.000Z",
					expires_at: "2026-10-26T11:30:00.000Z",
					decision_payload: {
						action_id: "gmail_send_draft",
						input: { draftId: "d-1" },
						input_keys: ["draftId"],
						caller: "mcp",
						request_id: "req-1",
						client_id: "claude-web",
						session_id: "sess-1",
					},
				},
				{
					id: "dec-sparse",
					created_at: "2026-10-19T10:00:00.000Z",
					expires_at: null,
					decision_payload: {},
				},
			],
			error: null,
		}));

		const store = createSupabaseActionApprovalStore(fake.client, {
			now: () => fixedNow,
		});

		const rows = await store.listPending("user-owner-1", 50);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("system_decisions");
		expect(call.op).toBe("select");
		expect(call.selected).toBe("id, decision_payload, created_at, expires_at");
		expect(fake.filtersOf(call, "eq")).toEqual([
			["decision_type", "action_approval"],
			["user_id", "user-owner-1"],
			["status", "pending"],
		]);
		expect(fake.filtersOf(call, "is")).toEqual([["resolved_at", null]]);
		expect(fake.filtersOf(call, "gt")).toEqual([
			["expires_at", "2026-10-19T12:00:00.000Z"],
		]);
		expect(fake.filtersOf(call, "order")).toEqual([
			["created_at", { ascending: false }],
		]);
		expect(fake.filtersOf(call, "limit")).toEqual([[50]]);

		expect(rows).toEqual([
			{
				decision_id: "dec-newest",
				action_id: "gmail_send_draft",
				input: { draftId: "d-1" },
				input_keys: ["draftId"],
				caller: "mcp",
				client_id: "claude-web",
				session_id: "sess-1",
				created_at: "2026-10-19T11:30:00.000Z",
				expires_at: "2026-10-26T11:30:00.000Z",
			},
			{
				decision_id: "dec-sparse",
				action_id: null,
				input: null,
				input_keys: null,
				caller: null,
				client_id: null,
				session_id: null,
				created_at: "2026-10-19T10:00:00.000Z",
				expires_at: null,
			},
		]);
	});

	it("rejects on PostgREST error with a message naming system_decisions and the code, never resolving [] (Case 10)", async () => {
		const fake = createFakeSupabase(() => ({
			data: null,
			error: { code: "42501", message: "permission denied for table" },
		}));
		const store = createSupabaseActionApprovalStore(fake.client, {
			now: () => fixedNow,
		});

		await expect(store.listPending("user-owner-1", 50)).rejects.toThrow(
			/system_decisions.*42501/,
		);
	});
});
