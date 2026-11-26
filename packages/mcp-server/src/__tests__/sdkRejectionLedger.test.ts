import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActionRegistry, defineAction, setDefaultAuditSink, stderrAuditSink, type ActionAuditRecord } from "@ahkms/core";
import { recordSdkRejections, sdkRejectionPrefix } from "../actions/sdkRejections.js";
import { createServer, registerAllTools } from "../server.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function connectTestClient(options?: { withAttribution?: boolean; registry?: ActionRegistry }) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	if (options?.withAttribution) {
		serverTransport.sessionId = "s1";
		const origSend = clientTransport.send.bind(clientTransport);
		clientTransport.send = (message, sendOpts) =>
			origSend(message, { ...sendOpts, authInfo: { token: "t", clientId: "c1", scopes: [] } });
	}
	const server = createServer([], [], options?.registry);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

function firstText(result: Record<string, unknown>): string {
	return ((result.content as Array<{ type: string; text: string }> | undefined)?.[0])?.text ?? "";
}

describe("MCP SDK tool input validation rejection ledger (#1414)", () => {
	let records: ActionAuditRecord[] = [];

	beforeEach(() => {
		records = [];
		setDefaultAuditSink((r) => {
			records.push(r);
		});
	});

	afterEach(() => {
		setDefaultAuditSink(stderrAuditSink);
	});

	it("Case 1: records legacy tool SDK rejection with attribution and no secret values", async () => {
		const { client, close } = await connectTestClient({ withAttribution: true });
		try {
			const result = await client.callTool({
				name: "ingest_enrich_next",
				arguments: { artifact_id: "not-a-uuid", limit: "secret-limit" },
			});
			expect(result.isError).toBe(true);
			const text = firstText(result);
			expect(text.startsWith(sdkRejectionPrefix("ingest_enrich_next"))).toBe(true);

			expect(records).toHaveLength(1);
			const record = records[0]!;
			expect(record).toMatchObject({
				actionId: "ingest_enrich_next",
				seam: "legacy_tool",
				caller: "mcp",
				outcome: "validation_error",
				clientId: "c1",
				sessionId: "s1",
				userId: "00000000-0000-0000-0000-000000000000",
				inputSha256: null,
				errorMessage: text.slice(0, 500),
			});
			expect(record.requestId).toMatch(UUID_RE);
			expect(typeof record.durationMs).toBe("number");
			expect([...record.inputKeys].sort()).toEqual(["artifact_id", "limit"]);
			const serialized = JSON.stringify(record);
			expect(serialized).not.toContain("not-a-uuid");
			expect(serialized).not.toContain("secret-limit");
		} finally {
			await close();
		}
	});

	it("Case 2: records shared-handler alias under canonical actionId with null attribution when absent", async () => {
		const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		const fixtureRegistry = new ActionRegistry();
		fixtureRegistry.register(
			defineAction({
				id: "fixture_sync_entities",
				description: "Fixture canonical action",
				schema: z.object({ artifact_id: z.string().uuid() }),
				formerIds: [{ id: "fixture_entity_sync", until: tomorrow }],
				run: async () => ({ ok: true }),
			}),
		);
		const { client, close } = await connectTestClient({ registry: fixtureRegistry });
		try {
			const result = await client.callTool({
				name: "fixture_entity_sync",
				arguments: { artifact_id: "not-a-uuid" },
			});
			expect(result.isError).toBe(true);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				actionId: "fixture_sync_entities",
				seam: "action",
				outcome: "validation_error",
				clientId: null,
				sessionId: null,
			});
		} finally {
			await close();
		}
	});

	it("Case 3: records action-backed tools (capture and entity_get) under seam 'action'", async () => {
		const { client, close } = await connectTestClient();
		try {
			const r1 = await client.callTool({ name: "capture", arguments: { text: "" } });
			const r2 = await client.callTool({ name: "entity_get", arguments: { id: 42 } });
			expect(r1.isError).toBe(true);
			expect(r2.isError).toBe(true);
			expect(records).toHaveLength(2);
			expect(records[0]).toMatchObject({ actionId: "capture", seam: "action", outcome: "validation_error" });
			expect(records[1]).toMatchObject({ actionId: "entity_get", seam: "action", outcome: "validation_error" });
		} finally {
			await close();
		}
	});

	it("Case 4: handler-level error after passing SDK validation writes one 'error' row and no 'validation_error'", async () => {
		const { client, close } = await connectTestClient();
		try {
			const result = await client.callTool({
				name: "person_update",
				arguments: { patch: { name: "x" } },
			});
			expect(result.isError).toBe(true);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ actionId: "person_update", seam: "action", outcome: "error" });
			expect(records.some((r) => r.outcome === "validation_error")).toBe(false);
		} finally {
			await close();
		}
	});

	it("Case 5: unknown tool returns SDK not-found error and writes 0 ledger rows", async () => {
		const { client, close } = await connectTestClient();
		try {
			const result = await client.callTool({ name: "no_such_tool", arguments: {} });
			expect(result.isError).toBe(true);
			expect(firstText(result)).toContain("Tool no_such_tool not found");
			expect(records).toHaveLength(0);
		} finally {
			await close();
		}
	});

	it("Case 6: sink failure does not alter the SDK error result returned to the client", async () => {
		setDefaultAuditSink(async () => {
			throw new Error("sink down");
		});
		const { client, close } = await connectTestClient({ withAttribution: true });
		try {
			const result = await client.callTool({
				name: "person_update",
				arguments: { ids: ["not-a-uuid"], patch: { name: "secret-title" } },
			});
			expect(result.isError).toBe(true);
			expect(firstText(result).startsWith(sdkRejectionPrefix("person_update"))).toBe(true);
		} finally {
			await close();
		}
	});

	it("Case 7: recordSdkRejections throws when installed after a tool is already registered", () => {
		const server = new McpServer({ name: "t", version: "0.0.0" });
		server.registerTool("t", {}, async () => ({ content: [] }));
		expect(() => recordSdkRejections(server, () => undefined)).toThrow(
			/A request handler for tools\/call already exists/,
		);
	});

	it("Case 8: registerAllTools seam and actionId split matches raw vs wrapped handlers", () => {
		const sdkHandlers = new Map<string, unknown>();
		const stub = {
			registerTool: (name: string, _config: unknown, handler: unknown) => {
				sdkHandlers.set(name, handler);
				return {};
			},
		} as unknown as McpServer;

		const registered = registerAllTools(stub);
		expect(registered.size).toBeGreaterThan(0);

		for (const [name, entry] of registered.entries()) {
			expect(entry.seam).toBe(sdkHandlers.get(name) === entry.handler ? "action" : "legacy_tool");
			const firstMatch = [...registered.entries()].find(([, v]) => v.handler === entry.handler);
			expect(entry.actionId).toBe(firstMatch?.[0]);
		}
	});
});
