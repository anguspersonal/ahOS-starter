import express from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { captureAction, type CaptureInput, type CaptureResult } from "../tools/capture.js";
import { ARTIFACT_SURFACES } from "@ahkms/shared";
import type { LoginRateLimiter } from "../auth/loginRateLimiter.js";
import { dispatchCapture } from "./dispatchCapture.js";
import {
	createWebhookLimiter,
	recordAuthFailure,
	rejectIfLockedOut,
	webhookErrorHandler,
} from "./webhookGuards.js";

// POST /webhooks/capture — inbound HTTP capture webhook surface (ADR-048).
// Allows external tools, Raycast shortcuts, iOS Shortcuts, automated scripts,
// and third-party webhooks to push notes and artifacts straight into ahOS
// without going through an MCP client or waiting for scheduled discovery sweeps.
//
// Outside the OAuth bearer gate: authenticates via a pre-shared secret token
// passed in `X-Capture-Secret` header or `Authorization: Bearer <secret>`.
//
// Order of defences (ADR-096 rule 4): rate-limit lockout check, then secret check on
// headers ONLY, then the (small) body parse. An unauthenticated caller never gets a
// body buffered or parsed. Caller-controlled provenance is pinned: `surface` and
// `captured_by` are fixed server-side (surface feeds trust-tier derivation, ADR-026),
// `content_subtype` is allowlisted, `dedup_key` is namespaced, and `captured_at` and
// `trust_override` are not accepted.

/** Body ceiling for notes pushed over the webhook; applied only after the secret check. */
export const CAPTURE_BODY_LIMIT = "256kb";
const PINNED_SURFACE = ARTIFACT_SURFACES.api;
const PINNED_CAPTURED_BY = "webhook:capture";
const DEDUP_NAMESPACE = "webhook:capture:";
const DEDUP_KEY_MAX = 200;
/** Non-system, non-backdating subtypes a webhook caller may declare. */
const ALLOWED_CONTENT_SUBTYPES = new Set([
	"note",
	"conversation",
	"reference",
	"quote",
	"transcript",
	"meeting-note",
]);

export type CaptureWebhookOptions = {
	/** Override the pre-shared secret token (tests). Defaults to env.captureWebhookSecret. */
	secret?: string | null;
	/** Override the capture implementation (tests). Defaults to the registered `capture` action. */
	handleCapture?: (input: CaptureInput) => Promise<CaptureResult>;
	/** Override the failed-auth rate limiter (tests). */
	rateLimiter?: LoginRateLimiter;
};

function extractToken(req: express.Request): string | null {
	const headerSecret = req.header("x-capture-secret");
	if (headerSecret) return headerSecret.trim();

	const authHeader = req.header("authorization");
	if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
		return authHeader.slice(7).trim();
	}

	return null;
}

function verifySecret(expected: string, provided: string | null): boolean {
	if (!provided) return false;
	const expectedBuf = Buffer.from(expected);
	const providedBuf = Buffer.from(provided);
	if (expectedBuf.length !== providedBuf.length) return false;
	return timingSafeEqual(expectedBuf, providedBuf);
}

/** Build the `/webhooks/capture` router. Mount with `app.use("/webhooks/capture", …)`. */
export function captureWebhookRouter(opts: CaptureWebhookOptions = {}): express.Router {
	const secret = opts.secret !== undefined ? opts.secret : env.captureWebhookSecret;
	const handleCapture = opts.handleCapture ?? dispatchCapture("webhooks/capture");
	const limiter = opts.rateLimiter ?? createWebhookLimiter();

	const router = express.Router();

	// 1. Lockout, 2. configuration, 3. authentication: all on headers, before any body parse.
	router.use(rejectIfLockedOut(limiter));
	router.use((req, res, next) => {
		if (!secret) {
			console.error("capture webhook: CAPTURE_WEBHOOK_SECRET is not configured on server");
			res.status(503).json({
				error: "capture webhook is not configured on this server",
			});
			return;
		}
		if (!verifySecret(secret, extractToken(req))) {
			recordAuthFailure(limiter, req);
			console.error("capture webhook: unauthorized delivery attempt (invalid or missing token)");
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		next();
	});

	// 4. Only now parse the body, with a note-sized ceiling.
	router.use(express.json({ limit: CAPTURE_BODY_LIMIT }));

	router.post("/", async (req, res) => {
		const body = req.body;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			res.status(400).json({ error: "request body must be a JSON object" });
			return;
		}

		// Accept `text` or `content` alias
		const text = typeof body.text === "string" ? body.text : (typeof body.content === "string" ? body.content : "");
		if (!text.trim()) {
			res.status(400).json({ error: "field 'text' (or 'content') is required and must not be empty" });
			return;
		}

		let contentSubtype: string | undefined;
		if (body.content_subtype !== undefined) {
			if (typeof body.content_subtype !== "string" || !ALLOWED_CONTENT_SUBTYPES.has(body.content_subtype)) {
				res.status(400).json({
					error: `field 'content_subtype' must be one of: ${[...ALLOWED_CONTENT_SUBTYPES].join(", ")}`,
				});
				return;
			}
			contentSubtype = body.content_subtype;
		}

		let dedupKey: string | undefined;
		if (body.dedup_key !== undefined) {
			if (typeof body.dedup_key !== "string" || !body.dedup_key || body.dedup_key.length > DEDUP_KEY_MAX) {
				res.status(400).json({ error: `field 'dedup_key' must be a string of 1-${DEDUP_KEY_MAX} characters` });
				return;
			}
			dedupKey = `${DEDUP_NAMESPACE}${body.dedup_key}`;
		}

		const candidate = {
			text,
			title: typeof body.title === "string" ? body.title : undefined,
			source_url: typeof body.source_url === "string" ? body.source_url : undefined,
			tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown): t is string => typeof t === "string") : undefined,
			surface: PINNED_SURFACE,
			content_subtype: contentSubtype,
			urgency: body.urgency === "throw" || body.urgency === "default" || body.urgency === "file" ? body.urgency : undefined,
			captured_by: PINNED_CAPTURED_BY,
			dedup_key: dedupKey,
			// Caller metadata rides under its own key so it cannot spoof system-written keys.
			processing_metadata:
				body.processing_metadata && typeof body.processing_metadata === "object" && !Array.isArray(body.processing_metadata)
					? { webhook_client: body.processing_metadata as Record<string, unknown> }
					: undefined,
		};

		// Validate against the action's own schema so a bad field is a 400, not a 500.
		const parsed = captureAction.schema.safeParse(candidate);
		if (!parsed.success) {
			const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
			res.status(400).json({ error: `invalid field(s): ${fields.join(", ")}` });
			return;
		}

		try {
			const result = await handleCapture(parsed.data);
			res.status(201).json({
				ok: true,
				artifact: {
					id: result.id,
					title: result.title,
					tags: result.tags,
					source_channel: result.source_channel,
					storage_bucket: result.storage_bucket,
					storage_path: result.storage_path,
					captured_at: result.captured_at,
					deduplicated: result.deduplicated,
				},
			});
		} catch (err) {
			// Detail stays in the server log; the caller gets nothing it could use to probe storage.
			console.error("capture webhook: capture failed:", err instanceof Error ? err.message : String(err));
			res.status(500).json({ error: "capture failed" });
		}
	});

	router.use(webhookErrorHandler);

	return router;
}
