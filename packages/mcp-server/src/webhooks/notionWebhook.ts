import express from "express";
import { env } from "../env.js";
import { verifyNotionSignature } from "../automations/notionSignature.js";
import type { NotionPagePropertiesUpdatedEvent } from "../automations/completedAtStamp.js";
import { dispatchAction } from "./dispatchAction.js";

// POST /webhooks/notion — the system's first inbound webhook surface (#546 /
// ADR-048). Joins the existing Railway HTTP app (http.ts) OUTSIDE the OAuth
// bearer gate: Notion cannot do an OAuth dance, so authenticity comes from the
// X-Notion-Signature HMAC instead (notionSignature.ts).
//
// Lifecycle:
//   1. Subscription handshake — Notion POSTs { verification_token } once. The
//      endpoint logs it prominently (the operator pastes it into the Notion UI
//      and sets NOTION_WEBHOOK_VERIFICATION_TOKEN) and returns 200.
//   2. Not-yet-configured — until the env var is set, every delivery is
//      acknowledged 200 and NOT processed (we can't authenticate it yet).
//   3. Configured — invalid/missing signature ⇒ 401, no processing. Valid ⇒ ACK
//      200 immediately and process async (Notion retries ~8 times over 24h on
//      non-2xx; rule work must never make it time out). Event types other than
//      page.properties_updated are ignored (debug log).

/** A delivery's parsed body: a handshake, or an event envelope. */
type NotionWebhookBody = NotionPagePropertiesUpdatedEvent & {
	type?: string;
	verification_token?: string;
};

type RouterOptions = {
	/** Override the HMAC key (tests). Defaults to env NOTION_WEBHOOK_VERIFICATION_TOKEN. */
	verificationToken?: string | null;
	/** Override the event handler (tests). Defaults to the completed_at_stamp rule. */
	handleEvent?: (event: NotionPagePropertiesUpdatedEvent) => Promise<unknown>;
};

/** Build the `/webhooks/notion` router. Mount with `app.use("/webhooks/notion", …)`. */
export function notionWebhookRouter(opts: RouterOptions = {}): express.Router {
	const verificationToken =
		opts.verificationToken !== undefined
			? opts.verificationToken
			: env.notionWebhookVerificationToken;
	const handleEvent =
		opts.handleEvent ??
		dispatchAction<NotionPagePropertiesUpdatedEvent>("notion_completed_at_stamp", "webhooks/notion");

	const router = express.Router();

	// The HMAC is computed over the RAW body bytes — capture them alongside the
	// parsed JSON (re-serialising the parse is not byte-faithful).
	const jsonWithRawBody = express.json({
		verify: (req, _res, buf) => {
			(req as express.Request & { rawBody?: Buffer }).rawBody = buf;
		},
	});

	router.post("/", jsonWithRawBody, (req, res) => {
		const body = (req.body ?? {}) as NotionWebhookBody;

		// 1. Subscription handshake. Checked before signature verification: the
		// initial handshake predates any configured token (and on token rotation the
		// new token arrives signed with a key we don't hold yet). Logging a forged
		// token is harmless — it configures nothing by itself: adopting one requires
		// the operator to manually set the Railway env var, so this path carries no
		// rate-limiting or provenance check in v0 (accepted risk — worst case is
		// log noise, never state change).
		if (typeof body.verification_token === "string") {
			console.error("=== Notion webhook verification handshake received ===");
			console.error(`verification_token: ${body.verification_token}`);
			console.error(
				"Paste this token into the Notion webhook verification UI, then set " +
					"NOTION_WEBHOOK_VERIFICATION_TOKEN to this value (Railway env) and redeploy.",
			);
			res.status(200).json({ ok: true });
			return;
		}

		// 2. Not yet configured: acknowledge, never process (can't authenticate).
		if (!verificationToken) {
			console.error(
				"notion webhook: delivery received but NOTION_WEBHOOK_VERIFICATION_TOKEN " +
					"is not set — acknowledged without processing. Complete the subscription " +
					"handshake and set the env var to enable processing.",
			);
			res.status(200).json({ ok: true });
			return;
		}

		// 3. Verify the delivery. 401 on mismatch, no processing.
		const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
		const signature = req.header("x-notion-signature");
		if (
			!rawBody ||
			!verifyNotionSignature(verificationToken, rawBody, signature)
		) {
			console.error("notion webhook: invalid or missing X-Notion-Signature — rejected");
			res.status(401).json({ error: "invalid signature" });
			return;
		}

		// 4. ACK first, work second.
		res.status(200).json({ ok: true });

		if (body.type !== "page.properties_updated") {
			console.debug(`notion webhook: ignoring event type ${body.type ?? "(none)"}`);
			return;
		}

		setImmediate(() => {
			void handleEvent(body).catch((err) => {
				console.error(
					"notion webhook: event processing failed:",
					err instanceof Error ? err.message : String(err),
				);
			});
		});
	});

	return router;
}
