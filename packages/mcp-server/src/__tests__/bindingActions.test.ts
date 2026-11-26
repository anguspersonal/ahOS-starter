import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createSupabaseBindingRepository } from "@ahkms/core/adapters";
import actionManifest from "@ahkms/core/action-manifest.json" with { type: "json" };
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";


async function listAllMcpTools() {
	const server = createServer();
	const client = new Client({ name: "binding-actions-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("binding_list action migration (#1594)", () => {
	it("1. Contract parity (R11): MCP schema keys, types, required list, description, and annotations match dev", async () => {
		const tools = await listAllMcpTools();
		const tool = tools.find((t) => t.name === "binding_list");
		expect(tool).toBeDefined();

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual(["domain", "name", "scope"]);
		expect(props.domain.enum).toEqual(["work", "angus"]);
		expect(props.scope.type).toBe("string");
		expect(props.name.type).toBe("string");
		expect(tool!.inputSchema.required ?? []).toEqual([]);

		expect(tool!.description).toBe(
			"List bindings, optionally filtered by scope ('personal'|'work') or exact name. Shows each binding's scope, target_kind, and target_ref (pointer only — no resolved secret values).",
		);
		expect(tool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Exposure: binding_list is in action-manifest.json with mcp/http/ui_agent/worker true and cli/a2a false", () => {
		const entry = (actionManifest.actions as Record<string, any>).binding_list;
		expect(entry).toBeDefined();
		expect(entry.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: binding_list is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registryIds = buildRegistry({}).list().map((a) => a.id);
		expect(registryIds).toContain("binding_list");

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("binding_list");
	});

	it("4. Adapter never selects a secret column: resolveBindingValue reads user_integrations.config and entities.properties only", async () => {
		const selected: string[] = [];
		const client = {
			from: vi.fn((table: string) => {
				const builder: any = {
					select(cols: string) {
						selected.push(`${table}:${cols}`);
						return builder;
					},
					eq() {
						return builder;
					},
					maybeSingle() {
						if (table === "user_integrations") {
							return Promise.resolve({
								data: { config: { tasks_database_id: "SAFE-ID" } },
								error: null,
							});
						}
						return Promise.resolve({
							data: { title: "T", description: "D", properties: { key: "VAL" } },
							error: null,
						});
					},
				};
				return builder;
			}),
		} as any;

		const repo = createSupabaseBindingRepository({ client, ownerId: "u1" });
		const val1 = await repo.resolveBindingValue({
			id: "b1",
			domain_entity_id: null,
			name: "notion.inbox_db",
			target_kind: "integration_config",
			target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
		});
		const val2 = await repo.resolveBindingValue({
			id: "b2",
			domain_entity_id: null,
			name: "entity.prop",
			target_kind: "entity",
			target_ref: { entity_id: "e1", property: "key" },
		});

		expect(val1).toBe("SAFE-ID");
		expect(val2).toBe("VAL");
		expect(selected).toContain("user_integrations:config");
		expect(selected).toContain("entities:title, description, properties");
		expect(selected.join("|")).not.toMatch(/credential_ref|status|routing|expires_at/);
	});
});
