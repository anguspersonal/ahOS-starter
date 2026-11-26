import { describe, it, expect, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	createServer,
	buildInstructions,
	CAPABILITY_REGISTRY_INSTRUCTIONS,
	HANDSHAKE_DIRECTIONS,
	HANDSHAKE_HOT_TIER_SHARE,
	HANDSHAKE_RULES_POINTER,
	MCP_HANDSHAKE_INSTRUCTION_BUDGET,
} from "./server.js";
import { attachDosConfigToToneRules, renderDosConfigSections } from "./dosConfig.js";
import { renderHotTier } from "./hotTier.js";
import { realisticDosConfig, realisticHotRows } from "./__tests__/handshakeRealisticFixture.js";
import { TOOL_ALIASES } from "./toolAliases.js";

// The capability-registry fallback (docs/guides/CAPABILITY_REGISTRY.md) is delivered
// to every surface via the MCP `instructions` handshake field. This is the one
// repo-versioned channel that reaches cowork/chat, so a regression here silently
// removes the fallback from those surfaces — assert the contract a real client sees.
describe("createServer — capability-registry instructions", () => {
	it("serves the fallback instructions to a client during the initialize handshake", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });

		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);

		const instructions = client.getInstructions();
		expect(instructions).toBeTruthy();
		expect(client.getServerVersion()?.name).toBe("ahOS");
		// Load-bearing content: how to fetch a missing capability's body, and how to
		// register a new one so it serves everywhere.
		expect(instructions).toContain("capability_get");
		expect(instructions).toContain("capability_register");
		expect(instructions).toContain("kms-db");
		expect(instructions).toContain("Registry-Native by default");
		expect(instructions).toContain('capability_get({ name: "writing-for-agents" })');
		expect(instructions).toContain('capability_get({ name: "which-skill" })');
		// Memory-mirroring rule: durable memories also get captured to the KMS.
		expect(instructions).toContain("capture");
		// Model-behaviour changes SOP (ADR-094, #595).
		expect(instructions).toContain("Model-behaviour changes (ADR-094)");
		expect(instructions).toContain("dos tone config");

		await client.close();
		await server.close();
	});

	// #819: the owner's tone rules ride the same handshake. createServer takes them as
	// a plain argument (the entry points load them from the DB via loadToneRules), so
	// these tests exercise the rendering contract without touching Supabase.
	async function handshakeInstructions(server: ReturnType<typeof createServer>) {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		const instructions = client.getInstructions();
		await client.close();
		await server.close();
		return instructions;
	}

	it("appends the owner's tone rules to the instructions when provided", async () => {
		const instructions = await handshakeInstructions(
			createServer(["NEVER use the em-dash", "Plain British English, no jargon"]),
		);
		expect(instructions).toContain("NEVER use the em-dash");
		expect(instructions).toContain("Plain British English, no jargon");
		// The rules must point back at their source of truth (ADR-030), not read as
		// repo-authored prose.
		expect(instructions).toContain("dos_config.tone");
		// And the capability-registry half must survive the append — it is load-bearing.
		expect(instructions).toContain("capability_get");
	});

	it("states the ahos/<name> prefix routing rule alongside the fallback", async () => {
		const instructions = await handshakeInstructions(createServer([]));
		// Both spellings, and the two halves that make it a routing instruction
		// rather than a hint: registry-over-local, and no guessing when absent.
		expect(instructions).toContain('"ahos/<name>" or "ahkms/<name>"');
		expect(instructions).toContain("forces the registry copy");
		expect(instructions).toContain("say so and stop");
	});

	it("directs off-repo surfaces to call capability_get({ name }) in one call without an include_body: false probe (#1995)", () => {
		const instructions = buildInstructions([]);
		expect(instructions).toContain('call capability_get({ name: "<name>" }) in one call');
		expect(instructions).toContain("include_body defaults to true");
		expect(instructions).toContain("do not probe with include_body: false first");
	});

	it("omits the writing-rules section entirely when no rules are configured", async () => {
		// Both the explicit empty list and the no-arg default (the degraded path when
		// loadToneRules cannot reach the DB) must yield the directions, the pointer and
		// the registry instructions (#2346): no dangling header, no empty bullet list.
		for (const server of [createServer([]), createServer()]) {
			const instructions = await handshakeInstructions(server);
			expect(instructions).not.toContain("writing rules");
			expect(instructions).not.toContain("dos_config.tone");
			expect(instructions).toContain("capability_get");
		}
	});

	it("caps tone rules to at most 20 in the handshake and warns on truncation (#648, #823)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const rules = Array.from({ length: 22 }, (_, i) => `Tone rule number ${i + 1}`);
			const instructions = await handshakeInstructions(createServer(rules));

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("tone rules count (22) exceeds cap of 20; truncating (#648)"),
			);
			// First 20 rules must be present
			for (let i = 1; i <= 20; i++) {
				expect(instructions).toContain(`Tone rule number ${i}`);
			}
			// 21st and 22nd rules must NOT be present
			expect(instructions).not.toContain("Tone rule number 21");
			expect(instructions).not.toContain("Tone rule number 22");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("places the hot tier before the tone rules, and both before the capability registry instructions (#1226, #2346)", async () => {
		const hotRow = {
			id: "11111111-1111-1111-1111-111111111111",
			entity_type: "person",
			title: "Todd",
			description: "Partner",
			properties: null,
			aliases: ["todd"],
		};
		const instructions = await handshakeInstructions(
			createServer(["NEVER use the em-dash"], [hotRow]),
		);

		expect(instructions).toBeDefined();
		const toneIndex = instructions!.indexOf("Owner's writing rules");
		const hotIndex = instructions!.indexOf("Todd");
		// HANDSHAKE_DIRECTIONS names capability_get, so anchor on the registry prose.
		const registryIndex = instructions!.indexOf("ahkms is your capability registry");

		expect(hotIndex).toBeGreaterThanOrEqual(0);
		expect(toneIndex).toBeGreaterThan(hotIndex);
		expect(registryIndex).toBeGreaterThan(toneIndex);
	});

	it("contains no retired tool name from TOOL_ALIASES", () => {
		const text = buildInstructions([]);
		const retiredNames = Object.keys(TOOL_ALIASES).filter((name) => name.includes("_"));
		const found = retiredNames.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
		expect(found).toEqual([]);
	});
});

