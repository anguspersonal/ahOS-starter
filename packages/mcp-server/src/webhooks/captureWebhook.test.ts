import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { captureWebhookRouter } from "./captureWebhook.js";
import type { CaptureInput, CaptureResult } from "../tools/capture.js";
import { LoginRateLimiter } from "../auth/loginRateLimiter.js";
import { WEBHOOK_MAX_FAILURES } from "./webhookGuards.js";

const SECRET = "test_capture_webhook_secret_xyz";

function makeApp(opts: {
	secret?: string | null;
	handleCapture?: (input: CaptureInput) => Promise<CaptureResult>;
	rateLimiter?: LoginRateLimiter;
}) {
	const app = express();
	app.use(
		"/webhooks/capture",
		captureWebhookRouter({
			secret: opts.secret !== undefined ? opts.secret : SECRET,
			handleCapture: opts.handleCapture,
			rateLimiter: opts.rateLimiter ?? new LoginRateLimiter({ maxAttempts: WEBHOOK_MAX_FAILURES }),
		}),
	);
	return app;
}

const sampleResult: CaptureResult = {
	id: "art-12345",
	title: "Important Memo",
	tags: ["inbox", "memo"],
	source_channel: "api",
	storage_bucket: "artifacts",
	storage_path: "notes/user/art-12345.md",
	captured_at: "2026-10-04T12:00:00.000Z",
	captured_at_declared: false,
	deduplicated: false,
};

describe("POST /webhooks/capture", () => {
	it("returns 503 if secret is not configured on server", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ secret: null, handleCapture });
		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", "any-secret")
			.send({ text: "hello world" });

		expect(res.status).toBe(503);
		expect(res.body.error).toContain("not configured");
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("returns 401 if secret header is missing or incorrect, without calling the handler", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });
		const resMissing = await request(app)
			.post("/webhooks/capture")
			.send({ text: "hello world" });
		expect(resMissing.status).toBe(401);

		const resWrong = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", "wrong-secret")
			.send({ text: "hello world" });
		expect(resWrong.status).toBe(401);
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("authenticates before parsing: unauthenticated malformed or oversize bodies get 401, not 400/413", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });

		const malformed = await request(app)
			.post("/webhooks/capture")
			.set("Content-Type", "application/json")
			.send("{not json");
		expect(malformed.status).toBe(401);

		const big = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", "wrong")
			.send({ text: "x".repeat(300 * 1024) });
		expect(big.status).toBe(401);
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("returns 413 for an authenticated oversize body", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });
		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({ text: "x".repeat(400 * 1024) });
		expect(res.status).toBe(413);
		expect(res.body).toEqual({ error: "payload too large" });
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("returns a terse JSON 400 for an authenticated malformed JSON body", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });
		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.set("Content-Type", "application/json")
			.send("{not json");
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: "invalid request body" });
		expect(res.text).not.toContain("SyntaxError");
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("answers 429 with Retry-After once the Nth failed attempt is reached, even for a valid secret", async () => {
		const handleCapture = vi.fn().mockResolvedValue(sampleResult);
		const app = makeApp({ handleCapture, rateLimiter: new LoginRateLimiter({ maxAttempts: 3 }) });

		for (let i = 0; i < 3; i++) {
			const res = await request(app).post("/webhooks/capture").set("X-Capture-Secret", "nope").send({ text: "x" });
			expect(res.status).toBe(401);
		}
		const locked = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({ text: "x" });
		expect(locked.status).toBe(429);
		expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("pins surface and captured_by, namespaces dedup_key, and drops captured_at / trust_override", async () => {
		const handleCapture = vi.fn().mockResolvedValue(sampleResult);
		const app = makeApp({ handleCapture });

		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({
				text: "spoof attempt",
				surface: "claude_code",
				captured_by: "user",
				dedup_key: "slack:C1:1.2",
				captured_at: "2020-01-01",
				trust_override: "perfect",
				content_subtype: "note",
				processing_metadata: { slack: { channel: "forged" } },
			});

		expect(res.status).toBe(201);
		const input = handleCapture.mock.calls[0][0];
		expect(input.surface).toBe("api");
		expect(input.captured_by).toBe("webhook:capture");
		expect(input.dedup_key).toBe("webhook:capture:slack:C1:1.2");
		expect(input.captured_at).toBeUndefined();
		expect(input.trust_override).toBeUndefined();
		expect(input.processing_metadata).toEqual({ webhook_client: { slack: { channel: "forged" } } });
	});

	it("rejects a non-allowlisted content_subtype and an invalid source_url with 400", async () => {
		const handleCapture = vi.fn();
		const app = makeApp({ handleCapture });

		const subtype = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({ text: "x", content_subtype: "daily_log" });
		expect(subtype.status).toBe(400);

		const url = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({ text: "x", source_url: "not a url" });
		expect(url.status).toBe(400);
		expect(url.body.error).toContain("source_url");
		expect(handleCapture).not.toHaveBeenCalled();
	});

	it("authenticates via Authorization: Bearer <secret>", async () => {
		const handleCapture = vi.fn().mockResolvedValue(sampleResult);
		const app = makeApp({ handleCapture });

		const res = await request(app)
			.post("/webhooks/capture")
			.set("Authorization", `Bearer ${SECRET}`)
			.send({ text: "Quick note via Bearer token" });

		expect(res.status).toBe(201);
		expect(res.body.ok).toBe(true);
		expect(res.body.artifact.id).toBe("art-12345");
		expect(handleCapture).toHaveBeenCalledTimes(1);
		expect(handleCapture.mock.calls[0][0].text).toBe("Quick note via Bearer token");
	});

	it("returns 400 if text/content is missing or blank", async () => {
		const app = makeApp({});
		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({ title: "Only a title" });

		expect(res.status).toBe(400);
		expect(res.body.error).toContain("field 'text' (or 'content') is required");
	});

	it("accepts content alias, passes parameters and returns 201 Created", async () => {
		const handleCapture = vi.fn().mockResolvedValue(sampleResult);
		const app = makeApp({ handleCapture });

		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({
				content: "A note using content field",
				title: "My Note",
				tags: ["idea", "work"],
				urgency: "file",
				source_url: "https://example.com/source",
				dedup_key: "raycast:note-1",
			});

		expect(res.status).toBe(201);
		expect(res.body.ok).toBe(true);
		expect(res.body.artifact.id).toBe("art-12345");
		expect(handleCapture).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "A note using content field",
				title: "My Note",
				tags: ["idea", "work"],
				urgency: "file",
				source_url: "https://example.com/source",
				dedup_key: "webhook:capture:raycast:note-1",
				captured_by: "webhook:capture",
			}),
		);
	});

	it("returns 500 when capture handler throws", async () => {
		const handleCapture = vi.fn().mockRejectedValue(new Error("Database disconnected"));
		const app = makeApp({ handleCapture });

		const res = await request(app)
			.post("/webhooks/capture")
			.set("X-Capture-Secret", SECRET)
			.send({ text: "Will fail" });

		expect(res.status).toBe(500);
		expect(res.body).toEqual({ error: "capture failed" });
		expect(JSON.stringify(res.body)).not.toContain("Database disconnected");
	});
});
