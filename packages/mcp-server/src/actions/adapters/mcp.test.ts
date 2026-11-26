import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import express from "express";
import request from "supertest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ActionRegistry,
	getActionScope,
	noopActionScope,
	setActionScope,
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
	type ActionAuditSink,
} from "@ahkms/core";
import { defineAction } from "../defineAction.js";
import { toMcpTool } from "./mcp.js";
import { actionsRouter } from "../actionsRouter.js";
import { configureActionScope } from "../scope.js";
import {
	defaultSessionTraceTracker,
	SESSION_TURN_WINDOW_MS,
} from "../sessionTrace.js";

describe("toMcpTool", () => {
	beforeEach(() => {
		defaultSessionTraceTracker.clear();
	});

	afterEach(() => {
		defaultSessionTraceTracker.clear();
		setActionScope(noopActionScope);
		setDefaultAuditSink(stderrAuditSink);
		vi.useRealTimers();
	});
	it("converts an ActionDefinition into valid McpServer tool config and handler", async () => {
		const action = defineAction({
			id: "calculate_area",
			description: "Calculate rectangle area.",
			schema: z.object({
				width: z.number().positive(),
				height: z.number().positive(),
			}),
			outputSchema: z.object({
				area: z.number(),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
			run: async ({ width, height }, ctx) => {
				expect(ctx.caller).toBe("mcp");
				expect(typeof ctx.requestId).toBe("string");
				return { area: width * height };
			},
		});

		const mcpTool = toMcpTool(action);

		expect(mcpTool.name).toBe("calculate_area");
		expect(mcpTool.config.description).toBe("Calculate rectangle area.");
		expect(mcpTool.config.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const res = await mcpTool.handler({ width: 5, height: 4 });
		expect(res).toEqual({
			content: [
				{
					type: "text",
					text: JSON.stringify({ area: 20 }, null, 2),
				},
			],
			structuredContent: { area: 20 },
		});
	});

	it("formats raw string return values without extra JSON stringification", async () => {
		const action = defineAction({
			id: "format_message",
			description: "Format a greeting.",
			schema: z.object({
				name: z.string(),
			}),
			run: async ({ name }) => {
				return `Hello, ${name}!`;
			},
		});

		const mcpTool = toMcpTool(action);
		const res = await mcpTool.handler({ name: "Alice" });
		expect(res).toEqual({
			content: [
				{
					type: "text",
					text: "Hello, Alice!",
				},
			],
		});
	});

	it("uses custom formatMcp presentation function when provided", async () => {
		const action = defineAction({
			id: "formatted_report",
			description: "Action with custom text formatting.",
			schema: z.object({
				items: z.array(z.string()),
			}),
			run: async ({ items }) => {
				return { count: items.length, items };
			},
			formatMcp: (result) => `Total items: ${result.count}\n${result.items.join(", ")}`,
		});

		const mcpTool = toMcpTool(action);
		const res = await mcpTool.handler({ items: ["apple", "banana"] });
		expect(res).toEqual({
			content: [
				{
					type: "text",
					text: "Total items: 2\napple, banana",
				},
			],
			structuredContent: { count: 2, items: ["apple", "banana"] },
		});
	});

	it("extracts domain routing and passes it into ActionContext", async () => {
		const action = defineAction({
			id: "domain_aware_action",
			description: "Action requiring domain routing.",
			schema: z.object({
				domain: z.enum(["work", "angus"]),
				task: z.string(),
			}),
			run: async ({ task }, ctx) => {
				return { domainSeen: ctx.domain, task };
			},
		});

		const mcpTool = toMcpTool(action);
		const res = await mcpTool.handler({ domain: "work", task: "review" });
		const parsed = JSON.parse(res.content[0].text);
		expect(parsed.domainSeen).toBe("work");
	});

	it("logs audit information on execution", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const action = defineAction({
			id: "audited_action",
			description: "Action with audit trail logging.",
			schema: z.object({
				value: z.string(),
			}),
			run: async ({ value }) => {
				return { echoed: value };
			},
		});

		const mcpTool = toMcpTool(action);
		await mcpTool.handler({ value: "test-audit" });

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringMatching(/\[audit:action\] audited_action caller=mcp requestId=/),
		);

		consoleSpy.mockRestore();
	});

	it("rethrows errors encountered during action execution", async () => {
		const action = defineAction({
			id: "failing_action",
			description: "Action that throws an error.",
			schema: z.object({}),
			run: async () => {
				throw new Error("Deliberate failure for test");
			},
		});

		const mcpTool = toMcpTool(action);
		await expect(mcpTool.handler({})).rejects.toThrow("Deliberate failure for test");
	});

	it("registers and executes cleanly over live McpServer client transport", async () => {
		const server = new McpServer({ name: "test-actions-server", version: "1.0.0" });

		const action = defineAction({
			id: "multiply_numbers",
			description: "Multiply two numbers.",
			schema: z.object({
				x: z.number(),
				y: z.number(),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
			run: async ({ x, y }) => {
				return { product: x * y };
			},
		});

		const mcpTool = toMcpTool(action);
		(server.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(
			mcpTool.name,
			mcpTool.config,
			mcpTool.handler,
		);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "multiply_numbers");
		expect(tool).toBeDefined();
		expect(tool?.description).toBe("Multiply two numbers.");
		expect(tool?.annotations?.readOnlyHint).toBe(true);

		const callResult = await client.callTool({
			name: "multiply_numbers",
			arguments: { x: 6, y: 7 },
		});

		await client.close();

		expect(callResult.content).toBeDefined();
		const textContent = (callResult.content as { type: "text"; text: string }[])[0].text;
		expect(JSON.parse(textContent)).toEqual({ product: 42 });
	});

	describe("audit sink", () => {
		it("records caller, clientId, and sessionId to custom auditSink, defaulting empty clientId and missing sessionId to null", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (rec) => {
				records.push(rec);
			};

			const action = defineAction({
				id: "test_attributed_action",
				description: "Test action with attribution.",
				schema: z.object({
					msg: z.string(),
				}),
				run: async ({ msg }) => ({ received: msg }),
			});

			const mcpTool = toMcpTool(action, { auditSink });

			// 1. With authInfo and sessionId
			await mcpTool.handler(
				{ msg: "hello" },
				{
					authInfo: { token: "t", clientId: "c1", scopes: [] },
					sessionId: "s1",
				},
			);

			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				actionId: "test_attributed_action",
				caller: "mcp",
				clientId: "c1",
				sessionId: "s1",
				outcome: "success",
			});

			// 2. With clientId: "" and no sessionId
			records.length = 0;
			await mcpTool.handler(
				{ msg: "hello again" },
				{
					authInfo: { token: "t", clientId: "", scopes: [] },
				},
			);

			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				actionId: "test_attributed_action",
				caller: "mcp",
				clientId: null,
				sessionId: null,
				outcome: "success",
			});
		});

		it("records exactly one record when action.run throws", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (rec) => {
				records.push(rec);
			};

			const action = defineAction({
				id: "test_throwing_action",
				description: "Test action that throws.",
				schema: z.object({}),
				run: async () => {
					throw new Error("Deliberate failure");
				},
			});

			const mcpTool = toMcpTool(action, { auditSink });

			await expect(
				mcpTool.handler(
					{},
					{
						authInfo: { token: "t", clientId: "client_err", scopes: [] },
						sessionId: "sess_err",
					},
				),
			).rejects.toThrow("Deliberate failure");

			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				actionId: "test_throwing_action",
				caller: "mcp",
				clientId: "client_err",
				sessionId: "sess_err",
				outcome: "error",
				errorMessage: "Deliberate failure",
			});
		});

		it("correlates consecutive same-session calls with shared traceId and parentRequestId and expires after SESSION_TURN_WINDOW_MS (#2054)", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (rec) => {
				records.push(rec);
			};

			const action = defineAction({
				id: "session_burst_action",
				description: "Action testing session trace correlation.",
				schema: z.object({ step: z.number() }),
				run: async ({ step }, ctx) => ({
					step,
					requestId: ctx.requestId,
					parentRequestId: ctx.parentRequestId,
					traceId: ctx.traceId,
				}),
			});

			const mcpTool = toMcpTool(action, { auditSink });
			const extra = {
				authInfo: { token: "t", clientId: "c1", scopes: [] },
				sessionId: "mcp-session-42",
			};

			await mcpTool.handler({ step: 1 }, extra);
			vi.advanceTimersByTime(4_000);
			await mcpTool.handler({ step: 2 }, extra);

			expect(records).toHaveLength(2);
			expect(records[0].parentRequestId).toBeNull();
			expect(records[0].traceId).toBe(records[0].requestId);
			expect(records[1].traceId).toBe(records[0].traceId);
			expect(records[1].parentRequestId).toBe(records[0].requestId);

			// Expire turn window
			vi.advanceTimersByTime(SESSION_TURN_WINDOW_MS + 1);
			await mcpTool.handler({ step: 3 }, extra);

			expect(records).toHaveLength(3);
			expect(records[2].parentRequestId).toBeNull();
			expect(records[2].traceId).toBe(records[2].requestId);
			expect(records[2].traceId).not.toBe(records[0].traceId);
		});

		it("preserves in-process ActionScope parentCtx over SessionTraceTracker in toMcpTool (#2054)", async () => {
			configureActionScope();
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (rec) => {
				records.push(rec);
			};

			const action = defineAction({
				id: "nested_mcp_action",
				description: "Action testing nested scope precedence.",
				schema: z.object({}),
				run: async () => ({ ok: true }),
			});

			const mcpTool = toMcpTool(action, { auditSink });
			const extra = {
				authInfo: { token: "t", clientId: "c1", scopes: [] },
				sessionId: "mcp-session-nested",
			};

			await mcpTool.handler({}, extra);
			await getActionScope().run(
				{
					caller: "mcp",
					requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				},
				async () => {
					await mcpTool.handler({}, extra);
				},
			);

			expect(records).toHaveLength(2);
			expect(records[1].parentRequestId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
			expect(records[1].traceId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
		});

		it("forwards validated X-Parent-Request-Id in actionsRouter and exposes it in CORS allowedHeaders (#2054)", async () => {
			const records: ActionAuditRecord[] = [];
			setDefaultAuditSink((rec) => {
				records.push(rec);
			});

			const ownerId = "00000000-0000-0000-0000-000000000001";
			const registry = new ActionRegistry();
			registry.register(
				defineAction({
					id: "http_parent_test",
					description: "Action verifying X-Parent-Request-Id forwarding.",
					schema: z.object({}),
					run: async (_input, ctx) => ({
						parentRequestId: ctx.parentRequestId ?? null,
						traceId: ctx.traceId ?? null,
					}),
				}),
			);

			const app = express();
			app.use(
				"/api/actions",
				actionsRouter({
					registry,
					ownerUserId: ownerId,
					allowedOrigins: ["http://localhost:5173"],
					supabaseClient: {
						auth: {
							getUser: async () => ({
								data: { user: { id: ownerId } },
								error: null,
							}),
						},
					},
				}),
			);

			const preflight = await request(app)
				.options("/api/actions/http_parent_test")
				.set("Origin", "http://localhost:5173")
				.set("Access-Control-Request-Method", "POST");
			expect(preflight.headers["access-control-allow-headers"]).toContain(
				"X-Parent-Request-Id",
			);

			const validParentId = "12345678-1234-4234-8234-1234567890ab";
			const validTraceId = "87654321-4321-4321-8321-ba0987654321";
			const res = await request(app)
				.post("/api/actions/http_parent_test")
				.set("Authorization", "Bearer valid-token")
				.set("X-Parent-Request-Id", validParentId)
				.set("X-Action-Trace-Id", validTraceId)
				.send({});

			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				parentRequestId: validParentId,
				traceId: validTraceId,
			});
			expect(records).toHaveLength(1);
			expect(records[0].parentRequestId).toBe(validParentId);
			expect(records[0].traceId).toBe(validTraceId);
		});
	});

	describe("structuredContent (#2333)", () => {
		it("1. returns full plain-object result as structuredContent alongside custom formatMcp text", async () => {
			const action = defineAction({
				id: "calendar_stub_event",
				description: "Stub calendar event.",
				schema: z.object({}),
				run: async () => ({ id: "e1", summary: "Standup", etag: '"abc"' }),
				formatMcp: (r) => r.summary,
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			const res = await mcpTool.handler({});
			expect(res.content).toEqual([{ type: "text", text: "Standup" }]);
			expect(res.structuredContent).toEqual({ id: "e1", summary: "Standup", etag: '"abc"' });
		});

		it("2. wraps array results in { result: [...] }", async () => {
			const action = defineAction({
				id: "array_result_action",
				description: "Returns array.",
				schema: z.object({}),
				run: async () => [1, 2],
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			const res = await mcpTool.handler({});
			expect(res.structuredContent).toEqual({ result: [1, 2] });
		});

		it("3. omits structuredContent key when result is a string", async () => {
			const action = defineAction({
				id: "string_result_action",
				description: "Returns string.",
				schema: z.object({}),
				run: async () => "plain text",
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			const res = await mcpTool.handler({});
			expect(res.content).toEqual([{ type: "text", text: "plain text" }]);
			expect("structuredContent" in res).toBe(false);
		});

		it("4. uses mcpStructured hook return value while keeping text unchanged", async () => {
			const action = defineAction({
				id: "hook_structured_action",
				description: "Uses mcpStructured.",
				schema: z.object({}),
				run: async () => ({ id: "abc", extra: "ignored" }),
				formatMcp: (r) => `ID: ${r.id}`,
				mcpStructured: (r) => ({ id: r.id }),
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			const res = await mcpTool.handler({});
			expect(res.content).toEqual([{ type: "text", text: "ID: abc" }]);
			expect(res.structuredContent).toEqual({ id: "abc" });
		});

		it("5. omits structuredContent key when mcpStructured returns undefined", async () => {
			const action = defineAction({
				id: "hook_undefined_action",
				description: "Hook returns undefined.",
				schema: z.object({}),
				run: async () => ({ id: "abc" }),
				mcpStructured: () => undefined,
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			const res = await mcpTool.handler({});
			expect("structuredContent" in res).toBe(false);
		});

		it("6. logs warning and omits structuredContent without throwing when result has BigInt", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const action = defineAction({
				id: "bigint_result_action",
				description: "Returns BigInt.",
				schema: z.object({}),
				run: async () => ({ count: BigInt(42) }),
				formatMcp: (r) => `count=${r.count.toString()}`,
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			const res = await mcpTool.handler({});
			expect(res.content).toEqual([{ type: "text", text: "count=42" }]);
			expect("structuredContent" in res).toBe(false);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bigint_result_action"));
			warnSpy.mockRestore();
		});

		it("7. toMcpTool(action).config has no outputSchema key", () => {
			const action = defineAction({
				id: "with_output_schema_action",
				description: "Has outputSchema.",
				schema: z.object({}),
				outputSchema: z.object({ ok: z.boolean() }),
				run: async () => ({ ok: true }),
			});

			const mcpTool = toMcpTool(action);
			expect("outputSchema" in mcpTool.config).toBe(false);
		});

		it("8. InMemoryTransport SDK client callTool receives structuredContent and listTools has no outputSchema", async () => {
			const server = new McpServer({ name: "test-structured-server", version: "1.0.0" });
			const action = defineAction({
				id: "structured_wire_action",
				description: "Wire test action.",
				schema: z.object({ name: z.string() }),
				outputSchema: z.object({ greeting: z.string(), etag: z.string() }),
				run: async ({ name }) => ({ greeting: `Hi ${name}`, etag: '"v1"' }),
				formatMcp: (r) => r.greeting,
			});

			const mcpTool = toMcpTool(action, { auditSink: () => {} });
			(server.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(
				mcpTool.name,
				mcpTool.config,
				mcpTool.handler,
			);

			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

			await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

			const { tools } = await client.listTools();
			const tool = tools.find((t) => t.name === "structured_wire_action");
			expect(tool).toBeDefined();
			expect(tool?.outputSchema).toBeUndefined();

			const callResult = await client.callTool({
				name: "structured_wire_action",
				arguments: { name: "Ada" },
			});

			await client.close();

			expect(callResult.content).toEqual([{ type: "text", text: "Hi Ada" }]);
			expect(callResult.structuredContent).toEqual({ greeting: "Hi Ada", etag: '"v1"' });
		});
	});
});
