import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { slackWebhookRouter } from "./slackWebhook.js";
import { computeSlackSignature } from "../automations/slackSignature.js";
import type { CaptureInput, CaptureResult } from "../tools/capture.js";
import { LoginRateLimiter } from "../auth/loginRateLimiter.js";

const SIGNING_SECRET = "test_slack_signing_secret_999";
const NOW = 1700000000;

function makeApp(opts: {
	signingSecret?: string | null;
	handleCapture?: (input: CaptureInput) => Promise<CaptureResult>;
	nowSec?: () => number;
	rateLimiter?: LoginRateLimiter;
	allowedTeamIds?: string[] | null;
	allowedChannelIds?: string[] | null;
}) {
	const app = express();
	app.use(
		"/webhooks/slack",
		slackWebhookRouter({
			signingSecret: opts.signingSecret !== undefined ? opts.signingSecret : SIGNING_SECRET,
			handleCapture: opts.handleCapture,
			nowSec: opts.nowSec ?? (() => NOW),
			rateLimiter: opts.rateLimiter ?? new LoginRateLimiter(),
			allowedTeamIds: opts.allowedTeamIds ?? null,
			allowedChannelIds: opts.allowedChannelIds ?? null,
		}),
	);
	return app;
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function signedPost(app: express.Express, payload: unknown, opts: { ts?: number; headers?: Record<string, string> } = {}) {
	const ts = opts.ts ?? NOW;
	const body = JSON.stringify(payload);
	let req = request(app)
		.post("/webhooks/slack")
		.set("Content-Type", "application/json")
		.set("X-Slack-Signature", computeSlackSignature(SIGNING_SECRET, ts, body))
		.set("X-Slack-Request-Timestamp", String(ts));
	for (const [k, v] of Object.entries(opts.headers ?? {})) req = req.set(k, v);
	return req.send(body);
}

const messagePayload = (over: Record<string, unknown> = {}) => ({
	type: "event_callback",
	team_id: "T1",
	event: { type: "message", user: "U1", text: "hello team", channel: "C1", ts: "1700000000.000100" },
	...over,
});

describe("POST /webhooks/slack", () => {
	it("echoes an unsigned url_verification challenge only while the signing secret is unset (bootstrap)", async () => {
		const app = makeApp({ signingSecret: null });
		const res = await request(app)
			.post("/webhooks/slack")
			.send({
				type: "url_verification",
				token: "legacy_token",
				challenge: "challenge_string_abc123",
			});

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ challenge: "challenge_string_abc123" });
	});

	it("returns 200 without processing when SLACK_SIGNING_SECRET is not configured", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ signingSecret: null, handleCapture });

		const res = await request(app)
			.post("/webhooks/slack")
			.send({
				type: "event_callback",
				event: { type: "message", text: "hello", channel: "C123", ts: "1700000000.001" },
			});
		await flushAsync();

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("returns 401 on invalid signature or timestamp", async () => {
		const app = makeApp({});
		const body = JSON.stringify({
			type: "event_callback",
			event: { type: "message", text: "hello" },
		});

		const res = await request(app)
			.post("/webhooks/slack")
			.set("Content-Type", "application/json")
			.set("X-Slack-Signature", "v0=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb")
			.set("X-Slack-Request-Timestamp", String(NOW))
			.send(body);

		expect(res.status).toBe(401);
		expect(res.body.error).toBe("invalid signature");
	});

	it("does not call the handler on a bad signature", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });
		const res = await request(app)
			.post("/webhooks/slack")
			.set("Content-Type", "application/json")
			.set("X-Slack-Signature", "v0=" + "0".repeat(64))
			.set("X-Slack-Request-Timestamp", String(NOW))
			.send(JSON.stringify(messagePayload()));
		await flushAsync();
		expect(res.status).toBe(401);
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("rejects an unsigned url_verification challenge with 401 when the secret is configured", async () => {
		const app = makeApp({});
		const res = await request(app)
			.post("/webhooks/slack")
			.send({ type: "url_verification", challenge: "attacker-controlled" });
		expect(res.status).toBe(401);
		expect(JSON.stringify(res.body)).not.toContain("attacker-controlled");
	});

	it("echoes a correctly signed url_verification challenge when configured", async () => {
		const app = makeApp({});
		const res = await signedPost(app, { type: "url_verification", challenge: "abc" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ challenge: "abc" });
	});

	it("rejects a correctly signed request with a stale timestamp (route-level replay)", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });
		const res = await signedPost(app, messagePayload(), { ts: NOW - 301 });
		await flushAsync();
		expect(res.status).toBe(401);
		expect(handleCapture).not.toHaveBeenCalled();

		const future = await signedPost(app, messagePayload(), { ts: NOW + 301 });
		expect(future.status).toBe(401);
	});

	it("returns a terse JSON 400 for malformed JSON and never processes it", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });
		const res = await request(app)
			.post("/webhooks/slack")
			.set("Content-Type", "application/json")
			.send("{not json");
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: "invalid request body" });
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("returns 413 for an oversize body", async () => {
		const app = makeApp({});
		const res = await request(app)
			.post("/webhooks/slack")
			.set("Content-Type", "application/json")
			.send(JSON.stringify({ type: "event_callback", pad: "x".repeat(200 * 1024) }));
		expect(res.status).toBe(413);
	});

	it("answers 429 once the failure ceiling is reached, before parsing", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture, rateLimiter: new LoginRateLimiter({ maxAttempts: 3 }) });
		for (let i = 0; i < 3; i++) {
			const res = await request(app).post("/webhooks/slack").send({ type: "event_callback" });
			expect(res.status).toBe(401);
		}
		const locked = await signedPost(app, messagePayload());
		expect(locked.status).toBe(429);
		expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
		await flushAsync();
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("collapses Slack retries onto the same dedup_key", async () => {
		const handleCapture = vi.fn().mockResolvedValue({ id: "a" });
		const app = makeApp({ handleCapture });
		const first = await signedPost(app, messagePayload());
		const retry = await signedPost(app, messagePayload(), { headers: { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" } });
		await flushAsync();
		expect(first.status).toBe(200);
		expect(retry.status).toBe(200);
		const keys = handleCapture.mock.calls.map((c) => c[0].dedup_key);
		expect(keys).toEqual(["slack:C1:1700000000.000100", "slack:C1:1700000000.000100"]);
	});

	it("drops events outside the team / channel allowlists, but ingests inside them", async () => {
		const handleCapture = vi.fn().mockResolvedValue({ id: "a" });
		const app = makeApp({ handleCapture, allowedTeamIds: ["T1"], allowedChannelIds: ["C1"] });

		await signedPost(app, messagePayload({ team_id: "T9" }));
		await signedPost(app, messagePayload({ event: { type: "message", text: "other", channel: "C9", ts: "1.1" } }));
		await flushAsync();
		expect(handleCapture).not.toHaveBeenCalled();

		const ok = await signedPost(app, messagePayload());
		await flushAsync();
		expect(ok.status).toBe(200);
		expect(handleCapture).toHaveBeenCalledTimes(1);
	});

	it("authenticates valid signature, ACKs 200, and captures standard user message asynchronously", async () => {
		const handleCapture = vi.fn().mockResolvedValue({ id: "art-slack-1" });
		const app = makeApp({ handleCapture });

		const payload = {
			type: "event_callback",
			event_id: "Ev123",
			event: {
				type: "message",
				user: "U999",
				text: "Key discussion point from team retro",
				channel: "C456",
				ts: "1700000000.000100",
			},
		};
		const body = JSON.stringify(payload);
		const sig = computeSlackSignature(SIGNING_SECRET, NOW, body);

		const res = await request(app)
			.post("/webhooks/slack")
			.set("Content-Type", "application/json")
			.set("X-Slack-Signature", sig)
			.set("X-Slack-Request-Timestamp", String(NOW))
			.send(body);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });

		await flushAsync();

		expect(handleCapture).toHaveBeenCalledTimes(1);
		expect(handleCapture).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Key discussion point from team retro",
				title: "Slack message in #C456",
				source_url: "https://slack.com/archives/C456/p1700000000000100",
				captured_by: "webhook:slack",
				dedup_key: "slack:C456:1700000000.000100",
				content_subtype: "conversation",
				processing_metadata: {
					slack: {
						channel: "C456",
						user: "U999",
						ts: "1700000000.000100",
						thread_ts: undefined,
					},
				},
			}),
		);
	});

	it("ignores bot messages, message updates, and empty messages", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });

		const payload = {
			type: "event_callback",
			event: {
				type: "message",
				subtype: "bot_message",
				text: "A bot posted this",
				channel: "C456",
				ts: "1700000000.000200",
			},
		};
		const body = JSON.stringify(payload);
		const sig = computeSlackSignature(SIGNING_SECRET, NOW, body);

		const res = await request(app)
			.post("/webhooks/slack")
			.set("Content-Type", "application/json")
			.set("X-Slack-Signature", sig)
			.set("X-Slack-Request-Timestamp", String(NOW))
			.send(body);

		expect(res.status).toBe(200);
		await flushAsync();

		expect(handleCapture).not.toHaveBeenCalled();
	});
});
