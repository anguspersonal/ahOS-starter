import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { INGEST_SLACK_DESCRIPTION } from "@ahkms/core";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { getCredential } from "../../credentials.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("ingest_slack migration (#1535)", () => {
	it("serves ingest_slack from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.ingest_slack?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("ingest_slack")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("ingest_slack");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "ingest_slack")!;
		expect(tool?.description).toBe(INGEST_SLACK_DESCRIPTION);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; description?: string; minimum?: number; maximum?: number }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"channel",
			"dry_run",
			"include_dms",
			"max_results",
			"since",
			"until",
		]);
		expect(props.max_results).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 100,
		});
	});

	it("reads SLACK_TOKEN_USER_OAUTH and rejects SLACK_TOKEN_BOT_OAUTH", async () => {
		delete process.env.SLACK_TOKEN_USER_OAUTH;
		vi.stubEnv("SLACK_TOKEN_BOT_OAUTH", "test-slack-b-token");

		await expect(getCredential("slack")).rejects.toThrow(
			/SLACK_TOKEN_USER_OAUTH is not set/,
		);
		await expect(getCredential("slack")).rejects.not.toThrow(/legacy/);

		vi.stubEnv("SLACK_TOKEN_USER_OAUTH", "test-slack-p-token");
		await expect(getCredential("slack")).resolves.toBe("test-slack-p-token");
	});
});
