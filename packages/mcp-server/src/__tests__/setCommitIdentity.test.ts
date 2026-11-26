/**
 * Unit tests for the commit-identity bootstrap (#520, follow-up to #498/#507).
 *
 * The script is plain CommonJS at the repo root (matches its siblings, e.g.
 * scripts/check-commit-authorship.js), so it is loaded via createRequire.
 *
 * What these pin, and why each one is load-bearing:
 *   1. It replaces an UNSET identity. That is the cloud-sandbox case the whole
 *      issue is about; a bootstrap that declines it fixes nothing.
 *   2. It replaces the ASSISTANT'S identity. A sandbox that already committed
 *      once has the fallback applied, not an empty value.
 *   3. It NEVER replaces a real contributor's identity. This is the risk #520
 *      names explicitly ("guard against clobbering"), and it is the reason the
 *      predicate is exported and tested directly rather than only through the
 *      script's side effect.
 *   4. Its detection agrees EXACTLY with the guard that rejects bad commits.
 *      A state this script declines to fix and check-commit-authorship.js then
 *      rejects is the worst of both worlds: the pattern is duplicated across
 *      two CommonJS scripts with no build step, so the equivalence is pinned
 *      here rather than left to drift.
 *   5. The script exports at all. The first draft put module.exports after
 *      process.exit(0), so nothing was importable and this file could not have
 *      been written.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const identity = require("../../../../scripts/set-commit-identity.js");
const authorship = require("../../../../scripts/check-commit-authorship.js");

const { shouldReplace, OFFENDING, NAME, EMAIL } = identity;

describe("set-commit-identity - what it replaces", () => {
	it("replaces an unset identity (the cloud-sandbox case)", () => {
		expect(shouldReplace(null)).toBe(true);
		expect(shouldReplace(undefined)).toBe(true);
		expect(shouldReplace("")).toBe(true);
		expect(shouldReplace("   ")).toBe(true);
	});

	it("replaces the assistant's own identity", () => {
		expect(shouldReplace("noreply@assistant.example.com")).toBe(true);
		expect(shouldReplace("someone@assistant.example.com")).toBe(true);
		// git config values can arrive with trailing whitespace.
		expect(shouldReplace(" noreply@assistant.example.com \n")).toBe(true);
	});
});

describe("set-commit-identity - what it must never touch", () => {
	it("leaves a real contributor's identity alone", () => {
		expect(shouldReplace("someone@example.com")).toBe(false);
		expect(shouldReplace("110114721+anguspersonal@users.noreply.github.com")).toBe(false);
		expect(shouldReplace("Angus Hally")).toBe(false);
	});

	/**
	 * The suffix anchor matters. Without `$` an address merely CONTAINING the
	 * domain would match, and a real contributor at, say, a forwarding address
	 * would have their config silently rewritten — the exact clobbering #520
	 * asks to be guarded against.
	 */
	it("does not treat an address that merely mentions the domain as the assistant's", () => {
		expect(shouldReplace("anthropic.com.user@example.com")).toBe(false);
		expect(shouldReplace("me+anthropic.com@example.org")).toBe(false);
	});

	it("does not replace the identity it would write, so a second install is a no-op", () => {
		expect(shouldReplace(EMAIL)).toBe(false);
		expect(shouldReplace(NAME)).toBe(false);
	});
});

describe("set-commit-identity - agreement with the authorship guard", () => {
	/**
	 * The two scripts each carry their own copy of the pattern (plain CommonJS,
	 * no build step, same as every other guard here). If they ever disagree,
	 * this fails rather than a contributor discovering it as a hard-failing PR.
	 */
	it("uses the same offending-identity pattern the guard rejects on", () => {
		expect(authorship.OFFENDING).toBeInstanceOf(RegExp);
		expect(OFFENDING.source).toBe(authorship.OFFENDING.source);
		expect(OFFENDING.flags).toBe(authorship.OFFENDING.flags);
	});

	it("would fix every identity the guard would reject", () => {
		for (const email of ["noreply@assistant.example.com", "assistant@assistant.example.com"]) {
			expect(authorship.OFFENDING.test(email)).toBe(true);
			expect(shouldReplace(email)).toBe(true);
		}
	});

	it("writes an identity the guard accepts", () => {
		expect(authorship.OFFENDING.test(EMAIL)).toBe(false);
	});
});
