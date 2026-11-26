import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOOGLE_MINT_SCOPES } from "../google/scopes.js";

// scripts/check-google-scopes.mjs verifies what a stored refresh token can actually
// do, and it is the ONLY check that distinguishes a stale token from a live one: a
// token minted before a scope joined GOOGLE_MINT_SCOPES is accepted by Google and
// then rejected per-API with a 403 (ADR-045's scope-bundling trap).
//
// The script is plain .mjs on purpose (#508: it must run against Railway with only
// the three GOOGLE_* vars, no tsx and no src/env.ts), so it cannot import the
// TypeScript constant and re-declares the list as literals. That duplication went
// stale once already: the two Gmail scopes landed in #821 and the script's NEEDED
// was not updated, so on 2026-09-05 it would have reported PASS for a personal
// token whose every Gmail call 403'd with ACCESS_TOKEN_SCOPE_INSUFFICIENT, the
// exact failure the script exists to catch, invisible to the script.
//
// This test is the pin. Adding a scope to GOOGLE_MINT_SCOPES now fails here until
// the script is updated too.
const SCRIPT_PATH = fileURLToPath(
	new URL("../../scripts/check-google-scopes.mjs", import.meta.url),
);

/** The `NEEDED` array literal, read out of the script's source. */
function neededFromScript(): string[] {
	const source = readFileSync(SCRIPT_PATH, "utf8");
	const block = /const NEEDED = \[([\s\S]*?)\];/.exec(source);
	if (!block) throw new Error("could not find the NEEDED array in check-google-scopes.mjs");
	return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the scope checker's NEEDED list", () => {
	it("matches GOOGLE_MINT_SCOPES exactly, in the same order", () => {
		expect(neededFromScript()).toEqual([...GOOGLE_MINT_SCOPES]);
	});

	it("covers both Gmail scopes, the pair whose absence #821 left unchecked", () => {
		const needed = neededFromScript();
		expect(needed).toContain("https://www.googleapis.com/auth/gmail.readonly");
		expect(needed).toContain("https://www.googleapis.com/auth/gmail.modify");
	});

	it("knows a token env var for every account google-oauth.ts can mint", () => {
		// Mirrors ENV_VAR in scripts/google-oauth.ts; a third account added there
		// without a branch here would make that account unverifiable. Both names carry
		// an account suffix on purpose: while `personal` was the unsuffixed
		// GOOGLE_REFRESH_TOKEN it read as the default rather than as one of two, which
		// is how a personal token ended up in the work slot (#1002).
		const source = readFileSync(SCRIPT_PATH, "utf8");
		expect(source).toContain("personal: \"GOOGLE_REFRESH_TOKEN_PERSONAL\"");
		expect(source).toContain("work: \"GOOGLE_REFRESH_TOKEN_WORK\"");
	});
});

// The identity half, added 2026-09-05 after a personal-account token was pasted
// into GOOGLE_REFRESH_TOKEN_WORK: correctly scoped, valid, 200 on every call,
// and serving the wrong mailbox. A scope check cannot see that, so the script
// also reads the account's own address. These pins keep the two account maps in
// step; an account with a token var but no expected-address var would be
// scope-checked and identity-unchecked, the exact gap that let the swap through.
describe("the scope checker's identity half", () => {
	const source = readFileSync(SCRIPT_PATH, "utf8");

	it("has an expected-address env var for every account it has a token var for", () => {
		const names = (block: string) =>
			[...block.matchAll(/(\w+): "/g)].map((m) => m[1]);
		const tokens = /const ACCOUNT_ENV = \{([\s\S]*?)\};/.exec(source);
		const emails = /const ACCOUNT_EMAIL_ENV = \{([\s\S]*?)\};/.exec(source);
		if (!tokens || !emails) throw new Error("could not find both account maps");
		expect(names(emails[1])).toEqual(names(tokens[1]));
	});

	it("reads the mailbox with users.getProfile, which gmail.readonly already covers", () => {
		// Not the oauth2 userinfo endpoint: that needs an openid/email scope, which
		// GOOGLE_MINT_SCOPES deliberately does not request, so it would 403 here.
		expect(source).toContain("gmail/v1/users/me/profile");
		expect(source).not.toContain("oauth2/v3/userinfo");
	});
});
