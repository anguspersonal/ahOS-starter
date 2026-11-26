import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverAdapters } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");
const origFrom = supabase.from;

const ART_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
	(supabase as any).from = origFrom;
});

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

describe("artifactWriteActions (#1529)", () => {
	it("1. Contract parity: artifact_update and artifact_delete match dev inputSchema, description, and annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);

		const updateTool = tools.find((t) => t.name === "artifact_update");
		expect(updateTool, "artifact_update should be listed").toBeDefined();
		const updateProps = (updateTool!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(updateProps)).toEqual(["id", "patch"]);
		expect(updateTool!.inputSchema.required ?? []).toEqual(["id", "patch"]);
		expect(updateProps.id?.type).toBe("string");
		expect(updateProps.id?.format).toBe("uuid");
		expect(updateProps.patch?.type).toBe("object");
		expect(updateTool!.description).toBe(
			"Update one artifact row by id, including routing audit fields and Drive provenance columns. " +
				"Also the restore path for a soft-deleted artifact: pass archived: false to un-archive it (clears archived_at/archived_reason).",
		);
		expect(updateTool!.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const deleteTool = tools.find((t) => t.name === "artifact_delete");
		expect(deleteTool, "artifact_delete should be listed").toBeDefined();
		const deleteProps = (deleteTool!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(deleteProps)).toEqual(["ids", "archive_only", "archived_reason"]);
		expect(deleteTool!.inputSchema.required ?? []).toEqual(["ids"]);
		expect(deleteProps.ids?.type).toBe("array");
		expect(deleteProps.archive_only?.type).toBe("boolean");
		expect(deleteProps.archived_reason?.anyOf).toBeDefined();
		expect(deleteTool!.description).toContain("docs/guides/tools/artifact_delete.md");
		expect(deleteTool!.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it("2. Exposure: artifact_update and artifact_delete are in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		for (const id of ["artifact_update", "artifact_delete"] as const) {
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
		expect(ids).toContain("artifact_update");
		expect(ids).toContain("artifact_delete");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("artifact_update");
		expect(baseline).not.toContain("artifact_delete");
	});

	it("4. artifact_delete without archive_only archives and returns Archived N artifact(s): [id] title.", async () => {
		let updatedPayload: Record<string, unknown> | undefined;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifacts") {
				return {
					update: (payload: Record<string, unknown>) => {
						updatedPayload = payload;
						return {
							eq: () => ({
								in: () => ({
									select: () =>
										Promise.resolve({
											data: [{ id: ART_ID, title: "Archived Note" }],
											error: null,
										}),
								}),
							}),
						};
					},
				};
			}
			throw new Error(`unexpected table in test: ${table}`);
		});

		const res = await withMcpClient((c) =>
			c.callTool({ name: "artifact_delete", arguments: { ids: [ART_ID] } }),
		);
		const text = ((res.content as any)[0]?.text ?? "") as string;

		expect(updatedPayload).toMatchObject({ archived: true, archived_reason: null });
		expect(text).toBe(`Archived 1 artifact: [${ART_ID}] Archived Note.`);
	});
});
