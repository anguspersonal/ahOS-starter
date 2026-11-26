import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createPlanningAdapter } from "../../adapters/planning/index.js";
import type { PlanningPort } from "../../ports/planning.js";
import {
	createPlanningEditAction,
	PLANNING_EDIT_DESCRIPTION,
	type PlanningEditInput,
} from "./edit.js";

// The planning tools (example-org/web-app#114). `planning_read` has moved to @ahkms/core
// (#1629); what remains here is `planning_edit` until its migration (#1630).

const OK = (body: unknown) =>
	({
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}) as unknown as Response;

const FAIL = (status: number, body: string) =>
	({
		ok: false,
		status,
		json: async () => JSON.parse(body),
		text: async () => body,
	}) as unknown as Response;

const INDEX = {
	snapshotId: "3f1b7f6e-1111-4222-8333-444455556666",
	label: "01Sep2026",
	createdAt: "2026-09-01T12:08:49Z",
	writable: ["roadmapItems", "modelIssues", "modelDecisions", "modelQuestions", "risks"],
	collections: { roadmapItems: 112, modelIssues: 9 },
};

const ctx = { caller: "test" as const, requestId: "test-req-1" };

const action = createPlanningEditAction(
	createPlanningAdapter({
		baseUrl: () => process.env.WORK_PLANNING_BASE_URL || "https://planning.example.com",
		getToken: () => {
			if (!process.env.WORK_PLANNING_TOKEN) {
				throw new Error("WORK_PLANNING_TOKEN is not set");
			}
			return process.env.WORK_PLANNING_TOKEN;
		},
	}),
);

const planningEditHandler = async (input: PlanningEditInput) => {
	const out = await action.run(input, ctx);
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	process.env.WORK_PLANNING_TOKEN = "hlp_test-token";
	delete process.env.WORK_PLANNING_BASE_URL;
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.WORK_PLANNING_TOKEN;
});

