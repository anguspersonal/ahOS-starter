import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// credentials.ts resolves through env.ts, which reads process.env at import time, so a
// case that changes a token needs a fresh module graph (vi.resetModules) after mutating
// process.env. The base vars mirror vitest.config.ts's stubs — required() would throw.
const baseEnv = {
	SUPABASE_URL: "http://localhost:54321",
	SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
	KMS_USER_ID: "00000000-0000-0000-0000-000000000000",
};

const NOTION_VARS = [
	"NOTION_WORK_ACCESS_TOKEN",
	"NOTION_API_KEY",
	"NOTION_PERSONAL_ACCESS_TOKEN",
] as const;

const GOOGLE_VARS = [
	"GOOGLE_REFRESH_TOKEN_PERSONAL",
	"GOOGLE_REFRESH_TOKEN",
	"GOOGLE_REFRESH_TOKEN_WORK",
] as const;

// Connection-scoped vars (ADR-060). Named here only so the harness restores them; the
// resolver never enumerates connections, which is the whole point.
const POSTHOG_VARS = [
	"POSTHOG_API_KEY_WORK",
	"POSTHOG_API_KEY_PERSONAL",
	"POSTHOG_API_KEY_BROTHER_ACTING",
] as const;

const META_ADS_VARS = ["META_ADS_ACCESS_TOKEN"] as const;

const SLACK_VARS = ["SLACK_TOKEN_USER_OAUTH", "SLACK_TOKEN_BOT_OAUTH", "SLACK_BOT_TOKEN"] as const;
const GEMINI_VARS = ["GEMINI_API_KEY"] as const;
const LINKEDIN_VARS = ["LINKEDIN_ACCESS_TOKEN"] as const;
const GITHUB_VARS = [
	"GITHUB_WORK_ACCESS_TOKEN",
	"GITHUB_PERSONAL_ACCESS_TOKEN",
	"GITHUB_TOKEN_PULLS",
	"GITHUB_TOKEN_ISSUES",
	"GITHUB_TOKEN_INGEST",
	"GITHUB_TOKEN",
] as const;
const MANAGED_VARS = [...NOTION_VARS, ...GOOGLE_VARS, ...POSTHOG_VARS, ...META_ADS_VARS, ...SLACK_VARS, ...GEMINI_VARS, ...LINKEDIN_VARS, ...GITHUB_VARS] as const;

const originalEnv: Record<string, string | undefined> = {};

/** Import credentials.ts against the current process.env. */
async function freshGetCredential() {
	vi.resetModules();
	const mod = await import("../credentials.js");
	return mod.getCredential;
}

/** The whole module, for the connection helpers that are not `getCredential`. */
async function freshCredentials() {
	vi.resetModules();
	return import("../credentials.js");
}

beforeEach(() => {
	for (const key of MANAGED_VARS) originalEnv[key] = process.env[key];
	for (const [key, value] of Object.entries(baseEnv)) process.env[key] = value;
});

afterEach(() => {
	for (const key of MANAGED_VARS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	for (const key of Object.keys(baseEnv)) delete process.env[key];
	vi.resetModules();
});

describe("getCredential — Notion workspace token routing (#424 defect 1)", () => {
	it("resolves the WORK token for notion_work", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "work_token";
		process.env.NOTION_PERSONAL_ACCESS_TOKEN = "personal_token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("notion_work")).resolves.toBe("work_token");
	});

	it("resolves the PERSONAL token for notion_personal", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "work_token";
		process.env.NOTION_PERSONAL_ACCESS_TOKEN = "personal_token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("notion_personal")).resolves.toBe("personal_token");
	});

	it("falls back to the legacy NOTION_API_KEY for notion_work only", async () => {
		delete process.env.NOTION_WORK_ACCESS_TOKEN;
		process.env.NOTION_API_KEY = "legacy_token";
		process.env.NOTION_PERSONAL_ACCESS_TOKEN = "personal_token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("notion_work")).resolves.toBe("legacy_token");
		// The legacy work name must never satisfy the personal provider.
		await expect(getCredential("notion_personal")).resolves.toBe("personal_token");
	});

	it("throws naming NOTION_PERSONAL_ACCESS_TOKEN — never falls back to the work token", async () => {
		// The exact defect-1 shape: the work token IS available, so a silent fallback
		// would "succeed" here and then 404 against Notion (the Work integration
		// cannot see personal pages). It must fail loudly at the credential boundary.
		process.env.NOTION_WORK_ACCESS_TOKEN = "work_token";
		delete process.env.NOTION_PERSONAL_ACCESS_TOKEN;

		const getCredential = await freshGetCredential();

		const err = (await getCredential("notion_personal").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/NOTION_PERSONAL_ACCESS_TOKEN is not set/);
		// Setup errors reach whatever agent surface made the call, so they name the var
		// and never echo a resolved secret value.
		expect(err.message).not.toContain("work_token");
	});

	it("throws naming both accepted var names when the work token is unset", async () => {
		delete process.env.NOTION_WORK_ACCESS_TOKEN;
		delete process.env.NOTION_API_KEY;

		const getCredential = await freshGetCredential();

		await expect(getCredential("notion_work")).rejects.toThrow(
			/NOTION_WORK_ACCESS_TOKEN \(or legacy NOTION_API_KEY\) is not set/,
		);
	});

	it("points at .env.example so the error is actionable", async () => {
		delete process.env.NOTION_PERSONAL_ACCESS_TOKEN;

		const getCredential = await freshGetCredential();

		await expect(getCredential("notion_personal")).rejects.toThrow(
			/packages\/mcp-server\/\.env\.example/,
		);
	});
});

