/**
 * One-time helper to mint a personal Microsoft OAuth refresh token for the
 * OneDrive tools (`onedrive_*`, issue #2043).
 *
 * Uses the OAuth 2.0 Authorization Code flow with PKCE (`S256`) and `state`
 * against the Microsoft Identity Platform `consumers` authority:
 *   - Authorize: https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize
 *   - Token:     https://login.microsoftonline.com/consumers/oauth2/v2.0/token
 *
 * Run from the repo root:
 *   npm --workspace @ahkms/mcp-server run microsoft-auth
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { resolve as resolvePath } from "node:path";
import { URL, URLSearchParams } from "node:url";
import { env } from "../src/env.js";

const MICROSOFT_AUTHORIZE_URL =
	"https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL =
	"https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MICROSOFT_ONEDRIVE_SCOPES = [
	"Files.ReadWrite",
	"offline_access",
	"User.Read",
] as const;

function loadOptionalEnvFiles(): void {
	const loadEnvFile = (
		process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }
	).loadEnvFile;
	if (typeof loadEnvFile !== "function") return;
	for (const candidate of [
		resolvePath(process.cwd(), "../../.env"),
		resolvePath(process.cwd(), ".env"),
		resolvePath(process.cwd(), "packages/mcp-server/.env"),
	]) {
		try {
			loadEnvFile(candidate);
		} catch {
			// Ignore missing .env files
		}
	}
}

function base64Url(buf: Buffer): string {
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

async function main(): Promise<void> {
	loadOptionalEnvFiles();

	const clientId = env.microsoftClientId;
	if (!clientId) {
		throw new Error(
			"Missing required env var MICROSOFT_CLIENT_ID. Set it in packages/mcp-server/.env before running microsoft-auth.",
		);
	}
	const clientSecret = env.microsoftClientSecret;
	const redirectUri = env.microsoftOAuthRedirect;
	const redirect = new URL(redirectUri);
	const port = Number(redirect.port || "53683");

	const codeVerifier = base64Url(randomBytes(32));
	const codeChallenge = base64Url(
		createHash("sha256").update(codeVerifier).digest(),
	);
	const state = base64Url(randomBytes(16));

	const authUrl = new URL(MICROSOFT_AUTHORIZE_URL);
	authUrl.searchParams.set("client_id", clientId);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("response_mode", "query");
	authUrl.searchParams.set("scope", MICROSOFT_ONEDRIVE_SCOPES.join(" "));
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", codeChallenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	authUrl.searchParams.set("prompt", "consent");

	const code: string = await new Promise((resolve, reject) => {
		const srv = createServer((req, res) => {
			if (!req.url) return;
			const reqUrl = new URL(req.url, `http://localhost:${port}`);
			if (reqUrl.pathname !== redirect.pathname) {
				res.writeHead(404).end();
				return;
			}
			const err = reqUrl.searchParams.get("error");
			const errDesc = reqUrl.searchParams.get("error_description");
			const gotCode = reqUrl.searchParams.get("code");
			const gotState = reqUrl.searchParams.get("state");

			res.writeHead(200, { "Content-Type": "text/plain" });
			if (err || !gotCode) {
				const reason = [err, errDesc].filter(Boolean).join(": ") || "no code";
				res.end(`Authorization failed: ${reason}. You can close this tab.`);
				srv.close();
				reject(new Error(reason));
				return;
			}
			if (gotState !== state) {
				res.end("Authorization failed: OAuth state mismatch. You can close this tab.");
				srv.close();
				reject(new Error("OAuth state mismatch"));
				return;
			}

			res.end("Authorized! You can close this tab and return to the terminal.");
			srv.close();
			resolve(gotCode);
		});

		srv.listen(port, () => {
			log("\nMinting a refresh token for the personal Microsoft OneDrive account.");
			log("Scopes requested:");
			for (const s of MICROSOFT_ONEDRIVE_SCOPES) log(`  - ${s}`);
			log("\n1. Open this URL in your browser and approve access:\n");
			log(authUrl.toString());
			log(`\n2. Waiting for Microsoft to redirect to ${redirectUri} ...\n`);
		});
		srv.on("error", reject);
	});

	const tokenParams = new URLSearchParams({
		client_id: clientId,
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
		scope: MICROSOFT_ONEDRIVE_SCOPES.join(" "),
	});
	if (clientSecret) {
		tokenParams.set("client_secret", clientSecret);
	}

	const tokenRes = await fetch(MICROSOFT_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: tokenParams.toString(),
	});
	const tokens = (await tokenRes.json().catch(() => ({}))) as {
		refresh_token?: string;
		error?: string;
		error_description?: string;
	};

	if (!tokenRes.ok || !tokens.refresh_token) {
		const detail = [tokens.error, tokens.error_description]
			.filter(Boolean)
			.join(": ");
		throw new Error(
			`Token exchange failed (${tokenRes.status}): ${detail || "no refresh_token returned"}`,
		);
	}

	log("\nSuccess. Add this to packages/mcp-server/.env:\n");
	log(`MICROSOFT_REFRESH_TOKEN_PERSONAL=${tokens.refresh_token}\n`);
}

main().catch((err) => {
	process.stderr.write(
		`FAIL: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
