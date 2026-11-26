import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/index.js";
import * as canonicalInstructions from "../canonicalInstructions.js";
import * as dosConfigModule from "../dosConfig.js";
import {
	buildInstructions,
	CAPABILITY_REGISTRY_INSTRUCTIONS,
	MCP_HANDSHAKE_INSTRUCTION_BUDGET,
} from "../server.js";

function getInstructionsHandler(args: Record<string, never>) {
	const registry = buildRegistry({
		instructions: {
			loadDosConfig: () => dosConfigModule.loadDosConfig(),
			loadPastedInstructions: () => canonicalInstructions.loadPastedInstructions(),
			toolCatalog: () => canonicalInstructions.getDefaultToolCatalog(),
		},
	});
	const tool = toMcpTool(registry.get("instructions_get")!);
	return tool.handler(args, {} as any);
}

describe("instructions_get tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns formatted canonical instructions with drift report", async () => {
		vi.spyOn(dosConfigModule, "loadDosConfig").mockResolvedValue(dosConfigModule.DEFAULT_DOS_CONFIG);
		vi.spyOn(canonicalInstructions, "loadPastedInstructions").mockResolvedValue(null);

		const res = await getInstructionsHandler({});
		const text = res.content[0].text;

		expect(text).toContain("# Canonical System Instructions (system-instructions, #1025)");
		expect(text).toContain("Sync key: system_instructions_sync");
		expect(text).toContain("Status: WARN");
		expect(text).toContain("custom instructions never recorded as pasted");
		expect(text).toContain("Fix: copy from capability_get({ name: 'system-instructions' })");
		expect(text).toContain("--- COPY BELOW THIS LINE INTO SYSTEM INSTRUCTIONS ---");
		expect(text).toContain("If you do not know a command, skill, or agent the user invokes, check ahOS for capabilities");
		expect(text).toContain("Priority scale (ADR-116): ahOS uses a universal 7-point priority scale where 1 is lowest and 7 is highest");
	});

	it("renders full dos_config sections and vendor-neutral system instructions", async () => {
		const twentyFiveToneRules = Array.from({ length: 25 }, (_, i) => `Tone directive #${i + 1}`);
		const fullDosConfig = dosConfigModule.dosConfigSchema.parse({
			tone: twentyFiveToneRules,
			operating_principles: [
				"Single source of truth in user_preferences.dos_config",
				"Every surface receives identical operating context",
			],
			handshake_instructions:
				"Custom DB handshake instructions: check ahOS capabilities first via capability_get.",
			system_instructions:
				"Custom DB canonical prose prefix: ahOS is the vendor-neutral operating system.",
			types: [
				{ key: "Note", description: "Passive observation" },
				{ key: "Decision", description: "Binding choice" },
			],
			audiences: [{ key: "Investors", register: "direct, metric-driven" }],
			by_domain: {
				work: {
					topics: ["Apple", "Round"],
					pillars: [
						{
							key: "Pillar 1",
							label: "Launch",
							description: "Ship the app",
							notion_option: "P1 Launch",
						},
					],
					artefact_registers: [{ key: "Bri", tone: "co-founder, signal not status" }],
					domain_signals: ["Work", "Briana"],
					waiting_on_status: "Waiting on",
				},
				angus: {
					topics: ["Health"],
					domain_signals: ["private health", "family"],
				},
			},
		});

		// 1. Verify MCP initialize handshake (buildInstructions in server.ts)
		expect(MCP_HANDSHAKE_INSTRUCTION_BUDGET).toBe(2000);
		const toneWithConfig = dosConfigModule.attachDosConfigToToneRules(
			fullDosConfig.tone,
			fullDosConfig,
		);
		const handshake = buildInstructions(toneWithConfig, []);

		// All 25 tone rules render without the 20-rule truncation cap
		expect(handshake).toContain("- Tone directive #1");
		expect(handshake).toContain("- Tone directive #21");
		expect(handshake).toContain("- Tone directive #25");
		// All dos_config sections render in handshake
		expect(handshake).toContain(
			"Operating principles (source of truth: user_preferences.dos_config.operating_principles):",
		);
		expect(handshake).toContain("- Single source of truth in user_preferences.dos_config");
		expect(handshake).toContain("Atom types (source of truth: user_preferences.dos_config.types):");
		expect(handshake).toContain("- Decision: Binding choice");
		expect(handshake).toContain("Audiences (source of truth: user_preferences.dos_config.audiences):");
		expect(handshake).toContain("- Investors: direct, metric-driven");
		expect(handshake).toContain("Domains (source of truth: user_preferences.dos_config.by_domain):");
		expect(handshake).toContain(
			"- work: topics: Apple, Round | pillars: Pillar 1 Launch [P1 Launch] | registers: Bri (co-founder, signal not status) | signals: Work, Briana | waiting_on_status: Waiting on",
		);
		expect(handshake).toContain("- angus: topics: Health | signals: private health, family");
		// DB-backed handshake_instructions override code fallback
		expect(handshake).toContain(
			"Custom DB handshake instructions: check ahOS capabilities first via capability_get.",
		);
		expect(handshake).not.toContain(CAPABILITY_REGISTRY_INSTRUCTIONS);

		// Code fallback when handshake_instructions is absent
		const fallbackConfig = dosConfigModule.dosConfigSchema.parse({
			tone: ["Fallback tone rule"],
		});
		const fallbackHandshake = buildInstructions(fallbackConfig, []);
		expect(fallbackHandshake).toContain("- Fallback tone rule");
		expect(fallbackHandshake).toContain(CAPABILITY_REGISTRY_INSTRUCTIONS);

		// 2. Verify instructions_get and canonicalInstructions rendering
		vi.spyOn(dosConfigModule, "loadDosConfig").mockResolvedValue(fullDosConfig);
		const expectedHash = canonicalInstructions.getCanonicalInstructionsHash(
			canonicalInstructions.getDefaultToolCatalog(),
			[],
			fullDosConfig,
		);
		vi.spyOn(canonicalInstructions, "loadPastedInstructions").mockResolvedValue({
			sha256: expectedHash,
			pasted_at: new Date().toISOString(),
		});

		const res = await getInstructionsHandler({});
		const text = res.content[0].text;

		expect(text).toContain("# Canonical System Instructions (system-instructions, #1025)");
		expect(text).toContain("Sync key: system_instructions_sync");
		expect(text).toContain("Status: OK");
		expect(text).toContain("--- COPY BELOW THIS LINE INTO SYSTEM INSTRUCTIONS ---");
		expect(text).toContain(
			"Custom DB canonical prose prefix: ahOS is the vendor-neutral operating system.",
		);
		expect(text).toContain("- Tone directive #1");
		expect(text).toContain("- Tone directive #25");
		expect(text).toContain("- Single source of truth in user_preferences.dos_config");
		expect(text).toContain("- Decision: Binding choice");
		expect(text).toContain("- Investors: direct, metric-driven");
		expect(text).toContain("Domains (source of truth: user_preferences.dos_config.by_domain):");
		expect(text).toContain(
			"- work: topics: Apple, Round | pillars: Pillar 1 Launch [P1 Launch] | registers: Bri (co-founder, signal not status) | signals: Work, Briana | waiting_on_status: Waiting on",
		);
		expect(text).toContain(
			"Handshake instructions (source of truth: user_preferences.dos_config.handshake_instructions):",
		);
		expect(text).toContain(
			"Custom DB handshake instructions: check ahOS capabilities first via capability_get.",
		);
		expect(text).not.toContain("\u2014");
	});

	it("supports backward-compatible read fallback for claude-instructions and claude_instructions_sync", async () => {
		const legacyConfig = dosConfigModule.dosConfigSchema.parse({
			"claude-instructions": "Legacy claude-instructions prefix from DB.",
			claude_instructions_sync: {
				sha256: "f".repeat(64),
				pasted_at: "2026-10-01T00:00:00Z",
			},
		});

		vi.spyOn(dosConfigModule, "loadDosConfig").mockResolvedValue(legacyConfig);
		vi.spyOn(canonicalInstructions, "loadPastedInstructions").mockResolvedValue(null);

		const res = await getInstructionsHandler({});
		const text = res.content[0].text;

		expect(text).toContain("Legacy claude-instructions prefix from DB.");
		expect(text).toContain(`Pasted sha256: ${"f".repeat(64)}`);
		expect(text).toContain("Pasted at: 2026-10-01T00:00:00Z");
	});
});
