import {
	countDocumentTabs as coreCountDocumentTabs,
	readDocument as coreReadDocument,
	type DocTab,
	type DocsAuth,
	type ReadDocResult,
} from "@ahkms/core/adapters";
import { google, type docs_v1 } from "googleapis";
import { getCredential } from "../credentials.js";
import { getOAuth2Client, getGoogleAccessToken } from "./oauth.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	GOOGLE_ACCOUNT_PROVIDER,
	type GoogleAccount,
} from "./accounts.js";

export type { DocTab, DocsAuth, ReadDocResult };

// One client per ACCOUNT, matching the pattern in drive.ts and appsscript.ts (issue #338).
const cached = new Map<GoogleAccount, { client: docs_v1.Docs; token: string }>();

/**
 * Docs v1 client for one Google account. The google-auth-library transparently
 * exchanges the refresh token for short-lived access tokens, so a cached client stays
 * valid indefinitely for a given refresh token.
 */
export async function getDocs(
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
	refreshToken?: string,
): Promise<docs_v1.Docs> {
	const existing = cached.get(account);

	if (refreshToken) {
		if (existing && existing.token === refreshToken) return existing.client;
		const auth = getOAuth2Client();
		auth.setCredentials({ refresh_token: refreshToken });
		const client = google.docs({ version: "v1", auth });
		cached.set(account, { client, token: refreshToken });
		return client;
	}

	if (existing) return existing.client;

	const token = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
	const auth = getOAuth2Client();
	auth.setCredentials({ refresh_token: token });
	const client = google.docs({ version: "v1", auth });
	cached.set(account, { client, token });
	return client;
}

/** Clear cached clients (useful in tests, or when credentials rotate). */
export function clearDocsCache(account?: GoogleAccount): void {
	if (account) {
		cached.delete(account);
	} else {
		cached.clear();
	}
}

const authFor = (account: GoogleAccount): DocsAuth => ({
	label: account,
	accessToken: () => getGoogleAccessToken(account, "Google Docs"),
});

export function readDocument(
	documentId: string,
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
): Promise<ReadDocResult> {
	return coreReadDocument(documentId, authFor(account));
}

export function countDocumentTabs(
	documentId: string,
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
): Promise<number> {
	return coreCountDocumentTabs(documentId, authFor(account));
}
