import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { env } from "../env.js";
import { getCredential } from "../credentials.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	GOOGLE_ACCOUNT_PROVIDER,
	type GoogleAccount,
} from "./accounts.js";

// Google OAuth plumbing shared by every Google client (Drive, Calendar, Gmail, Docs).
//
// Lifted out of drive.ts to break an import cycle rather than for tidiness: docs.ts
// needs an access token, drive.ts needs docs.ts to read tabbed documents, and with the
// OAuth helpers still living in drive.ts those two import each other. drive.ts
// re-exports getOAuth2Client so existing importers (calendar.ts, scripts/google-oauth.ts)
// keep working unchanged.

/**
 * Build an OAuth2 client from the project's OAuth client credentials — a "Web
 * application" client, which is why every redirect URI must be registered exactly
 * (see scripts/google-oauth.ts and #508).
 *
 * Carries no account: the client id and secret identify the APPLICATION, and the
 * account is decided by which refresh token gets set on the returned client.
 */
export function getOAuth2Client(): OAuth2Client {
	if (!env.googleClientId || !env.googleClientSecret) {
		throw new Error(
			"GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — required for every Google tool. See packages/mcp-server/.env.example",
		);
	}
	return new google.auth.OAuth2(
		env.googleClientId,
		env.googleClientSecret,
		env.googleOAuthRedirect,
	);
}

/**
 * Mint a short-lived bearer token for one account, for the clients that call Google's
 * REST endpoints with fetch (Calendar, Gmail, Docs) rather than through the googleapis
 * SDK (Drive).
 *
 * Resolved through the credential seam rather than read from env, so the account choice
 * and the secret choice cannot disagree (ADR-045 seam 1, issue #338).
 *
 * `refreshToken` is the same escape hatch getDrive() has (#977): a scheduled sweep that
 * already resolved the account's credential to decide whether it is wired at all (the
 * Gmail attachment discover cadence, #1210) passes it straight through rather than
 * paying a second `getCredential` round-trip for the same account.
 */
export async function getGoogleAccessToken(
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
	purpose = "Google",
	refreshToken?: string,
): Promise<string> {
	const resolved = refreshToken ?? (await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]));
	const auth = getOAuth2Client();
	auth.setCredentials({ refresh_token: resolved });
	const { token } = await auth.getAccessToken();
	if (!token) {
		throw new Error(
			`Failed to obtain a ${purpose} access token for the '${account}' account from its stored refresh token.`,
		);
	}
	return token;
}