describe("getCredential — Google account token routing (#338)", () => {
	it("resolves the personal refresh token for google_personal", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "personal_refresh";
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "work_refresh";

		const getCredential = await freshGetCredential();

		await expect(getCredential("google_personal")).resolves.toBe("personal_refresh");
	});

	it("resolves the Work refresh token for google_work", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "personal_refresh";
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "work_refresh";

		const getCredential = await freshGetCredential();

		await expect(getCredential("google_work")).resolves.toBe("work_refresh");
	});

	it("throws naming GOOGLE_REFRESH_TOKEN_WORK — never falls back to the personal token", async () => {
		// The Google-shaped version of #424 defect 1, and a worse failure than the Notion
		// one: a silent fallback here would read the WRONG PERSON'S MAILBOX and succeed,
		// rather than 404. The account boundary has to fail loudly and locally.
		process.env.GOOGLE_REFRESH_TOKEN = "personal_refresh";
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;

		const getCredential = await freshGetCredential();

		const err = (await getCredential("google_work").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/GOOGLE_REFRESH_TOKEN_WORK is not set/);
		expect(err.message).not.toContain("personal_refresh");
	});

	it("names the per-account mint command so the error is actionable", async () => {
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;

		const getCredential = await freshGetCredential();

		await expect(getCredential("google_work")).rejects.toThrow(
			/google-auth -- --account work/,
		);
	});

	// The personal token's var was renamed from GOOGLE_REFRESH_TOKEN to
	// GOOGLE_REFRESH_TOKEN_PERSONAL on 2026-09-05, so that neither account is the
	// unsuffixed default. The asymmetry was not cosmetic: it is why a personal token
	// pasted into the work slot read as an ordinary setup rather than a mistake
	// (#1002). Both names resolve, because a rename that breaks every .env minted
	// before it is a second outage, not a fix.
	it("prefers GOOGLE_REFRESH_TOKEN_PERSONAL over the old unsuffixed name", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "new_name_refresh";
		process.env.GOOGLE_REFRESH_TOKEN = "old_name_refresh";

		const getCredential = await freshGetCredential();

		await expect(getCredential("google_personal")).resolves.toBe("new_name_refresh");
	});

	it("still resolves the old GOOGLE_REFRESH_TOKEN when only it is set", async () => {
		delete process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
		process.env.GOOGLE_REFRESH_TOKEN = "old_name_refresh";

		const getCredential = await freshGetCredential();

		await expect(getCredential("google_personal")).resolves.toBe("old_name_refresh");
	});

	it("names BOTH personal var names when neither is set", async () => {
		// The failure this guards is "it is set under the other name", so the error has
		// to name every name that would have worked, new one first.
		delete process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
		delete process.env.GOOGLE_REFRESH_TOKEN;

		const getCredential = await freshGetCredential();

		const err = (await getCredential("google_personal").catch((e: unknown) => e)) as Error;

		expect(err.message).toContain("GOOGLE_REFRESH_TOKEN_PERSONAL");
		expect(err.message).toContain("GOOGLE_REFRESH_TOKEN");
	});
});

