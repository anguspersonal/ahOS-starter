import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { INGEST_GITHUB_DESCRIPTION } from "@ahkms/core";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { getCredential, getGithubCredential } from "../../credentials.js";
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

describe("ingest_github migration (#1531)", () => {
	it("serves ingest_github from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.ingest_github?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("ingest_github")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("ingest_github");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "ingest_github")!;
		expect(tool?.description).toBe(INGEST_GITHUB_DESCRIPTION);
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
			"dry_run",
			"max_results",
			"repo",
			"since",
			"until",
		]);
		expect(props.max_results).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 100,
		});
	});

	it("reads GITHUB_PERSONAL_ACCESS_TOKEN (with fallback to GITHUB_TOKEN_INGEST), ignores GITHUB_TOKEN, and routes example-org/* to GITHUB_WORK_ACCESS_TOKEN", async () => {
		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		delete process.env.GITHUB_TOKEN_INGEST;
		vi.stubEnv("GITHUB_TOKEN", "ghp_wrong_var");
		await expect(getCredential("github")).rejects.toThrow("GITHUB_PERSONAL_ACCESS_TOKEN");

		vi.stubEnv("GITHUB_TOKEN_INGEST", "ghp_legacy_ingest");
		await expect(getCredential("github")).resolves.toBe("ghp_legacy_ingest");

		vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_personal");
		vi.stubEnv("GITHUB_WORK_ACCESS_TOKEN", "ghp_work_org");
		await expect(getGithubCredential("github", "example-org/work")).resolves.toBe(
			"ghp_work_org",
		);
		await expect(getGithubCredential("github", "anguspersonal/ahOS")).resolves.toBe(
			"ghp_personal",
		);
		await expect(getGithubCredential("github")).resolves.toBe("ghp_personal");
	});
});
