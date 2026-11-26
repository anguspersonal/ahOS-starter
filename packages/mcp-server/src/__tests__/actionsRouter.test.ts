import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { defineAction } from "../actions/defineAction.js";
import { ActionRegistry } from "../actions/registry.js";
import {
	actionsRouter,
	ActionRateLimiter,
	isOriginAllowed,
} from "../actions/actionsRouter.js";

describe("actionsRouter (/api/actions/:id)", { timeout: 30_000 }, () => {
	let testRegistry: ActionRegistry;
	let mockSupabase: any;
	let app: express.Express;

	const testAction = defineAction({
		id: "echo_action",
		name: "echo_action",
		description: "Echoes input back",
		schema: z.object({
			message: z.string().min(1),
		}),
		run: async (input, ctx) => {
			return {
				echoed: input.message,
				caller: ctx?.caller,
				userId: ctx?.userId,
				requestId: ctx?.requestId,
			};
		},
	});

	beforeEach(() => {
		testRegistry = new ActionRegistry();
		testRegistry.register(testAction);

		mockSupabase = {
			auth: {
				getUser: vi.fn(async (token: string) => {
					if (token === "valid-token") {
						return { data: { user: { id: "user-123", email: "test@example.com" } }, error: null };
					}
					if (token === "other-token") {
						return { data: { user: { id: "user-999", email: "other@example.com" } }, error: null };
					}
					if (token === "kms-owner-token") {
						return {
							data: { user: { id: "00000000-0000-0000-0000-000000000000", email: "owner@example.com" } },
							error: null,
						};
					}
					return { data: { user: null }, error: new Error("Invalid token") };
				}),
			},
		};

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

	it("rejects unauthenticated requests without authorization header (401)", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.send({ message: "hello" });

		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/missing or invalid authorization/i);
	});

	it("rejects requests with invalid authorization header format (401)", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Basic 12345")
			.send({ message: "hello" });

		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/missing or invalid authorization/i);
	});

	it("rejects invalid or expired tokens (401)", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer expired-token")
			.send({ message: "hello" });

		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/invalid or expired access token/i);
	});

	it("returns 404 if the requested action does not exist in CAR", async () => {
		const res = await request(app)
			.post("/api/actions/nonexistent_action")
			.set("Authorization", "Bearer valid-token")
			.send({ foo: "bar" });

		expect(res.status).toBe(404);
		expect(res.body.message).toContain("nonexistent_action");
	});

	it("returns 400 with validation errors on invalid schema input", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "" }); // schema requires min(1)

		expect(res.status).toBe(400);
		expect(res.body.message).toBeDefined();
		expect(res.body.errors).toBeDefined();
	});

	it("executes registered action and returns typed result (200)", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Request-Id", "custom-req-id")
			.set("X-Action-Caller", "ui")
			.send({ message: "Greetings from UI" });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			echoed: "Greetings from UI",
			caller: "ui",
			userId: "user-123",
			requestId: "custom-req-id",
		});
	});

	it("defaults caller to 'ui' and generates requestId when headers are omitted", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "Default headers test" });

		expect(res.status).toBe(200);
		expect(res.body.echoed).toBe("Default headers test");
		expect(res.body.caller).toBe("ui");
		expect(res.body.userId).toBe("user-123");
		expect(res.body.requestId).toBeDefined();
	});

	it("rejects unknown X-Action-Caller header values with 400", async () => {
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.set("X-Action-Caller", "system")
			.send({ message: "Caller spoofing attempt" });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe("unknown X-Action-Caller");
	});

	it("enforces rate limits per ADR-096 (429)", async () => {
		const strictLimiter = new ActionRateLimiter(2, 60_000);
		const limitedApp = express();
		limitedApp.use(
			"/api/actions",
			actionsRouter({
				registry: testRegistry,
				supabaseClient: mockSupabase,
				rateLimiter: strictLimiter,
				ownerUserId: "user-123",
			}),
		);

		// First request: OK
		const res1 = await request(limitedApp)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "1" });
		expect(res1.status).toBe(200);

		// Second request: OK
		const res2 = await request(limitedApp)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "2" });
		expect(res2.status).toBe(200);

		// Third request: 429 Rate limited
		const res3 = await request(limitedApp)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: "3" });
		expect(res3.status).toBe(429);
		expect(res3.header["retry-after"]).toBeDefined();
		expect(res3.body.message).toMatch(/rate limit exceeded/i);
	});

	it("rejects 200 requests with no bearer from one IP inside a minute with 429 before calling supabase.auth.getUser", async () => {
		const unmeteredAuthSpy = vi.fn();
		const unauthSupabase = {
			auth: {
				getUser: unmeteredAuthSpy,
			},
		};
		const testApp = express();
		testApp.use(
			"/api/actions",
			actionsRouter({
				registry: testRegistry,
				supabaseClient: unauthSupabase,
				// Default ipRateLimiter is 120 / min
			}),
		);

		let lastRes: request.Response | undefined;
		for (let i = 0; i < 200; i++) {
			lastRes = await request(testApp)
				.post("/api/actions/echo_action")
				.send({ message: "ping" });
		}

		expect(lastRes).toBeDefined();
		expect(lastRes!.status).toBe(429);
		expect(lastRes!.header["retry-after"]).toBeDefined();
		expect(lastRes!.body.message).toMatch(/rate limit exceeded/i);
		expect(unmeteredAuthSpy).not.toHaveBeenCalled();
	});

	it("prunes expired entries from ActionRateLimiter", () => {
		const limiter = new ActionRateLimiter(5, 1_000);
		// Add entry at t=1000
		limiter.isRateLimited("key-1", 1_000);
		// Check key-2 at t=2500 (1500ms later > 1000ms window); should prune key-1
		const res2 = limiter.isRateLimited("key-2", 2_500);
		expect(res2.limited).toBe(false);

		// Check key-1 at t=2500; should start a fresh window of count=1
		const res1 = limiter.isRateLimited("key-1", 2_500);
		expect(res1.limited).toBe(false);
	});

	it("enforces 1mb payload limit (413 for oversized payloads)", async () => {
		const largePayload = "a".repeat(1.5 * 1024 * 1024); // 1.5MB
		const res = await request(app)
			.post("/api/actions/echo_action")
			.set("Authorization", "Bearer valid-token")
			.send({ message: largePayload });

		expect(res.status).toBe(413);
	});

	describe("isOriginAllowed", () => {
		it("allows local dev web origins when NODE_ENV is not production", () => {
			expect(isOriginAllowed("http://localhost:5173")).toBe(true);
			expect(isOriginAllowed("http://localhost:4173")).toBe(true);
			expect(isOriginAllowed("http://127.0.0.1:5173")).toBe(true);
		});

		it("rejects localhost origins when NODE_ENV=production", () => {
			const origEnv = process.env.NODE_ENV;
			try {
				process.env.NODE_ENV = "production";
				expect(isOriginAllowed("http://localhost:5173")).toBe(false);
				expect(isOriginAllowed("http://127.0.0.1:5173")).toBe(false);
			} finally {
				process.env.NODE_ENV = origEnv;
			}
		});

		it("allows non-browser/same-origin calls with undefined origin", () => {
			expect(isOriginAllowed(undefined)).toBe(true);
		});

		it("allows configured origin in allowedOrigins option", () => {
			expect(isOriginAllowed("https://my-custom-domain.com", ["https://my-custom-domain.com"])).toBe(true);
		});

		it("rejects suffix domain origin when WEB_ORIGIN is configured (acceptance case 1)", () => {
			const orig = process.env.WEB_ORIGIN;
			try {
				process.env.WEB_ORIGIN = "https://app.example.com";
				expect(isOriginAllowed("https://app.example.com.evil.net")).toBe(false);
				expect(isOriginAllowed("https://app.example.com")).toBe(true);
			} finally {
				process.env.WEB_ORIGIN = orig;
			}
		});

		it("rejects railway suffix/domain even if RAILWAY_PUBLIC_DOMAIN is set (acceptance case 2)", () => {
			const orig = process.env.RAILWAY_PUBLIC_DOMAIN;
			try {
				process.env.RAILWAY_PUBLIC_DOMAIN = "your-app.up.railway.app";
				expect(isOriginAllowed("https://your-app.up.railway.app.evil.net")).toBe(false);
			} finally {
				process.env.RAILWAY_PUBLIC_DOMAIN = orig;
			}
		});

		it("blocks unauthorized external origins", () => {
			expect(isOriginAllowed("https://evil-hacker.com")).toBe(false);
		});
	});

	describe("owner gate", () => {
		it("rejects non-owner with 403 and message when ownerUserId is configured, never calling action run", async () => {
			const runSpy = vi.fn(async (input: any, ctx: any) => ({
				echoed: input.message,
				caller: ctx?.caller,
				userId: ctx?.userId,
				requestId: ctx?.requestId,
			}));
			const spiedRegistry = new ActionRegistry();
			spiedRegistry.register(
				defineAction({
					id: "echo_action",
					name: "echo_action",
					description: "Echoes input back",
					schema: z.object({
						message: z.string().min(1),
					}),
					run: runSpy,
				}),
			);

			const testApp = express();
			testApp.use(
				"/api/actions",
				actionsRouter({
					registry: spiedRegistry,
					supabaseClient: mockSupabase,
					ownerUserId: "user-123",
				}),
			);

			const res = await request(testApp)
				.post("/api/actions/echo_action")
				.set("Authorization", "Bearer other-token")
				.send({ message: "hello" });

			expect(res.status).toBe(403);
			expect(res.body.message).toBeDefined();
			expect(runSpy).not.toHaveBeenCalled();
		});

		it("rejects non-owner calling unknown action with 403 (no action-name oracle)", async () => {
			const res = await request(app)
				.post("/api/actions/unknown_action")
				.set("Authorization", "Bearer other-token")
				.send({ message: "hello" });

			expect(res.status).toBe(403);
			expect(res.body.message).toBeDefined();
		});

		it("defaults to getCurrentUserId() when ownerUserId is omitted", async () => {
			const defaultOwnerApp = express();
			defaultOwnerApp.use(
				"/api/actions",
				actionsRouter({
					registry: testRegistry,
					supabaseClient: mockSupabase,
				}),
			);

			const nonOwnerRes = await request(defaultOwnerApp)
				.post("/api/actions/echo_action")
				.set("Authorization", "Bearer valid-token")
				.send({ message: "from non-owner" });

			expect(nonOwnerRes.status).toBe(403);
			expect(nonOwnerRes.body.message).toBeDefined();

			const ownerRes = await request(defaultOwnerApp)
				.post("/api/actions/echo_action")
				.set("Authorization", "Bearer kms-owner-token")
				.send({ message: "from owner" });

			expect(ownerRes.status).toBe(200);
			expect(ownerRes.body.echoed).toBe("from owner");
		});

		it("answers 503 failing closed when ownerUserId is empty string", async () => {
			const emptyOwnerApp = express();
			emptyOwnerApp.use(
				"/api/actions",
				actionsRouter({
					registry: testRegistry,
					supabaseClient: mockSupabase,
					ownerUserId: "",
				}),
			);

			const res = await request(emptyOwnerApp)
				.post("/api/actions/echo_action")
				.set("Authorization", "Bearer valid-token")
				.send({ message: "hello" });

			expect(res.status).toBe(503);
			expect(res.body.message).toBeDefined();
		});
	});
});
