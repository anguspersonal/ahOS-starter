import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: { from: vi.fn() } }));

import { approvalChecks } from "./approvalChecks.js";

function createFakeClient(result: {
	data: Array<{ id: string; title: string | null; resolved_at: string | null }> | null;
	count: number | null;
	error: { message: string } | null;
}) {
	const limit = vi.fn().mockResolvedValue(result);
	const order = vi.fn().mockReturnValue({ limit });
	const lt = vi.fn().mockReturnValue({ order });
	const eqStatus = vi.fn().mockReturnValue({ lt });
	const eqType = vi.fn().mockReturnValue({ eq: eqStatus });
	const select = vi.fn().mockReturnValue({ eq: eqType });
	const from = vi.fn().mockReturnValue({ select });
	return { client: { from }, from, select, eqType, eqStatus, lt, order, limit };
}

describe("approvalChecks (#1430)", () => {
	const now = new Date("2026-10-11T12:00:00.000Z");

	it("6. selects id, title, resolved_at with exact count, filters <now-30m>, orders ascending limit 5, and returns ok on 0", async () => {
		const fake = createFakeClient({ data: [], count: 0, error: null });
		const checks = await approvalChecks(fake.client as never, now);

		expect(fake.from).toHaveBeenCalledWith("system_decisions");
		expect(fake.select).toHaveBeenCalledWith("id, title, resolved_at", { count: "exact" });
		expect(fake.eqType).toHaveBeenCalledWith("decision_type", "action_approval");
		expect(fake.eqStatus).toHaveBeenCalledWith("status", "approved");
		expect(fake.lt).toHaveBeenCalledWith("resolved_at", "2026-10-11T11:30:00.000Z");
		expect(fake.order).toHaveBeenCalledWith("resolved_at", { ascending: true });
		expect(fake.limit).toHaveBeenCalledWith(5);
		expect(checks).toEqual([
			{ family: "wiring", name: "stuck action approvals", status: "ok", detail: "no action_approval rows stuck at approved past 30 minutes.", fix: "" },
		]);
	});

	it("7. warns for a row claimed 45 minutes ago naming id, title, claim time, may or may not have run, and fix pointing to action_ledger", async () => {
		const fake = createFakeClient({
			data: [{ id: "dec-45m", title: "Approve slack_post", resolved_at: "2026-10-11T11:15:00.000Z" }],
			count: 1,
			error: null,
		});
		const [check] = await approvalChecks(fake.client as never, now);

		expect(check?.status).toBe("warn");
		expect(check?.detail).toContain("dec-45m");
		expect(check?.detail).toContain("Approve slack_post");
		expect(check?.detail).toContain("2026-10-11T11:15:00.000Z");
		expect(check?.detail).toMatch(/may or may not have run/i);
		expect(check?.fix).toMatch(/never re-run/i);
		expect(check?.fix).toContain("action_ledger");
	});

	it("8. fails when oldest row was claimed over 2 hours ago, names engine service and approval_expiry, and reports 'and 2 more' for 7 rows", async () => {
		const rows = [
			{ id: "dec-1", title: "Approve gmail_send_draft", resolved_at: "2026-10-11T09:30:00.000Z" },
			{ id: "dec-2", title: "Approve slack_post", resolved_at: "2026-10-11T10:15:00.000Z" },
			{ id: "dec-3", title: "Approve drive_delete", resolved_at: "2026-10-11T10:30:00.000Z" },
			{ id: "dec-4", title: "Approve notion_page_update", resolved_at: "2026-10-11T10:45:00.000Z" },
			{ id: "dec-5", title: "Approve task_create", resolved_at: "2026-10-11T11:00:00.000Z" },
		];
		const fake = createFakeClient({ data: rows, count: 7, error: null });
		const [check] = await approvalChecks(fake.client as never, now);

		expect(check?.status).toBe("fail");
		expect(check?.detail).toContain("and 2 more");
		expect(check?.fix).toMatch(/engine/i);
		expect(check?.fix).toContain("approval_expiry");
	});

	it("9. returns warn (never ok) on read error or null count", async () => {
		const [errCheck] = await approvalChecks(createFakeClient({ data: null, count: null, error: { message: "connection timeout" } }).client as never, now);
		expect(errCheck?.status).toBe("warn");
		expect(errCheck?.detail).toContain("connection timeout");

		const [nullCheck] = await approvalChecks(createFakeClient({ data: [], count: null, error: null }).client as never, now);
		expect(nullCheck?.status).toBe("warn");
		expect(nullCheck?.detail).toMatch(/null count/i);
	});
});
