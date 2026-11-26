import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRequire } from "node:module";
import {
	ActionRegistry,
	executeAction,
	inputSha256,
	setActionApprovalStore,
	type ActionCaller,
	type ActionDefinition,
	type ApprovalFinishResolution,
	type ApprovalInboxStore,
	type ApprovalRequest,
	type ApprovalResolutionOutcome,
	type ClaimedApproval,
	type PendingApprovalInboxRow,
} from "@ahkms/core";
import {
	buildRegistry,
	type ApprovedRunContext,
	type ApprovedRunner,
} from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { actionsRouter } from "./actionsRouter.js";
import {
	configureApprovals,
	createApprovalActions,
	getConfiguredApprovalStore,
} from "./approvals.js";
import { inboxActionResolver, serverRegistry } from "./serverRegistry.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");

interface InMemoryRow {
	decision_id: string;
	action_id: string;
	input: unknown;
	input_keys: string[];
	input_sha256: string;
	caller: string;
	user_id: string;
	client_id: string | null;
	session_id: string | null;
	status: "pending" | "approved" | "executed" | "failed" | "rejected";
	notes: string | null;
	error?: string;
	created_at: string;
	expires_at: string | null;
}

function createInMemoryApprovalStore(initialRows: InMemoryRow[] = []) {
	const rows = new Map<string, InMemoryRow>(
		initialRows.map((r) => [r.decision_id, { ...r }]),
	);
	const calls: Array<{ method: string; args: unknown[] }> = [];

	const store: ApprovalInboxStore = {
		async park(req: ApprovalRequest) {
			calls.push({ method: "park", args: [req] });
			const id = "00000000-0000-4000-8000-000000000099";
			rows.set(id, {
				decision_id: id,
				action_id: req.actionId,
				input: req.input,
				input_keys:
					req.input && typeof req.input === "object"
						? Object.keys(req.input as Record<string, unknown>)
						: [],
				input_sha256: req.inputSha256,
				caller: req.caller,
				user_id: req.userId ?? "user-123",
				client_id: req.clientId,
				session_id: req.sessionId,
				status: "pending",
				notes: null,
				created_at: "2026-10-19T12:00:00.000Z",
				expires_at: "2026-10-26T12:00:00.000Z",
			});
			return { decisionId: id };
		},
		async claim(
			decisionId: string,
			approverUserId: string,
			notes?: string | null,
		): Promise<ClaimedApproval | null> {
			calls.push({ method: "claim", args: [decisionId, approverUserId, notes] });
			const row = rows.get(decisionId);
			if (!row || row.status !== "pending" || row.user_id !== approverUserId) {
				return null;
			}
			row.status = "approved";
			row.notes = notes ?? null;
			return {
				decisionId: row.decision_id,
				actionId: row.action_id,
				input: row.input,
				inputSha256: row.input_sha256,
				caller: row.caller,
				userId: row.user_id,
			};
		},
		async finish(
			decisionId: string,
			resolution: ApprovalResolutionOutcome | ApprovalFinishResolution,
			error?: string,
		): Promise<void> {
			calls.push({ method: "finish", args: [decisionId, resolution, error] });
			const row = rows.get(decisionId);
			if (!row || row.status !== "approved") {
				throw new Error(`Row ${decisionId} is not approved`);
			}
			const outcome =
				typeof resolution === "string"
					? resolution
					: (resolution.outcome ?? resolution.status ?? "executed");
			row.status = outcome;
			row.error = typeof resolution === "string" ? error : resolution.error;
		},
		async reject(
			decisionId: string,
			approverUserId: string,
			notes?: string | null,
		): Promise<boolean> {
			calls.push({
				method: "reject",
				args: [decisionId, approverUserId, notes],
			});
			const row = rows.get(decisionId);
			if (!row || row.status !== "pending" || row.user_id !== approverUserId) {
				return false;
			}
			row.status = "rejected";
			row.notes = notes ?? null;
			return true;
		},
		async listPending(
			userId: string,
			limit: number,
		): Promise<PendingApprovalInboxRow[]> {
			calls.push({ method: "listPending", args: [userId, limit] });
			return Array.from(rows.values())
				.filter((r) => r.user_id === userId && r.status === "pending")
				.sort((a, b) => b.created_at.localeCompare(a.created_at))
				.slice(0, limit)
				.map((r) => ({
					decision_id: r.decision_id,
					action_id: r.action_id,
					input: r.input,
					input_keys: r.input_keys,
					caller: r.caller,
					client_id: r.client_id,
					session_id: r.session_id,
					created_at: r.created_at,
					expires_at: r.expires_at,
				}));
		},
	};

	return { store, rows, calls };
}

