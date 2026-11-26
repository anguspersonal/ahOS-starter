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
import {
	buildRegistry,
	STORAGE_LOCATIONS,
	wrapServedCapabilityBody,
} from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverAdapters } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { hashBody } from "../skill-sync/hash.js";
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

type Row = Record<string, unknown>;

function stubCapabilityRows(rows: Row[]) {
	(supabase as any).from = vi.fn(() => {
		const preds: Array<(r: Row) => boolean> = [];
		const builder: any = {
			select: () => builder,
			eq: (col: string, val: unknown) => {
				preds.push((r) => r[col] === val);
				return builder;
			},
			order: () => builder,
			then: (res: any, rej: any) =>
				Promise.resolve({
					data: rows.filter((r) => preds.every((p) => p(r))),
					error: null,
				}).then(res, rej),
		};
		return builder;
	});
}

describe("capabilityActions (#1593)", () => {
	it("1. Contract parity (R11): capability_get and capability_register schemas and annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);

		const getTool = tools.find((t) => t.name === "capability_get");
		expect(getTool).toBeDefined();
		expect(Object.keys(getTool!.inputSchema.properties ?? {})).toEqual([
			"name",
			"kind",
			"surface",
			"client",
			"scope",
			"domain",
			"storage_location",
			"include_archived",
			"include_body",
		]);
		expect(getTool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});

		const registerTool = tools.find((t) => t.name === "capability_register");
		expect(registerTool).toBeDefined();
		expect(Object.keys(registerTool!.inputSchema.properties ?? {})).toEqual([
			"name",
			"description",
			"kind",
			"surface",
			"clients",
			"scope",
			"domain",
			"storage_location",
			"storage_url",
			"body",
		]);
		expect(registerTool!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("2. Exposure: capability_get and capability_register are in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		const expectedExposure = {
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		};
		expect(manifest.actions.capability_get?.expose).toEqual(expectedExposure);
		expect(manifest.actions.capability_register?.expose).toEqual(expectedExposure);
	});

	it("3. Registration path: both are in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		const ids = registry.list().map((a) => a.id);
		expect(ids).toContain("capability_get");
		expect(ids).toContain("capability_register");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("capability_get");
		expect(baseline).not.toContain("capability_register");
	});

	it("4. Freshness probe: capability_get({ name, include_body: false }) returns body_sha256 equal to hashBody(body) and omits body", async () => {
		const fixtureBody = "---\r\nname: dos  \r\n---\r\nbody line with trailing spaces   \r\n\r\n";
		const expectedHash = hashBody(fixtureBody);

		stubCapabilityRows([
			{
				id: "cap-dos",
				user_id: "00000000-0000-0000-0000-000000000000",
				entity_type: "capability",
				title: "dos",
				description: "Daily Operating System",
				properties: {
					kind: "skill",
					surface: ["claude-code"],
					storage_location: "kms-db",
					storage_url: null,
					body: fixtureBody,
					body_synced_at: "2026-09-04T21:29:35.713Z",
				},
				updated_at: "2026-09-04T21:29:36.000Z",
				archived: false,
			},
		]);

		const result = await withMcpClient((c) =>
			c.callTool({
				name: "capability_get",
				arguments: { name: "dos", include_body: false },
			}),
		);
		const text = ((result.content as any)[0]?.text ?? "") as string;
		expect(text).toContain(`body_sha256: ${expectedHash}`);
		expect(text).not.toContain("body line with trailing spaces");
	});

	it("5. Served body: capability_get({ name, include_body: true }) wraps body identically to wrapServedCapabilityBody for each storage_location", async () => {
		const body = "---\nname: cap\n---\n\n# Body\nStep 1.";
		for (const loc of STORAGE_LOCATIONS) {
			const storageUrl = loc === "kms-db" ? null : "skills/cap/SKILL.md";
			stubCapabilityRows([
				{
					id: `cap-${loc}`,
					user_id: "00000000-0000-0000-0000-000000000000",
					entity_type: "capability",
					title: "cap",
					description: null,
					properties: {
						kind: "skill",
						surface: ["claude-code"],
						storage_location: loc,
						storage_url: storageUrl,
						body,
						body_synced_at: "2026-09-04T21:29:35.713Z",
					},
					updated_at: "2026-09-04T21:29:36.000Z",
					archived: false,
				},
			]);

			const result = await withMcpClient((c) =>
				c.callTool({
					name: "capability_get",
					arguments: { name: "cap", include_body: true },
				}),
			);
			const text = ((result.content as any)[0]?.text ?? "") as string;
			const expectedWrapped = wrapServedCapabilityBody(body, loc, storageUrl);
			expect(text.endsWith(`\n\n${expectedWrapped}`)).toBe(true);
		}
	});
});
