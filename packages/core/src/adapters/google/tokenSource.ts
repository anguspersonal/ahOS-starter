/**
 * @ahkms/core/adapters/google/tokenSource
 *
 * Shared Google OAuth refresh-token exchange keyed by domain (ADR-101 §1, ADR-045, Issue #1480).
 * Resolves the domain's refresh token per call and exchanges it for a short-lived access token
 * via plain fetch. No token caching and no googleapis dependency.
 */

import { DOMAINS, type Domain } from "../../domain/domains.js";

export interface GoogleTokenSourceConfig {
	clientId?: string;
	clientSecret?: string;
	refreshToken: (domain: Domain) => Promise<string | null | undefined>;
	fetchFn?: typeof fetch;
}

export interface GoogleTokenSource {
	accessToken(domain: Domain): Promise<string>;
}

function assertValidDomain(domain: unknown): asserts domain is Domain {
	if (typeof domain !== "string" || !(DOMAINS as readonly string[]).includes(domain)) {
		throw new Error(
			`Unknown Google domain '${String(domain)}'. Expected one of: ${DOMAINS.join(", ")}.`,
		);
	}
}

export function createGoogleTokenSource(config: GoogleTokenSourceConfig): GoogleTokenSource {
	return {
		async accessToken(domain: Domain): Promise<string> {
			assertValidDomain(domain);

			const clientId = config.clientId?.trim();
			const clientSecret = config.clientSecret?.trim();
			if (!clientId || !clientSecret) {
				throw new Error(
					`Google OAuth clientId and clientSecret are required for domain '${domain}'`,
				);
			}

			const refresh = (await config.refreshToken(domain))?.trim();
			if (!refresh) {
				throw new Error(
					`Google refresh token for domain '${domain}' is not configured`,
				);
			}

			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const params = new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refresh,
				grant_type: "refresh_token",
			});

			const res = await fetchImpl("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString(),
			});

			if (!res.ok) {
				let errorCode = "unknown_error";
				try {
					const body = (await res.json()) as { error?: unknown };
					if (typeof body?.error === "string" && body.error.trim().length > 0) {
						errorCode = body.error.trim();
					}
				} catch {
					// Ignore unparseable body; never include raw response body or tokens in error message.
				}
				throw new Error(
					`Google OAuth token exchange failed for domain '${domain}' (HTTP ${res.status}, error: ${errorCode})`,
				);
			}

			const data = (await res.json()) as { access_token?: string };
			if (!data.access_token) {
				throw new Error(
					`Google OAuth token response for domain '${domain}' did not contain access_token`,
				);
			}

			return data.access_token;
		},
	};
}
