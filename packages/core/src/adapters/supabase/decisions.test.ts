import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseDecisionRepository } from "./decisions.js";

describe("createSupabaseDecisionRepository", () => {
	it("listRecent without a user id applies no user_id filter and defaults status to pending; with one it filters it", async () => {
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		const repo = createSupabaseDecisionRepository(fake.client);

		await repo.listRecent({ blockingOnly: true, stage: "organize", reviewType: "approval", limit: 10 });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].table).toBe("system_decisions");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["status", "pending"],
			["blocking", true],
			["stage", "organize"],
			["review_type", "approval"],
		]);

		await repo.listRecent({ status: "approved" }, "user-123");
		expect(fake.calls).toHaveLength(2);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["user_id", "user-123"],
			["status", "approved"],
		]);
	});

	it("resolvePending filters id, user_id and status = 'pending', selects id, and returns false when no row comes back", async () => {
		let rows: Array<{ id: string }> = [];
		const fake = createFakeSupabase(() => ({ data: rows, error: null }));
		const repo = createSupabaseDecisionRepository(fake.client);

		const emptyResult = await repo.resolvePending("dec-1", { status: "approved" }, "user-123");
		expect(emptyResult).toBe(false);
		expect(fake.calls[0].op).toBe("update");
		expect(fake.calls[0].selected).toBe("id");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", "dec-1"],
			["user_id", "user-123"],
			["status", "pending"],
		]);

		rows = [{ id: "dec-1" }];
		const hitResult = await repo.resolvePending("dec-1", { status: "approved" }, "user-123");
		expect(hitResult).toBe(true);
	});

	it("covers get, typesOf, resolve, listPage and getOne", async () => {
		const row = { id: "dec-1", decision_type: "entity_created", status: "pending" };
		const fake = createFakeSupabase(() => ({ data: [row], count: 1, error: null }));
		const repo = createSupabaseDecisionRepository(fake.client);

		expect((await repo.get("dec-1", "u1")).id).toBe("dec-1");
		expect(await repo.typesOf(["dec-1"], "u1")).toEqual([row]);
		expect(await repo.resolve(["dec-1"], { status: "approved" }, { excludeType: "action_approval" }, "u1")).toEqual([row]);
		expect(await repo.listPage({ status: "pending", decisionType: "entity_created", offset: 0, limit: 5 }, "u1")).toEqual({
			rows: [row],
			total: 1,
		});
		expect((await repo.getOne("dec-1", "u1"))?.id).toBe("dec-1");
	});

	it("listJobApplicationWatermarks filters shadow rows in SQL and keys by message_id + item_key", async () => {
		const rows = [
			{
				decision_payload: {
					message_id: "m1",
					item_key: "primary",
					mode: "shadow",
				},
			},
			{
				decision_payload: {
					message_id: "m2",
					item_key: "0:augur-fde",
					mode: "label",
				},
			},
			{
				decision_payload: {
					message_id: "m3",
					mode: "act",
				},
			},
		];
		const fake = createFakeSupabase(() => ({ data: rows, error: null }));
		const repo = createSupabaseDecisionRepository(fake.client);

		const watermarks = await repo.listJobApplicationWatermarks?.(["m1", "m2", "m3"], "u1");
		expect(watermarks).toEqual(new Set(["m2::0:augur-fde", "m3::primary"]));
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["decision_type", "job_application_update"],
			["user_id", "u1"],
		]);
		expect(fake.filtersOf(fake.calls[0], "neq")).toEqual([
			["decision_payload->>mode", "shadow"],
		]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([
			["decision_payload->>message_id", ["m1", "m2", "m3"]],
		]);
		expect(fake.filtersOf(fake.calls[0], "range")).toEqual([[0, 499]]);
	});

	it("listJobApplicationWatermarks chunks messageIds in batches of 50 and paginates past 500 rows", async () => {
		const allMessageIds = Array.from({ length: 120 }, (_, i) => `msg-${i}`);
		// First chunk returns a full page of 500 items (e.g. multi-role digests) followed by 15 more
		const chunk0Page0 = Array.from({ length: 500 }, (_, idx) => ({
			decision_payload: {
				message_id: "msg-0",
				item_key: `${idx}:role-${idx}`,
				mode: "label",
			},
		}));
		const chunk0Page1 = Array.from({ length: 15 }, (_, idx) => ({
			decision_payload: {
				message_id: "msg-0",
				item_key: `${500 + idx}:role-${500 + idx}`,
				mode: "label",
			},
		}));
		let callIdx = 0;
		const fake = createFakeSupabase((call) => {
			const idx = callIdx++;
			const inFilter = call.filters.find((f) => f.method === "in")?.args[1] as string[];
			if (inFilter.includes("msg-0")) {
				return idx === 0 ? { data: chunk0Page0, error: null } : { data: chunk0Page1, error: null };
			}
			return {
				data: [
					{
						decision_payload: {
							message_id: inFilter[0],
							item_key: "primary",
							mode: "act",
						},
					},
				],
				error: null,
			};
		});
		const repo = createSupabaseDecisionRepository(fake.client);

		const watermarks = await repo.listJobApplicationWatermarks?.(allMessageIds, "u1");
		// 3 chunks (50 + 50 + 20); chunk 0 paginated twice (range 0..499 then 500..999)
		expect(fake.calls).toHaveLength(4);
		expect(fake.filtersOf(fake.calls[0], "in")[0][1]).toHaveLength(50);
		expect(fake.filtersOf(fake.calls[0], "range")).toEqual([[0, 499]]);
		expect(fake.filtersOf(fake.calls[1], "range")).toEqual([[500, 999]]);
		expect(fake.filtersOf(fake.calls[2], "in")[0][1]).toHaveLength(50);
		expect(fake.filtersOf(fake.calls[3], "in")[0][1]).toHaveLength(20);
		expect(watermarks?.size).toBe(515 + 2);
		expect(watermarks?.has("msg-0::514:role-514")).toBe(true);
		expect(watermarks?.has("msg-50::primary")).toBe(true);
		expect(watermarks?.has("msg-100::primary")).toBe(true);
	});

	it("recordJobApplicationWatermarks inserts job_application_update rows into system_decisions", async () => {
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		const repo = createSupabaseDecisionRepository(fake.client);

		await repo.recordJobApplicationWatermarks?.(
			[
				{
					message_id: "m1",
					item_key: "primary",
					mode: "shadow",
					outcome: "shadow_logged",
					organisation: "Veeva",
					role_title: "Strategy Director",
					stage: "applied",
					confidence: 0.96,
				},
			],
			"u1",
		);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].table).toBe("system_decisions");
		expect(fake.calls[0].op).toBe("insert");
		const inserted = (fake.calls[0].payload as Array<Record<string, unknown>>)[0];
		expect(inserted.decision_type).toBe("job_application_update");
		expect(inserted.user_id).toBe("u1");
		expect(inserted.decision_payload).toMatchObject({
			message_id: "m1",
			item_key: "primary",
			mode: "shadow",
			outcome: "shadow_logged",
			organisation: "Veeva",
		});
	});
});
