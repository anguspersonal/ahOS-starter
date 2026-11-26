import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { defineAction } from "@ahkms/core";
import { createServer, getRegisteredToolCatalog, makeRegistrar } from "../server.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import {
	HTTP_ROUTE_EXEMPTIONS,
	HTTP_ROUTE_EXEMPTION_REASONS,
} from "../actions/httpRouteExemptions.js";
import { actionsRouter } from "../actions/actionsRouter.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

/**
 * Scan http.ts source text to collect mounted HTTP routes and root routers.
 * Collects the first argument of every app.(get|post|put|patch|delete|all|use) call:
 * either a string-literal path or a router factory identifier ending in "Router".
 * Drops "/api/actions" and ignores generic middleware like cors(...).
 */
export function collectHttpRoutes(content: string): Set<string> {
	const routes = new Set<string>();
	const appCallRegex =
		/\bapp\.(?:get|post|put|patch|delete|all|use)\s*\(\s*(?:(['"])(.*?)\1|([a-zA-Z0-9_$]*Router)\b)/g;
	let match: RegExpExecArray | null;
	while ((match = appCallRegex.exec(content)) !== null) {
		const routeOrRouter = match[2] ?? match[3];
		if (routeOrRouter && routeOrRouter !== "/api/actions") {
			routes.add(routeOrRouter);
		}
	}
	return routes;
}

describe("surface parity (#1407, ADR-100)", () => {
	it("the HTTP set does not grow when MCP starts", async () => {
		const expectedHttpIds = serverRegistry()
			.list()
			.filter((a) => a.expose?.http === true)
			.map((a) => a.id)
			.sort();

		expect(expectedHttpIds.length).toBeGreaterThan(0);

		createServer();
		const idsAfterCreateServer = serverRegistry()
			.list()
			.filter((a) => a.expose?.http === true)
			.map((a) => a.id)
			.sort();
		expect(idsAfterCreateServer).toEqual(expectedHttpIds);

		getRegisteredToolCatalog();
		const idsAfterCatalog = serverRegistry()
			.list()
			.filter((a) => a.expose?.http === true)
			.map((a) => a.id)
			.sort();
		expect(idsAfterCatalog).toEqual(expectedHttpIds);

		const stubSupabase = {
			auth: {
				getUser: vi.fn(async (token: string) => {
					if (token === "valid-token") {
						return {
							data: { user: { id: "user-123", email: "test@example.com" } },
							error: null,
						};
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
			}),
		);

		createServer();

		const res = await request(app)
			.post("/api/actions/ingest_enrich_next")
			.set("Authorization", "Bearer valid-token")
			.send({});

		expect(res.status).toBe(404);
	});

	it("no id has two contracts", async () => {
		const tools = await listTools();
		const toolMap = new Map(tools.map((t) => [t.name, t]));
		const httpActions = serverRegistry()
			.list()
			.filter((a) => a.expose?.http === true);

		const commonIds = httpActions
			.map((a) => a.id)
			.filter((id) => toolMap.has(id))
			.sort();

		expect(commonIds.length).toBeGreaterThan(0);

		for (const id of commonIds) {
			const action = httpActions.find((a) => a.id === id)!;
			const mcpTool = toolMap.get(id)!;

			const mcpProperties = Object.keys((mcpTool.inputSchema as any)?.properties ?? {}).sort();
			const actionProperties = Object.keys((action.schema as any)?.shape ?? {}).sort();

			expect(mcpProperties, `Contract property mismatch for common action ${id}`).toEqual(
				actionProperties,
			);
		}

		// Also assert: every manifest mcp id appears in listTools()
		const manifestMcpIds = Object.entries(manifest.actions)
			.filter(([_, entry]: any) => entry.expose?.mcp === true)
			.map(([id]) => id)
			.sort();

		const toolNames = new Set(tools.map((t) => t.name));
		for (const id of manifestMcpIds) {
			expect(toolNames.has(id), `Manifest mcp action "${id}" missing from listTools()`).toBe(true);
		}

		// Also assert: every action marked http but not mcp has a non-empty note
		const httpOnlyActions = serverRegistry()
			.list()
			.filter((a) => a.expose?.http === true && !a.expose?.mcp);

		expect(httpOnlyActions.length).toBeGreaterThan(0);
		for (const action of httpOnlyActions) {
			expect(
				action.expose?.note && action.expose.note.trim().length > 0,
				`Action "${action.id}" is marked http but not mcp, so it must have a non-empty note`,
			).toBe(true);
		}
	});

	it("every other HTTP route says why it is not an action", () => {
		const httpTsPath = path.resolve(__dirname, "../http.ts");
		const content = fs.readFileSync(httpTsPath, "utf-8");

		const collectedRoutes = collectHttpRoutes(content);
		expect(
			collectedRoutes.size,
			"collectHttpRoutes must find at least one route so the test cannot pass vacuously",
		).toBeGreaterThan(0);

		const exemptionKeys = new Set(Object.keys(HTTP_ROUTE_EXEMPTIONS));

		// Missing exemptions: collected route not in exemptionKeys
		const missingExemptions = Array.from(collectedRoutes).filter((r) => !exemptionKeys.has(r));
		expect(
			missingExemptions,
			`HTTP routes mounted in http.ts missing from HTTP_ROUTE_EXEMPTIONS: ${missingExemptions.join(", ")}`,
		).toEqual([]);

		// Stale exemptions: exemptionKeys not in collected routes
		const staleExemptions = Array.from(exemptionKeys).filter((r) => !collectedRoutes.has(r));
		expect(
			staleExemptions,
			`Stale entries in HTTP_ROUTE_EXEMPTIONS not mounted in http.ts: ${staleExemptions.join(", ")}`,
		).toEqual([]);

		// Every entry reason must be in HTTP_ROUTE_EXEMPTION_REASONS and have non-empty note
		for (const [route, entry] of Object.entries(HTTP_ROUTE_EXEMPTIONS)) {
			expect(
				(HTTP_ROUTE_EXEMPTION_REASONS as readonly string[]).includes(entry.reason),
				`Exemption reason "${entry.reason}" for route "${route}" is not in HTTP_ROUTE_EXEMPTION_REASONS`,
			).toBe(true);
			expect(
				entry.note && entry.note.trim().length > 0,
				`Exemption note for route "${route}" must not be empty`,
			).toBe(true);
		}
	});

	it("registerAction throws for an action not declared for the mcp surface", () => {
		const server = new McpServer({ name: "test", version: "0.0.0" });
		const { registerAction } = makeRegistrar(server);
		const undeclaredAction = defineAction({
			id: "undeclared_test_action",
			description: "test action not declared for mcp",
			schema: z.object({}),
			expose: {
				mcp: false,
				reason: "app_internal",
				note: "test",
			},
			run: async () => ({ success: true }),
		});
		expect(() => registerAction(undeclaredAction)).toThrow(
			/not declared for the "mcp" surface/,
		);
	});
});

