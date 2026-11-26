import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/index.js";
import * as canonicalInstructions from "../canonicalInstructions.js";
import * as dosConfigModule from "../dosConfig.js";

function markInstructionsPastedHandler(args: { sha256?: string; pasted_at?: string }) {
	const registry = buildRegistry({
		instructions: {
			loadDosConfig: () => dosConfigModule.loadDosConfig(),
			savePastedInstructions: (sha256, pastedAt) =>
				canonicalInstructions.savePastedInstructions(sha256, pastedAt),
			toolCatalog: () => canonicalInstructions.getDefaultToolCatalog(),
		},
	});
	const tool = toMcpTool(registry.get("instructions_mark_pasted")!);
	return tool.handler(args, {} as any);
}

describe("instructions_mark_pasted tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records pasted instructions with vendor-neutral naming and reports status", async () => {
		vi.spyOn(dosConfigModule, "loadDosConfig").mockResolvedValue(dosConfigModule.DEFAULT_DOS_CONFIG);
		const saveSpy = vi.spyOn(canonicalInstructions, "savePastedInstructions").mockResolvedValue();
		const canonical = canonicalInstructions.getCanonicalInstructionsHash(
			undefined,
			[],
			dosConfigModule.DEFAULT_DOS_CONFIG,
		);

		// When called with no args, defaults to canonical hash and now
		const res = await markInstructionsPastedHandler({});
		expect(saveSpy).toHaveBeenCalledTimes(1);
		const [savedHash, savedAt] = saveSpy.mock.calls[0];
		expect(savedHash).toBe(canonical);
		expect(typeof savedAt).toBe("string");
		expect(res.content[0].text).toContain("system-instructions");
		expect(res.content[0].text).toContain("system_instructions_sync");
		expect(res.content[0].text).toContain("in sync with canonical instructions");

		// When called with mismatched hash, reports drift warning
		const resMismatched = await markInstructionsPastedHandler({
			sha256: "0".repeat(64),
			pasted_at: "2026-09-20T00:00:00Z",
		});
		expect(resMismatched.content[0].text).toContain("DRIFT WARNING");
	});

	it("computes canonical hash using DB-backed dos_config sections and overrides", async () => {
		const customConfig = dosConfigModule.dosConfigSchema.parse({
			tone: ["Use plain language"],
			operating_principles: ["Always verify"],
			system_instructions: "Custom DB system instructions prefix.",
		});
		vi.spyOn(dosConfigModule, "loadDosConfig").mockResolvedValue(customConfig);
		const saveSpy = vi.spyOn(canonicalInstructions, "savePastedInstructions").mockResolvedValue();

		const expectedHash = canonicalInstructions.getCanonicalInstructionsHash(
			undefined,
			[],
			customConfig,
		);
		const res = await markInstructionsPastedHandler({});

		expect(saveSpy).toHaveBeenCalledWith(expectedHash, expect.any(String));
		expect(res.content[0].text).toContain(`canonical_sha256: ${expectedHash}`);
		expect(res.content[0].text).toContain("in sync with canonical instructions");
	});

	it("extractSystemInstructionsSync reads system_instructions_sync and falls back to claude_instructions_sync", () => {
		const primary = { sha256: "1".repeat(64), pasted_at: "2026-10-30T10:00:00Z" };
		const legacy = { sha256: "2".repeat(64), pasted_at: "2026-10-29T10:00:00Z" };

		expect(
			canonicalInstructions.extractSystemInstructionsSync({
				system_instructions_sync: primary,
				claude_instructions_sync: legacy,
			}),
		).toEqual(primary);

		expect(
			canonicalInstructions.extractSystemInstructionsSync({
				claude_instructions_sync: legacy,
			}),
		).toEqual(legacy);
	});
});
