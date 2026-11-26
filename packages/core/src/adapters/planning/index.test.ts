import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanningAdapter } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

describe("createPlanningAdapter", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends requests to the injected base URL with the token as a bearer header", async () => {
		fetchMock.mockResolvedValue(OK(INDEX));
		const adapter = createPlanningAdapter({
			baseUrl: "http://localhost:3001/",
			getToken: async () => "hlp_test-token",
		});

		const res = await adapter.read(["modelIssues", "modelQuestions"]);
		expect(res.snapshotId).toBe(INDEX.snapshotId);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"http://localhost:3001/api/planning/document?collections=modelIssues%2CmodelQuestions",
		);
		expect(init.headers.Authorization).toBe("Bearer hlp_test-token");
	});

	it("surfaces the API refusal text on a non-2xx answer", async () => {
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
		const adapter = createPlanningAdapter({
			baseUrl: "https://planning.example.com",
			getToken: () => "hlp_test-token",
		});

		await expect(
			adapter.edit({
				ops: [{ collection: "modelGoals", op: "upsert", value: { id: "g" } }],
			}),
		).rejects.toThrow(/not a writable collection/);
	});

	it("has no Supabase client and no .from( call", () => {
		const source = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");
		expect(source).not.toMatch(/\.from\(/);
		expect(source).not.toMatch(/createClient/);
	});
});
