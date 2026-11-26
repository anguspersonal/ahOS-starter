import { describe, expect, it } from "vitest";
import { DEFAULT_DOS_CONFIG, dosConfigSchema } from "../../domain/dosConfig.js";
import { getCanonicalInstructionsHash } from "./canonicalInstructions.js";
import { createInstructionsGetAction, formatInstructionsGetMcp } from "./instructionsGet.js";

const ctx = {
	caller: "mcp" as const,
	userId: "user-1",
	correlationId: "corr-1",
};

describe("createInstructionsGetAction (#1601)", () => {
	it("returns formatted canonical instructions with WARN drift report when never pasted", async () => {
		const action = createInstructionsGetAction({
			toolCatalog: () => [
				{ name: "knowledge_search", description: "Search the knowledge store." },
			],
			loadDosConfig: async () => DEFAULT_DOS_CONFIG,
			loadPastedInstructions: async () => null,
		});

		const output = await action.run({}, ctx);
		expect(output.freshness.status).toBe("warn");
		expect(output.pasted).toBeNull();
		expect(output.canonicalHash).toMatch(/^[a-f0-9]{64}$/);

		const text = formatInstructionsGetMcp(output);
		expect(text).toContain("# Canonical System Instructions (system-instructions, #1025)");
		expect(text).toContain("Sync key: system_instructions_sync");
		expect(text).toContain("Status: WARN");
		expect(text).toContain("custom instructions never recorded as pasted");
		expect(text).toContain("Fix: copy from capability_get({ name: 'system-instructions' })");
		expect(text).toContain("--- COPY BELOW THIS LINE INTO SYSTEM INSTRUCTIONS ---");
	});

	it("returns OK status when pasted hash matches canonicalHash", async () => {
		const tools = [{ name: "knowledge_search", description: "Search the knowledge store." }];
		const customConfig = dosConfigSchema.parse({
			tone: ["Tone directive #1"],
			system_instructions: "Custom DB canonical prose prefix.",
		});
		const expectedHash = getCanonicalInstructionsHash(tools, [], customConfig);

		const action = createInstructionsGetAction({
			toolCatalog: () => tools,
			loadDosConfig: async () => customConfig,
			loadPastedInstructions: async () => ({
				sha256: expectedHash,
				pasted_at: new Date().toISOString(),
			}),
		});

		const output = await action.run({}, ctx);
		expect(output.freshness.status).toBe("ok");
		const text = formatInstructionsGetMcp(output);
		expect(text).toContain("Status: OK");
		expect(text).toContain("Custom DB canonical prose prefix.");
		expect(text).toContain("- Tone directive #1");
	});
});
