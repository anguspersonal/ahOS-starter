import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	ActionRegistry,
	defineAction,
	executeAction,
	noopActionScope,
	setActionApprovalStore,
	setActionScope,
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
} from "@ahkms/core";
import { toMcpTool } from "./adapters/mcp.js";
import { ActionRateLimiter, actionsRouter } from "./actionsRouter.js";
import { wrapLegacyHandler } from "./legacyDispatch.js";
import { configureActionScope } from "./scope.js";

describe("configureActionScope and trace propagation (#1562)", () => {
	let records: ActionAuditRecord[] = [];

	beforeEach(() => {
		records = [];
		configureActionScope();
		setDefaultAuditSink((rec) => {
			records.push(rec);
		});
	});

	afterEach(() => {
		setActionScope(noopActionScope);
		setDefaultAuditSink(stderrAuditSink);
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("1. wrapLegacyHandler runs handler in scope so child executeAction records parentRequestId and same traceId", async () => {
		const captureAction = defineAction({
			id: "capture",
			description: "Capture artifact",
			schema: z.object({ text: z.string() }),
			run: async (input) => ({ captured: input.text }),
		});

		const wrapped = wrapLegacyHandler(
			"gmail_send_draft",
			async (_args: unknown, _extra?: unknown) => {
				await executeAction(captureAction, { text: "sent draft body" });
				return { content: [{ type: "text", text: "ok" }] };
			},
		);

		await wrapped({ draft_id: "d1" }, {});

		expect(records).toHaveLength(2);
		const legacyRec = records.find((r) => r.actionId === "gmail_send_draft")!;
		const captureRec = records.find((r) => r.actionId === "capture")!;

		expect(legacyRec).toBeDefined();
		expect(captureRec).toBeDefined();
		expect(legacyRec.requestId).toBeTruthy();
		expect(captureRec.parentRequestId).toBe(legacyRec.requestId);
		expect(captureRec.traceId).toBe(legacyRec.traceId);
		expect(captureRec.traceId).toBe(legacyRec.requestId);
	});

	it("2. POST /api/actions/<id> with X-Action-Trace-Id: <uuid> records that traceId; with 'abc' it records its own", async () => {
		const echoAction = defineAction({
			id: "echo_action",
			description: "Echo input",
			schema: z.object({ message: z.string() }),
			run: async (input) => ({ echoed: input.message }),
		});

		const registry = new ActionRegistry();
		registry.register(echoAction);

		const mockSupabase = {
			auth: {
				getUser: vi.fn(async () => ({
					data: { user: { id: "user-123" } },
					error: null,
				})),
			},
		};

		const app = express();
		app.use(
			"/api/actions",
			actionsRouter({
				registry,
				supabaseClient: mockSupabase,
				rateLimiter: new ActionRateLimiter(20, 60_000),
				ownerUserId: "user-123",
			}),
		);

		const validTraceId = "11111111-2222-4333-8444-555555555555";
		const resValid = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Trace-Id", validTraceId)
			.send({ message: "hello" });

		expect(resValid.status).toBe(200);
		expect(records).toHaveLength(1);
		expect(records[0].traceId).toBe(validTraceId);
		expect(records[0].requestId).not.toBe(validTraceId);

		const resInvalid = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Trace-Id", "abc")
			.send({ message: "world" });

		expect(resInvalid.status).toBe(200);
		expect(records).toHaveLength(2);
		expect(records[1].traceId).toBe(records[1].requestId);
		expect(records[1].traceId).not.toBe("abc");
	});

	it("3. two concurrent MCP calls (two toMcpTool handlers awaited together) never share a trace", async () => {
		const childAction = defineAction({
			id: "child_action",
			description: "Nested child action",
			schema: z.object({ label: z.string() }),
			run: async (input) => ({ label: input.label }),
		});

		const outerActionA = defineAction({
			id: "outer_a",
			description: "Outer MCP action A",
			schema: z.object({}),
			run: async () => {
				await new Promise((r) => setTimeout(r, 10));
				await executeAction(childAction, { label: "a" });
				return { ok: "a" };
			},
		});

		const outerActionB = defineAction({
			id: "outer_b",
			description: "Outer MCP action B",
			schema: z.object({}),
			run: async () => {
				await new Promise((r) => setTimeout(r, 5));
				await executeAction(childAction, { label: "b" });
				return { ok: "b" };
			},
		});

		const toolA = toMcpTool(outerActionA);
		const toolB = toMcpTool(outerActionB);

		await Promise.all([toolA.handler({}), toolB.handler({})]);

		expect(records).toHaveLength(4);
		const recA = records.find((r) => r.actionId === "outer_a")!;
		const recB = records.find((r) => r.actionId === "outer_b")!;
		const children = records.filter((r) => r.actionId === "child_action");

		expect(recA.parentRequestId).toBeNull();
		expect(recB.parentRequestId).toBeNull();
		expect(recA.traceId).toBe(recA.requestId);
		expect(recB.traceId).toBe(recB.requestId);
		expect(recA.traceId).not.toBe(recB.traceId);

		const childOfA = children.find((r) => r.parentRequestId === recA.requestId)!;
		const childOfB = children.find((r) => r.parentRequestId === recB.requestId)!;
		expect(childOfA).toBeDefined();
		expect(childOfB).toBeDefined();
		expect(childOfA.traceId).toBe(recA.traceId);
		expect(childOfB.traceId).toBe(recB.traceId);
	});

	it("4. static check: configureActionScope( precedes createServer( in both main()s (index.ts and http.ts)", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const indexSrc = readFileSync(resolve(here, "../index.ts"), "utf8");
		const httpSrc = readFileSync(resolve(here, "../http.ts"), "utf8");

		const indexMain = indexSrc.slice(indexSrc.indexOf("async function main()"));
		const indexScopeIdx = indexMain.indexOf("configureActionScope(");
		const indexCreateServerIdx = indexMain.indexOf("createServer(");
		expect(indexScopeIdx).toBeGreaterThan(0);
		expect(indexCreateServerIdx).toBeGreaterThan(indexScopeIdx);

		const httpMain = httpSrc.slice(httpSrc.indexOf("async function main()"));
		const httpScopeIdx = httpMain.indexOf("configureActionScope(");
		const httpActionsRouterIdx = httpMain.indexOf("actionsRouter(");
		const httpCreateServerIdx = httpMain.indexOf("createServer(");
		expect(httpScopeIdx).toBeGreaterThan(0);
		expect(httpActionsRouterIdx).toBeGreaterThan(httpScopeIdx);
		expect(httpCreateServerIdx).toBeGreaterThan(httpScopeIdx);
	});

	it("5. X-Action-Trace-Id never changes caller, approval class, or gate decision", async () => {
		const runSpy = vi.fn(async (input: { message: string }) => ({
			echoed: input.message,
		}));

		const gatedAction = defineAction({
			id: "gated_action",
			description: "Gated action requiring approval for agent callers",
			needsApproval: true,
			schema: z.object({ message: z.string() }),
			run: runSpy,
		});

		const registry = new ActionRegistry();
		registry.register(gatedAction);

		const mockSupabase = {
			auth: {
				getUser: vi.fn(async () => ({
					data: { user: { id: "user-123" } },
					error: null,
				})),
			},
		};

		setActionApprovalStore({
			park: vi.fn(async () => ({ decisionId: "dec-parked-trace" })),
		});

		const app = express();
		app.use(
			"/api/actions",
			actionsRouter({
				registry,
				supabaseClient: mockSupabase,
				rateLimiter: new ActionRateLimiter(20, 60_000),
				ownerUserId: "user-123",
			}),
		);

		const traceUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

		// Agent caller with X-Action-Trace-Id is still parked by the approval gate and records caller="ui_agent"
		const agentRes = await request(app)
			.post("/api/actions/gated_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "ui_agent")
			.set("X-Action-Trace-Id", traceUuid)
			.send({ message: "agent attempt" });

		expect(agentRes.status).toBe(202);
		expect(runSpy).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
		expect(records[0].caller).toBe("ui_agent");
		expect(records[0].outcome).toBe("pending_approval");
		expect(records[0].traceId).toBe(traceUuid);

		// Default/UI caller with X-Action-Trace-Id still runs immediately and records caller="ui"
		const uiRes = await request(app)
			.post("/api/actions/gated_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Trace-Id", traceUuid)
			.send({ message: "human click" });

		expect(uiRes.status).toBe(200);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(records).toHaveLength(2);
		expect(records[1].caller).toBe("ui");
		expect(records[1].outcome).toBe("success");
		expect(records[1].traceId).toBe(traceUuid);
	});
});
