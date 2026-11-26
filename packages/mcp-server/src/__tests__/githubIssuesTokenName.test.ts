import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = [
	"GITHUB_PERSONAL_ACCESS_TOKEN",
	"GITHUB_TOKEN_ISSUES",
	"GITHUB_ISSUES_TOKEN",
	"GITHUB_TOKEN",
	"GITHUB_TOKEN_INGEST",
] as const;

describe("github_issues credential name precedence (#1926)", () => {
	const saved: Record<string, string | undefined> = Object.fromEntries(
		KEYS.map((k) => [k, process.env[k]]),
	);

	function clearAll() {
		for (const k of KEYS) delete process.env[k];
	}

	async function freshGetCredential() {
		vi.resetModules();
		const mod = await import("../credentials.js");
		return mod.getCredential;
	}

	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("resolves GITHUB_PERSONAL_ACCESS_TOKEN when only it is set", async () => {
		clearAll();
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_pat_canonical";

		const getCredential = await freshGetCredential();
		await expect(getCredential("github_issues")).resolves.toBe("ghp_pat_canonical");
	});

	it("prefers GITHUB_PERSONAL_ACCESS_TOKEN over GITHUB_TOKEN_ISSUES when both are set", async () => {
		clearAll();
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_pat_canonical";
		process.env.GITHUB_TOKEN_ISSUES = "ghp_legacy_issues";

		const getCredential = await freshGetCredential();
		await expect(getCredential("github_issues")).resolves.toBe("ghp_pat_canonical");
	});

	it("still resolves legacy GITHUB_TOKEN_ISSUES and GITHUB_ISSUES_TOKEN when set alone", async () => {
		clearAll();
		process.env.GITHUB_TOKEN_ISSUES = "ghp_legacy_1";

		let getCredential = await freshGetCredential();
		await expect(getCredential("github_issues")).resolves.toBe("ghp_legacy_1");

		clearAll();
		process.env.GITHUB_ISSUES_TOKEN = "ghp_legacy_2";

		getCredential = await freshGetCredential();
		await expect(getCredential("github_issues")).resolves.toBe("ghp_legacy_2");
	});

	it("rejects naming GITHUB_PERSONAL_ACCESS_TOKEN when unset, without leaking decoy values", async () => {
		clearAll();
		process.env.GITHUB_TOKEN = "ghp_decoy_general";
		process.env.GITHUB_TOKEN_INGEST = "ghp_decoy_ingest";

		const getCredential = await freshGetCredential();
		const err = (await getCredential("github_issues").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/GITHUB_PERSONAL_ACCESS_TOKEN.*is not set/);
		expect(err.message).not.toContain("ghp_decoy_general");
		expect(err.message).not.toContain("ghp_decoy_ingest");
	});
});