describe("planning_edit", () => {
	it("1. Contract: id, schema JSON snapshot, description, and annotations match legacy planning_edit", () => {
		const stubPort: PlanningPort = {
			read: async () => INDEX,
			edit: async () => ({
				snapshotId: INDEX.snapshotId,
				label: null,
				createdAt: INDEX.createdAt,
				applied: [],
				warnings: [],
				standingWarnings: 0,
			}),
		};
		const a = createPlanningEditAction(stubPort);
		expect(a.id).toBe("planning_edit");
		expect(a.description).toBe(PLANNING_EDIT_DESCRIPTION);
		expect(a.description).toBe("Edit the Work planning document by applying patch, upsert and remove ops to named collections. All ops land or none do, and they apply server-side against whatever is current, so a concurrent human edit is not overwritten wholesale. Full notes: docs/guides/tools/planning_edit.md");
		expect(a.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const s1 = { type: "string", minLength: 1 };
		const rv = { type: "object", propertyNames: { type: "string" }, additionalProperties: {} };
		expect(z.toJSONSchema(a.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				ops: {
					type: "array",
					minItems: 1,
					maxItems: 100,
					description: "Changes to apply, all or none. Three shapes: {collection, op:'patch', id, value} merges value into the record with that id and FAILS if there is none, so a typo'd id cannot create a half-formed record; {collection, op:'upsert', value} replaces the whole record or appends it when the id is new, and value must carry a string `id`; {collection, op:'remove', id} deletes it. Writable collections are roadmapItems, modelIssues, modelDecisions, modelQuestions and risks — run planning_read first to confirm, since the API is the authority. The goal tree, domain registries, periods, people and budget are NOT writable and are refused by name: they are structure and change in code.",
					items: {
						anyOf: [
							{ type: "object", properties: { collection: s1, op: { type: "string", const: "patch" }, id: s1, value: rv }, required: ["collection", "op", "id", "value"], additionalProperties: false },
							{ type: "object", properties: { collection: s1, op: { type: "string", const: "upsert" }, value: rv }, required: ["collection", "op", "value"], additionalProperties: false },
							{ type: "object", properties: { collection: s1, op: { type: "string", const: "remove" }, id: s1 }, required: ["collection", "op", "id"], additionalProperties: false },
						],
					},
				},
				label: { type: "string", minLength: 1, maxLength: 200, description: "Label for the snapshot this write creates, shown in the page's Load panel. Say what changed and that an agent did it, e.g. 'mcp: close landing-page issue'." },
				baseSnapshotId: {
					type: "string",
					format: "uuid",
					pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
					description: "The snapshot id you read before composing these ops. Supply it whenever you read and then think before writing: if someone saved in between, the write is refused with a 409 naming the current snapshot instead of silently overwriting their edit. Omit only when reading and writing in one uninterrupted step.",
				},
			},
			required: ["ops"],
			additionalProperties: false,
		});
	});

	it("PATCHes the ops and carries baseSnapshotId through", async () => {
		fetchMock.mockResolvedValue(
			OK({
				snapshotId: "new-id",
				label: "mcp: close issue",
				createdAt: "2026-09-02T09:00:00Z",
				applied: ["patch modelIssues/landing-page"],
				warnings: [],
				standingWarnings: 0,
			}),
		);

		const res = await planningEditHandler({
			ops: [
				{
					collection: "modelIssues",
					op: "patch",
					id: "landing-page",
					value: { status: "resolved" },
				},
			],
			label: "mcp: close issue",
			baseSnapshotId: INDEX.snapshotId,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://planning.example.com/api/planning/document");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body)).toEqual({
			ops: [
				{
					collection: "modelIssues",
					op: "patch",
					id: "landing-page",
					value: { status: "resolved" },
				},
			],
			label: "mcp: close issue",
			baseSnapshotId: INDEX.snapshotId,
		});
		expect(res.content[0].text).toContain("patch modelIssues/landing-page");
	});

	it("omits the optional fields rather than sending nulls", async () => {
		fetchMock.mockResolvedValue(
			OK({
				snapshotId: "x",
				label: null,
				createdAt: "2026-09-02T09:00:00Z",
				applied: [],
				warnings: [],
				standingWarnings: 0,
			}),
		);
		await planningEditHandler({
			ops: [{ collection: "risks", op: "remove", id: "r1" }],
		});

		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			ops: [{ collection: "risks", op: "remove", id: "r1" }],
		});
	});

	it("surfaces validator warnings, which nothing else will report", async () => {
		fetchMock.mockResolvedValue(
			OK({
				snapshotId: "x",
				label: null,
				createdAt: "2026-09-02T09:00:00Z",
				applied: ["create modelIssues/i9"],
				warnings: [
					{
						code: "MISSING_END_DATE",
						severity: "warn",
						subject: "chat_quality",
						message: "item has no endDate",
					},
				],
				standingWarnings: 41,
			}),
		);
		const res = await planningEditHandler({
			ops: [{ collection: "modelIssues", op: "upsert", value: { id: "i9" } }],
		});

		expect(res.content[0].text).toContain(
			"validator warnings on what you changed (1, not blocking)",
		);
		expect(res.content[0].text).toContain("MISSING_END_DATE");
		// The standing backlog is counted, never listed: the live model carries dozens
		// and printing them on every write is how the channel stops being read.
		expect(res.content[0].text).toContain("41 other validator warnings are standing");
	});

	it("keeps the API's refusal message, not just the status code", async () => {
		fetchMock.mockResolvedValue(
			FAIL(
				400,
				JSON.stringify({
					error: "Bad request",
					message:
						'ops[0]: "modelGoals" is not a writable collection. Writable: roadmapItems, modelIssues, modelDecisions, modelQuestions, risks.',
				}),
			),
		);

		await expect(
			planningEditHandler({
				ops: [{ collection: "modelGoals", op: "upsert", value: { id: "g" } }],
			}),
		).rejects.toThrow(/not a writable collection/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports a stale write as a conflict rather than swallowing it", async () => {
		fetchMock.mockResolvedValue(
			FAIL(
				409,
				JSON.stringify({
					error: "Conflict",
					message: "The document moved on",
					currentSnapshotId: "newer",
				}),
			),
		);

		await expect(
			planningEditHandler({
				ops: [{ collection: "risks", op: "remove", id: "r1" }],
				baseSnapshotId: INDEX.snapshotId,
			}),
		).rejects.toThrow(/409/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects multi-op batches containing invalid domain, parent, feedsGoals, or attachesTo.id slugs before calling port.edit (#1994)", async () => {
		const editSpy = vi.fn();
		const stubPort: PlanningPort = {
			read: async () => ({
				...INDEX,
				data: {
					modelDomains: [
						{ id: "product-engineering" },
						{ id: "gtm" },
						{ id: "marketing" },
					],
					modelGoals: [
						{ id: "serve" },
						{ id: "monetization" },
						{ id: "retention" },
					],
					roadmapItems: [
						{ id: "paywall-move-and-refactor", detailLevel: "project" },
						{ id: "analytics-revamp", detailLevel: "project" },
						{ id: "recreate-mobile-paywall", detailLevel: "task" },
					],
				},
			}),
			edit: editSpy,
		};
		const editAction = createPlanningEditAction(stubPort);

		let caught: Error | undefined;
		try {
			await editAction.run(
				{
					ops: [
						{
							collection: "roadmapItems",
							op: "upsert",
							value: {
								id: "task-1",
								domain: "product-eng",
								parent: "paywall-refactor",
								feedsGoals: ["monetize"],
							},
						},
						{
							collection: "modelIssues",
							op: "upsert",
							value: {
								id: "issue-1",
								attachesTo: { id: "nonexistent-goal", kind: "goal" },
							},
						},
						{
							collection: "roadmapItems",
							op: "patch",
							id: "task-2",
							value: {
								parent: "recreate-mobile-paywall",
							},
						},
					],
				},
				ctx,
			);
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeDefined();
		const msg = caught!.message;
		expect(editSpy).not.toHaveBeenCalled();

		// Reports every offending op index, bad slug, and valid candidates / closest matches in one error
		expect(msg).toContain("ops[0].domain");
		expect(msg).toContain('"product-eng"');
		expect(msg).toContain("product-engineering");

		expect(msg).toContain("ops[0].parent");
		expect(msg).toContain('"paywall-refactor"');
		expect(msg).toContain("paywall-move-and-refactor");

		expect(msg).toContain("ops[0].feedsGoals");
		expect(msg).toContain('"monetize"');
		expect(msg).toContain("monetization");

		expect(msg).toContain("ops[1].attachesTo.id");
		expect(msg).toContain('"nonexistent-goal"');
		expect(msg).toContain("serve, monetization, retention");

		// A task-level item is not a valid project parent
		expect(msg).toContain("ops[2].parent");
		expect(msg).toContain('"recreate-mobile-paywall"');
	});

	it("allows multi-op batches where an earlier or sibling upsert creates the parent project referenced in the same batch (#1994)", async () => {
		const editSpy = vi.fn().mockResolvedValue({
			snapshotId: "new-snap",
			label: "mcp: create project + child task",
			createdAt: "2026-10-26T12:00:00Z",
			applied: [
				"create roadmapItems/new-funnel-project",
				"create roadmapItems/new-funnel-task",
				"create modelIssues/funnel-issue",
			],
			warnings: [],
			standingWarnings: 0,
		});
		const stubPort: PlanningPort = {
			read: async () => ({
				...INDEX,
				data: {
					modelDomains: [{ id: "product-engineering" }, { id: "gtm" }],
					modelGoals: [{ id: "monetization" }],
					roadmapItems: [{ id: "paywall-move-and-refactor", detailLevel: "project" }],
				},
			}),
			edit: editSpy,
		};
		const editAction = createPlanningEditAction(stubPort);

		const res = await editAction.run(
			{
				ops: [
					{
						collection: "roadmapItems",
						op: "upsert",
						value: {
							id: "new-funnel-task",
							domain: "product-engineering",
							detailLevel: "task",
							parent: "new-funnel-project",
							feedsGoals: ["monetization"],
						},
					},
					{
						collection: "roadmapItems",
						op: "upsert",
						value: {
							id: "new-funnel-project",
							domain: "product-engineering",
							detailLevel: "project",
							feedsGoals: ["monetization"],
						},
					},
					{
						collection: "modelIssues",
						op: "upsert",
						value: {
							id: "funnel-issue",
							attachesTo: { id: "new-funnel-project", kind: "item" },
						},
					},
				],
			},
			ctx,
		);

		expect(editSpy).toHaveBeenCalledTimes(1);
		expect(res.snapshotId).toBe("new-snap");
	});
});

describe("setup errors", () => {
	it("names the env var when the token is missing", async () => {
		delete process.env.WORK_PLANNING_TOKEN;
		await expect(
			planningEditHandler({
				ops: [{ collection: "risks", op: "remove", id: "r1" }],
			}),
		).rejects.toThrow(/WORK_PLANNING_TOKEN is not set/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
