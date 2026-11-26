import { google, type drive_v3 } from "googleapis";
import { GOOGLE_EXPORT, isFolder, isGoogleDoc } from "@ahkms/core/adapters";
import { getCredential } from "../credentials.js";
import { getOAuth2Client } from "./oauth.js";
import { readDocument } from "./docs.js";
import { readSpreadsheet } from "./sheets.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	GOOGLE_ACCOUNT_PROVIDER,
	type GoogleAccount,
} from "./accounts.js";

// getOAuth2Client lives in oauth.js (it is shared by Drive, Calendar, Gmail and Docs)
// and is re-exported here so existing importers keep working unchanged.
export { getOAuth2Client };

// Full read + write + manage. Narrow this (e.g. drive.readonly) only if the
// capability scope is ever reduced — but the refresh token is minted against
// whatever scope was consented to, so changing it means re-running google-auth.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// One client per ACCOUNT, not one globally (issue #338). Keyed by account because a
// Drive client is bound to the refresh token it was built with, so a single cached
// client would silently serve the first caller's account to every later caller.
// Each entry records the token it was built with, so token rotation or a passed-in
// fresh token invalidates the stale client (#1048).
const cached = new Map<GoogleAccount, { client: drive_v3.Drive; token: string }>();

/**
 * Drive v3 client for one Google account. The google-auth-library transparently
 * exchanges the refresh token for short-lived access tokens, so a cached client stays
 * valid indefinitely for a given refresh token.
 *
 * Async because the credential seam is async (ADR-045 seam 1) — see getCredential. The
 * ~20 call sites pay one `await` for the multi-tenant path being a body swap later
 * rather than a re-threading of every Drive tool.
 *
 * `refreshToken` lets a caller that already resolved the credential (the Drive
 * discover cadence, which has to check wiring before it sweeps — #977) pass it
 * straight through instead of paying a second `getCredential` round-trip for the
 * same account. If the passed token differs from the cached client's token, the
 * cache invalidates and builds a fresh client with the new token (#1048). Every
 * other call site omits it and this resolves its own via getCredential, caching the
 * client for subsequent calls.
 */
export async function getDrive(
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
	refreshToken?: string,
): Promise<drive_v3.Drive> {
	const existing = cached.get(account);

	if (refreshToken) {
		if (existing && existing.token === refreshToken) return existing.client;
		const auth = getOAuth2Client();
		auth.setCredentials({ refresh_token: refreshToken });
		const client = google.drive({ version: "v3", auth });
		cached.set(account, { client, token: refreshToken });
		return client;
	}

	if (existing) return existing.client;

	// Resolved through the credential seam rather than read from env directly, so the
	// account choice and the secret choice cannot disagree. getCredential throws a setup
	// error naming the exact env var when the account is not wired.
	const token = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
	const auth = getOAuth2Client();
	auth.setCredentials({ refresh_token: token });
	const client = google.drive({ version: "v3", auth });
	cached.set(account, { client, token });
	return client;
}

/** Clear cached clients (useful in tests, or when credentials rotate). */
export function clearDriveCache(account?: GoogleAccount): void {
	if (account) {
		cached.delete(account);
	} else {
		cached.clear();
	}
}

export {
	FILE_FIELDS,
	GOOGLE_DOC_MIME_TYPE,
	GOOGLE_EXPORT,
	isFolder,
	isGoogleDoc,
	LIST_FIELDS,
	formatFile,
	formatList,
	type DriveFile,
} from "@ahkms/core/adapters";

// Download a file's bytes. Google-native docs are exported to the mapped format;
// everything else is fetched raw via alt=media. Returns the bytes plus the
// effective mime type / extension so callers can store them honestly.
export async function downloadFileBytes(
	fileId: string,
	mimeType: string | null | undefined,
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
): Promise<{ buffer: Buffer; mimeType: string; extension: string | null }> {
	const drive = await getDrive(account);

	if (isFolder(mimeType)) {
		throw new Error(`File ${fileId} is a folder and has no content to download.`);
	}

	// Google Docs go through the Docs API, not Drive's export, because export renders
	// the default tab only and drops every other tab silently (see google/docs.ts).
	// Doing it here rather than in each caller means drive_read_file, ingest_drive and
	// drive_import_file all stop truncating tabbed documents at once.
	if (mimeType === "application/vnd.google-apps.document") {
		const doc = await readDocument(fileId, account);
		return {
			buffer: Buffer.from(doc.text, "utf-8"),
			mimeType: "text/markdown",
			extension: "md",
		};
	}

	// Google Sheets go through the Sheets API for the same reason: Drive's export renders
	// only the first sheet/tab as CSV and drops all other tabs silently (#1433, ADR-102 §3).
	if (mimeType === "application/vnd.google-apps.spreadsheet") {
		const sheet = await readSpreadsheet(fileId, account);
		return {
			buffer: Buffer.from(sheet.text, "utf-8"),
			mimeType: "text/markdown",
			extension: "md",
		};
	}

	if (isGoogleDoc(mimeType)) {
		const target = GOOGLE_EXPORT[mimeType ?? ""];
		if (!target) {
			throw new Error(
				`Google-native file type "${mimeType}" cannot be exported by these tools.`,
			);
		}
		const res = await drive.files.export(
			{ fileId, mimeType: target.mimeType },
			{ responseType: "arraybuffer" },
		);
		return {
			buffer: Buffer.from(res.data as ArrayBuffer),
			mimeType: target.mimeType,
			extension: target.extension,
		};
	}

	const res = await drive.files.get(
		{ fileId, alt: "media" },
		{ responseType: "arraybuffer" },
	);
	return {
		buffer: Buffer.from(res.data as ArrayBuffer),
		mimeType: mimeType ?? "application/octet-stream",
		extension: null,
	};
}
