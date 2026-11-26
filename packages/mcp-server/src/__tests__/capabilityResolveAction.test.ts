import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.SUPABASE_URL = "http://localhost:54321";
	process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
	process.env.KMS_USER_ID = "00000000-0000-0000-0000-000000000000";
});

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

afterEach(() => {
	(supabase as any).from = origFrom;
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

type Store = {
	entities?: Array<Record<string, unknown>>;
	bindings?: Array<Record<string, unknown>>;
	user_integrations?: Array<Record<string, unknown>>;
};

function installStoreStub(store: Store) {
	(supabase as any).from = vi.fn((table: keyof Store) => {
		const filters: Record<string, unknown> = {};
		const rows = () =>
			(store[table] ?? []).filter((row) =>
				Object.entries(filters).every(([k, v]) => row[k] === v),
			);
		const builder: any = {
			select: () => builder,
			eq: (col: string, val: unknown) => {
				filters[col] = val;
				return builder;
			},
			is: (col: string, val: unknown) => {
				filters[col] = val;
				return builder;
			},
			order: () => builder,
			maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
			then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
				Promise.resolve({ data: rows(), error: null }).then(onFulfilled, onRejected),
		};
		return builder;
	});
}

describe("capability_resolve action migration (#1596)", () => {
	it("1. Contract parity: capability_resolve inputSchema, required list, description, and annotations match dev", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);
		const tool = tools.find((t) => t.name === "capability_resolve");
		expect(tool).toBeDefined();

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props)).toEqual(["name", "domain", "scope"]);
		expect(props.name.type).toBe("string");
		expect(props.domain.enum).toEqual(["work", "angus"]);
		expect(props.scope.type).toBe("string");
		expect(tool!.inputSchema.required).toEqual(["name"]);

		expect(tool!.description).toBe(
			"Bake-at-serve resolution: load a capability's body and substitute every {{name}} reference with the value its binding resolves to UNDER THE GIVEN SCOPE. scope is a human string ('personal' | 'work') — the same body resolves differently per scope. Bindings resolve to identifiers/paths only, NEVER secrets. Missing bindings fail loud with a required-bindings manifest (error='missing_bindings'), never a silent-empty substitution.",
		);
		expect(tool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("2. Exposure: capability_resolve is in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		expect(manifest.actions.capability_resolve?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: capability_resolve is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		const ids = registry.list().map((a) => a.id);
		expect(ids).toContain("capability_resolve");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("capability_resolve");
	});

	it("4. Resolves bound refs into served body and fails loud naming unbound ref when a ref is unbound", async () => {
		const userId = "00000000-0000-0000-0000-000000000000";
		const domWork = "dom-work";

		const baseEntities = [
			{
				id: domWork,
				user_id: userId,
				entity_type: "domain",
				title: "work",
				archived: false,
			},
			{
				id: "cap-capture",
				user_id: userId,
				entity_type: "capability",
				title: "capture",
				archived: false,
				properties: {
					storage_location: "kms-db",
					storage_url: null,
					body: "Inbox {{notion.inbox_db}}, folder {{drive.folder_id}}.",
				},
			},
		];

		// One bound (notion.inbox_db) and one unbound (drive.folder_id)
		installStoreStub({
			entities: baseEntities,
			bindings: [
				{
					id: "b-notion",
					user_id: userId,
					domain_entity_id: domWork,
					name: "notion.inbox_db",
					target_kind: "integration_config",
					target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
				},
			],
			user_integrations: [
				{
					user_id: userId,
					provider: "notion_work",
					config: { tasks_database_id: "WORK-DB-ID" },
				},
			],
		});

		const partialRes = await withMcpClient((c) =>
			c.callTool({
				name: "capability_resolve",
				arguments: { name: "capture", domain: "work" },
			}),
		);
		expect(partialRes.isError).toBe(true);
		const partialText = ((partialRes.content as any)[0]?.text ?? "") as string;
		expect(partialText).toContain('"error":"missing_bindings"');
		expect(partialText).toContain('"missing":["drive.folder_id"]');
		expect(partialText).not.toContain("notion.inbox_db");

		// Both bound -> returns baked served body
		installStoreStub({
			entities: baseEntities,
			bindings: [
				{
					id: "b-notion",
					user_id: userId,
					domain_entity_id: domWork,
					name: "notion.inbox_db",
					target_kind: "integration_config",
					target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
				},
				{
					id: "b-drive",
					user_id: userId,
					domain_entity_id: null,
					name: "drive.folder_id",
					target_kind: "literal",
					target_ref: { value: "DRIVE-FOLDER-123" },
				},
			],
			user_integrations: [
				{
					user_id: userId,
					provider: "notion_work",
					config: { tasks_database_id: "WORK-DB-ID" },
				},
			],
		});

		const fullRes = await withMcpClient((c) =>
			c.callTool({
				name: "capability_resolve",
				arguments: { name: "capture", domain: "work" },
			}),
		);
		expect(fullRes.isError).toBeFalsy();
		const fullText = ((fullRes.content as any)[0]?.text ?? "") as string;
		expect(fullText).toBe("Inbox WORK-DB-ID, folder DRIVE-FOLDER-123.");
	});
});
