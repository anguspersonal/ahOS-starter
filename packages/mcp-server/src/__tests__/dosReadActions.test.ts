import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverAdapters } from "../actions/serverRegistry.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");

async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

describe("dosReadActions (#1606)", () => {
	it("1. Contract parity: dos_daily_log_queue and dos_synthesis_coverage preserve schema, required list, and annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);

		const queueTool = tools.find((t) => t.name === "dos_daily_log_queue");
		expect(queueTool).toBeDefined();
		expect(queueTool!.description).toContain("docs/guides/tools/dos_daily_log_queue.md");
		const queueProps = queueTool!.inputSchema.properties as Record<string, Record<string, unknown>>;
		expect(Object.keys(queueProps)).toEqual(["domain", "include_consumed"]);
		expect(queueProps.domain?.enum).toEqual(["work", "angus"]);
		expect(queueProps.include_consumed?.type).toBe("boolean");
		expect(queueTool!.inputSchema.required ?? []).toEqual([]);
		expect(queueTool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const covTool = tools.find((t) => t.name === "dos_synthesis_coverage");
		expect(covTool).toBeDefined();
		expect(covTool!.description).toContain("docs/guides/tools/dos_synthesis_coverage.md");
		const covProps = covTool!.inputSchema.properties as Record<string, Record<string, unknown>>;
		expect(Object.keys(covProps)).toEqual(["from", "to", "domain"]);
		expect(covProps.from?.type).toBe("string");
		expect(covProps.to?.type).toBe("string");
		expect(covProps.domain?.enum).toEqual(["work", "angus"]);
		expect(covTool!.inputSchema.required).toEqual(["from", "to"]);
		expect(covTool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Exposure: dos_daily_log_queue and dos_synthesis_coverage are in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		for (const id of ["dos_daily_log_queue", "dos_synthesis_coverage"] as const) {
			expect(manifest.actions[id]?.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});

	it("3. Registration path: both ids are in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		const ids = registry.list().map((a) => a.id);
		expect(ids).toContain("dos_daily_log_queue");
		expect(ids).toContain("dos_synthesis_coverage");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("dos_daily_log_queue");
		expect(baseline).not.toContain("dos_synthesis_coverage");
	});

	it("4. A window wider than MAX_COVERAGE_DAYS (92) is refused with the legacy message", async () => {
		const res = await withMcpClient((c) =>
			c.callTool({
				name: "dos_synthesis_coverage",
				arguments: { from: "2026-01-01", to: "2026-12-31" },
			}),
		);
		expect(res.isError).toBe(true);
		const text = ((res.content as Array<{ text?: string }>)[0]?.text ?? "");
		expect(text).toContain(
			"dos_synthesis_coverage: window is 365 days; the maximum is 92. Narrow the range.",
		);
	});
});
