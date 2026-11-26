import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	SYNTHESIZED as CORE_SYNTHESIZED,
	SYNTHESIZED_UNATTENDED as CORE_SYNTHESIZED_UNATTENDED,
	SYNTHESIS_MARKER_KINDS as CORE_SYNTHESIS_MARKER_KINDS,
	SYNTHESIS_MARKER_WRITE_KIND as CORE_SYNTHESIS_MARKER_WRITE_KIND,
} from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import actionManifest from "@ahkms/core/action-manifest.json" with { type: "json" };
import {
	SYNTHESIZED as SHARED_SYNTHESIZED,
	SYNTHESIZED_UNATTENDED as SHARED_SYNTHESIZED_UNATTENDED,
	SYNTHESIS_MARKER_KINDS as SHARED_SYNTHESIS_MARKER_KINDS,
	SYNTHESIS_MARKER_WRITE_KIND as SHARED_SYNTHESIS_MARKER_WRITE_KIND,
} from "@ahkms/shared";
import { serverAdapters } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";


async function connectClient() {
	const server = createServer();
	const client = new Client({ name: "external-link-action-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("external_link_create action migration (#1539)", () => {
	it("case 1: contract parity (R11) — inputSchema.properties, required, annotations, and description match dev", async () => {
		const client = await connectClient();
		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "external_link_create");
		expect(tool).toBeDefined();

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
		expect(Object.keys(props)).toEqual([
			"artifact_id",
			"provider",
			"kind",
			"external_id",
			"external_url",
			"dedup_key",
			"run_id",
		]);
		for (const prop of Object.values(props)) {
			expect(prop.type).toBe("string");
		}
		expect(tool!.inputSchema.required).toEqual([
			"artifact_id",
			"provider",
			"kind",
			"external_id",
		]);

		expect(tool!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(tool!.description).toContain(
			"Full notes: docs/guides/tools/external_link_create.md",
		);
	});

	it("case 2: exposure — external_link_create is in action-manifest.json with mcp/http/ui_agent/worker true and cli/a2a false", () => {
		const entry = (actionManifest.actions as Record<string, { expose: unknown }>)[
			"external_link_create"
		];
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

	it("case 3: registration path — external_link_create is in buildRegistry(serverAdapters()) and absent from legacy-tools-baseline.txt", () => {
		const ids = buildRegistry(serverAdapters())
			.list()
			.map((a) => a.id);
		expect(ids).toContain("external_link_create");

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("external_link_create");
	});

	it("case 4: guard — calling external_link_create with kind='synthesized' and no run_id is refused", async () => {
		const client = await connectClient();
		const res = await client.callTool({
			name: "external_link_create",
			arguments: {
				artifact_id: "22222222-2222-4222-8222-222222222222",
				provider: "notion_work",
				kind: "synthesized",
				external_id: "page-1",
			},
		});

		expect(res.isError).toBe(true);
		const text = ((res.content as Array<{ text?: string }>)[0]?.text ?? "");
		expect(text).toMatch(/requires a ritual `run_id`/);
	});

	it("keeps synthesis marker constants deep-equal between @ahkms/core and @ahkms/shared", () => {
		expect(CORE_SYNTHESIZED).toBe(SHARED_SYNTHESIZED);
		expect(CORE_SYNTHESIZED_UNATTENDED).toBe(SHARED_SYNTHESIZED_UNATTENDED);
		expect(CORE_SYNTHESIS_MARKER_WRITE_KIND).toBe(SHARED_SYNTHESIS_MARKER_WRITE_KIND);
		expect(CORE_SYNTHESIS_MARKER_KINDS).toEqual(SHARED_SYNTHESIS_MARKER_KINDS);
	});
});
