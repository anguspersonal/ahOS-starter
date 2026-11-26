import { afterEach, describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseActionApprovalStore } from "./actionApprovals.js";
import { setActionApprovalStore, type ApprovalRequest } from "../../actions/gate.js";

const SAMPLE_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("createSupabaseActionApprovalStore", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	it("inserts an action_approval row into system_decisions with exact columns, payload, 7-day/1-day expiry, and key-only description (Case 1)", async () => {
		const fake = createFakeSupabase(() => ({
			data: { id: "d-1" },
			error: null,
		}));
		const fixedNow = new Date("2026-10-19T12:00:00.000Z");
		const store = createSupabaseActionApprovalStore(fake.client as any, {
			now: () => fixedNow,
		});

		const request: ApprovalRequest = {
			actionId: "gmail_send_draft",
			input: { draftId: "d-1", secretBody: "ultra-secret-value-999" },
			inputSha256: SAMPLE_HASH,
			caller: "mcp",
			requestId: "req-101",
			userId: "user-owner-1",
			clientId: "claude-web",
			sessionId: "sess-42",
		};

		const result = await store.park(request);
		expect(result).toEqual({ decisionId: "d-1" });

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("system_decisions");
		expect(call.op).toBe("insert");
		expect(call.selected).toBe("id");
		expect(call.single).toBe("single");

		const expectedColumns = [
			"decision_type",
			"review_type",
			"stage",
			"status",
			"title",
			"description",
			"decision_payload",
			"input_sha256",
			"user_id",
			"requires_user_action",
			"user_visible",
			"blocking",
			"expires_at",
		];
		const payload = call.payload as Record<string, unknown>;
		expect(Object.keys(payload).sort()).toEqual([...expectedColumns].sort());

		expect(payload.decision_type).toBe("action_approval");
		expect(payload.review_type).toBe("approval");
		expect(payload.stage).toBe("act");
		expect(payload.status).toBe("pending");
		expect(payload.title).toBe("Approve gmail_send_draft");
		expect(payload.input_sha256).toBe(SAMPLE_HASH);
		expect(payload.user_id).toBe("user-owner-1");
		expect(payload.requires_user_action).toBe(true);
		expect(payload.user_visible).toBe(true);
		expect(payload.blocking).toBe(false);
		expect(payload.expires_at).toBe("2026-10-26T12:00:00.000Z");

		// Description names actionId, caller, and input keys, never input values
		expect(payload.description).toContain("gmail_send_draft");
		expect(payload.description).toContain("mcp");
		expect(payload.description).toContain("draftId");
		expect(payload.description).toContain("secretBody");
		expect(payload.description).not.toContain("ultra-secret-value-999");
		expect(payload.description).not.toContain("d-1");

		const decisionPayload = payload.decision_payload as Record<string, unknown>;
		expect(Object.keys(decisionPayload).sort()).toEqual(
			[
				"action_id",
				"input",
				"input_keys",
				"caller",
				"request_id",
				"client_id",
				"session_id",
			].sort(),
		);
		expect(decisionPayload).toEqual({
			action_id: "gmail_send_draft",
			input: { draftId: "d-1", secretBody: "ultra-secret-value-999" },
			input_keys: ["draftId", "secretBody"],
			caller: "mcp",
			request_id: "req-101",
			client_id: "claude-web",
			session_id: "sess-42",
		});

		// ttlDays: 1 gives 1 day after now, and absent clientId/sessionId become null
		const oneDayStore = createSupabaseActionApprovalStore(fake.client as any, {
			now: () => fixedNow,
			ttlDays: 1,
		});
		await oneDayStore.park({
			actionId: "gmail_send_draft",
			input: { draftId: "d-1" },
			inputSha256: SAMPLE_HASH,
			caller: "mcp",
			requestId: "req-102",
			userId: "user-owner-1",
			clientId: null,
			sessionId: null,
		});
		const secondPayload = fake.calls[1].payload as Record<string, unknown>;
		expect(secondPayload.expires_at).toBe("2026-10-20T12:00:00.000Z");
		expect(secondPayload.decision_payload).toEqual({
			action_id: "gmail_send_draft",
			input: { draftId: "d-1" },
			input_keys: ["draftId"],
			caller: "mcp",
			request_id: "req-102",
			client_id: null,
			session_id: null,
		});
	});

	it("rejects before touching Supabase when userId is null, and surfaces PostgREST errors with table and code (Case 2)", async () => {
		const fakeForNullUser = createFakeSupabase(() => ({
			data: { id: "dec-never" },
			error: null,
		}));
		const storeForNullUser = createSupabaseActionApprovalStore(
			fakeForNullUser.client as any,
		);

		await expect(
			storeForNullUser.park({
				actionId: "gmail_send_draft",
				input: { draftId: "d-1" },
				inputSha256: SAMPLE_HASH,
				caller: "mcp",
				requestId: "req-null-user",
				userId: null,
				clientId: null,
				sessionId: null,
			}),
		).rejects.toThrow(/user_id/i);
		expect(fakeForNullUser.calls).toHaveLength(0);

		const fakeError = createFakeSupabase(() => ({
			data: null,
			error: { code: "23514", message: "new row violates check constraint" },
		}));
		const storeError = createSupabaseActionApprovalStore(fakeError.client as any);

		await expect(
			storeError.park({
				actionId: "gmail_send_draft",
				input: { draftId: "d-1" },
				inputSha256: SAMPLE_HASH,
				caller: "mcp",
				requestId: "req-err",
				userId: "user-owner-1",
				clientId: null,
				sessionId: null,
			}),
		).rejects.toThrow(/system_decisions.*23514/);
		expect(fakeError.calls).toHaveLength(1);
	});
});
