import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { createRequire } from "node:module";
import { defineAction, ActionRegistry, setDefaultAuditSink, type ActionAuditRecord } from "@ahkms/core";
import { actionsRouter } from "../actions/actionsRouter.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");

vi.mock("../supabase.js", () => {
	const chain: any = {
		select: vi.fn(() => chain),
		eq: vi.fn(() => chain),
		order: vi.fn(() => chain),
		range: vi.fn(() => chain),
		in: vi.fn(() => chain),
		single: vi.fn(async () => ({ data: null, error: null })),
		then: (resolve: any) => resolve({ data: [], count: 0, error: null }),
	};
	return {
		supabase: {
			from: vi.fn(() => chain),
			rpc: vi.fn(async () => ({ data: null, error: null })),
			auth: {
				getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
			},
		},
	};
});

function makeTestApp(routerOptions: any = {}) {
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

	const noRateLimit = { isRateLimited: () => ({ limited: false }) };
	const app = express();
	app.use(express.json());
	app.use(
		"/api/actions",
		actionsRouter({
			supabaseClient: stubSupabase as any,
			ownerUserId: "user-123",
			rateLimiter: noRateLimit,
			ipRateLimiter: noRateLimit,
			...routerOptions,
		}),
	);
	return app;
}

describe("actionsRouter registry integration (Issue #1551)", { timeout: 30_000 }, () => {
	it("case 1: the router's served ids equal the manifest ids with expose.http; unknown ids and http:off actions answer 404", async () => {
		const app = makeTestApp();

		const manifestHttpIds = Object.entries(manifest.actions)
			.filter(([_, a]: [string, any]) => a.expose?.http === true)
			.map(([id]) => id)
			.sort();

		expect(manifestHttpIds.length).toBeGreaterThan(0);

		// Every manifest action with expose.http: true is served (not 404 or 429)
		for (const id of manifestHttpIds) {
			const res = await request(app)
				.post(`/api/actions/${id}`)
				.set("Authorization", "Bearer valid-token")
				.send({});
			expect(res.status, `Action "${id}" should be served on HTTP but returned 404`).not.toBe(404);
			expect(res.status, `Action "${id}" hit rate limit in registry sweep`).not.toBe(429);
		}

		// Unknown action answers 404
		const unknownRes = await request(app)
			.post("/api/actions/nonexistent_action_xyz")
			.set("Authorization", "Bearer valid-token")
			.send({});
		expect(unknownRes.status).toBe(404);

		// An action in the registry with http: false answers 404
		const fixtureRegistry = new ActionRegistry();
		const offAction = defineAction({
			id: "internal_tool",
			description: "Internal only action",
			schema: z.object({}),
			expose: {
				mcp: false,
				http: false,
				ui_agent: false,
				worker: true,
				cli: false,
				a2a: false,
				reason: "app_internal",
				note: "internal only",
			},
			run: async () => ({ ok: true }),
		});
		fixtureRegistry.register(offAction);

		const fixtureApp = makeTestApp({ registry: fixtureRegistry });
		const offRes = await request(fixtureApp)
			.post("/api/actions/internal_tool")
			.set("Authorization", "Bearer valid-token")
			.send({});
		expect(offRes.status).toBe(404);
	});

	it.skip("case 2: with X-Action-Caller: ui_agent, an action with ui_agent off answers 403 not_exposed_to_ui_agent (#1418)", async () => {
		// Skipped: waiting for #1418 to land on dev
	});

	it("case 3: a former id within its window runs the new action and the record carries the new id; after the window, 404", async () => {
		const records: ActionAuditRecord[] = [];
		setDefaultAuditSink(async (rec) => {
			records.push(rec);
		});

		const fixtureRegistry = new ActionRegistry();
		const actionWithFormer = defineAction({
			id: "live_action",
			description: "Action with former IDs",
			schema: z.object({ message: z.string().optional() }),
			formerIds: [
				{ id: "active_former_id", until: "2099-12-31" },
				{ id: "expired_former_id", until: "2020-01-01" },
			],
			run: async (input) => ({ echoed: input.message ?? "none" }),
		});
		fixtureRegistry.register(actionWithFormer);

		const app = makeTestApp({ registry: fixtureRegistry });

		// Active former ID resolves, runs new action, audit record carries the new action ID
		const activeRes = await request(app)
			.post("/api/actions/active_former_id")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "hello former" });

		expect(activeRes.status).toBe(200);
		expect(activeRes.body).toEqual({ echoed: "hello former" });

		const matchingRecord = records.find((r) => r.actionId === "live_action");
		expect(matchingRecord).toBeDefined();
		expect(matchingRecord?.actionId).toBe("live_action");

		// Expired former ID answers 404
		const expiredRes = await request(app)
			.post("/api/actions/expired_former_id")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "hello expired" });

		expect(expiredRes.status).toBe(404);
	});

	it("case 4: createServer() twice leaves the served set unchanged (the side-effect copy is gone for good)", async () => {
		const reg = serverRegistry();
		const beforeIds = reg.list().map((a) => a.id).sort();

		createServer();
		createServer();

		const afterIds = reg.list().map((a) => a.id).sort();
		expect(afterIds).toEqual(beforeIds);
	});
});
