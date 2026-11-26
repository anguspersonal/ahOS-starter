// Verify two independent things about a configured Google refresh token: WHAT
// it can do (its scopes) and WHOSE mailbox it opens (its identity).
//
// Scopes come from exchanging the token at Google's token endpoint and reading
// the `scope` field of the response. Identity comes from one Gmail
// users.getProfile call with the access token that exchange returns, which
// needs only gmail.readonly, a scope this script already requires.
//
// Prints the scope list, the account's own email address and a pass/fail
// verdict. Never a token or secret, so the output is safe to paste into this
// private repo as verification evidence (#478); redact the address before
// pasting it anywhere public.
//
// Scopes are a property of the (client_id, refresh_token) pair, so a PASS
// here proves what the server can do wherever that same pair is deployed.
// Failure modes this distinguishes that Drive-tool smoke tests cannot:
//   - a stale Drive-only token (Drive works, Calendar 403s) → FAIL, missing
//     calendar.events
//   - a token minted against a different client id → FAIL, invalid_grant
//   - a VALID token for the WRONG account → FAIL, mailbox mismatch. This one
//     has no auth-error signature at all: on 2026-09-05 a freshly minted
//     personal token was pasted into GOOGLE_REFRESH_TOKEN_WORK, and every
//     `account: 'work'` Gmail call then returned the personal mailbox with
//     correct scopes and a 200. The failure surfaced as plausible-looking mail
//     from the wrong account, which no error handler catches. Scope checks
//     prove capability; only an identity check proves identity.
//
// Run against the local .env:
//   npm --workspace @ahkms/mcp-server run google-check
//   npm --workspace @ahkms/mcp-server run google-check -- --account work
// Run against Railway's live variables (no .env needed — see the
// --env-file-if-exists flag, which tolerates the file's absence):
//   railway run npm --workspace @ahkms/mcp-server run google-check
//
// Plain .mjs on purpose: no tsx, no src/env.ts import — so it needs only the
// three GOOGLE_* vars, not the full required() set (see #508).

import { URLSearchParams } from "node:url";

// MUST equal GOOGLE_MINT_SCOPES in src/google/scopes.ts. Duplicated as literals
// because this file is deliberately plain .mjs (no tsx, so it cannot import the
// TypeScript constant) and is run against Railway where src/ is not compiled.
// The duplication is pinned by src/__tests__/googleScopeCheck.test.ts, added
// after the two Gmail scopes were introduced in #821 and this list was not
// updated: the checker then printed PASS for a token that 403s on every Gmail
// call, which is the one failure it exists to catch.
const NEEDED = [
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/script.projects",
	"https://www.googleapis.com/auth/script.deployments",
	"https://www.googleapis.com/auth/script.processes",
	"https://www.googleapis.com/auth/documents",
	"https://www.googleapis.com/auth/bigquery.readonly",
];

// One refresh token per Google account (issue #338), each in its own env var.
// The names mirror scripts/google-oauth.ts, which mints them.
const ACCOUNT_ENV = {
	personal: "GOOGLE_REFRESH_TOKEN_PERSONAL",
	work: "GOOGLE_REFRESH_TOKEN_WORK",
};

// Optional per-account expected mailbox. Set these and a wrong-account token
// FAILs instead of quietly serving the wrong mail; leave them unset and the
// script still PRINTS the address it found, which is enough to spot the swap by
// eye. Deliberately not in required(): an address is not a credential, and a
// missing one must not stop the scope half of the check from running.
const ACCOUNT_EMAIL_ENV = {
	personal: "GOOGLE_ACCOUNT_EMAIL_PERSONAL",
	work: "GOOGLE_ACCOUNT_EMAIL_WORK",
};

const accountFlag = process.argv.indexOf("--account");
const account = accountFlag >= 0 ? process.argv[accountFlag + 1] : "personal";
if (!Object.hasOwn(ACCOUNT_ENV, account)) {
	console.error(
		`Unknown --account '${account}'. Known: ${Object.keys(ACCOUNT_ENV).join(", ")}.`,
	);
	process.exit(2);
}
const tokenVar = ACCOUNT_ENV[account];

