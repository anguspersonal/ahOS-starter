import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../server.js";
import { createRequire } from "node:module";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");

export const GRANDFATHERED_TWINS: readonly string[] = [];

export function diffAgainstBaseline(
	current: Iterable<string>,
	baseline: Iterable<string>,
): { added: string[]; stale: string[] } {
	const currentSet = new Set(current);
	const baselineSet = new Set(baseline);
	const added = [...currentSet].filter((x) => !baselineSet.has(x)).sort();
	const stale = [...baselineSet].filter((x) => !currentSet.has(x)).sort();
	return { added, stale };
}

async function listAdvertisedTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-legacy-ratchet", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

function detectAliases(tools: { name: string; description?: string }[]): Set<string> {
	const toolMap = new Map(tools.map((t) => [t.name, t]));
	const aliases = new Set<string>();

	for (const tool of tools) {
		const desc = (tool.description ?? "").trim();
		// Format from server.ts:433: `${deprecationNotice(newName)} ${target.config.description ?? ""}`.trim()
		// where deprecationNotice(newName) is `Deprecated, use ${newName}.`
		const match = desc.match(/^Deprecated, use ([^.]+)\.\s*(.*)$/s);
		if (!match) continue;
		const targetName = match[1];
		const remainingDesc = match[2].trim();
		const targetTool = toolMap.get(targetName);
		if (!targetTool) continue;
		const targetDesc = (targetTool.description ?? "").trim();
		if (remainingDesc === targetDesc) {
			aliases.add(tool.name);
		}
	}

	return aliases;
}

function getActionToolIds(): Set<string> {
	if (manifest && manifest.actions) {
		return new Set(
			Object.entries(manifest.actions)
				.filter(([_, entry]: any) => entry.expose?.mcp === true)
				.map(([id]) => id),
		);
	}
	return new Set();
}


async function getLegacyTools(): Promise<string[]> {
	const advertised = await listAdvertisedTools();
	const aliases = detectAliases(advertised);
	const actionToolIds = await getActionToolIds();
	return advertised
		.map((t) => t.name)
		.filter((name) => !aliases.has(name) && !actionToolIds.has(name))
		.sort();
}

describe("legacy MCP tool surface ratchet (#1406)", () => {
	it("Case 1: legacy is non-empty while the baseline lists tools, and [] once the file is deleted", async () => {
		const legacy = await getLegacyTools();
		if (readLegacyBaseline().length > 0) {
			expect(legacy.length, "the baseline lists tools, so Cases 2 and 3 must not pass vacuously").toBeGreaterThan(0);
		} else {
			expect(legacy, "legacy-tools-baseline.txt is gone, so no legacy tool may remain (ADR-105)").toEqual([]);
		}
	});


	it("Case 2: legacy minus baseline is empty (no new legacy tools allowed)", async () => {
		const legacy = await getLegacyTools();
		const baseline = readLegacyBaseline();

		const { added } = diffAgainstBaseline(legacy, baseline);
		expect(
			added,
			`New legacy tool(s) detected: ${added.join(", ")}. Define it with defineAction and registerAction (ADR-100); adding a baseline line is an architect decision.`,
		).toEqual([]);
	});

	it("Case 3: baseline minus legacy is empty (delete lines when tools are migrated)", async () => {
		const legacy = await getLegacyTools();
		const baseline = readLegacyBaseline();

		const { stale } = diffAgainstBaseline(legacy, baseline);
		expect(
			stale,
			`Delete these lines from legacy-tools-baseline.txt, the tools have moved or gone: ${stale.join(", ")}`,
		).toEqual([]);
	});

	it("Case 4: twins = legacy ∩ ids of manifest http actions matches GRANDFATHERED_TWINS exactly", async () => {
		const legacy = await getLegacyTools();
		const httpActionIds = new Set(
			Object.entries(manifest.actions)
				.filter(([_, entry]: [string, any]) => entry.expose?.http === true)
				.map(([id]) => id),
		);
		const twins = legacy.filter((name) => httpActionIds.has(name)).sort();

		const expectedTwins = [...GRANDFATHERED_TWINS].sort();
		const unexpectedTwins = twins.filter((t) => !expectedTwins.includes(t as any));
		const staleTwins = expectedTwins.filter((t) => !twins.includes(t));

		expect(
			unexpectedTwins,
			`Unexpected twins between legacy tools and manifest http actions: ${unexpectedTwins.join(", ")}`,
		).toEqual([]);

		expect(
			staleTwins,
			`Grandfathered twins that are no longer twins: ${staleTwins.join(", ")}`,
		).toEqual([]);

		expect(twins).toEqual(expectedTwins);
	});

	it("Case 5: diffAgainstBaseline pure helper returns added and stale entries", () => {
		const current = ["alpha", "beta", "gamma"];
		const baseline = ["beta", "gamma", "delta"];
		const diff = diffAgainstBaseline(current, baseline);
		expect(diff).toEqual({
			added: ["alpha"],
			stale: ["delta"],
		});
	});
});
