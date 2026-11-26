import { describe, expect, it, vi } from "vitest";
import {
	createEntitySynthesizeAction,
	formatSynthesizeResult,
	type EntitySynthesizePorts,
} from "@ahkms/core/actions";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverAdapters } from "../actions/serverRegistry.js";

const { mockCreateSynthesizePorts } = vi.hoisted(() => ({
	mockCreateSynthesizePorts: vi.fn(),
}));

vi.mock("@ahkms/core/adapters", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/core/adapters")>();
	return {
		...actual,
		createSynthesizePorts: mockCreateSynthesizePorts,
	};
});

vi.mock("../credentials.js", () => ({
	hasCredential: vi.fn(async (provider: string) => provider === "gemini"),
	getCredential: vi.fn(async (provider: string) => (provider === "gemini" ? "seam-gemini" : undefined)),
}));

vi.mock("../identity.js", () => ({
	getCurrentUserId: () => "test-user-uuid",
}));

const validEntityId = "11111111-1111-4111-8111-111111111111";

describe("synthesizeEntity MCP tool", () => {
	it("formats output text with quoted LLM strings and no markdown interpolation", () => {
		const formatted = formatSynthesizeResult({
			status: "completed",
			entity_id: validEntityId,
			dry_run: false,
			artifacts_used: ["art-1"],
			provider: "gemini",
			model: "gemini-2.5-flash",
			profile: {
				summary: "A markdown payload: **bold** and [link](http://example.com) and <script>",
				key_facts: ["Fact with *italics*"],
				timeline: [{ date: "2024", event: "Event with # header" }],
			},
		});

		expect(formatted).toContain("Entity Synthesis Result:");
		expect(formatted).toContain("Status: completed");
		expect(formatted).toContain(
			JSON.stringify("A markdown payload: **bold** and [link](http://example.com) and <script>"),
		);
		expect(formatted).toContain(JSON.stringify("Fact with *italics*"));
		expect(formatted).toContain(JSON.stringify("Event with # header"));
	});

	it("executes action through toMcpTool with injected ports and returns MCP text content", async () => {
		const fakePorts: EntitySynthesizePorts = {
			fetchEntity: async () => ({
				id: validEntityId,
				title: "Marie Curie",
				entity_type: "people",
				description: null,
				properties: null,
				updated_at: "2026-10-01T00:00:00Z",
			}),
			fetchLinkedArtifacts: async () => [
				{
					id: "art-1",
					title: "Nobel Prize Paper",
					plain_text: "Marie Curie conducted pioneering research on radioactivity.",
				},
			],
			generate: async () => ({
				text: JSON.stringify({
					summary: "Marie Curie was a physicist and chemist who pioneered research on radioactivity.",
					key_facts: ["Won two Nobel Prizes"],
					timeline: [{ date: "1903", event: "Won first Nobel Prize" }],
				}),
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
			updateEntityProfile: async () => true,
			recordDecision: async () => {},
		};

		const mcpTool = toMcpTool(createEntitySynthesizeAction(fakePorts));
		const result = await mcpTool.handler({
			entity_id: validEntityId,
			dry_run: true,
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("Status: completed");
		expect(result.content[0].text).toContain("Dry Run: true");
		expect(result.content[0].text).toContain("Marie Curie was a physicist");
	});
});

describe("synthesizeEntity: gemini key via the credential seam", () => {
	it("resolves geminiApiKey from getCredential instead of process.env through serverAdapters()", async () => {
		let capturedResolver: (() => Promise<any>) | undefined;
		mockCreateSynthesizePorts.mockImplementation((_client: unknown, llm: () => Promise<any>) => {
			capturedResolver = llm;
			return {};
		});

		const savedKey = process.env.GEMINI_API_KEY;
		delete process.env.GEMINI_API_KEY;

		try {
			serverAdapters();
			expect(capturedResolver).toBeTypeOf("function");
			const resolved = await capturedResolver!();
			expect(resolved).toMatchObject({
				geminiApiKey: "seam-gemini",
			});
		} finally {
			if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
			else delete process.env.GEMINI_API_KEY;
		}
	});
});


