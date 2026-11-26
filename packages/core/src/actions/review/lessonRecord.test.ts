import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { createReviewLessonRecordAction } from "./lessonRecord.js";
import { subjectKey } from "./subjectKey.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const DECISION_ID = "00000000-0000-4000-8000-000000000010";
const ENTITY_A = "00000000-0000-4000-8000-0000000000a1";
const ENTITY_B = "00000000-0000-4000-8000-0000000000b2";

describe("review_lesson_record (#1649)", () => {
	it("1. a pending decision refuses; a rejected relationship_suggested one inserts one row with sorted-pair subject_key and cooling_off_until 14 days on", async () => {
		const fixedNow = new Date("2026-10-16T12:00:00.000Z");
		let status = "pending";
		const fake = createFakeSupabase((call) => {
			if (call.table === "system_decisions") {
				return {
					data: [
						{
							id: DECISION_ID,
							user_id: OWNER_ID,
							status,
							decision_type: "relationship_suggested",
							decision_payload: {
								fromEntityId: ENTITY_B,
								toEntityId: ENTITY_A,
								relationshipType: "works_with",
							},
						},
					],
					error: null,
				};
			}
			if (call.table === "review_lessons" && call.op === "insert") {
				const p = call.payload as Record<string, unknown>;
				return {
					data: [
						{
							id: "00000000-0000-4000-8000-000000000099",
							subject_key: p.subject_key,
							cooling_off_until: p.cooling_off_until,
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const action = createReviewLessonRecordAction({
			supabase: fake.client,
			now: () => fixedNow,
		});

		await expect(
			action.run(
				{
					decision_id: DECISION_ID,
					category: "not_wanted",
					summary: "They are on different teams",
				},
				{ userId: OWNER_ID, caller: "mcp", requestId: "req-1" },
			),
		).rejects.toThrow("only a rejected suggestion can carry a lesson");

		status = "rejected";
		const result = await action.run(
			{
				decision_id: DECISION_ID,
				category: "not_wanted",
				summary: "They are on different teams",
			},
			{ userId: OWNER_ID, caller: "mcp", requestId: "req-1" },
		);

		const expectedCoolingOff = new Date(
			fixedNow.getTime() + 14 * 24 * 60 * 60 * 1000,
		).toISOString();
		expect(result).toEqual({
			id: "00000000-0000-4000-8000-000000000099",
			subject_key: `${ENTITY_A}::${ENTITY_B}::works_with`,
			cooling_off_until: expectedCoolingOff,
		});

		const inserts = fake.calls.filter(
			(c) => c.table === "review_lessons" && c.op === "insert",
		);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].payload).toMatchObject({
			user_id: OWNER_ID,
			decision_id: DECISION_ID,
			decision_type: "relationship_suggested",
			subject_key: `${ENTITY_A}::${ENTITY_B}::works_with`,
			category: "not_wanted",
			summary: "They are on different teams",
			cooling_off_until: expectedCoolingOff,
		});
	});

	it("2. forever: true stores cooling_off_until: null", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "system_decisions") {
				return {
					data: [
						{
							id: DECISION_ID,
							user_id: OWNER_ID,
							status: "rejected",
							decision_type: "merge_suggested",
							decision_payload: {
								winnerEntityId: ENTITY_B,
								loserEntityId: ENTITY_A,
							},
						},
					],
					error: null,
				};
			}
			if (call.table === "review_lessons" && call.op === "insert") {
				const p = call.payload as Record<string, unknown>;
				return {
					data: [
						{
							id: "00000000-0000-4000-8000-000000000098",
							subject_key: p.subject_key,
							cooling_off_until: p.cooling_off_until,
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const action = createReviewLessonRecordAction({ supabase: fake.client });
		const result = await action.run(
			{
				decision_id: DECISION_ID,
				category: "wrong",
				summary: "Two distinct people with the same name",
				forever: true,
			},
			{ userId: OWNER_ID, caller: "mcp", requestId: "req-1" },
		);

		expect(result.cooling_off_until).toBeNull();
		expect(result.subject_key).toBe(`${ENTITY_A}::${ENTITY_B}`);
	});

	it("3. a task_reminder decision refuses with 'no subject key for task_reminder yet'", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "system_decisions") {
				return {
					data: [
						{
							id: DECISION_ID,
							user_id: OWNER_ID,
							status: "rejected",
							decision_type: "task_reminder",
							decision_payload: {},
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const action = createReviewLessonRecordAction({ supabase: fake.client });
		await expect(
			action.run(
				{
					decision_id: DECISION_ID,
					category: "not_now",
					summary: "Skip this reminder",
				},
				{ userId: OWNER_ID, caller: "mcp", requestId: "req-1" },
			),
		).rejects.toThrow("no subject key for task_reminder yet");
	});

	it("4. another user's decision refuses as not found", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "system_decisions") {
				const userFilter = call.filters.find(
					(f) => f.method === "eq" && f.args[0] === "user_id",
				);
				if (userFilter?.args[1] !== "other-user") {
					return { data: [], error: null };
				}
				return {
					data: [
						{
							id: DECISION_ID,
							user_id: "other-user",
							status: "rejected",
							decision_type: "relationship_suggested",
							decision_payload: {
								fromEntityId: ENTITY_A,
								toEntityId: ENTITY_B,
								relationshipType: "works_with",
							},
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const action = createReviewLessonRecordAction({ supabase: fake.client });
		await expect(
			action.run(
				{
					decision_id: DECISION_ID,
					category: "not_wanted",
					summary: "Not mine",
				},
				{ userId: OWNER_ID, caller: "mcp", requestId: "req-1" },
			),
		).rejects.toThrow(/not found/i);
	});

	it("5. subjectKey gives the same key for (A, B, works_with) and (B, A, works_with)", () => {
		const keyAB = subjectKey("relationship_suggested", {
			fromEntityId: ENTITY_A,
			toEntityId: ENTITY_B,
			relationshipType: "works_with",
		});
		const keyBA = subjectKey("relationship_suggested", {
			fromEntityId: ENTITY_B,
			toEntityId: ENTITY_A,
			relationshipType: "works_with",
		});
		expect(keyAB).toBe(keyBA);
		expect(keyAB).toBe(`${ENTITY_A}::${ENTITY_B}::works_with`);
	});
});
