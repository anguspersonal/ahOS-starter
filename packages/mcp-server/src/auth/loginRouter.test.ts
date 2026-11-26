import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OwnerOAuthProvider } from "./ownerOAuthProvider.js";
import { ownerLoginRouter } from "./loginRouter.js";
import { LoginRateLimiter } from "./loginRateLimiter.js";
import type { HttpEnv } from "../env.js";

const ISSUER = "https://ahkms.example.com";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const PASSWORD = "correct horse battery staple";

const httpEnv: HttpEnv = {
	port: 8080,
	publicUrl: ISSUER,
	ownerPassword: PASSWORD,
	jwtSecret: "test-secret-not-for-production-use-only",
	accessTokenTtl: 3600,
	refreshTokenTtl: 2592000,
};

const client = {
	client_id: "client-abc",
	redirect_uris: ["https://client.example.com/callback"],
} as OAuthClientInformationFull;

// Returns the one registered client; unknown ids resolve to undefined.
const clients: OAuthRegisteredClientsStore = {
	getClient: async (id) => (id === client.client_id ? client : undefined),
	registerClient: async (c) => c as OAuthClientInformationFull,
};

/** Mount the login router on a fresh app. `fixedDelayMs: 0` keeps the suite fast. */
function makeApp(limiter?: LoginRateLimiter) {
	const provider = new OwnerOAuthProvider(httpEnv, clients, USER_ID);
	const app = express();
	app.use(ownerLoginRouter(provider, { fixedDelayMs: 0, rateLimiter: limiter }));
	return app;
}

const goodForm = {
	client_id: client.client_id,
	redirect_uri: client.redirect_uris[0],
	code_challenge: "challenge-123",
	state: "state-xyz",
	scope: "kms",
	password: PASSWORD,
};

describe("ownerLoginRouter", () => {
	let app: express.Express;
	beforeEach(() => {
		app = makeApp();
	});

	it("happy path: correct password → 302 with a code on the registered redirect_uri", async () => {
		const res = await request(app).post("/owner-login").type("form").send(goodForm);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.location);
		expect(location.origin + location.pathname).toBe(client.redirect_uris[0]);
		expect(location.searchParams.get("code")).toBeTruthy();
		expect(location.searchParams.get("state")).toBe("state-xyz");
	});

	it("wrong password → 401 re-render, no redirect", async () => {
		const res = await request(app)
			.post("/owner-login")
			.type("form")
			.send({ ...goodForm, password: "nope" });
		expect(res.status).toBe(401);
		expect(res.headers.location).toBeUndefined();
		expect(res.text).toContain("Incorrect password.");
	});

	it("forged redirect_uri not on the client's allow-list → 400 re-render (open-redirect defense)", async () => {
		const res = await request(app)
			.post("/owner-login")
			.type("form")
			.send({ ...goodForm, redirect_uri: "https://evil.example.com/steal" });
		expect(res.status).toBe(400);
		expect(res.headers.location).toBeUndefined();
		expect(res.text).toContain("redirect_uri is not registered");
	});

	it("unknown client_id → 400 re-render", async () => {
		const res = await request(app)
			.post("/owner-login")
			.type("form")
			.send({ ...goodForm, client_id: "client-unknown" });
		expect(res.status).toBe(400);
		expect(res.text).toContain("Unknown client");
	});

	it("malformed request (missing code_challenge) → 400 before any client lookup", async () => {
		const res = await request(app)
			.post("/owner-login")
			.type("form")
			.send({ ...goodForm, code_challenge: "" });
		expect(res.status).toBe(400);
		expect(res.text).toContain("Malformed authorization request");
	});

	it("locks out after repeated wrong passwords → 429 with Retry-After", async () => {
		const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
		const limitedApp = makeApp(limiter);
		const wrong = { ...goodForm, password: "nope" };

		// First 3 wrong attempts: rejected as 401 (still under the ceiling).
		for (let i = 0; i < 3; i++) {
			const res = await request(limitedApp).post("/owner-login").type("form").send(wrong);
			expect(res.status).toBe(401);
		}
		// 4th attempt: now locked out regardless of password correctness.
		const blocked = await request(limitedApp).post("/owner-login").type("form").send(wrong);
		expect(blocked.status).toBe(429);
		expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
		expect(blocked.text).toContain("Too many attempts");

		// Even a correct password stays blocked while the window is open.
		const stillBlocked = await request(limitedApp).post("/owner-login").type("form").send(goodForm);
		expect(stillBlocked.status).toBe(429);
	});

	it("a successful login clears the failure counter for that IP", async () => {
		const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
		const limitedApp = makeApp(limiter);
		const wrong = { ...goodForm, password: "nope" };

		// Two misses, then a success resets the counter...
		await request(limitedApp).post("/owner-login").type("form").send(wrong);
		await request(limitedApp).post("/owner-login").type("form").send(wrong);
		const ok = await request(limitedApp).post("/owner-login").type("form").send(goodForm);
		expect(ok.status).toBe(302);

		// ...so two more misses don't trip the (3-attempt) lockout.
		await request(limitedApp).post("/owner-login").type("form").send(wrong);
		const res = await request(limitedApp).post("/owner-login").type("form").send(wrong);
		expect(res.status).toBe(401);
	});
});
