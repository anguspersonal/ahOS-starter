import express, { type Router } from "express";
import { setTimeout as delay } from "node:timers/promises";
import {
	OwnerOAuthProvider,
	renderLoginForm,
	OWNER_SCOPE,
} from "./ownerOAuthProvider.js";
import { LoginRateLimiter } from "./loginRateLimiter.js";

/** Per-attempt delay (ms) applied to every `/owner-login` POST, slowing online guessing. */
const DEFAULT_FIXED_DELAY_MS = 500;

export type LoginRouterOptions = {
	/** Injectable for tests; defaults to the standard per-IP limiter. */
	rateLimiter?: LoginRateLimiter;
	/** Fixed delay per attempt (ms). Tests pass 0 to keep the suite fast. */
	fixedDelayMs?: number;
};

/**
 * Handles the owner login/consent POST (step 2 of the authorize flow). Kept separate from
 * the SDK's `mcpAuthRouter` because the consent screen is bespoke to this single-owner
 * server. Mount at the application root so its path is `/owner-login`, matching the form
 * action emitted by {@link OwnerOAuthProvider.authorize}.
 *
 * Security:
 *  - the posted `redirect_uri` is re-validated against the registered client's allow-list
 *    here, so a forged form cannot turn the AS into an open redirector even though the SDK
 *    already validated it on the initial GET /authorize;
 *  - the gate rests on a single shared password on an internet-facing endpoint, so each
 *    attempt is throttled with a fixed delay and a per-IP attempt limiter (429 + Retry-After
 *    once the ceiling is hit) to make online brute-forcing impractical. The constant-time
 *    password compare lives in {@link OwnerOAuthProvider.verifyOwnerPassword}.
 */
export function ownerLoginRouter(
	provider: OwnerOAuthProvider,
	options: LoginRouterOptions = {},
): Router {
	const router = express.Router();
	router.use(express.urlencoded({ extended: false }));

	const limiter = options.rateLimiter ?? new LoginRateLimiter();
	const fixedDelayMs = options.fixedDelayMs ?? DEFAULT_FIXED_DELAY_MS;

	router.post("/owner-login", async (req, res) => {
		// `req.ip` honours X-Forwarded-For only when the app sets `trust proxy` (http.ts does,
		// for the single Railway hop). Fall back to a constant so a missing IP can't bypass
		// the limiter by registering every attempt under `undefined`.
		const ip = req.ip ?? "unknown";

		const limit = limiter.check(ip);
		if (limit.blocked) {
			if (limit.retryAfterSec !== undefined) {
				res.setHeader("Retry-After", String(limit.retryAfterSec));
			}
			res.status(429).setHeader("Content-Type", "text/html; charset=utf-8");
			res.send(
				renderLoginForm({
					clientName: (req.body as Record<string, string | undefined>)?.client_id ?? "",
					clientId: (req.body as Record<string, string | undefined>)?.client_id ?? "",
					redirectUri: (req.body as Record<string, string | undefined>)?.redirect_uri ?? "",
					codeChallenge: (req.body as Record<string, string | undefined>)?.code_challenge ?? "",
					scope: OWNER_SCOPE,
					error: "Too many attempts. Wait a few minutes and try again.",
				}),
			);
			return;
		}

		const body = req.body as Record<string, string | undefined>;
		const clientId = body.client_id ?? "";
		const redirectUri = body.redirect_uri ?? "";
		const codeChallenge = body.code_challenge ?? "";
		const state = body.state;
		const scope = body.scope ?? OWNER_SCOPE;
		const resource = body.resource;
		const password = body.password ?? "";

		const reRender = (error: string, status = 400) => {
			res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
			res.send(
				renderLoginForm({
					clientName: clientId,
					clientId,
					redirectUri,
					codeChallenge,
					state,
					scope,
					resource,
					error,
				}),
			);
		};

		if (!clientId || !redirectUri || !codeChallenge) {
			return reRender("Malformed authorization request. Restart the connection.");
		}

		// Re-validate the client + redirect_uri (defence against a forged POST).
		const client = await provider.clientsStore.getClient(clientId);
		if (!client) {
			return reRender("Unknown client. Restart the connection.");
		}
		if (!client.redirect_uris.includes(redirectUri)) {
			return reRender("redirect_uri is not registered for this client.");
		}

		// Fixed delay on every password-bearing attempt: throttles online guessing and
		// blunts (alongside the constant-time compare) any residual timing signal.
		if (fixedDelayMs > 0) await delay(fixedDelayMs);

		if (!provider.verifyOwnerPassword(password)) {
			limiter.recordFailure(ip);
			return reRender("Incorrect password.", 401);
		}

		limiter.recordSuccess(ip);
		const location = provider.createAuthorizationRedirect({
			clientId,
			redirectUri,
			codeChallenge,
			scope,
			state,
			resource,
		});
		res.redirect(302, location);
	});

	return router;
}
