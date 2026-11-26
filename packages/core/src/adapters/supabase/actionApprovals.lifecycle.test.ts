import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseActionApprovalStore } from "./actionApprovals.js";

const SAMPLE_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("createSupabaseActionApprovalStore lifecycle", () => {
	const fixedNow = new Date("2026-10-19T12:00:00.000Z");

	it("claim performs one conditional update on system_decisions, maps the row back, returns null on zero rows, and rejects naming the decision id on PostgREST error (Case 1)", async () => {
		const fake = createFakeSupabase(() => ({
			data: [
				{
					id: "dec-1",
					decision_type: "action_approval",
					user_id: "user-owner-1",
					status: "approved",
					input_sha256: SAMPLE_HASH,
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
			],
			error: null,
		}));
		const store = createSupabaseActionApprovalStore(fake.client, {
			now: () => fixedNow,
		});

		const claimed = await store.claim(
			"dec-1",
			"user-owner-1",
			"approved in the web inbox",
		);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("system_decisions");
		expect(call.op).toBe("update");
		expect(call.payload).toEqual({
			status: "approved",
			resolved_by: "user-owner-1",
			resolved_at: "2026-10-19T12:00:00.000Z",
			resolution_notes: "approved in the web inbox",
		});
		expect(call.selected).toBe("*");
		expect(fake.filtersOf(call, "eq")).toEqual([
			["id", "dec-1"],
			["decision_type", "action_approval"],
			["user_id", "user-owner-1"],
			["status", "pending"],
		]);
		expect(fake.filtersOf(call, "is")).toEqual([["resolved_at", null]]);
		expect(fake.filtersOf(call, "gt")).toEqual([
			["expires_at", "2026-10-19T12:00:00.000Z"],
		]);
		expect(claimed).toEqual({
			decisionId: "dec-1",
			actionId: "gmail_send_draft",
			input: { draftId: "d-1" },
			inputSha256: SAMPLE_HASH,
			caller: "mcp",
			userId: "user-owner-1",
		});

		const fakeEmpty = createFakeSupabase(() => ({ data: [], error: null }));
		const emptyStore = createSupabaseActionApprovalStore(fakeEmpty.client, {
			now: () => fixedNow,
		});
		expect(await emptyStore.claim("dec-missing", "user-owner-1")).toBeNull();

		const fakeErr = createFakeSupabase(() => ({
			data: null,
			error: { code: "42501", message: "permission denied" },
		}));
		const errStore = createSupabaseActionApprovalStore(fakeErr.client, {
			now: () => fixedNow,
		});
		await expect(
			errStore.claim("dec-err-42", "user-owner-1"),
		).rejects.toThrow(/dec-err-42/);
	});

	it("finish updates approved rows to executed or failed and rejects on zero rows or error; reject moves pending to rejected and returns false on zero rows (Case 2)", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ id: "dec-1" }],
			error: null,
		}));
		const store = createSupabaseActionApprovalStore(fake.client, {
			now: () => fixedNow,
		});

		await store.finish("dec-1", { outcome: "executed" });
		expect(fake.calls[0]).toMatchObject({
			table: "system_decisions",
			op: "update",
			payload: {
				status: "executed",
				resolution_data: { outcome: "executed" },
			},
			selected: "id",
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", "dec-1"],
			["status", "approved"],
		]);

		await store.finish("dec-1", { outcome: "failed", error: "boom" });
		expect(fake.calls[1].payload).toEqual({
			status: "failed",
			resolution_data: { outcome: "failed", error: "boom" },
		});

		const fakeZeroFinish = createFakeSupabase(() => ({ data: [], error: null }));
		const zeroFinishStore = createSupabaseActionApprovalStore(
			fakeZeroFinish.client,
			{ now: () => fixedNow },
		);
		await expect(
			zeroFinishStore.finish("dec-zero", { outcome: "executed" }),
		).rejects.toThrow(/dec-zero/);

		const fakeFinishErr = createFakeSupabase(() => ({
			data: null,
			error: { code: "23514", message: "check constraint" },
		}));
		const finishErrStore = createSupabaseActionApprovalStore(
			fakeFinishErr.client,
			{ now: () => fixedNow },
		);
		await expect(
			finishErrStore.finish("dec-err", { outcome: "executed" }),
		).rejects.toThrow(/dec-err/);

		const rejected = await store.reject("dec-2", "user-owner-1", "not needed");
		expect(rejected).toBe(true);
		const rejectCall = fake.calls[2];
		expect(rejectCall).toMatchObject({
			table: "system_decisions",
			op: "update",
			payload: {
				status: "rejected",
				resolved_by: "user-owner-1",
				resolved_at: "2026-10-19T12:00:00.000Z",
				resolution_notes: "not needed",
			},
			selected: "id",
		});
		expect(fake.filtersOf(rejectCall, "eq")).toEqual([
			["id", "dec-2"],
			["decision_type", "action_approval"],
			["user_id", "user-owner-1"],
			["status", "pending"],
		]);
		expect(fake.filtersOf(rejectCall, "is")).toEqual([["resolved_at", null]]);

		expect(await zeroFinishStore.reject("dec-zero", "user-owner-1")).toBe(false);
		await expect(
			finishErrStore.reject("dec-err", "user-owner-1"),
		).rejects.toThrow(/dec-err/);
	});
});
