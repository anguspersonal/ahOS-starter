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
const origStorageFrom = supabase.storage.from;

const ART_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	vi.restoreAllMocks();
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

function stubArtifactFetch(row: Record<string, unknown>) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "artifacts") {
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							maybeSingle: () => Promise.resolve({ data: row, error: null }),
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
						maybeSingle: () => Promise.resolve({ data: null, error: null }),
					}),
				}),
			};
		}
		throw new Error(`unexpected table in test: ${table}`);
	});
}

function baseRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ART_ID,
		title: "Test artifact",
		description: null,
		plain_text: "hello",
		tags: [],
		lifecycle_stage: "uploaded",
		source: null,
		source_url: null,
		source_channel: "note",
		surface: null,
		trust_override: null,
		source_drive_file_id: null,
		source_parent_folder_ids: null,
		source_parent_folder_path: null,
		routing_decision: null,
		routing_confidence: null,
		routing_reason: null,
		drive_action: null,
		drive_action_at: null,
		created_at: "2026-07-13T00:00:00.000Z",
		storage_bucket: "user-uploads",
		storage_path: "drive-imports/user/photo.jpg",
		storage_url:
			"https://x.supabase.co/storage/v1/object/public/user-uploads/drive-imports/user/photo.jpg",
		file_type: "image/jpeg",
		file_size: 1024,
		processing_metadata: null,
		...overrides,
	};
}

describe("artifactFileAction (#1610)", () => {
	it(
		"1. Contract parity with dev: artifact_get_file inputSchema, description, and annotations match dev",
		{ timeout: 15_000 },
		async () => {
			const tools = await withMcpClient(async (c) => (await c.listTools()).tools);
			const tool = tools.find((t) => t.name === "artifact_get_file");
			expect(tool, "artifact_get_file should be listed").toBeDefined();

			const props = (tool!.inputSchema.properties ?? {}) as Record<string, any>;
			expect(Object.keys(props)).toEqual(["id"]);
			expect(props.id?.type).toBe("string");
			expect(props.id?.format).toBe("uuid");
			expect(tool!.inputSchema.required).toEqual(["id"]);
			expect(tool!.description).toBe(
				"artifact_get plus a resolvable reference to the artifact's original file, when one exists. Three " +
					"outcomes: a real stored file returns a reference; a plain-text capture has no file and says so " +
					"cleanly; a missing file is reported as missing rather than as an error. Full notes: " +
					"docs/guides/tools/artifact_get_file.md",
			);
			expect(tool!.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
		},
	);

	it("2. Exposure: artifact_get_file is in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		expect(manifest.actions.artifact_get_file?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: artifact_get_file is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		expect(registry.list().map((a) => a.id)).toContain("artifact_get_file");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("artifact_get_file");
	});

	it(
		"4. storage_bucket 'external' returns the external-link line and mints nothing; failed signed URL names every bucket tried",
		{ timeout: 15_000 },
		async () => {
			await withMcpClient(async (c) => {
				stubArtifactFetch(
					baseRow({
						storage_bucket: "external",
						storage_path: "discovered/notion/abc123",
						storage_url: "https://www.notion.so/Some-Page-abc123",
						file_type: null,
					}),
				);
				const storageFrom = vi.fn();
				(supabase.storage as any).from = storageFrom;

				const extRes = await c.callTool({ name: "artifact_get_file", arguments: { id: ART_ID } });
				const extText = ((extRes.content as any)[0]?.text ?? "") as string;
				expect(extText).toContain(
					"File: external link only (storage_url is not a Supabase Storage object) — https://www.notion.so/Some-Page-abc123",
				);
				expect(storageFrom).not.toHaveBeenCalled();

				stubArtifactFetch(
					baseRow({
						storage_bucket: "inputs",
						storage_url:
							"https://x.supabase.co/storage/v1/object/public/inputs/drive-imports/user/photo.jpg",
					}),
				);
				(supabase.storage as any).from = vi.fn(() => ({
					createSignedUrl: async () => ({ data: null, error: { message: "not found" } }),
				}));

				const failRes = await c.callTool({ name: "artifact_get_file", arguments: { id: ART_ID } });
				const failText = ((failRes.content as any)[0]?.text ?? "") as string;
				expect(failText).toContain(
					'File: unavailable — signed URL failed for "drive-imports/user/photo.jpg" (tried [inputs, user-uploads, raw-inputs, derived-artifacts]): inputs: not found; user-uploads: not found; raw-inputs: not found; derived-artifacts: not found',
				);
			});
		},
	);
});
