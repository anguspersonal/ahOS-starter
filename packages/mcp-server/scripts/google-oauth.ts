/**
 * One-time helper to mint a Google OAuth **refresh token**, per Google ACCOUNT, for
 * the Drive, Calendar and Gmail tools.
 *
 * Run it once per account (issue #338):
 *   ... google-oauth.ts --account personal   -> GOOGLE_REFRESH_TOKEN_PERSONAL
 *   ... google-oauth.ts --account work    -> GOOGLE_REFRESH_TOKEN_WORK
 *
 * The account flag only decides which env var name is printed at the end. WHICH
 * Google account the token actually belongs to is decided by which account you are
 * signed in as on the consent screen, so sign in deliberately.
 *
 * Uses the OAuth loopback flow (Google's recommended flow for installed/desktop
 * apps): it starts a tiny local web server, prints a consent URL, and after you
 * approve, Google redirects back here with a code that is exchanged for tokens.
 * The resulting refresh_token is printed for you to paste into
 * packages/mcp-server/.env as GOOGLE_REFRESH_TOKEN_PERSONAL.
 *
 * Prerequisites — the project's OAuth client in Google Cloud Console
 * (APIs & Services → Credentials) is a "Web application" client. Web clients
 * require every redirect URI to be registered EXACTLY: add the loopback
 * redirect this script listens on (default http://localhost:53682/oauth2callback,
 * override via GOOGLE_OAUTH_REDIRECT) under "Authorized redirect URIs", or the
 * consent flow fails with `Error 400: redirect_uri_mismatch` (#508). Enable the
 * Google Drive API AND the Google Calendar API for the project, and ensure the
 * OAuth consent screen Publishing status is "In production" (if left in "Testing",
 * Google revokes issued refresh tokens after 7 days with `invalid_grant`, #2052).
 *
 * Only GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET need to be set to run this —
 * env resolution is lazy (#508), so no Supabase/other secrets are required.
 *
 * Issue #126 (Event/Act facet, ADR-038 §6): the scope list below now also requests
 * CALENDAR_SCOPE, so re-running this helper is required to activate create_event — an
 * existing refresh token minted before this change is Drive-scope-only and will 403 on
 * Calendar calls until re-minted (prompt=consent below forces a fresh refresh_token that
 * carries both scopes).
 *
 * Run from repo root (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET must be set,
 * e.g. via the package .env):
 *   node --env-file=packages/mcp-server/.env --import tsx packages/mcp-server/scripts/google-oauth.ts
 */
import { createServer } from "node:http";
import { URL } from "node:url";
import { getOAuth2Client } from "../src/google/drive.js";
import { GOOGLE_MINT_SCOPES } from "../src/google/scopes.js";
import {
	GOOGLE_ACCOUNTS,
	parseGoogleAccount,
	type GoogleAccount,
} from "../src/google/accounts.js";
import { env } from "../src/env.js";

// Which env var the minted token belongs in, per account (issue #338). Kept here
// rather than in accounts.ts because it is a property of the OPERATOR's .env file,
// not of the running server: the server reads these names via credentials.ts.
const ENV_VAR: Record<GoogleAccount, string> = {
	personal: "GOOGLE_REFRESH_TOKEN_PERSONAL",
	work: "GOOGLE_REFRESH_TOKEN_WORK",
};

/** Read `--account <name>` from argv, defaulting to personal. */
function accountFromArgv(): GoogleAccount {
	const i = process.argv.indexOf("--account");
	if (i === -1) return parseGoogleAccount(undefined);
	return parseGoogleAccount(process.argv[i + 1]);
}

function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

async function main(): Promise<void> {
	const account = accountFromArgv();
	const oauth2 = getOAuth2Client();
	const redirect = new URL(env.googleOAuthRedirect);
	const port = Number(redirect.port || "53682");

	const authUrl = oauth2.generateAuthUrl({
		access_type: "offline",
		// 'consent' forces Google to return a refresh_token even if you've
		// authorized this client before.
		prompt: "consent",
		scope: [...GOOGLE_MINT_SCOPES],
	});

	const code: string = await new Promise((resolve, reject) => {
		const srv = createServer((req, res) => {
			if (!req.url) return;
			const reqUrl = new URL(req.url, `http://localhost:${port}`);
			if (reqUrl.pathname !== redirect.pathname) {
				res.writeHead(404).end();
				return;
			}
			const err = reqUrl.searchParams.get("error");
			const got = reqUrl.searchParams.get("code");
			res.writeHead(200, { "Content-Type": "text/plain" });
			if (err || !got) {
				res.end(`Authorization failed: ${err ?? "no code"}. You can close this tab.`);
				srv.close();
				reject(new Error(err ?? "no code returned"));
				return;
			}
			res.end("Authorized! You can close this tab and return to the terminal.");
			srv.close();
			resolve(got);
		});
		srv.listen(port, () => {
			log(`\nMinting a refresh token for the '${account}' Google account.`);
			log(
				`Sign in as the ${account === "work" ? "work.example.com" : "personal"} user on the consent screen. Approving as the wrong account mints a working token for the wrong mailbox, which fails later as a confusing 404 rather than an auth error.`,
			);
			log(`Scopes requested (all in one consent, see src/google/scopes.ts):`);
			for (const s of GOOGLE_MINT_SCOPES) log(`  - ${s}`);
			log("\n1. Open this URL in your browser and approve access:\n");
			log(authUrl);
			log(`\n2. Waiting for Google to redirect to ${env.googleOAuthRedirect} …\n`);
		});
		srv.on("error", reject);
	});

	const { tokens } = await oauth2.getToken(code);
	if (!tokens.refresh_token) {
		throw new Error(
			"No refresh_token returned. Revoke the app's access at https://myaccount.google.com/permissions and re-run (prompt=consent forces one).",
		);
	}

	log("\n✓ Success. Add this to packages/mcp-server/.env:\n");
	log(`${ENV_VAR[account]}=${tokens.refresh_token}\n`);
	log(
		`Then set the same var on the deployed server. Known accounts: ${GOOGLE_ACCOUNTS.join(", ")}.\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