const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", tokenVar].filter(
	(k) => !process.env[k],
);
if (missing.length > 0) {
	console.error(`Missing env var(s): ${missing.join(", ")}`);
	process.exit(2);
}

const res = await fetch("https://oauth2.googleapis.com/token", {
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		client_id: process.env.GOOGLE_CLIENT_ID,
		client_secret: process.env.GOOGLE_CLIENT_SECRET,
		refresh_token: process.env[tokenVar],
		grant_type: "refresh_token",
	}),
});

const body = await res.json();

if (!res.ok) {
	// Google's error bodies carry error/error_description only — no secrets.
	console.error(
		`FAIL (${res.status}): ${body.error} — ${body.error_description ?? ""}`,
	);
	if (body.error === "invalid_grant") {
		console.error(
			"\nThe refresh token is not valid for this client id/secret pair, was revoked, or expired.\n" +
				"Note: apps left in 'Testing' publishing status (Google Auth Platform → Audience) expire refresh tokens after 7 days.",
		);
	}
	process.exit(1);
}

const granted = (body.scope ?? "").split(" ").filter(Boolean);
console.log(`Granted scopes for the '${account}' account (${tokenVar}):`);
for (const s of granted) console.log(`  - ${s}`);

const absent = NEEDED.filter((n) => !granted.includes(n));
if (absent.length > 0) {
	console.log(`\nFAIL — missing: ${absent.join(", ")}`);
	console.log(
		`Re-mint with \`npm --workspace @ahkms/mcp-server run google-auth -- --account ${account}\` ` +
			`(one consent requests every scope) and update this env source, then redeploy.`,
	);
	console.log(
		"A token that carries Drive but not the Gmail scopes is the stale-token signature: " +
			"Drive and Calendar calls succeed while every Gmail call 403s with ACCESS_TOKEN_SCOPE_INSUFFICIENT.",
	);
	process.exit(1);
}
console.log(
	`\nPASS (scopes): the '${account}' token carries all ${NEEDED.length} required scopes.`,
);

// Identity half. Same access token, one Gmail profile read.
const expected = process.env[ACCOUNT_EMAIL_ENV[account]];
const profileRes = await fetch(
	"https://gmail.googleapis.com/gmail/v1/users/me/profile",
	{ headers: { Authorization: `Bearer ${body.access_token}` } },
);

if (!profileRes.ok) {
	const err = await profileRes.text();
	const line = `could not read the mailbox identity (${profileRes.status}): ${err.slice(0, 200)}`;
	if (expected) {
		console.error(`\nFAIL (identity): ${line}`);
		console.error(
			`${ACCOUNT_EMAIL_ENV[account]} is set, so an unverifiable identity is a failure, not a warning.`,
		);
		process.exit(1);
	}
	console.log(`\nWARN (identity): ${line}`);
	console.log(
		"Scopes passed, so this is not an auth problem; an account with no Gmail mailbox reports this.",
	);
	process.exit(0);
}

const { emailAddress } = await profileRes.json();
console.log(`\nMailbox for the '${account}' account: ${emailAddress}`);

if (!expected) {
	console.log(
		`Set ${ACCOUNT_EMAIL_ENV[account]} to have this checked rather than eyeballed.`,
	);
	process.exit(0);
}

if (emailAddress.toLowerCase() !== expected.toLowerCase()) {
	console.error(
		`\nFAIL (identity): expected ${expected}, got ${emailAddress}.`,
	);
	console.error(
		`The token in ${tokenVar} is valid and correctly scoped, but it opens the wrong account. ` +
			"Either it was minted while signed in as the wrong Google user, or a token minted for another " +
			`account was pasted into ${tokenVar}. Re-mint with ` +
			`\`npm --workspace @ahkms/mcp-server run google-auth -- --account ${account}\`, signing in as ` +
			`${expected}, then redeploy.`,
	);
	process.exit(1);
}

console.log(`PASS (identity): the '${account}' token opens ${expected}.`);
