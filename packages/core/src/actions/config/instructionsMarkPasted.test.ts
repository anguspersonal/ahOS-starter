import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DOS_CONFIG, dosConfigSchema } from "../../domain/dosConfig.js";
import { getCanonicalInstructionsHash } from "./canonicalInstructions.js";
import {
	createInstructionsMarkPastedAction,
	formatInstructionsMarkPastedMcp,
} from "./instructionsMarkPasted.js";

const ctx = {
	caller: "mcp" as const,
	userId: "user-1",
	correlationId: "corr-1",
};

describe("createInstructionsMarkPastedAction (#1601)", () => {
	it("records pasted instructions with vendor-neutral naming and reports status", async () => {
		const tools = [{ name: "knowledge_search", description: "Search the knowledge store." }];
		const saveSpy = vi.fn(async () => {});
		const canonical = getCanonicalInstructionsHash(tools, [], DEFAULT_DOS_CONFIG);

		const action = createInstructionsMarkPastedAction({
			toolCatalog: () => tools,
			loadDosConfig: async () => DEFAULT_DOS_CONFIG,
			savePastedInstructions: saveSpy,
		});

		const output = await action.run({}, ctx);
		expect(saveSpy).toHaveBeenCalledTimes(1);
		expect(saveSpy).toHaveBeenCalledWith(canonical, expect.any(String));
		expect(output.isMatch).toBe(true);

		const text = formatInstructionsMarkPastedMcp(output);
		expect(text).toContain("system-instructions");
		expect(text).toContain("system_instructions_sync");
		expect(text).toContain("in sync with canonical instructions");

		const mismatchedOutput = await action.run(
			{
				sha256: "0".repeat(64),
				pasted_at: "2026-09-20T00:00:00Z",
			},
			ctx,
		);
		expect(mismatchedOutput.isMatch).toBe(false);
		const mismatchedText = formatInstructionsMarkPastedMcp(mismatchedOutput);
		expect(mismatchedText).toContain("DRIFT WARNING");
	});

	it("computes canonical hash using DB-backed dos_config sections and overrides", async () => {
		const tools = [{ name: "knowledge_search", description: "Search the knowledge store." }];
		const customConfig = dosConfigSchema.parse({
			tone: ["Use plain language"],
			operating_principles: ["Always verify"],
			system_instructions: "Custom DB system instructions prefix.",
		});
		const saveSpy = vi.fn(async () => {});
		const expectedHash = getCanonicalInstructionsHash(tools, [], customConfig);

		const action = createInstructionsMarkPastedAction({
			toolCatalog: () => tools,
			loadDosConfig: async () => customConfig,
			savePastedInstructions: saveSpy,
		});

		const output = await action.run({}, ctx);
		expect(saveSpy).toHaveBeenCalledWith(expectedHash, expect.any(String));
		const text = formatInstructionsMarkPastedMcp(output);
		expect(text).toContain(`canonical_sha256: ${expectedHash}`);
		expect(text).toContain("in sync with canonical instructions");
	});
});
