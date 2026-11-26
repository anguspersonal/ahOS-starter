import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { TOOL_ALIASES } from "../../toolAliases.js";
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const require = createRequire(import.meta.url);
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";
const FIXED_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
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

describe("ingest_drive migration (#1614)", () => {
	it("serves ingest_drive from the registry with dev's exact contract, removes it from legacy baseline, and preserves drive_ingest alias", async () => {
		const manifest = require("@ahkms/core/action-manifest.json");
		expect(manifest.actions.ingest_drive?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("ingest_drive")).toBeDefined();
		expect(TOOL_ALIASES.drive_ingest).toBe("ingest_drive");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("ingest_drive");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "ingest_drive")!;
		expect(tool?.description).toBe(
			"Ingest a Google Drive file into the knowledge store without taking any Drive-side cleanup action. Downloads/exports the file, persists the artifact with Drive provenance, and returns the routing context so the agent can extract entities and decide keep/move/archive/delete afterward.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"domain",
			"file_id",
			"tags",
			"title",
		]);
		expect(tool.inputSchema.required).toEqual(["file_id"]);
		expect(props.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Drive file id to ingest into the knowledge store.",
		});
		expect(props.title).toMatchObject({
			type: "string",
			description: "Optional human-friendly artifact title. Defaults to the Drive file name.",
		});
		expect(props.tags).toMatchObject({
			type: "array",
			items: { type: "string" },
			description: "Optional tags for the artifact.",
		});
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
	});

	it("reuses existing artifact without Drive/Storage writes, and imports new files with byte-for-byte parity", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
		vi.stubEnv("KMS_USER_ID", DEFAULT_USER_ID);
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);

		const uploads: string[] = [];
		const inserts: Record<string, unknown>[] = [];
		let lookupResult: Record<string, unknown> | null = {
			id: "existing-art-1",
			title: "Existing Doc",
			storage_bucket: "user-uploads",
			storage_path: "drive-imports/user/file.txt",
			source_url: "https://drive.google.com/file/d/f-existing",
			source_parent_folder_ids: ["parent-1"],
			source_parent_folder_path: "Team / Projects",
			processing_status: "completed",
			plain_text: "Existing text",
		};

		(supabase.storage as any).from = vi.fn(() => ({
			upload: vi.fn(async (path: string) => {
				uploads.push(path);
				return { error: null };
			}),
			remove: vi.fn(async () => ({ error: null })),
		}));
		(supabase as any).from = vi.fn((table: string) => {
			if (table !== "artifacts") throw new Error(`Unexpected table: ${table}`);
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							or: () => ({
								limit: () => ({
									maybeSingle: async () => ({ data: lookupResult, error: null }),
								}),
							}),
						}),
					}),
				}),
				insert: (row: Record<string, unknown>) => {
					inserts.push(row);
					return {
						select: () => ({
							single: async () => ({
								data: { id: row.id, title: row.title, created_at: "2026-08-22T00:00:00Z" },
								error: null,
							}),
						}),
					};
				},
			};
		});

		const driveCalls: Array<{ method: string; url: URL }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				driveCalls.push({ method: String(init?.method ?? "GET"), url });
				if (url.searchParams.get("alt") === "media") {
					return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						id: "f-42",
						name: "Receipt.pdf",
						mimeType: "application/pdf",
						webViewLink: "https://drive.google.com/file/d/f-42/view",
						parents: [],
						createdTime: "2025-01-15T12:00:00.000Z",
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();

		// 1) Existing artifact reused — zero Drive/Storage/insert calls
		const reusedRes = await client.callTool({
			name: "ingest_drive",
			arguments: { file_id: "f-existing" },
		});
		expect(reusedRes.isError).toBeFalsy();
		expect(((reusedRes.content as any)[0] as any).text).toBe(
			[
				"Drive file f-existing already ingested as artifact existing-art-1.",
				"Title: Existing Doc",
				"Source URL: https://drive.google.com/file/d/f-existing",
				"Parent folder ids: parent-1",
				"Parent folder path: Team / Projects",
				"Stored at: user-uploads/drive-imports/user/file.txt",
				"Status: completed",
				"Existing artifact reused rather than re-capturing.",
			].join("\n"),
		);
		expect(driveCalls).toHaveLength(0);
		expect(uploads).toHaveLength(0);
		expect(inserts).toHaveLength(0);

		// 2) New binary file imported
		lookupResult = null;
		const newRes = await client.callTool({
			name: "ingest_drive",
			arguments: { file_id: "f-42" },
		});
		await client.close();

		expect(newRes.isError).toBeFalsy();
		expect(((newRes.content as any)[0] as any).text).toBe(
			[
				`Ingested Drive file f-42 as artifact ${FIXED_UUID}.`,
				"Title: Receipt.pdf",
				"Source URL: https://drive.google.com/file/d/f-42/view",
				"Parent folder ids: (none)",
				"Parent folder path: (root or unknown)",
				`Stored at: user-uploads/drive-imports/${DEFAULT_USER_ID}/${FIXED_UUID}.pdf`,
				"Status: pending",
				"Binary stored \u2014 call artifact_extract_text with this artifact id to make it searchable, then artifact_sync_entities if needed.",
			].join("\n"),
		);
		expect(uploads).toHaveLength(1);
		expect(inserts).toHaveLength(1);
	});
});
