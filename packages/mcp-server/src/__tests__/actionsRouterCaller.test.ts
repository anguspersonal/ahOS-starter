import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { setActionApprovalStore } from "@ahkms/core";
import { defineAction } from "../actions/defineAction.js";
import { ActionRegistry } from "../actions/registry.js";
import { actionsRouter, ActionRateLimiter } from "../actions/actionsRouter.js";

describe("actionsRouter X-Action-Caller & approval gate (#1418)", () => {
	let testRegistry: ActionRegistry;
	let mockSupabase: any;
	let app: express.Express;
	let runSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		runSpy = vi.fn(async (input: { message: string }, ctx) => ({
			echoed: input.message,
			caller: ctx?.caller,
		}));

		const gatedAction = defineAction({
			id: "gated_action",
			name: "gated_action",
			description: "Action requiring approval",
			needsApproval: true,
			schema: z.object({
				message: z.string().min(1),
			}),
			run: runSpy,
		});

		testRegistry = new ActionRegistry();
		testRegistry.register(gatedAction);

		mockSupabase = {
			auth: {
				getUser: vi.fn(async (token: string) => {
					if (token === "valid-token") {
						return { data: { user: { id: "user-123", email: "test@example.com" } }, error: null };
					}
					return { data: { user: null }, error: new Error("Invalid token") };
				}),
			},
		};

		setActionApprovalStore({
			park: vi.fn(async () => ({ decisionId: "dec-parked-123" })),
		});

		app = express();
		app.use(
			"/api/actions",
			actionsRouter({
				registry: testRegistry,
				supabaseClient: mockSupabase,
				rateLimiter: new ActionRateLimiter(10, 60_000),
				ownerUserId: "user-123",
			}),
		);
	});

	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	it("returns 202 pending_approval when X-Action-Caller is ui_agent and does not call run", async () => {
		const res = await request(app)
			.post("/api/actions/gated_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "ui_agent")
			.send({ message: "agent call" });

		expect(res.status).toBe(202);
		expect(res.body).toEqual({
			status: "pending_approval",
			decision_id: "dec-parked-123",
			action_id: "gated_action",
		});
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("returns 200 and calls run once when X-Action-Caller is omitted or 'ui'", async () => {
		const resOmitted = await request(app)
			.post("/api/actions/gated_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "human click no header" });

		expect(resOmitted.status).toBe(200);
		expect(resOmitted.body).toEqual({
			echoed: "human click no header",
			caller: "ui",
		});
		expect(runSpy).toHaveBeenCalledTimes(1);

		runSpy.mockClear();

		const resUi = await request(app)
			.post("/api/actions/gated_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "ui")
			.send({ message: "human click ui header" });

		expect(resUi.status).toBe(200);
		expect(resUi.body).toEqual({
			echoed: "human click ui header",
			caller: "ui",
		});
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("returns 400 unknown X-Action-Caller for 'mcp', 'system', or repeated headers without calling run", async () => {
		for (const badCaller of ["mcp", "system", "ui, ui_agent"]) {
			const res = await request(app)
				.post("/api/actions/gated_action")
				.set("Authorization", "Bearer valid-token")
				.set("X-Action-Caller", badCaller)
				.send({ message: "spoof" });

			expect(res.status).toBe(400);
			expect(res.body).toEqual({ message: "unknown X-Action-Caller" });
		}
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("returns 403 with refusal message when ui_agent calls a gated action with no approval store installed", async () => {
		setActionApprovalStore(undefined);

		const res = await request(app)
			.post("/api/actions/gated_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "ui_agent")
			.send({ message: "agent call without store" });

		expect(res.status).toBe(403);
		expect(res.body.message).toMatch(/approval/i);
		expect(runSpy).not.toHaveBeenCalled();
	});
});
