import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { actionsRouter } from "../../actions/actionsRouter.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

afterEach(() => {
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

describe("gmail_reconcile migration (#2343)", () => {
	it("serves gmail_reconcile from the core registry with expected exposure, MCP contract, and no legacy baseline or server.ts entry", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_reconcile?.expose).toEqual({
			mcp: true,
			http: false,
			ui_agent: false,
			worker: true,
			cli: false,
			a2a: false,
			reason: "owner_decision_pending",
			note: "http and ui_agent off: it archives threads and marks them read; widening is a separate owner decision (ruling of 21 Nov 2026 on #1338)",
		});
		expect(serverRegistry().get("gmail_reconcile")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_reconcile");

		const serverSource = readFileSync(
			resolve(repoRoot, "packages/mcp-server/src/server.ts"),
			"utf-8",
		);
		expect(serverSource).not.toContain('"gmail_reconcile"');

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "gmail_reconcile")!;
		expect(tool).toBeDefined();
		expect(tool.description).toBe(
			"Reconcile Gmail labels for threads captured into ahOS (issue #356). " +
				"Applies AhOS on capture, AhOSProcessed on entity sync, and evaluates linked tasks: " +
				"archives and marks read when no open tasks exist; applies 'Pending Action' if the next move is on Angus; " +
				"or applies '6: awaiting reply' if waiting on someone else. Supports dry_run preview.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"domain",
			"dry_run",
			"limit",
			"thread_id",
		]);
	});

	it("returns 404 on POST /api/actions/gmail_reconcile for direct caller and ui_agent, and leaves expose.http/ui_agent false", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_reconcile?.expose?.http).toBe(false);
		expect(manifest.actions.gmail_reconcile?.expose?.ui_agent).toBe(false);

		const stubSupabase = {
			auth: {
				getUser: vi.fn(async (token: string) => {
					if (token === "valid-token") {
						return { data: { user: { id: "user-123", email: "owner@example.com" } }, error: null };
					}
					return { data: { user: null }, error: new Error("Invalid token") };
				}),
			},
		};

		const app = express();
		app.use(express.json());
		app.use(
			"/api/actions",
			actionsRouter({
				supabaseClient: stubSupabase as any,
				ownerUserId: "user-123",
				registry: serverRegistry(),
			}),
		);

		const directRes = await request(app)
			.post("/api/actions/gmail_reconcile")
			.set("Authorization", "Bearer valid-token")
			.send({ dry_run: true });
		expect(directRes.status).toBe(404);

		const uiAgentRes = await request(app)
			.post("/api/actions/gmail_reconcile")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "ui_agent")
			.send({ dry_run: true });
		expect(uiAgentRes.status).toBe(404);
	});
});
