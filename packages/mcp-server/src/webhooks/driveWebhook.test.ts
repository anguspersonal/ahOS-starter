import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { driveWebhookRouter } from "./driveWebhook.js";
import { LoginRateLimiter } from "../auth/loginRateLimiter.js";

const TOKEN = "test_drive_webhook_token_abc";

function makeApp(opts: {
	webhookToken?: string | null;
	triggerDiscover?: () => Promise<void>;
	debounceMs?: number;
	rateLimiter?: LoginRateLimiter;
}) {
	const app = express();
	app.use(
		"/webhooks/drive",
		driveWebhookRouter({
			webhookToken: opts.webhookToken !== undefined ? opts.webhookToken : TOKEN,
			triggerDiscover: opts.triggerDiscover,
			debounceMs: opts.debounceMs ?? 0,
			rateLimiter: opts.rateLimiter ?? new LoginRateLimiter(),
		}),
	);
	return app;
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 20));

const change = (app: express.Express, token: string | null = TOKEN) => {
	let req = request(app)
		.post("/webhooks/drive")
		.set("X-Goog-Channel-ID", "channel-xyz")
		.set("X-Goog-Resource-ID", "res-12345")
		.set("X-Goog-Resource-State", "change");
	if (token) req = req.set("X-Goog-Channel-Token", token);
	return req;
};

describe("POST /webhooks/drive", () => {
	it("acknowledges the 'sync' handshake when the token is valid, without triggering discover", async () => {
		const triggerDiscover = vi.fn();
		const app = makeApp({ triggerDiscover });

		const res = await request(app)
			.post("/webhooks/drive")
			.set("X-Goog-Channel-ID", "channel-xyz")
			.set("X-Goog-Channel-Token", TOKEN)
			.set("X-Goog-Resource-State", "sync");
		await flushAsync();

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true, state: "sync" });
		expect(triggerDiscover).not.toHaveBeenCalled();
	});

	it("rejects a 'sync' handshake with a missing token", async () => {
		const triggerDiscover = vi.fn();
		const app = makeApp({ triggerDiscover });
		const res = await request(app)
			.post("/webhooks/drive")
			.set("X-Goog-Channel-ID", "channel-xyz")
			.set("X-Goog-Resource-State", "sync");
		expect(res.status).toBe(401);
		expect(triggerDiscover).not.toHaveBeenCalled();
	});

	it("returns 200 without triggering discover when DRIVE_WEBHOOK_TOKEN is unconfigured", async () => {
		const triggerDiscover = vi.fn();
		const app = makeApp({ webhookToken: null, triggerDiscover });

		const res = await request(app)
			.post("/webhooks/drive")
			.set("X-Goog-Channel-ID", "channel-xyz")
			.set("X-Goog-Resource-State", "change");
		await flushAsync();

		expect(res.status).toBe(200);
		expect(triggerDiscover).not.toHaveBeenCalled();
	});

	it("returns 401 when token header is invalid or missing, without triggering discover", async () => {
		const triggerDiscover = vi.fn();
		const app = makeApp({ triggerDiscover });

		const resMissing = await request(app)
			.post("/webhooks/drive")
			.set("X-Goog-Channel-ID", "channel-xyz")
			.set("X-Goog-Resource-State", "change");
		expect(resMissing.status).toBe(401);

		const resWrong = await request(app)
			.post("/webhooks/drive")
			.set("X-Goog-Channel-ID", "channel-xyz")
			.set("X-Goog-Channel-Token", "wrong_token")
			.set("X-Goog-Resource-State", "change");
		expect(resWrong.status).toBe(401);
		await flushAsync();
		expect(triggerDiscover).not.toHaveBeenCalled();
	});

	it("answers 429 once the failure ceiling is reached", async () => {
		const triggerDiscover = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({ triggerDiscover, rateLimiter: new LoginRateLimiter({ maxAttempts: 3 }) });
		for (let i = 0; i < 3; i++) expect((await change(app, "bad")).status).toBe(401);
		const locked = await change(app);
		expect(locked.status).toBe(429);
		expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
		await flushAsync();
		expect(triggerDiscover).not.toHaveBeenCalled();
	});

	it("coalesces a burst of valid notifications into one sweep", async () => {
		const triggerDiscover = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({ triggerDiscover, debounceMs: 30 });
		const results = await Promise.all(Array.from({ length: 10 }, () => change(app)));
		expect(results.every((r) => r.status === 200)).toBe(true);
		await new Promise((r) => setTimeout(r, 80));
		expect(triggerDiscover).toHaveBeenCalledTimes(1);
	});

	it("never overlaps sweeps: notifications during a run cause exactly one trailing sweep", async () => {
		let active = 0;
		let maxActive = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const triggerDiscover = vi.fn(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			if (triggerDiscover.mock.calls.length === 1) await gate;
			active--;
		});
		const app = makeApp({ triggerDiscover, debounceMs: 0 });

		await change(app);
		await flushAsync(); // first sweep now running, blocked on the gate
		expect(triggerDiscover).toHaveBeenCalledTimes(1);
		await Promise.all([change(app), change(app), change(app)]);
		await flushAsync();
		expect(triggerDiscover).toHaveBeenCalledTimes(1); // still blocked, no overlap

		release();
		await flushAsync();
		await flushAsync();
		expect(triggerDiscover).toHaveBeenCalledTimes(2); // one trailing sweep
		expect(maxActive).toBe(1);
	});

	it("authenticates valid token, ACKs 200, and triggers discover asynchronously with channelId", async () => {
		const triggerDiscover = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({ triggerDiscover });

		const res = await request(app)
			.post("/webhooks/drive")
			.set("X-Goog-Channel-ID", "channel-xyz")
			.set("X-Goog-Channel-Token", TOKEN)
			.set("X-Goog-Resource-ID", "res-12345")
			.set("X-Goog-Resource-State", "change");

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });

		await flushAsync();
		expect(triggerDiscover).toHaveBeenCalledTimes(1);
		expect(triggerDiscover).toHaveBeenCalledWith({ channelId: "channel-xyz" });
	});
});