function buildRouterApp(registry: ActionRegistry) {
	const stubSupabase = {
		auth: {
			getUser: vi.fn(async (token: string) => {
				if (token === "valid-token") {
					return {
						data: { user: { id: "user-123", email: "owner@example.com" } },
						error: null,
					};
				}
				return { data: { user: null }, error: new Error("Invalid token") };
			}),
		},
	};
	const app = express();
	app.use(
		"/api/actions",
		actionsRouter({
			registry,
			supabaseClient: stubSupabase as any,
			ownerUserId: "user-123",
		}),
	);
	return app;
}

const DEC_1 = "11111111-1111-4111-8111-111111111111";
const DEC_2 = "22222222-2222-4222-8222-222222222222";

describe("approval_list, approval_approve and approval_reject (#1422)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	it("1. Refusal: rejects non-ui callers and ui without userId with 403 before touching the store", async () => {
		const { store, calls } = createInMemoryApprovalStore();
		const actions = createApprovalActions({
			getStore: () => store,
			resolve: () => undefined,
		});

		const validInputs: Record<string, unknown> = {
			approval_list: {},
			approval_approve: { decision_id: DEC_1 },
			approval_reject: { decision_id: DEC_1 },
		};

		const forbiddenCallers: Array<ActionCaller | undefined> = [
			"mcp",
			"worker",
			"internal",
			"http",
			"cli",
			"a2a",
			"test",
			"ui_agent",
			undefined,
		];

		for (const action of actions as ReadonlyArray<ActionDefinition<any, unknown>>) {
			const input = validInputs[action.id];
			for (const caller of forbiddenCallers) {
				await expect(
					executeAction(action, input, {
						context: {
							...(caller ? { caller } : {}),
							userId: "user-123",
						},
					}),
				).rejects.toMatchObject({
					message: "approval actions run only from the owner's web session",
					status: 403,
				});
			}

			await expect(
				executeAction(action, input, {
					context: { caller: "ui" },
				}),
			).rejects.toMatchObject({
				message: "approval actions run only from the owner's web session",
				status: 403,
			});
		}

		expect(calls).toHaveLength(0);
	});

	it("2. Not on MCP: listTools() contains none of the three; manifest and registries declare http-only owner_only", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const client = new Client(
			{ name: "test", version: "0" },
			{ capabilities: {} },
		);
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		const { tools } = await client.listTools();
		await client.close();

		const toolNames = new Set(tools.map((t) => t.name));
		const coreReg = buildRegistry({});
		const srvReg = serverRegistry();

		for (const id of [
			"approval_list",
			"approval_approve",
			"approval_reject",
		] as const) {
			expect(toolNames.has(id)).toBe(false);

			const entry = manifest.actions[id];
			expect(entry).toBeDefined();
			expect(entry.expose.http).toBe(true);
			expect(entry.expose.mcp).toBe(false);
			expect(entry.expose.ui_agent).toBe(false);
			expect(entry.expose.worker).toBe(false);
			expect(entry.expose.reason).toBe("owner_only");
			expect(typeof entry.expose.note).toBe("string");
			expect(entry.expose.note.length).toBeGreaterThan(0);

			expect(coreReg.get(id)).toBeDefined();
			expect(srvReg.get(id)).toBeDefined();
		}
	});

	it("3. Approve over HTTP: ui_agent gets 403, owner ui gets 200 and runs once, second POST gets 409", async () => {
		const storedInput = { page_id: "p-1", title: "Hello" };
		const hash = await inputSha256(storedInput);
		const { store, rows } = createInMemoryApprovalStore([
			{
				decision_id: DEC_1,
				action_id: "notion_page_create",
				input: storedInput,
				input_keys: ["page_id", "title"],
				input_sha256: hash,
				caller: "mcp",
				user_id: "user-123",
				client_id: "claude-web",
				session_id: "sess-1",
				status: "pending",
				notes: null,
				created_at: "2026-10-19T11:00:00.000Z",
				expires_at: "2026-10-26T11:00:00.000Z",
			},
		]);

		const runnerCalls: Array<{ input: unknown; context: ApprovedRunContext }> =
			[];
		const resolve = (actionId: string): ApprovedRunner | undefined => {
			if (actionId !== "notion_page_create") return undefined;
			return async (input, context) => {
				runnerCalls.push({ input, context });
				return { created_id: "notion-99" };
			};
		};

		const registry = new ActionRegistry();
		for (const action of createApprovalActions({
			getStore: () => store,
			resolve,
		})) {
			registry.register(action);
		}
		const app = buildRouterApp(registry);

		const uiAgentRes = await request(app)
			.post("/api/actions/approval_approve")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "ui_agent")
			.send({ decision_id: DEC_1 });

		expect(uiAgentRes.status).toBe(403);
		expect(rows.get(DEC_1)?.status).toBe("pending");
		expect(runnerCalls).toHaveLength(0);

		const okRes = await request(app)
			.post("/api/actions/approval_approve")
			.set("Authorization", "Bearer valid-token")
			.send({ decision_id: DEC_1 });

		expect(okRes.status).toBe(200);
		expect(okRes.body).toEqual({
			status: "executed",
			result: { created_id: "notion-99" },
		});
		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]).toEqual({
			input: storedInput,
			context: {
				caller: "mcp",
				userId: "user-123",
				approval: {
					decisionId: DEC_1,
					actionId: "notion_page_create",
					inputSha256: hash,
				},
			},
		});
		expect(rows.get(DEC_1)?.status).toBe("executed");

		const secondRes = await request(app)
			.post("/api/actions/approval_approve")
			.set("Authorization", "Bearer valid-token")
			.send({ decision_id: DEC_1 });

		expect(secondRes.status).toBe(409);
		expect(secondRes.body.message).toMatch(/is not pending/);
		expect(runnerCalls).toHaveLength(1);
	});

	it("4. Approve takes only the id: extra input key gives 400 and store sees no call", async () => {
		const { store, calls } = createInMemoryApprovalStore();
		const registry = new ActionRegistry();
		for (const action of createApprovalActions({
			getStore: () => store,
			resolve: () => undefined,
		})) {
			registry.register(action);
		}
		const app = buildRouterApp(registry);

		const res = await request(app)
			.post("/api/actions/approval_approve")
			.set("Authorization", "Bearer valid-token")
			.send({ decision_id: DEC_1, input: {} });

		expect(res.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("5. List: approval_list {} as ui returns newest first with exact shape from one listPending('user-123', 50) call", async () => {
		const { store, calls } = createInMemoryApprovalStore([
			{
				decision_id: DEC_1,
				action_id: "github_issue_create",
				input: { title: "Older" },
				input_keys: ["title"],
				input_sha256: "hash-1",
				caller: "mcp",
				user_id: "user-123",
				client_id: null,
				session_id: null,
				status: "pending",
				notes: null,
				created_at: "2026-10-19T10:00:00.000Z",
				expires_at: "2026-10-26T10:00:00.000Z",
			},
			{
				decision_id: DEC_2,
				action_id: "notion_block_delete",
				input: { block_id: "b-2" },
				input_keys: ["block_id"],
				input_sha256: "hash-2",
				caller: "ui_agent",
				user_id: "user-123",
				client_id: "web",
				session_id: "s-2",
				status: "pending",
				notes: null,
				created_at: "2026-10-19T11:30:00.000Z",
				expires_at: "2026-10-26T11:30:00.000Z",
			},
		]);

		const { approval_list } = createApprovalActions({
			getStore: () => store,
			resolve: () => undefined,
		});

		const result = await executeAction(
			approval_list,
			{},
			{ context: { caller: "ui", userId: "user-123" } },
		);

		expect(calls).toEqual([{ method: "listPending", args: ["user-123", 50] }]);
		expect(result).toEqual({
			approvals: [
				{
					decision_id: DEC_2,
					action_id: "notion_block_delete",
					input: { block_id: "b-2" },
					input_keys: ["block_id"],
					caller: "ui_agent",
					client_id: "web",
					session_id: "s-2",
					created_at: "2026-10-19T11:30:00.000Z",
					expires_at: "2026-10-26T11:30:00.000Z",
				},
				{
					decision_id: DEC_1,
					action_id: "github_issue_create",
					input: { title: "Older" },
					input_keys: ["title"],
					caller: "mcp",
					client_id: null,
					session_id: null,
					created_at: "2026-10-19T10:00:00.000Z",
					expires_at: "2026-10-26T10:00:00.000Z",
				},
			],
		});
	});

	it("6. Reject: approval_reject marks row rejected with notes without running runner, and second call gives 409", async () => {
		const { store, rows } = createInMemoryApprovalStore([
			{
				decision_id: DEC_1,
				action_id: "notion_block_delete",
				input: { block_id: "b-1" },
				input_keys: ["block_id"],
				input_sha256: "hash-1",
				caller: "mcp",
				user_id: "user-123",
				client_id: null,
				session_id: null,
				status: "pending",
				notes: null,
				created_at: "2026-10-19T11:00:00.000Z",
				expires_at: "2026-10-26T11:00:00.000Z",
			},
		]);

		let runnerCount = 0;
		const registry = new ActionRegistry();
		for (const action of createApprovalActions({
			getStore: () => store,
			resolve: () => async () => {
				runnerCount += 1;
				return {};
			},
		})) {
			registry.register(action);
		}
		const app = buildRouterApp(registry);

		const res1 = await request(app)
			.post("/api/actions/approval_reject")
			.set("Authorization", "Bearer valid-token")
			.send({ decision_id: DEC_1, notes: "no" });

		expect(res1.status).toBe(200);
		expect(res1.body).toEqual({ status: "rejected", decision_id: DEC_1 });
		expect(rows.get(DEC_1)?.status).toBe("rejected");
		expect(rows.get(DEC_1)?.notes).toBe("no");
		expect(runnerCount).toBe(0);

		const res2 = await request(app)
			.post("/api/actions/approval_reject")
			.set("Authorization", "Bearer valid-token")
			.send({ decision_id: DEC_1, notes: "no" });

		expect(res2.status).toBe(409);
		expect(res2.body.message).toMatch(/is not pending/);
	});

	it("7. No store: when getStore returns undefined, each action rejects with status 503", async () => {
		const actions = createApprovalActions({
			getStore: () => undefined,
			resolve: () => undefined,
		});

		const validInputs: Record<string, unknown> = {
			approval_list: {},
			approval_approve: { decision_id: DEC_1 },
			approval_reject: { decision_id: DEC_1 },
		};

		for (const action of actions as ReadonlyArray<ActionDefinition<any, unknown>>) {
			await expect(
				executeAction(action, validInputs[action.id], {
					context: { caller: "ui", userId: "user-123" },
				}),
			).rejects.toMatchObject({
				message: "no approval store is configured",
				status: 503,
			});
		}

		expect(getConfiguredApprovalStore()).toBeUndefined();
		const installed = configureApprovals({ from: () => ({}) as any });
		expect(getConfiguredApprovalStore()).toBe(installed);
	});

	it("8. Resolver: manifest inbox resolver resolves entity_crud and notion_block_delete, and returns undefined for approval_approve or unknown id", () => {
		expect(inboxActionResolver("entity_crud")).toBeDefined();
		expect(inboxActionResolver("notion_block_delete")).toBeDefined();
		expect(inboxActionResolver("approval_approve")).toBeUndefined();
		expect(inboxActionResolver("approval_list")).toBeUndefined();
		expect(inboxActionResolver("approval_reject")).toBeUndefined();
		expect(inboxActionResolver("unknown_action_id")).toBeUndefined();
	});

	it("9. configureApprovals wraps store with Slack approval card notifier when bot token and owner_user_id resolve (#1534)", async () => {
		const prevToken = process.env.SLACK_TOKEN_BOT_OAUTH;
		const prevWebUrl = process.env.AHOS_WEB_URL;
		process.env.SLACK_TOKEN_BOT_OAUTH = "test-slack-b-token";
		process.env.AHOS_WEB_URL = "https://ahos.example.com";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => JSON.stringify({ ok: true, channel: "D_OWNER", ts: "1700000000.000001" }),
		} as unknown as Response);
		try {
			const mockClient = {
				from(table: string) {
					if (table === "system_decisions") {
						return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: "dec-slack-1" }, error: null }) }) }) };
					}
					return {
						select: () => ({
							eq: () => ({
								eq: () => ({
									maybeSingle: async () => ({ data: { enabled: true, config: { owner_user_id: "U_OWNER_99" } }, error: null }),
								}),
							}),
						}),
					};
				},
			};
			const store = configureApprovals(mockClient as any);
			const parked = await store.park({
				actionId: "slack_post",
				input: { channel: "C1", text: "Hi <!channel>" },
				inputSha256: "hash-99",
				caller: "mcp",
				requestId: "req-99",
				userId: "user-123",
				clientId: "claude-code",
				sessionId: "sess-99",
			});
			expect(parked).toEqual({ decisionId: "dec-slack-1" });
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
			expect(body.channel).toBe("U_OWNER_99");
			expect(JSON.stringify(body.blocks)).toContain("&lt;!channel&gt;");
			expect(JSON.stringify(body.blocks)).toContain("https://ahos.example.com/approvals");
		} finally {
			fetchSpy.mockRestore();
			if (prevToken === undefined) delete process.env.SLACK_TOKEN_BOT_OAUTH;
			else process.env.SLACK_TOKEN_BOT_OAUTH = prevToken;
			if (prevWebUrl === undefined) delete process.env.AHOS_WEB_URL;
			else process.env.AHOS_WEB_URL = prevWebUrl;
		}
	});
});
