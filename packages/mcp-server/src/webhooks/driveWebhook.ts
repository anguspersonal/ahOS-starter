import express from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { dispatchAction } from "./dispatchAction.js";
import type { LoginRateLimiter } from "../auth/loginRateLimiter.js";
import {
	createWebhookLimiter,
	recordAuthFailure,
	rejectIfLockedOut,
	webhookErrorHandler,
} from "./webhookGuards.js";

// POST /webhooks/drive — Google Drive Push Notifications webhook (ADR-048).
// Receives change notifications from Google Drive watch channels (changes.watch)
// and triggers reactive discovery instead of waiting for the 15-minute polling cadence.
//
// Google Push Notification Headers:
//   X-Goog-Channel-ID: <channel-uuid>
//   X-Goog-Channel-Token: <secret-token>
//   X-Goog-Resource-ID: <resource-id>
//   X-Goog-Resource-State: sync | add | update | trash | change
//
// Lifecycle:
//   1. Not-yet-configured — if DRIVE_WEBHOOK_TOKEN is not set, ACK 200 without processing.
//   2. Configured — token mismatch => 401 (the sync handshake carries the token too, so it
//      is checked as well). Handshake (state: "sync") => ACK 200. Valid change state => ACK
//      200 and request a discovery sweep, coalesced by a single-flight + trailing debounce
//      so bursts or replayed headers cannot fan out overlapping whole-estate sweeps.
//   3. A per-IP failed-auth rate limiter runs first (ADR-096 rule 4).
//
// Channel registration & renewal: managed automatically by the `drive-watch` cadence
// in @ahkms/core/src/engine/cadences/driveWatchCadence.ts (ADR-101, Issue #1348).
// Channels are renewed ahead of expiry and stopped on retirement. The 15-minute polling
// cadence remains the active safety net.

/** Quiet period before a burst of notifications turns into one discovery sweep. */
export const DRIVE_DEBOUNCE_MS = 10_000;

export type DriveWebhookOptions = {
	/** Override the Drive webhook token (tests). Defaults to env.driveWebhookToken. */
	webhookToken?: string | null;
	/** Override the cadence trigger (tests). Defaults to drive_discover_sweep action. */
	triggerDiscover?: (input?: { channelId?: string }) => Promise<void>;
	/** Override the debounce quiet period in ms (tests). Defaults to DRIVE_DEBOUNCE_MS. */
	debounceMs?: number;
	/** Override the failed-auth rate limiter (tests). */
	rateLimiter?: LoginRateLimiter;
};

function verifyToken(expected: string, provided: string | undefined | null): boolean {
	if (!provided) return false;
	const expectedBuf = Buffer.from(expected);
	const providedBuf = Buffer.from(provided);
	if (expectedBuf.length !== providedBuf.length) return false;
	return timingSafeEqual(expectedBuf, providedBuf);
}

/** Strip anything but id-safe characters and cap length before logging a header value. */
function logSafe(value: string | undefined | null): string {
	return value ? value.replace(/[^\w.-]/g, "_").slice(0, 80) : "(none)";
}

/** Build the `/webhooks/drive` router. Mount with `app.use("/webhooks/drive", …)`. */
export function driveWebhookRouter(opts: DriveWebhookOptions = {}): express.Router {
	const webhookToken =
		opts.webhookToken !== undefined ? opts.webhookToken : env.driveWebhookToken;
	const triggerDiscover =
		opts.triggerDiscover ??
		dispatchAction<{ channelId?: string }, void>("drive_discover_sweep", "webhooks/drive");
	const debounceMs = opts.debounceMs ?? DRIVE_DEBOUNCE_MS;
	const limiter = opts.rateLimiter ?? createWebhookLimiter();

	// Single-flight + trailing debounce (per router instance). A burst of valid
	// notifications collapses into one sweep after a quiet period; notifications arriving
	// while a sweep runs set `pending` and cause exactly one follow-up sweep afterwards.
	// Never more than one webhook-triggered sweep in flight, however fast deliveries land.
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let pending = false;
	const queuedChannelIds = new Set<string | undefined>();
	const pendingChannelIds = new Set<string | undefined>();

	const runSweep = async (): Promise<void> => {
		running = true;
		const channelIds = Array.from(queuedChannelIds);
		queuedChannelIds.clear();
		try {
			const targets = channelIds.length > 0 ? channelIds : [undefined];
			for (const chId of targets) {
				if (chId) {
					await triggerDiscover({ channelId: chId });
				} else {
					await triggerDiscover();
				}
			}
		} catch (err) {
			console.error(
				"drive webhook: reactive discovery trigger failed:",
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			running = false;
			if (pending) {
				pending = false;
				for (const id of pendingChannelIds) {
					queuedChannelIds.add(id);
				}
				pendingChannelIds.clear();
				scheduleSweepTimer();
			}
		}
	};

	function scheduleSweepTimer(): void {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			void runSweep();
		}, debounceMs);
		timer.unref?.();
	}

	function requestSweep(channelId?: string): void {
		if (running) {
			pending = true;
			pendingChannelIds.add(channelId);
			return;
		}
		queuedChannelIds.add(channelId);
		scheduleSweepTimer();
	}

	const router = express.Router();
	router.use(rejectIfLockedOut(limiter));

	router.post("/", (req, res) => {
		const channelId = req.header("x-goog-channel-id");
		const resourceState = req.header("x-goog-resource-state");
		const resourceId = req.header("x-goog-resource-id");
		const token = req.header("x-goog-channel-token");

		// 1. Unconfigured check: nothing can be authenticated, so acknowledge and do nothing
		if (!webhookToken) {
			console.error(
				"drive webhook: delivery received but DRIVE_WEBHOOK_TOKEN is not configured — acknowledged without processing",
			);
			res.status(200).json({ ok: true });
			return;
		}

		// 2. Verify token (Google echoes the channel token on the sync handshake too)
		if (!verifyToken(webhookToken, token)) {
			recordAuthFailure(limiter, req);
			console.error("drive webhook: invalid or missing X-Goog-Channel-Token — rejected");
			res.status(401).json({ error: "invalid token" });
			return;
		}

		// 3. Subscription handshake
		if (resourceState === "sync") {
			console.log(`drive webhook: sync handshake received for channel ${logSafe(channelId)}`);
			res.status(200).json({ ok: true, state: "sync" });
			return;
		}

		// 4. ACK immediately
		res.status(200).json({ ok: true });

		// 5. Coalesced reactive discovery
		console.log(
			`drive webhook: received ${logSafe(resourceState)} notification for channel ${logSafe(channelId)}, resource ${logSafe(resourceId)}`,
		);
		requestSweep(channelId);
	});

	router.use(webhookErrorHandler);

	return router;
}
