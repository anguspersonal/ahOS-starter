import express from "express";
import { env } from "../env.js";
import { verifySlackSignature } from "../automations/slackSignature.js";
import type { CaptureInput, CaptureResult } from "../tools/capture.js";
import { ARTIFACT_SURFACES } from "@ahkms/shared";
import type { LoginRateLimiter } from "../auth/loginRateLimiter.js";
import { dispatchCapture } from "./dispatchCapture.js";
import {
	createWebhookLimiter,
	recordAuthFailure,
	rejectIfLockedOut,
	webhookErrorHandler,
} from "./webhookGuards.js";

// POST /webhooks/slack — inbound Slack Events API webhook surface (ADR-048).
// Joins the existing Railway HTTP app (http.ts) outside the OAuth bearer gate.
// Slack signs every request with HMAC-SHA256 (X-Slack-Signature) using the
// SLACK_SIGNING_SECRET.
//
// Lifecycle:
//   1. Not-yet-configured — until SLACK_SIGNING_SECRET is set, deliveries are
//      acknowledged 200 without processing. The ONLY unsigned response is the
//      url_verification challenge echo, kept so the operator can bootstrap the Slack
//      app's Request URL before the secret exists.
//   2. Configured — invalid signature / expired timestamp => 401, for EVERY request
//      including url_verification (Slack signs the challenge too). Valid => url_verification
//      echoes the challenge; events ACK 200 immediately (within Slack's 3s limit) and
//      are processed asynchronously.
//   3. Optional allowlists (SLACK_ALLOWED_TEAM_IDS / SLACK_ALLOWED_CHANNEL_IDS): when set,
//      events from other workspaces/channels are acknowledged and dropped. Unset = every
//      channel/DM the app can see is ingested.
// A per-IP failed-auth rate limiter runs before body parsing (ADR-096 rule 4).

export type SlackEvent = {
	type: string;
	user?: string;
	text?: string;
	channel?: string;
	channel_type?: string;
	ts?: string;
	thread_ts?: string;
	subtype?: string;
	bot_id?: string;
};

export type SlackWebhookEnvelope = {
	type?: string;
	challenge?: string;
	event_id?: string;
	event_time?: number;
	team_id?: string;
	event?: SlackEvent;
};

export type SlackWebhookOptions = {
	/** Override the Slack signing secret (tests). Defaults to env.slackSigningSecret. */
	signingSecret?: string | null;
	/** Override the capture implementation (tests). Defaults to the registered `capture` action. */
	handleCapture?: (input: CaptureInput) => Promise<CaptureResult>;
	/** Injected clock for signature timestamp verification (seconds since epoch). */
	nowSec?: () => number;
	/** Override the failed-auth rate limiter (tests). */
	rateLimiter?: LoginRateLimiter;
	/** Override the allowed team ids (tests). Defaults to env.slackAllowedTeamIds; null = any. */
	allowedTeamIds?: string[] | null;
	/** Override the allowed channel ids (tests). Defaults to env.slackAllowedChannelIds; null = any. */
	allowedChannelIds?: string[] | null;
};

/** Build the `/webhooks/slack` router. Mount with `app.use("/webhooks/slack", …)`. */
export function slackWebhookRouter(opts: SlackWebhookOptions = {}): express.Router {
	const signingSecret =
		opts.signingSecret !== undefined ? opts.signingSecret : env.slackSigningSecret;
	const handleCapture = opts.handleCapture ?? dispatchCapture("webhooks/slack");
	const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
	const limiter = opts.rateLimiter ?? createWebhookLimiter();
	const allowedTeamIds = opts.allowedTeamIds !== undefined ? opts.allowedTeamIds : env.slackAllowedTeamIds;
	const allowedChannelIds =
		opts.allowedChannelIds !== undefined ? opts.allowedChannelIds : env.slackAllowedChannelIds;

	const router = express.Router();
	router.use(rejectIfLockedOut(limiter));

	// Preserve raw body buffer for byte-accurate HMAC computation
	const jsonWithRawBody = express.json({
		verify: (req, _res, buf) => {
			(req as express.Request & { rawBody?: Buffer }).rawBody = buf;
		},
	});

	router.post("/", jsonWithRawBody, (req, res) => {
		const body = (req.body ?? {}) as SlackWebhookEnvelope;

		const isChallenge = body.type === "url_verification" && typeof body.challenge === "string";

		// 1. Not yet configured: nothing can be authenticated. The unsigned challenge echo is
		// the one bootstrap exception (the operator needs it to register the Request URL).
		if (!signingSecret) {
			if (isChallenge) {
				res.status(200).json({ challenge: body.challenge });
				return;
			}
			console.error(
				"slack webhook: delivery received but SLACK_SIGNING_SECRET is not set — acknowledged without processing",
			);
			res.status(200).json({ ok: true });
			return;
		}

		// 2. Verify signature and replay protection BEFORE anything is echoed or processed
		const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
		const signature = req.header("x-slack-signature");
		const timestamp = req.header("x-slack-request-timestamp");

		if (
			!rawBody ||
			!verifySlackSignature(signingSecret, rawBody, signature, timestamp, nowSec())
		) {
			recordAuthFailure(limiter, req);
			console.error("slack webhook: invalid or missing Slack signature / timestamp — rejected");
			res.status(401).json({ error: "invalid signature" });
			return;
		}

		// 3. Subscription handshake (signed url_verification challenge)
		if (isChallenge) {
			res.status(200).json({ challenge: body.challenge });
			return;
		}

		// 4. ACK immediately to meet Slack's 3-second SLA
		res.status(200).json({ ok: true });

		// 5. Asynchronous event ingestion
		if (body.type !== "event_callback" || !body.event) {
			return;
		}

		// Optional workspace / channel allowlists (unset = ingest everything the app sees).
		if (allowedTeamIds && (!body.team_id || !allowedTeamIds.includes(body.team_id))) {
			return;
		}
		if (allowedChannelIds && (!body.event.channel || !allowedChannelIds.includes(body.event.channel))) {
			return;
		}

		const event = body.event;
		// Only capture standard user messages and app mentions
		if (event.type !== "message" && event.type !== "app_mention") {
			return;
		}

		// Ignore bot messages, channel join/leaves, and edits/deletes
		if (event.subtype || event.bot_id || !event.text || !event.channel || !event.ts) {
			return;
		}

		const text = event.text.trim();
		if (!text) return;

		setImmediate(() => {
			const channelArchiveUrl = `https://slack.com/archives/${event.channel}/p${event.ts!.replace(".", "")}`;
			const captureInput: CaptureInput = {
				text,
				title: `Slack message in #${event.channel}`,
				source_url: channelArchiveUrl,
				surface: ARTIFACT_SURFACES.api,
				content_subtype: "conversation",
				captured_by: "webhook:slack",
				dedup_key: `slack:${event.channel}:${event.ts}`,
				processing_metadata: {
					slack: {
						channel: event.channel,
						user: event.user,
						ts: event.ts,
						thread_ts: event.thread_ts,
					},
				},
			};

			void handleCapture(captureInput).catch((err) => {
				console.error(
					"slack webhook: event capture failed:",
					err instanceof Error ? err.message : String(err),
				);
			});
		});
	});

	// Unsigned junk that fails to parse counts against the caller too (it is pre-signature work).
	router.use((err: unknown, req: express.Request, _res: express.Response, next: express.NextFunction) => {
		recordAuthFailure(limiter, req);
		next(err);
	});
	router.use(webhookErrorHandler);

	return router;
}
