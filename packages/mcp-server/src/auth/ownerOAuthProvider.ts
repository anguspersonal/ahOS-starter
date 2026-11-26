import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type {
	OAuthServerProvider,
	AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
	OAuthClientInformationFull,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { HttpEnv } from "../env.js";

/** The single MCP scope this server issues. Single-user: scope is informational. */
export const OWNER_SCOPE = "kms";

type StoredCode = {
	codeChallenge: string;
	clientId: string;
	redirectUri: string;
	scopes: string[];
	resource?: string;
	expiresAt: number;
};

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes — only spans the redirect dance.

/**
 * A self-hosted OAuth 2.1 Authorization Server for a single owner (issue #84 / ADR-019
 * follow-up #1). The MCP server *is* the AS — per the ADR we do NOT delegate to a
 * platform/proxy auth layer, which would interfere with the client's in-chat handshake.
 *
 * Design (deliberately the smallest thing that satisfies the spec for one user):
 *  - **Login gate:** one shared owner password ({@link HttpEnv.ownerPassword}) entered on
 *    the consent screen. Correct password ⇒ an authorization code is minted; this is what
 *    makes "unauthenticated calls are rejected" true.
 *  - **Tokens:** stateless HS256 JWTs signed with {@link HttpEnv.jwtSecret}. Verification
 *    needs no server-side store, so access + refresh survive container restarts. The trade
 *    is that individual tokens can't be revoked before expiry (see {@link revokeToken}).
 *  - **PKCE:** required; the SDK's token handler verifies `code_verifier` against the
 *    challenge we return from {@link challengeForAuthorizationCode}.
 *  - **Clients:** persisted via the injected {@link OAuthRegisteredClientsStore} (Supabase),
 *    so DCR registrations outlive a redeploy.
 *
 * The Supabase service-role key never leaves the server; the client only ever holds one of
 * these JWTs.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
	private readonly codes = new Map<string, StoredCode>();
	private readonly secret: Uint8Array;
	private readonly issuer: string;

	constructor(
		private readonly httpEnv: HttpEnv,
		private readonly clients: OAuthRegisteredClientsStore,
		private readonly userId: string,
	) {
		this.secret = new TextEncoder().encode(httpEnv.jwtSecret);
		this.issuer = httpEnv.publicUrl;
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return this.clients;
	}

	/**
	 * Step 1 of the flow: render the owner login/consent screen. The form POSTs back to
	 * `/owner-login` (see loginRouter) carrying the authorization params as hidden fields.
	 * We never auto-approve — the password check is the whole point of the gate.
	 */
	async authorize(
		client: OAuthClientInformationFull,
		params: AuthorizationParams,
		res: Response,
	): Promise<void> {
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		res.send(
			renderLoginForm({
				clientName: client.client_name ?? client.client_id,
				clientId: client.client_id,
				redirectUri: params.redirectUri,
				codeChallenge: params.codeChallenge,
				state: params.state,
				scope: (params.scopes ?? [OWNER_SCOPE]).join(" "),
				resource: params.resource?.href,
			}),
		);
	}

	/**
	 * True iff the supplied password matches the configured owner password.
	 *
	 * Compares in constant time: both inputs are SHA-256'd to a fixed 32-byte digest first,
	 * so `timingSafeEqual` never sees unequal lengths (which would throw) and the comparison
	 * leaks neither the password length nor how many leading characters matched. This is the
	 * load-bearing gate on an internet-facing surface, so a naive `===` (which short-circuits
	 * on the first mismatched byte) is a timing oracle worth closing.
	 */
	verifyOwnerPassword(password: string): boolean {
		if (typeof password !== "string") return false;
		const supplied = createHash("sha256").update(password).digest();
		const expected = createHash("sha256")
			.update(this.httpEnv.ownerPassword)
			.digest();
		return timingSafeEqual(supplied, expected);
	}

	/**
	 * Step 2 (called by the login route after a correct password): mint a one-time
	 * authorization code bound to the PKCE challenge + redirect, and return the absolute
	 * redirect URL (with `code` and `state`) the browser should be sent to.
	 *
	 * `redirectUri` is re-validated against the registered client by the caller before this
	 * runs, so a forged form can't turn the AS into an open redirector.
	 */
	createAuthorizationRedirect(input: {
		clientId: string;
		redirectUri: string;
		codeChallenge: string;
		scope?: string;
		state?: string;
		resource?: string;
	}): string {
		const code = randomUUID();
		this.codes.set(code, {
			codeChallenge: input.codeChallenge,
			clientId: input.clientId,
			redirectUri: input.redirectUri,
			scopes: input.scope ? input.scope.split(/\s+/).filter(Boolean) : [OWNER_SCOPE],
			resource: input.resource,
			expiresAt: Date.now() + AUTH_CODE_TTL_MS,
		});
		const url = new URL(input.redirectUri);
		url.searchParams.set("code", code);
		if (input.state !== undefined) url.searchParams.set("state", input.state);
		return url.href;
	}

	async challengeForAuthorizationCode(
		_client: OAuthClientInformationFull,
		authorizationCode: string,
	): Promise<string> {
		const stored = this.takePeek(authorizationCode);
		return stored.codeChallenge;
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
		_codeVerifier?: string,
		redirectUri?: string,
		resource?: URL,
	): Promise<OAuthTokens> {
		const stored = this.consume(authorizationCode);
		if (stored.clientId !== client.client_id) {
			throw new InvalidGrantError("Authorization code was issued to another client");
		}
		if (redirectUri !== undefined && redirectUri !== stored.redirectUri) {
			throw new InvalidGrantError("redirect_uri does not match the authorization request");
		}
		return this.issueTokens(
			stored.scopes,
			resource?.href ?? stored.resource,
			stored.clientId,
		);
	}

	async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
		scopes?: string[],
		resource?: URL,
	): Promise<OAuthTokens> {
		let payload;
		try {
			({ payload } = await jwtVerify(refreshToken, this.secret, {
				issuer: this.issuer,
			}));
		} catch {
			throw new InvalidGrantError("Invalid or expired refresh token");
		}
		if (payload.typ !== "refresh" || payload.client_id !== client.client_id) {
			throw new InvalidGrantError("Refresh token is not valid for this client");
		}
		const grantedScopes =
			scopes && scopes.length > 0
				? scopes
				: typeof payload.scope === "string"
					? payload.scope.split(/\s+/).filter(Boolean)
					: [OWNER_SCOPE];
		return this.issueTokens(grantedScopes, resource?.href, client.client_id);
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		let payload;
		try {
			({ payload } = await jwtVerify(token, this.secret, { issuer: this.issuer }));
		} catch {
			throw new InvalidGrantError("Invalid or expired access token");
		}
		if (payload.typ !== "access") {
			throw new InvalidGrantError("Token is not an access token");
		}
		const scopes =
			typeof payload.scope === "string"
				? payload.scope.split(/\s+/).filter(Boolean)
				: [];
		const aud = typeof payload.aud === "string" ? payload.aud : undefined;
		return {
			token,
			clientId: typeof payload.client_id === "string" ? payload.client_id : "",
			scopes,
			expiresAt: payload.exp,
			resource: aud ? new URL(aud) : undefined,
			extra: { userId: payload.sub },
		};
	}

	/**
	 * Token revocation is a no-op: tokens are stateless JWTs with no server-side store, so
	 * there is nothing to delete — they simply expire. A real denylist is overkill for a
	 * single-owner server; rotating MCP_OAUTH_JWT_SECRET invalidates everything at once.
	 * Declared so DCR clients that call /revoke get a clean 200 rather than an error.
	 */
	async revokeToken(): Promise<void> {
		// intentionally empty
	}

	// --- internals ---

	private async issueTokens(
		scopes: string[],
		resource: string | undefined,
		clientId?: string,
	): Promise<OAuthTokens> {
		const scope = (scopes.length ? scopes : [OWNER_SCOPE]).join(" ");
		const accessToken = await this.signToken(
			"access",
			scope,
			this.httpEnv.accessTokenTtl,
			resource,
			clientId,
		);
		const refreshToken = await this.signToken(
			"refresh",
			scope,
			this.httpEnv.refreshTokenTtl,
			resource,
			clientId,
		);
		return {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: this.httpEnv.accessTokenTtl,
			scope,
			refresh_token: refreshToken,
		};
	}

	private async signToken(
		typ: "access" | "refresh",
		scope: string,
		ttlSeconds: number,
		resource?: string,
		clientId?: string,
	): Promise<string> {
		const builder = new SignJWT({ typ, scope, client_id: clientId })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setIssuer(this.issuer)
			.setSubject(this.userId)
			.setExpirationTime(`${ttlSeconds}s`);
		if (resource) builder.setAudience(resource);
		return builder.sign(this.secret);
	}

	/** Read a code without consuming it (used for the PKCE challenge lookup). */
	private takePeek(code: string): StoredCode {
		const stored = this.codes.get(code);
		if (!stored || stored.expiresAt < Date.now()) {
			this.codes.delete(code);
			throw new InvalidGrantError("Invalid or expired authorization code");
		}
		return stored;
	}

	/** Read and delete a code (one-time use, on token exchange). */
	private consume(code: string): StoredCode {
		const stored = this.takePeek(code);
		this.codes.delete(code);
		return stored;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function hidden(name: string, value: string | undefined): string {
	if (value === undefined) return "";
	return `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;
}

/**
 * The consent screen. Minimal, self-contained HTML (no external assets) so it renders the
 * same everywhere. `error` is set when re-rendering after a wrong password.
 */
export function renderLoginForm(input: {
	clientName: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state?: string;
	scope: string;
	resource?: string;
	error?: string;
}): string {
	const errorBlock = input.error
		? `<p class="error" role="alert">${escapeHtml(input.error)}</p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ahkms — authorize access</title>
<style>
	:root { color-scheme: light dark; }
	body { font-family: system-ui, -apple-system, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
	h1 { font-size: 1.25rem; }
	.client { font-weight: 600; }
	label { display: block; margin: 1rem 0 0.25rem; font-size: 0.9rem; }
	input[type=password] { width: 100%; padding: 0.6rem; font-size: 1rem; box-sizing: border-box; }
	button { margin-top: 1.25rem; padding: 0.6rem 1.1rem; font-size: 1rem; cursor: pointer; }
	.error { color: #c0392b; font-weight: 600; }
	.muted { color: #777; font-size: 0.8rem; margin-top: 1.5rem; }
</style>
</head>
<body>
	<h1>Authorize <span class="client">${escapeHtml(input.clientName)}</span></h1>
	<p>This app is requesting access to your ahkms knowledge store. Enter the owner password to allow it.</p>
	${errorBlock}
	<form method="post" action="owner-login">
		${hidden("client_id", input.clientId)}
		${hidden("redirect_uri", input.redirectUri)}
		${hidden("code_challenge", input.codeChallenge)}
		${hidden("state", input.state)}
		${hidden("scope", input.scope)}
		${hidden("resource", input.resource)}
		<label for="password">Owner password</label>
		<input type="password" id="password" name="password" autocomplete="current-password" autofocus required />
		<button type="submit">Authorize</button>
	</form>
	<p class="muted">Only the owner of this knowledge store should complete this step.</p>
</body>
</html>`;
}