// The Slack app hands out two tokens; the bot one is provisioned as
// SLACK_TOKEN_BOT_OAUTH beside SLACK_TOKEN_USER_OAUTH. SLACK_BOT_TOKEN, the name this
// seam first read, still resolves so an older .env keeps posting.
describe("getCredential — slack_bot token names", () => {
	it("resolves SLACK_TOKEN_BOT_OAUTH, preferring it over the legacy name", async () => {
		process.env.SLACK_TOKEN_BOT_OAUTH = "test-slack-b-token";
		process.env.SLACK_BOT_TOKEN = "test-slack-b-token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("slack_bot")).resolves.toBe("test-slack-b-token");
	});

	it("still resolves the legacy SLACK_BOT_TOKEN when only it is set", async () => {
		delete process.env.SLACK_TOKEN_BOT_OAUTH;
		process.env.SLACK_BOT_TOKEN = "test-slack-b-token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("slack_bot")).resolves.toBe("test-slack-b-token");
	});

	it("names both accepted names, new one first, when neither is set", async () => {
		delete process.env.SLACK_TOKEN_BOT_OAUTH;
		delete process.env.SLACK_BOT_TOKEN;

		const getCredential = await freshGetCredential();
		const err = (await getCredential("slack_bot").catch((e: unknown) => e)) as Error;

		expect(err.message).toMatch(/^SLACK_TOKEN_BOT_OAUTH \(or legacy SLACK_BOT_TOKEN\) is not set/);
		expect(err.message).toContain("chat.update");
	});

	it("names SLACK_TOKEN_USER_OAUTH, chat:write, and reactions:write for slack without falling back to slack_bot (#1526)", async () => {
		delete process.env.SLACK_TOKEN_USER_OAUTH;
		process.env.SLACK_TOKEN_BOT_OAUTH = "test-slack-b-token";

		const getCredential = await freshGetCredential();
		const err = (await getCredential("slack").catch((e: unknown) => e)) as Error;

		expect(err.message).toMatch(/^SLACK_TOKEN_USER_OAUTH is not set/);
		expect(err.message).toContain("chat:write");
		expect(err.message).toContain("reactions:write");
		expect(err.message).not.toContain("test-slack-b-token");
	});
});

describe("getCredential — connection refs (ADR-060)", () => {
	it("resolves a connection ref to its conventional env var", async () => {
		process.env.POSTHOG_API_KEY_WORK = "phx_work";

		const getCredential = await freshGetCredential();

		await expect(getCredential("posthog:work")).resolves.toBe("phx_work");
	});

	it("keeps two connections of the same family fully separate", async () => {
		// The failure this guards is the one #424 defect 1 already caused once for
		// Notion: selecting one connection's config while authenticating with another's
		// key. Against PostHog that would not error — it would return real, correct
		// numbers about the wrong project.
		process.env.POSTHOG_API_KEY_WORK = "phx_work";
		process.env.POSTHOG_API_KEY_PERSONAL = "phx_personal";

		const getCredential = await freshGetCredential();

		await expect(getCredential("posthog:work")).resolves.toBe("phx_work");
		await expect(getCredential("posthog:personal")).resolves.toBe("phx_personal");
	});

	it("never falls back to a sibling connection's key", async () => {
		process.env.POSTHOG_API_KEY_WORK = "phx_work";
		delete process.env.POSTHOG_API_KEY_PERSONAL;

		const getCredential = await freshGetCredential();

		await expect(getCredential("posthog:personal")).rejects.toThrow(
			/POSTHOG_API_KEY_PERSONAL is not set/,
		);
	});

	it("adding a connection needs no code change, only an env var", async () => {
		// The load-bearing test for ADR-060. `brother-acting` appears in no map, no
		// union and no config in this repo, and still resolves. If this ever needs a
		// source edit to pass, the design has regressed to the GoogleAccount enum.
		process.env.POSTHOG_API_KEY_BROTHER_ACTING = "phx_acting";

		const getCredential = await freshGetCredential();

		await expect(getCredential("posthog:brother-acting")).resolves.toBe("phx_acting");
	});

	it("maps a slug to its env var by a stated convention", async () => {
		const { connectionEnvVar } = await freshCredentials();

		expect(connectionEnvVar("posthog:work")).toBe("POSTHOG_API_KEY_WORK");
		// Hyphens and dots are legal in a slug and illegal in an env var name.
		expect(connectionEnvVar("posthog:brother-acting")).toBe("POSTHOG_API_KEY_BROTHER_ACTING");
	});

	it("rejects an unknown family instead of inventing a variable name", async () => {
		// Without this, `mixpanel:work` yields a plausible MIXPANEL_API_KEY_WORK
		// that is simply never set, so a typo reports as a missing credential and sends
		// you to the wrong place entirely.
		const getCredential = await freshGetCredential();

		await expect(getCredential("mixpanel:work")).rejects.toThrow(
			/Unknown connection family 'mixpanel'/,
		);
		await expect(getCredential("mixpanel:work")).rejects.toThrow(/Known families: posthog/);
	});

	it("rejects an empty slug", async () => {
		const getCredential = await freshGetCredential();

		await expect(getCredential("posthog:")).rejects.toThrow(/empty connection slug/);
	});

	it("still resolves the fixed providers unchanged", async () => {
		// The colon split must not disturb the closed union: those provider names carry
		// no colon, so they take the original path.
		process.env.NOTION_WORK_ACCESS_TOKEN = "work_token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("notion_work")).resolves.toBe("work_token");
	});
});

