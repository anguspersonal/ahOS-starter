import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { notionWebhookRouter } from "./notionWebhook.js";

const TOKEN = "secret_verification_token";

function makeApp(opts: {
	verificationToken?: string | null;
	handleEvent?: (event: unknown) => Promise<unknown>;
}) {
	const app = express();
	app.use(
		"/webhooks/notion",
		notionWebhookRouter({
			verificationToken: opts.verificationToken ?? null,
			handleEvent: opts.handleEvent ?? (async () => undefined),
		}),
	);
	return app;
}

function sign(body: string, token: string = TOKEN): string {
	return `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
}

const EVENT = {
	type: "page.properties_updated",
	timestamp: "2026-08-05T10:00:00.000Z",
	entity: { id: "page-1", type: "page" },
	data: { updated_properties: ["XGe%40"] },
};

/** Flush the setImmediate the router uses for async processing. */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /webhooks/notion — verification handshake", () => {
	it("logs the received verification_token prominently and returns 200 when unconfigured", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = makeApp({ verificationToken: null });

		const res = await request(app)
			.post("/webhooks/notion")
			.send({ verification_token: "secret_handshake_tok" });

		expect(res.status).toBe(200);
		const logged = errSpy.mock.calls.flat().join("\n");
		expect(logged).toContain("secret_handshake_tok");
		expect(logged).toContain("NOTION_WEBHOOK_VERIFICATION_TOKEN");
	});

	it("still logs a handshake (token rotation) and returns 200 when already configured", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: TOKEN, handleEvent });

		const res = await request(app)
			.post("/webhooks/notion")
			.send({ verification_token: "secret_rotated_tok" });
		await flushAsync();

		expect(res.status).toBe(200);
		expect(errSpy.mock.calls.flat().join("\n")).toContain("secret_rotated_tok");
		expect(handleEvent).not.toHaveBeenCalled();
	});
});

describe("POST /webhooks/notion — not yet configured", () => {
	it("acknowledges a delivery with 200 but never processes it", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: null, handleEvent });

		const res = await request(app).post("/webhooks/notion").send(EVENT);
		await flushAsync();

		expect(res.status).toBe(200);
		expect(handleEvent).not.toHaveBeenCalled();
		expect(errSpy.mock.calls.flat().join("\n")).toContain(
			"NOTION_WEBHOOK_VERIFICATION_TOKEN",
		);
	});
});

describe("POST /webhooks/notion — configured (HMAC verification)", () => {
	it("accepts a correctly signed delivery, ACKs 200, and processes the event async", async () => {
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: TOKEN, handleEvent });
		const body = JSON.stringify(EVENT);

		const res = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.set("X-Notion-Signature", sign(body))
			.send(body);
		await flushAsync();

		expect(res.status).toBe(200);
		expect(handleEvent).toHaveBeenCalledTimes(1);
		expect(handleEvent).toHaveBeenCalledWith(expect.objectContaining({
			type: "page.properties_updated",
			entity: { id: "page-1", type: "page" },
		}));
	});

	it("rejects an invalid signature with 401 and does not process", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: TOKEN, handleEvent });
		const body = JSON.stringify(EVENT);

		const res = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.set("X-Notion-Signature", sign(body, "wrong_token"))
			.send(body);
		await flushAsync();

		expect(res.status).toBe(401);
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("rejects a missing signature header with 401 and does not process", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: TOKEN, handleEvent });

		const res = await request(app).post("/webhooks/notion").send(EVENT);
		await flushAsync();

		expect(res.status).toBe(401);
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("rejects a signature over a tampered body with 401", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: TOKEN, handleEvent });
		const signedBody = JSON.stringify(EVENT);
		const tampered = JSON.stringify({ ...EVENT, entity: { id: "page-EVIL", type: "page" } });

		const res = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.set("X-Notion-Signature", sign(signedBody))
			.send(tampered);
		await flushAsync();

		expect(res.status).toBe(401);
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("ignores event types other than page.properties_updated (200, no processing)", async () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => undefined);
		const app = makeApp({ verificationToken: TOKEN, handleEvent });
		const body = JSON.stringify({ ...EVENT, type: "page.created" });

		const res = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.set("X-Notion-Signature", sign(body))
			.send(body);
		await flushAsync();

		expect(res.status).toBe(200);
		expect(handleEvent).not.toHaveBeenCalled();
		expect(debugSpy.mock.calls.flat().join("\n")).toContain("page.created");
	});

	it("still returns 200 when async processing fails (errors are logged, never re-delivered as 5xx)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const handleEvent = vi.fn(async () => {
			throw new Error("rule blew up");
		});
		const app = makeApp({ verificationToken: TOKEN, handleEvent });
		const body = JSON.stringify(EVENT);

		const res = await request(app)
			.post("/webhooks/notion")
			.set("Content-Type", "application/json")
			.set("X-Notion-Signature", sign(body))
			.send(body);
		await flushAsync();
		await flushAsync();

		expect(res.status).toBe(200);
		expect(handleEvent).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls.flat().join("\n")).toContain("rule blew up");
	});
});
