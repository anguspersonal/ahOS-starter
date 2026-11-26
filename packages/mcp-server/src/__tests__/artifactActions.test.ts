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

describe("artifactActions (#1511)", () => {
	it("1. Contract parity with dev: artifact_get inputSchema, description, and annotations match dev", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);
		const tool = tools.find((t) => t.name === "artifact_get");
		expect(tool, "artifact_get should be listed").toBeDefined();

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props)).toEqual(["id"]);
		expect(props.id?.type).toBe("string");
		expect(props.id?.format).toBe("uuid");
		expect(tool!.inputSchema.required).toEqual(["id"]);
		expect(tool!.description).toBe(
			"Fetch a single artifact's full content and its linked PARAMPS entities by id. For a discovered " +
				"pointer it also prints the link, connector, external id, owner, content hash with its kind " +
				"(md5 or modified_time) and the modified-at-source time.",
		);
		expect(tool!.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Exposure: artifact_get is in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		expect(manifest.actions.artifact_get?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: artifact_get is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		expect(registry.list().map((a) => a.id)).toContain("artifact_get");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("artifact_get");
	});

	it("4. Discovered pointer (storage_bucket 'external') prints pointer detail lines and derives trust and synthesis role from capture preferences", async () => {
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifacts") {
				return {
					select: () => ({
						eq: () => ({
							eq: () => ({
								maybeSingle: () =>
									Promise.resolve({
										data: {
											id: ART_ID,
											title: "Angus Hally CV.pdf",
											description: null,
											plain_text: null,
											tags: ["cv"],
											lifecycle_stage: "discovered",
											source: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
											source_url: null,
											source_channel: "discovered_gdrive",
											surface: "discovered_gdrive",
											trust_override: null,
											source_drive_file_id: null,
											source_parent_folder_ids: null,
											source_parent_folder_path: null,
											routing_decision: null,
											routing_confidence: null,
											routing_reason: null,
											drive_action: null,
											drive_action_at: null,
											created_at: "2026-08-04T00:00:00.000Z",
											storage_bucket: "external",
											storage_path: "discovered/gdrive/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
											storage_url:
												"https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
											file_type: null,
											file_size: null,
											processing_metadata: {
												discovery: {
													connector: "gdrive",
													external_id: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
													url: "https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
													owner: "Angus Hally",
													owner_email: "owner@example.com",
													source_created_at: "2025-05-13T09:00:00.000Z",
													source_modified_at: "2025-05-13T09:30:00.000Z",
													content_hash: "5d41402abc4b2a76b9719d911017c592",
													mime_type: "application/pdf",
													size: "837932",
												},
											},
										},
										error: null,
									}),
							}),
						}),
					}),
				};
			}
			if (table === "artifact_entity_links") {
				return {
					select: () => ({
						eq: () => Promise.resolve({ data: [], error: null }),
					}),
				};
			}
			if (table === "artifact_external_links") {
				return {
					select: () => ({
						eq: () => ({
							eq: () => Promise.resolve({ data: [], error: null }),
						}),
					}),
				};
			}
			if (table === "user_preferences") {
				return {
					select: () => ({
						eq: () => ({
							maybeSingle: () =>
								Promise.resolve({
									data: {
										capture_preferences: {
											surface_trust_map: { discovered_gdrive: "high" },
											surface_role_map: { discovered_gdrive: "evidence" },
										},
									},
									error: null,
								}),
						}),
					}),
				};
			}
			throw new Error(`unexpected table in test: ${table}`);
		});

		const res = await withMcpClient((c) =>
			c.callTool({ name: "artifact_get", arguments: { id: ART_ID } }),
		);
		const text = ((res.content as any)[0]?.text ?? "") as string;

		expect(text).toContain(
			"Provenance: channel=discovered_gdrive surface=discovered_gdrive trust=high role=evidence",
		);
		expect(text).toContain(
			"Link: https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
		);
		expect(text).toContain("Connector: gdrive");
		expect(text).toContain("External id: 1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-");
		expect(text).toContain("Owner: Angus Hally <owner@example.com>");
		expect(text).toContain("Content hash: 5d41402abc4b2a76b9719d911017c592 (md5)");
		expect(text).toContain("Mime type: application/pdf");
		expect(text).toContain("Size: 837,932 bytes");
		expect(text).toContain("Modified at source: 2025-05-13T09:30:00.000Z");
	});
});