describe("getCredential — Meta Ads system-user token (#646)", () => {
	it("resolves META_ADS_ACCESS_TOKEN for meta_ads", async () => {
		process.env.META_ADS_ACCESS_TOKEN = "meta_token";

		const getCredential = await freshGetCredential();

		await expect(getCredential("meta_ads")).resolves.toBe("meta_token");
	});

	it("throws a setup error naming the exact var and pointing at .env.example when unset", async () => {
		delete process.env.META_ADS_ACCESS_TOKEN;

		const getCredential = await freshGetCredential();

		const err = (await getCredential("meta_ads").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/META_ADS_ACCESS_TOKEN is not set/);
		expect(err.message).toMatch(/packages\/mcp-server\/\.env\.example/);
	});
});

describe("getCredential: gemini", () => {
	it("resolves GEMINI_API_KEY for gemini", async () => {
		process.env.GEMINI_API_KEY = "g";

		const getCredential = await freshGetCredential();

		await expect(getCredential("gemini")).resolves.toBe("g");
	});

	it("throws a setup error naming GEMINI_API_KEY, entity_synthesize, and .env.example when unset", async () => {
		delete process.env.GEMINI_API_KEY;

		const getCredential = await freshGetCredential();

		const err = (await getCredential("gemini").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("CredentialNotConfiguredError");
		expect(err.message).toMatch(/GEMINI_API_KEY/);
		expect(err.message).toMatch(/entity_synthesize/);
		expect(err.message).toMatch(/packages\/mcp-server\/\.env\.example/);
	});

	it("hasCredential resolves false when unset", async () => {
		delete process.env.GEMINI_API_KEY;

		const { hasCredential } = await freshCredentials();

		await expect(hasCredential("gemini")).resolves.toBe(false);
	});
});

describe("getCredential: linkedin (#1632)", () => {
	it("resolves LINKEDIN_ACCESS_TOKEN for linkedin", async () => {
		process.env.LINKEDIN_ACCESS_TOKEN = "li_token_123";

		const getCredential = await freshGetCredential();

		await expect(getCredential("linkedin")).resolves.toBe("li_token_123");
	});

	it("throws a setup error naming LINKEDIN_ACCESS_TOKEN and linkedin_post when unset", async () => {
		delete process.env.LINKEDIN_ACCESS_TOKEN;

		const getCredential = await freshGetCredential();

		const err = (await getCredential("linkedin").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("CredentialNotConfiguredError");
		expect(err.message).toMatch(/LINKEDIN_ACCESS_TOKEN/);
		expect(err.message).toMatch(/linkedin_post/);
		expect(err.message).toMatch(/packages\/mcp-server\/\.env\.example/);
	});
});

describe("getCredential: github_pulls (#1479)", () => {
	it("resolves GITHUB_PERSONAL_ACCESS_TOKEN first and falls back to legacy GITHUB_TOKEN_PULLS", async () => {
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_pat_primary";
		process.env.GITHUB_TOKEN_PULLS = "ghp_pulls_legacy";
		const getCredential = await freshGetCredential();
		await expect(getCredential("github_pulls")).resolves.toBe("ghp_pat_primary");

		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		const getCredentialLegacy = await freshGetCredential();
		await expect(getCredentialLegacy("github_pulls")).resolves.toBe("ghp_pulls_legacy");
	});

	it("throws naming GITHUB_PERSONAL_ACCESS_TOKEN (or legacy GITHUB_TOKEN_PULLS) and never falls back to GITHUB_WORK_ACCESS_TOKEN, GITHUB_TOKEN_ISSUES, GITHUB_TOKEN_INGEST, or GITHUB_TOKEN", async () => {
		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		delete process.env.GITHUB_TOKEN_PULLS;
		process.env.GITHUB_WORK_ACCESS_TOKEN = "ghp_work";
		process.env.GITHUB_TOKEN_ISSUES = "ghp_issues";
		process.env.GITHUB_TOKEN_INGEST = "ghp_ingest";
		process.env.GITHUB_TOKEN = "ghp_general";

		const getCredential = await freshGetCredential();
		const err = (await getCredential("github_pulls").catch((e: unknown) => e)) as Error;

		expect(err.name).toBe("CredentialNotConfiguredError");
		expect(err.message).toMatch(
			/GITHUB_PERSONAL_ACCESS_TOKEN \(or legacy GITHUB_TOKEN_PULLS\) is not set/,
		);
		expect(err.message).toMatch(/github_pr_create/);
	});
});

describe("getCredential & getGithubCredential: github_work (example-org/*)", () => {
	it("resolves GITHUB_WORK_ACCESS_TOKEN for github_work and never falls back to personal tokens", async () => {
		process.env.GITHUB_WORK_ACCESS_TOKEN = "ghp_work_token";
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_personal_token";
		const getCredential = await freshGetCredential();
		await expect(getCredential("github_work")).resolves.toBe("ghp_work_token");

		delete process.env.GITHUB_WORK_ACCESS_TOKEN;
		const getCredentialMissing = await freshGetCredential();
		await expect(getCredentialMissing("github_work")).rejects.toThrow(
			/GITHUB_WORK_ACCESS_TOKEN is not set/,
		);
	});

	it("routes example-org/* repos to GITHUB_WORK_ACCESS_TOKEN and personal repos to personal tokens", async () => {
		process.env.GITHUB_WORK_ACCESS_TOKEN = "ghp_work_token";
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_personal_token";
		const { getGithubCredential, isWorkGithubRepo } = await freshCredentials();

		expect(isWorkGithubRepo("example-org/work")).toBe(true);
		expect(isWorkGithubRepo("example-org/work-mcp")).toBe(true);
		expect(isWorkGithubRepo("example-org")).toBe(true);
		expect(isWorkGithubRepo("anguspersonal/ahOS")).toBe(false);
		expect(isWorkGithubRepo(undefined)).toBe(false);

		await expect(getGithubCredential("github", "example-org/work")).resolves.toBe(
			"ghp_work_token",
		);
		await expect(getGithubCredential("github_issues", "example-org/work-mcp")).resolves.toBe(
			"ghp_work_token",
		);
		await expect(getGithubCredential("github_pulls", "example-org/work")).resolves.toBe(
			"ghp_work_token",
		);

		await expect(getGithubCredential("github", "anguspersonal/ahOS")).resolves.toBe(
			"ghp_personal_token",
		);
		await expect(getGithubCredential("github_issues", "anguspersonal/ahOS")).resolves.toBe(
			"ghp_personal_token",
		);
		await expect(getGithubCredential("github_pulls", "anguspersonal/ahOS")).resolves.toBe(
			"ghp_personal_token",
		);
	});
});

describe("hasCredential — narrowed catch", () => {
	it("returns false when the provider is simply not configured", async () => {
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;

		const { hasCredential } = await freshCredentials();

		await expect(hasCredential("google_work")).resolves.toBe(false);
	});

	it("returns true when the provider resolves", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "work_refresh";

		const { hasCredential } = await freshCredentials();

		await expect(hasCredential("google_work")).resolves.toBe(true);
	});

	it("does not swallow an unrelated error, e.g. a typo'd connection family", async () => {
		// Before this fix, hasCredential's blanket catch turned "unknown family" (a real
		// bug) into "false" (looks like routine unwired state) — masking exactly the kind
		// of typo splitConnectionRef exists to catch loudly.
		const { hasCredential } = await freshCredentials();

		await expect(hasCredential("mixpanel:work")).rejects.toThrow(
			/Unknown connection family 'mixpanel'/,
		);
	});
});