// #2346 (owner decision, 21 Nov 2026): Claude Code delivers about the first
// MCP_HANDSHAKE_INSTRUCTION_BUDGET characters, so the directions, a pointer to the tone
// rules and the hot tier start inside them, and everything else follows, whole. Built
// from a fixture at real sizes: the test this replaces passed on 20 short rules.
describe("buildInstructions: delivered order (#2346)", () => {
	const SEP = "\n\n";
	const dosSections = renderDosConfigSections(realisticDosConfig);
	const tier = renderHotTier(realisticHotRows);
	const rowLines = tier.text
		.split("\n")
		.filter((line) => line.startsWith("| ") && !line.startsWith("| Name |") && !line.startsWith("| --- |"));
	const build = (rows = realisticHotRows, config = realisticDosConfig) =>
		buildInstructions(attachDosConfigToToneRules(config.tone, config), rows);
	const text = build();

	it("uses a fixture at real sizes", () => {
		expect(realisticDosConfig.tone.length).toBeGreaterThanOrEqual(25);
		expect(realisticDosConfig.operating_principles.length).toBeGreaterThanOrEqual(8);
		expect(dosSections).toHaveLength(5);
		expect(Object.keys(realisticDosConfig.by_domain ?? {})).toHaveLength(2);
		expect(dosSections.slice(0, 2).join(SEP).length).toBeGreaterThanOrEqual(2600);
		expect(dosSections.join(SEP).length).toBeGreaterThanOrEqual(6000);
		expect(realisticDosConfig.handshake_instructions).toBeNull();

		expect(realisticHotRows).toHaveLength(30);
		expect(realisticHotRows.filter((row) => row.entity_type === "people")).toHaveLength(15);
		expect(rowLines).toHaveLength(30);
		for (const line of rowLines) {
			expect(line.length).toBeGreaterThanOrEqual(60);
			expect(line.length).toBeLessThanOrEqual(110);
		}
		expect(tier.text.length).toBeGreaterThanOrEqual(2300);
		expect(tier.omitted).toBe(0);
	});

	it("orders directions, pointer, hot tier, dos_config sections, then the registry prose", () => {
		const offsets = [
			HANDSHAKE_DIRECTIONS,
			HANDSHAKE_RULES_POINTER,
			"Hot tier (source of truth",
			"Owner's writing rules",
			"Operating principles (source of truth",
			"Atom types (source of truth",
			"Audiences (source of truth",
			"Domains (source of truth",
			"ahkms is your capability registry",
		].map((anchor) => text.indexOf(anchor));
		expect(offsets[0]).toBe(0);
		for (let i = 1; i < offsets.length; i++) {
			expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
		}
	});

	it("starts all three leading parts inside the delivered budget, with at least 7 whole tier rows", () => {
		const head = text.slice(0, MCP_HANDSHAKE_INSTRUCTION_BUDGET);
		expect(head).toContain(HANDSHAKE_DIRECTIONS);
		expect(head).toContain(HANDSHAKE_RULES_POINTER);
		const tierStart = text.indexOf("Hot tier (source of truth");
		expect(tierStart).toBeGreaterThan(0);
		expect(tierStart).toBeLessThanOrEqual(MCP_HANDSHAKE_INSTRUCTION_BUDGET - HANDSHAKE_HOT_TIER_SHARE);
		const delivered = rowLines.filter((line) => head.includes(`${line}\n`));
		expect(delivered.length).toBeGreaterThanOrEqual(7);
	});

	it("keeps the split for the constants alone", () => {
		expect(HANDSHAKE_DIRECTIONS.length).toBeLessThanOrEqual(600);
		expect(HANDSHAKE_RULES_POINTER.length).toBeLessThanOrEqual(250);
		const bare = buildInstructions([], []);
		const lastSection = bare.indexOf(CAPABILITY_REGISTRY_INSTRUCTIONS);
		expect(lastSection).toBeGreaterThan(0);
		expect(lastSection).toBeLessThanOrEqual(MCP_HANDSHAKE_INSTRUCTION_BUDGET - HANDSHAKE_HOT_TIER_SHARE);
	});

	it("loses nothing for a client that reads the whole string", () => {
		expect(text).toBe(
			[HANDSHAKE_DIRECTIONS, HANDSHAKE_RULES_POINTER, tier.text, ...dosSections, CAPABILITY_REGISTRY_INSTRUCTIONS].join(SEP),
		);
		for (const rule of realisticDosConfig.tone) expect(text).toContain(`- ${rule}`);
		for (const principle of realisticDosConfig.operating_principles) expect(text).toContain(`- ${principle}`);
		for (const line of rowLines) expect(text).toContain(line);

		const custom = "Made-up stored handshake instructions for the fixture.";
		const withCustom = build(realisticHotRows, { ...realisticDosConfig, handshake_instructions: custom });
		expect(withCustom).toBe(
			[HANDSHAKE_DIRECTIONS, HANDSHAKE_RULES_POINTER, tier.text, ...dosSections, custom].join(SEP),
		);
		expect(withCustom).not.toContain(CAPABILITY_REGISTRY_INSTRUCTIONS);
	});

	it("puts the tone rules directly after the pointer when nothing is hot", () => {
		const noHot = build([]);
		expect(noHot).not.toContain("Hot tier");
		expect(noHot.startsWith(`${HANDSHAKE_DIRECTIONS}${SEP}${HANDSHAKE_RULES_POINTER}${SEP}Owner's writing rules`)).toBe(true);
	});
});
