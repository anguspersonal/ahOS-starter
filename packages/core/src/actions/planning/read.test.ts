import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPlanningAdapter } from "../../adapters/planning/index.js";
import type { PlanningIndex, PlanningPort } from "../../ports/planning.js";
import {
	createPlanningReadAction,
	PLANNING_READ_DESCRIPTION,
} from "./read.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX: PlanningIndex = {
	snapshotId: "3f1b7f6e-1111-4222-8333-444455556666",
	label: "01Sep2026",
	createdAt: "2026-09-01T12:08:49Z",
	writable: ["roadmapItems", "modelIssues", "modelDecisions", "modelQuestions", "risks"],
	collections: { roadmapItems: 112, modelIssues: 9 },
};

describe("planning_read action (#1629)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("1. Contract (R11): id, schema JSON snapshot, description, and annotations match legacy planning_read", () => {
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
		const action = createPlanningReadAction(stubPort);

		expect(action.id).toBe("planning_read");
		expect(action.description).toBe(PLANNING_READ_DESCRIPTION);
		expect(action.description).toBe(
			"Read the Work planning document — roadmap, issues, decisions, open questions and risks. Call " +
				"it with NO arguments first: that returns the snapshot id, a row count per collection, and the " +
				"collection names, which is what you need before asking for any one of them. Full notes: " +
				"docs/guides/tools/planning_read.md",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});

		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				collections: {
					type: "array",
					items: {
						type: "string",
						minLength: 1,
					},
					description:
						"Collections to return in full, e.g. ['modelIssues','modelQuestions']. " +
						"OMIT THIS ON THE FIRST CALL: with no collections the tool returns an index " +
						"(snapshot id, and a row count per collection) plus the list of writable " +
						"collections, which is how you find out what exists without pulling ~90KB of " +
						"document into context. Ask for collections by name once you know which you need.",
				},
			},
			additionalProperties: false,
		});
	});

	it("2. With no section, the index is returned; with a section, only that section rendered as render does", async () => {
		const port: PlanningPort = {
			read: async (collections) => {
				if (!collections || collections.length === 0) {
					return INDEX;
				}
				return {
					...INDEX,
					data: { modelIssues: [{ id: "i1", title: "Landing page" }] },
				};
			},
			edit: async () => {
				throw new Error("not used");
			},
		};
		const action = createPlanningReadAction(port);

		const ctx = { caller: "test" as const, requestId: "test-req-1" };
		const indexRes = await action.run({}, ctx);
		expect(indexRes.text).toContain(`snapshot:  ${INDEX.snapshotId}`);
		expect(indexRes.text).toContain(`collections:\n{\n  "roadmapItems": 112,\n  "modelIssues": 9\n}`);
		expect(action.formatMcp?.(indexRes)).toBe(indexRes.text);

		const sectionRes = await action.run({ collections: ["modelIssues"] }, ctx);
		expect(sectionRes.text).toContain(`snapshot:  ${INDEX.snapshotId}`);
		expect(sectionRes.text).toContain(`"modelIssues": [\n    {\n      "id": "i1",\n      "title": "Landing page"\n    }\n  ]`);
		expect(sectionRes.text).not.toContain("collections:\n");
	});

	it("3. Adapter: requests go to injected base URL with token as bearer header; non-2xx surfaces refusal text", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => INDEX,
			text: async () => JSON.stringify(INDEX),
		} as unknown as Response);

		const adapter = createPlanningAdapter({
			baseUrl: "http://localhost:3001/",
			getToken: async () => "hlp_test-token",
		});
		const action = createPlanningReadAction(adapter);
		const ctx = { caller: "test" as const, requestId: "test-req-1" };
		const res = await action.run({ collections: ["modelIssues", "modelQuestions"] }, ctx);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"http://localhost:3001/api/planning/document?collections=modelIssues%2CmodelQuestions",
		);
		expect(init.headers.Authorization).toBe("Bearer hlp_test-token");
		expect(res.snapshotId).toBe(INDEX.snapshotId);

		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () =>
				JSON.stringify({
					error: "Bad request",
					message:
						'Unknown collection "bogus". Legal collections: roadmapItems, modelIssues, modelDecisions, modelQuestions, risks.',
				}),
		} as unknown as Response);

		await expect(action.run({ collections: ["bogus"] }, ctx)).rejects.toThrow(
			/Legal collections: roadmapItems/,
		);
	});

	it("4. The adapter has no Supabase client and no .from( call", () => {
		const adapterSource = fs.readFileSync(
			path.resolve(__dirname, "../../adapters/planning/index.ts"),
			"utf8",
		);
		expect(adapterSource).not.toMatch(/\.from\(/);
		expect(adapterSource).not.toMatch(/createClient/);
	});

	it("5. Enriches empty-collections index reads with compact domain, goal, and projectParent slug registries under 8 KB (#1994)", async () => {
		const port: PlanningPort = {
			read: async (collections) => {
				if (!collections || collections.length === 0) {
					return INDEX;
				}
				expect(collections).toEqual(["modelDomains", "modelGoals", "roadmapItems"]);
				return {
					...INDEX,
					data: {
						modelDomains: [
							{ id: "product-engineering", name: "Product and Engineering" },
							{ id: "gtm", name: "GTM" },
							{ id: "marketing", name: "Marketing" },
						],
						modelGoals: [
							{ id: "serve", name: "Serve" },
							{ id: "monetization", name: "Real sign-ups become paying users" },
							{ id: "retention", name: "Users who stay" },
						],
						roadmapItems: [
							{
								id: "paywall-move-and-refactor",
								title: "Paywall refactor",
								detailLevel: "project",
							},
							{
								id: "hot-cold-memory",
								title: "Memory",
								detailLevel: "epic",
							},
							{
								id: "recreate-mobile-paywall",
								title: "Recreate mobile paywall",
								detailLevel: "task",
								parent: "paywall-move-and-refactor",
							},
						],
					},
				};
			},
			edit: async () => {
				throw new Error("not used");
			},
		};
		const action = createPlanningReadAction(port);
		const ctx = { caller: "test" as const, requestId: "test-req-5" };
		const res = await action.run({}, ctx);

		expect(res.domains).toEqual(["product-engineering", "gtm", "marketing"]);
		expect(res.goals).toEqual(["serve", "monetization", "retention"]);
		expect(res.projectParents).toEqual(["paywall-move-and-refactor", "hot-cold-memory"]);
		expect(res.projectParents).not.toContain("recreate-mobile-paywall");

		expect(res.text).toContain("domains:\nproduct-engineering, gtm, marketing");
		expect(res.text).toContain("goals:\nserve, monetization, retention");
		expect(res.text).toContain("projectParents:\npaywall-move-and-refactor, hot-cold-memory");
		expect(res.text).not.toContain("recreate-mobile-paywall");
		expect(Buffer.byteLength(res.text, "utf8")).toBeLessThan(8 * 1024);
	});
});
