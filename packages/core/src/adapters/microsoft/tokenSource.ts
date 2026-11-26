/**
 * Microsoft OAuth 2.0 (`consumers` authority) refresh-token exchange helper for
 * `@ahkms/core/adapters` (issue #2043).
 *
 * Exchanges a personal Microsoft refresh token at
 * `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`, caching the
 * short-lived `access_token` until expiry and rotating the `refresh_token` in
 * memory whenever Microsoft issues a new one on refresh.
 */

export const MICROSOFT_AUTHORIZE_URL =
	"https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL =
	"https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

export const MICROSOFT_ONEDRIVE_SCOPES = [
	"Files.ReadWrite",
	"offline_access",
	"User.Read",
] as const;

export interface MicrosoftTokenSourceConfig {
	clientId: string;
	clientSecret?: string | null;
	refreshToken: () =>
		| Promise<string | null | undefined>
		| string
		| null
		| undefined;
	scopes?: readonly string[];
	fetchFn?: typeof fetch;
	nowFn?: () => number;
}

export function createMicrosoftTokenSource(
	config: MicrosoftTokenSourceConfig,
): () => Promise<string> {
	const fetchFn = config.fetchFn ?? globalThis.fetch;
	const nowFn = config.nowFn ?? Date.now;
	const scopes = (config.scopes ?? MICROSOFT_ONEDRIVE_SCOPES).join(" ");

	let cachedAccessToken: string | null = null;
	let expiresAtMs = 0;
	let rotatedRefreshToken: string | null = null;
	let lastSeedRefreshToken: string | null = null;

	return async (): Promise<string> => {
		const configuredRefresh = await config.refreshToken();
		if (!configuredRefresh) {
			throw new Error(
				"Missing Microsoft OAuth refresh token for OneDrive adapter (MICROSOFT_REFRESH_TOKEN_PERSONAL).",
			);
		}
		if (!config.clientId) {
			throw new Error(
				"Missing MICROSOFT_CLIENT_ID for Microsoft OAuth token exchange.",
			);
		}

		// Reset cached state if the underlying configured refresh token changed
		if (
			lastSeedRefreshToken !== null &&
			lastSeedRefreshToken !== configuredRefresh
		) {
			cachedAccessToken = null;
			expiresAtMs = 0;
			rotatedRefreshToken = null;
		}
		lastSeedRefreshToken = configuredRefresh;

		const now = nowFn();
		if (cachedAccessToken && now < expiresAtMs) {
			return cachedAccessToken;
		}

		const refreshToExchange = rotatedRefreshToken ?? configuredRefresh;
		const params = new URLSearchParams({
			client_id: config.clientId,
			refresh_token: refreshToExchange,
			grant_type: "refresh_token",
			scope: scopes,
		});
		if (config.clientSecret) {
			params.set("client_secret", config.clientSecret);
		}

		const res = await fetchFn(MICROSOFT_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		const body = (await res.json().catch(() => ({}))) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		};

		if (!res.ok || !body.access_token) {
			const detail = [body.error, body.error_description]
				.filter(Boolean)
				.join(" ");
			throw new Error(
				`Microsoft OAuth token refresh failed (${res.status}): ${detail || res.statusText}`,
			);
		}

		const ttlSeconds =
			typeof body.expires_in === "number" && body.expires_in > 0
				? body.expires_in
				: 3600;
		const bufferMs = Math.min(60_000, Math.floor((ttlSeconds * 1000) / 2));

		cachedAccessToken = body.access_token;
		expiresAtMs = now + ttlSeconds * 1000 - bufferMs;
		if (body.refresh_token) {
			rotatedRefreshToken = body.refresh_token;
		}

		return cachedAccessToken;
	};
}
