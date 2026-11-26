import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_MINT_SCOPES } from "../google/scopes.js";
import { checkCredentials } from "./credentialChecks.js";
import type { DoctorCheck } from "./report.js";

// Real credentials.ts (it only reads process.env); fetch is the one stubbed boundary,
// routed by URL so every probe can be answered independently.

const ENV_KEYS = [
	"NOTION_WORK_ACCESS_TOKEN",
	"NOTION_API_KEY",
	"NOTION_PERSONAL_ACCESS_TOKEN",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"GOOGLE_REFRESH_TOKEN_PERSONAL",
	"GOOGLE_REFRESH_TOKEN",
	"GOOGLE_REFRESH_TOKEN_WORK",
	"GOOGLE_ACCOUNT_EMAIL_PERSONAL",
	"GOOGLE_ACCOUNT_EMAIL_WORK",
	"GITHUB_TOKEN_INGEST",
	"GITHUB_PERSONAL_ACCESS_TOKEN",
	"GITHUB_WORK_ACCESS_TOKEN",
	"GITHUB_TOKEN_PULLS",
	"GITHUB_TOKEN_ISSUES",
	"GITHUB_ISSUES_TOKEN",
	"GITHUB_TOKEN",
	"SLACK_TOKEN_USER_OAUTH",
	"SLACK_USER_TOKEN",
	"SLACK_BOT_TOKEN",
	"SLACK_TOKEN_BOT_OAUTH",
	"DEX_API_KEY",
	"META_ADS_ACCESS_TOKEN",
	"REVENUECAT_API_KEY",
	"WORK_PLANNING_TOKEN",
	"BREVO_MCP_API_KEY",
	"LINKEDIN_ACCESS_TOKEN",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"POSTHOG_API_KEY_WORK",
	"GEMINI_API_KEY",
	"MICROSOFT_CLIENT_ID",
	"MICROSOFT_CLIENT_SECRET",
	"MICROSOFT_REFRESH_TOKEN_PERSONAL",
	"MICROSOFT_ACCOUNT_EMAIL_PERSONAL",
];
let saved: Record<string, string | undefined> = {};

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;
let routes: Route[] = [];

function respond(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	routes = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			for (const r of routes) {
				const hit = r(String(url), init);
				if (hit) return respond(hit.status ?? 200, hit.body);
			}
			throw new Error(`unrouted fetch ${url}`);
		}),
	);
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.unstubAllGlobals();
});

const byName = (checks: DoctorCheck[], name: string) => {
	const c = checks.find((x) => x.name === name);
	if (!c) throw new Error(`no check named ${name}; have ${checks.map((x) => x.name).join(", ")}`);
	return c;
};

const googleRoutes = (emails: Record<string, string>, scopes = GOOGLE_MINT_SCOPES) => {
	routes.push((url, init) => {
		if (!url.startsWith("https://oauth2.googleapis.com/token")) return undefined;
		const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
		return { body: { access_token: `at-${refresh}`, scope: scopes.join(" ") } };
	});
	routes.push((url, init) => {
		if (!url.startsWith("https://gmail.googleapis.com/")) return undefined;
		const auth = String((init?.headers as Record<string, string>).Authorization);
		const refresh = auth.replace("Bearer at-", "");
		return { body: { emailAddress: emails[refresh] } };
	});
};

describe("credentials: presence, under which accepted name", () => {
	it("fails a core credential that is not set, naming every accepted env var", async () => {
		const checks = await checkCredentials();
		const notion = byName(checks, "notion_work");
		expect(notion.status).toBe("fail");
		expect(notion.fix).toContain("NOTION_WORK_ACCESS_TOKEN");
		expect(notion.detail).toContain("NOTION_WORK_ACCESS_TOKEN, NOTION_API_KEY");
	});

	it("only warns for an optional credential that is not set", async () => {
		const checks = await checkCredentials();
		expect(byName(checks, "meta_ads").status).toBe("warn");
		expect(byName(checks, "meta_ads").fix).toContain("META_ADS_ACCESS_TOKEN");
	});

	it("reports the legacy name it was found under, so a rename is visible", async () => {
		process.env.NOTION_API_KEY = "secret_legacy";
		routes.push((url) => (url.endsWith("/v1/users/me") ? { body: { id: "bot-1", bot: { workspace_name: "Work" } } } : undefined));

		const c = byName(await checkCredentials(), "notion_work");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain("NOTION_API_KEY");
		expect(c.fix).toContain("NOTION_WORK_ACCESS_TOKEN");
	});

	it("names the wrong-name trap: GITHUB_TOKEN set, GITHUB_PERSONAL_ACCESS_TOKEN not (#1021)", async () => {
		process.env.GITHUB_TOKEN = "ghp_general";
		const c = byName(await checkCredentials(), "github");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain("GITHUB_TOKEN is set");
		expect(c.fix).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
	});

	it("names the wrong-name trap for github_issues: GITHUB_TOKEN set, GITHUB_PERSONAL_ACCESS_TOKEN not", async () => {
		process.env.GITHUB_TOKEN = "ghp_general";
		const c = byName(await checkCredentials(), "github_issues");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain("GITHUB_TOKEN is set");
		expect(c.fix).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
	});

	it("names the wrong-name trap for github_work: GITHUB_PERSONAL_ACCESS_TOKEN set, GITHUB_WORK_ACCESS_TOKEN not", async () => {
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_personal_pat";
		routes.push((url) => (url === "https://api.github.com/user" ? { body: { login: "anguspersonal" } } : undefined));
		const c = byName(await checkCredentials(), "github_work");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain(
			"GITHUB_PERSONAL_ACCESS_TOKEN is set, but this provider reads GITHUB_WORK_ACCESS_TOKEN",
		);
		expect(c.fix).toContain("GITHUB_WORK_ACCESS_TOKEN");
	});

	it("never prints a secret value", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "secret_do_not_print";
		process.env.SLACK_BOT_TOKEN = "test-slack-b-token";
		routes.push((url) => (url.endsWith("/v1/users/me") ? { status: 401, body: { message: "API token is invalid." } } : undefined));
		routes.push((url) => (url.includes("slack.com/api/auth.test") ? { body: { ok: false, error: "invalid_auth" } } : undefined));

		const text = JSON.stringify(await checkCredentials());
		expect(text).not.toContain("secret_do_not_print");
		expect(text).not.toContain("test-slack-b-token");
	});
});

describe("credentials: authenticates", () => {
	it("fails a Notion token the API rejects, and says to replace it", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "secret_bad";
		routes.push((url) => (url.endsWith("/v1/users/me") ? { status: 401, body: { message: "API token is invalid." } } : undefined));

		const c = byName(await checkCredentials(), "notion_work");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("401");
	});

	it("passes a working Notion token and names the workspace it opens", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "secret_ok";
		routes.push((url) => (url.endsWith("/v1/users/me") ? { body: { id: "bot-1", bot: { workspace_name: "Work" } } } : undefined));

		const c = byName(await checkCredentials(), "notion_work");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("Work");
	});

	it("treats Slack's 200 {ok:false} as a failure, not a pass", async () => {
		process.env.SLACK_TOKEN_USER_OAUTH = "test-slack-p-token";
		routes.push((url) => (url.includes("slack.com/api/auth.test") ? { body: { ok: false, error: "invalid_auth" } } : undefined));

		const c = byName(await checkCredentials(), "slack");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("invalid_auth");
	});

	it("probes github_issues token against api.github.com/user", async () => {
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_issues_valid";
		routes.push((url) => (url === "https://api.github.com/user" ? { body: { login: "anguspersonal" } } : undefined));

		const c = byName(await checkCredentials(), "github_issues");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("authenticates as login anguspersonal");
	});

	it("accepts GITHUB_TOKEN_ISSUES legacy alias and offers to rename to GITHUB_PERSONAL_ACCESS_TOKEN (#1926)", async () => {
		process.env.GITHUB_TOKEN_ISSUES = "ghp_issues_legacy";
		routes.push((url) => (url === "https://api.github.com/user" ? { body: { login: "anguspersonal" } } : undefined));

		const c = byName(await checkCredentials(), "github_issues");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain("set under GITHUB_TOKEN_ISSUES (a legacy name)");
		expect(c.fix).toContain("rename GITHUB_TOKEN_ISSUES to GITHUB_PERSONAL_ACCESS_TOKEN");
		expect(c.fix).toMatch(/\(the working value is fine; the name is not\)$/);
	});

	it("accepts GITHUB_ISSUES_TOKEN alias and reports the name it was found under", async () => {
		process.env.GITHUB_ISSUES_TOKEN = "ghp_issues_alias";
		routes.push((url) => (url === "https://api.github.com/user" ? { body: { login: "anguspersonal" } } : undefined));

		const c = byName(await checkCredentials(), "github_issues");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain("GITHUB_ISSUES_TOKEN");
		expect(c.fix).toContain("rename GITHUB_ISSUES_TOKEN to GITHUB_PERSONAL_ACCESS_TOKEN");
	});

	it("fails a Dex key the Dex MCP endpoint rejects", async () => {
		process.env.DEX_API_KEY = "dex-bad";
		routes.push((url) => (url.startsWith("https://mcp.getdex.com") ? { status: 401, body: { error: "unauthorized" } } : undefined));

		const c = byName(await checkCredentials(), "dex");
		expect(c.status).toBe("fail");
		expect(c.fix).toContain("DEX_API_KEY");
	});

	it("passes a Dex key the endpoint accepts", async () => {
		process.env.DEX_API_KEY = "dex-ok";
		routes.push((url) => (url.startsWith("https://mcp.getdex.com") ? { body: { jsonrpc: "2.0", id: "doctor", result: { tools: [] } } } : undefined));

		expect(byName(await checkCredentials(), "dex").status).toBe("ok");
	});
});

describe("credentials: identity is the expected account (the check-google-scopes model)", () => {
	beforeEach(() => {
		process.env.GOOGLE_CLIENT_ID = "cid";
		process.env.GOOGLE_CLIENT_SECRET = "csecret";
	});

	it("fails a token missing a minted scope — the stale-token signature", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "p";
		googleRoutes({ p: "me@example.com" }, GOOGLE_MINT_SCOPES.slice(0, 1));

		const c = byName(await checkCredentials(), "google_personal");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("missing");
		expect(c.fix).toContain("google-auth -- --account personal");
	});

	it("includes the OAuth consent screen Testing vs In production hint on Google invalid_grant (#2052)", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "rt-expired-secret";
		routes.push((url) =>
			url.startsWith("https://oauth2.googleapis.com/token")
				? {
						status: 400,
						body: {
							error: "invalid_grant",
							error_description: "Token has been expired or revoked: rt-expired-secret",
						},
					}
				: undefined,
		);

		const checks = await checkCredentials();
		const c = byName(checks, "google_personal");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("invalid_grant");
		expect(c.detail).toContain("Publishing status is set to In production rather than Testing");
		expect(c.detail).toContain("#2052");
		expect(c.fix).toContain("google-auth -- --account personal");
		expect(JSON.stringify(checks)).not.toContain("rt-expired-secret");

		routes = [
			(url) =>
				url.startsWith("https://oauth2.googleapis.com/token")
					? {
							status: 401,
							body: {
								error: "invalid_client",
								error_description: "Unauthorized client for rt-expired-secret",
							},
						}
					: undefined,
		];
		const nonInvalidGrantChecks = await checkCredentials();
		const cOther = byName(nonInvalidGrantChecks, "google_personal");
		expect(cOther.status).toBe("fail");
		expect(cOther.detail).toContain("invalid_client");
		expect(cOther.detail).not.toContain("Publishing status is set to In production rather than Testing");
		expect(JSON.stringify(nonInvalidGrantChecks)).not.toContain("rt-expired-secret");
	});

	it("fails a valid, correctly scoped token that opens the wrong mailbox", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "h";
		process.env.GOOGLE_ACCOUNT_EMAIL_WORK = "owner@work.example.com";
		googleRoutes({ h: "me@example.com" });

		const c = byName(await checkCredentials(), "google_work");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("me@example.com");
		expect(c.detail).toContain("owner@work.example.com");
	});

	it("passes when the mailbox matches the pinned address", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "h";
		process.env.GOOGLE_ACCOUNT_EMAIL_WORK = "Owner@work.example.com";
		googleRoutes({ h: "owner@work.example.com" });

		expect(byName(await checkCredentials(), "google_work").status).toBe("ok");
	});

	it("fails both Google accounts when they open the same mailbox, pinned or not (the 2026-09-05 swap)", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "p";
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "h";
		googleRoutes({ p: "me@example.com", h: "me@example.com" });

		const c = byName(await checkCredentials(), "google accounts are distinct");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("me@example.com");
	});

	it("fails the two Notion tokens when they authenticate as the same integration", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "secret_a";
		process.env.NOTION_PERSONAL_ACCESS_TOKEN = "secret_b";
		routes.push((url) => (url.endsWith("/v1/users/me") ? { body: { id: "bot-same", bot: { workspace_name: "Angus" } } } : undefined));

		expect(byName(await checkCredentials(), "notion workspaces are distinct").status).toBe("fail");
	});
});

describe("credentials: presence-only families", () => {
	it("reports each posthog connection found by its env var prefix", async () => {
		process.env.POSTHOG_API_KEY_WORK = "phx";
		const c = byName(await checkCredentials(), "posthog:work");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("POSTHOG_API_KEY_WORK");
	});
});

describe("credentials: openai", () => {
	it("reports warn and fix names OPENAI_API_KEY when unset", async () => {
		delete process.env.OPENAI_API_KEY;
		const c = byName(await checkCredentials(), "openai");
		expect(c.status).toBe("warn");
		expect(c.fix).toContain("OPENAI_API_KEY");
	});

	it("reports ok when /v1/models returns 200 and does not leak value", async () => {
		process.env.OPENAI_API_KEY = "sk-do-not-print";
		routes.push((url, init) => {
			if (url !== "https://api.openai.com/v1/models") return undefined;
			const auth = (init?.headers as Record<string, string>)?.Authorization;
			return auth === "Bearer sk-do-not-print"
				? { status: 200, body: { data: [{ id: "text-embedding-3-small" }] } }
				: { status: 401, body: { error: { message: "Incorrect API key provided" } } };
		});

		const checks = await checkCredentials();
		const c = byName(checks, "openai");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("authenticates as OpenAI /v1/models accepted the key");
		expect(JSON.stringify(checks)).not.toContain("sk-do-not-print");
	});

	it("reports fail with HTTP status, error message, and fix on 401/403 or network error", async () => {
		process.env.OPENAI_API_KEY = "sk-revoked-secret";
		routes.push((url) =>
			url === "https://api.openai.com/v1/models"
				? { status: 401, body: { error: { message: "Incorrect API key provided: sk-revoked-secret" } } }
				: undefined,
		);

		const checks = await checkCredentials();
		const c = byName(checks, "openai");
		expect(c.status).toBe("fail");
		expect(c.detail).toContain("401");
		expect(c.detail).toContain("Incorrect API key provided");
		expect(c.fix).toContain("OPENAI_API_KEY");
		expect(JSON.stringify(checks)).not.toContain("sk-revoked-secret");

		routes = [
			(url) =>
				url === "https://api.openai.com/v1/models"
					? { status: 403, body: { error: { message: "Project disabled" } } }
					: undefined,
		];
		const c403 = byName(await checkCredentials(), "openai");
		expect(c403.status).toBe("fail");
		expect(c403.detail).toContain("403");
		expect(c403.detail).toContain("Project disabled");

		routes = [
			(url) => {
				if (url === "https://api.openai.com/v1/models") throw new Error("fetch failed");
				return undefined;
			},
		];
		const cNet = byName(await checkCredentials(), "openai");
		expect(cNet.status).toBe("fail");
		expect(cNet.detail).toContain("probe did not complete: fetch failed");
	});
});

describe("credentials: gemini", () => {
	const geminiModelsUrl = `https://${"generativelanguage"}.googleapis.com/v1beta/models?pageSize=1`;

	it("reports warn and fix names GEMINI_API_KEY when unset", async () => {
		delete process.env.GEMINI_API_KEY;
		const c = byName(await checkCredentials(), "gemini");
		expect(c.status).toBe("warn");
		expect(c.fix).toContain("GEMINI_API_KEY");
	});

	it("reports ok when /v1beta/models returns 200 and does not leak value", async () => {
		process.env.GEMINI_API_KEY = "g-do-not-print";
		routes.push((url, init) => {
			if (url !== geminiModelsUrl) return undefined;
			const key = (init?.headers as Record<string, string>)?.["x-goog-api-key"];
			return key === "g-do-not-print"
				? { status: 200, body: { models: [{ name: "models/gemini-2.5-flash" }] } }
				: { status: 400, body: { error: { message: "API key not valid." } } };
		});

		const checks = await checkCredentials();
		const c = byName(checks, "gemini");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("authenticates as Gemini /v1beta/models accepted the key");
		expect(JSON.stringify(checks)).not.toContain("g-do-not-print");
	});

	it("reports fail on 400/401/403 from /v1beta/models and does not leak value", async () => {
		process.env.GEMINI_API_KEY = "g-bad-key";
		for (const status of [400, 401, 403]) {
			routes = [
				(url) =>
					url === geminiModelsUrl
						? { status, body: { error: { message: "API key not valid. Please pass a valid API key." } } }
						: undefined,
			];
			const checks = await checkCredentials();
			const c = byName(checks, "gemini");
			expect(c.status).toBe("fail");
			expect(c.detail).toContain(String(status));
			expect(c.detail).toContain("API key not valid");
			expect(c.fix).toContain("GEMINI_API_KEY");
			expect(JSON.stringify(checks)).not.toContain("g-bad-key");
		}
	});
});

describe("credentials: microsoft_personal (#2043)", () => {
	const msTokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
	const msDriveUrl = "https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType,owner,quota";

	it("reports warn (not fail) when MICROSOFT_REFRESH_TOKEN_PERSONAL is unset", async () => {
		delete process.env.MICROSOFT_REFRESH_TOKEN_PERSONAL;
		const c = byName(await checkCredentials(), "microsoft_personal");
		expect(c.status).toBe("warn");
		expect(c.detail).toContain("MICROSOFT_REFRESH_TOKEN_PERSONAL");
		expect(c.fix).toContain("microsoft-auth");
		expect(c.fix).toContain("MICROSOFT_REFRESH_TOKEN_PERSONAL");
	});

	it("authenticates against consumers token endpoint and /v1.0/me/drive without leaking secrets", async () => {
		process.env.MICROSOFT_CLIENT_ID = "ms-cid";
		process.env.MICROSOFT_CLIENT_SECRET = "ms-csecret";
		process.env.MICROSOFT_REFRESH_TOKEN_PERSONAL = "ms-rt-secret-value";

		routes.push((url, init) => {
			if (url !== msTokenUrl) return undefined;
			const params = new URLSearchParams(String(init?.body));
			if (params.get("refresh_token") !== "ms-rt-secret-value") {
				return { status: 400, body: { error: "invalid_grant" } };
			}
			return {
				status: 200,
				body: {
					access_token: "ms-at-secret",
					scope: "Files.ReadWrite User.Read",
				},
			};
		});
		routes.push((url, init) => {
			if (url !== msDriveUrl) return undefined;
			const auth = (init?.headers as Record<string, string>)?.Authorization;
			return auth === "Bearer ms-at-secret"
				? {
						status: 200,
						body: {
							id: "drive-1",
							driveType: "personal",
							owner: { user: { displayName: "Angus Hally", email: "owner@example.com" } },
						},
					}
				: { status: 401, body: { error: { message: "Unauthorized" } } };
		});

		const checks = await checkCredentials();
		const c = byName(checks, "microsoft_personal");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("OneDrive");
		expect(c.detail).toContain("owner@example.com");
		expect(c.detail).toContain("personal");
		expect(JSON.stringify(checks)).not.toContain("ms-rt-secret-value");
		expect(JSON.stringify(checks)).not.toContain("ms-at-secret");
	});

	it("fails when Files.ReadWrite scope is missing or pinned email mismatches", async () => {
		process.env.MICROSOFT_CLIENT_ID = "ms-cid";
		process.env.MICROSOFT_REFRESH_TOKEN_PERSONAL = "ms-rt";

		routes.push((url) =>
			url === msTokenUrl
				? { status: 200, body: { access_token: "ms-at", scope: "User.Read" } }
				: undefined,
		);
		const missingScope = byName(await checkCredentials(), "microsoft_personal");
		expect(missingScope.status).toBe("fail");
		expect(missingScope.detail).toContain("Files.ReadWrite");

		routes = [
			(url) =>
				url === msTokenUrl
					? { status: 200, body: { access_token: "ms-at", scope: "Files.ReadWrite User.Read" } }
					: undefined,
			(url) =>
				url === msDriveUrl
					? {
							status: 200,
							body: {
								id: "drive-1",
								driveType: "personal",
								owner: { user: { displayName: "Other", email: "other@example.com" } },
							},
						}
					: undefined,
		];
		process.env.MICROSOFT_ACCOUNT_EMAIL_PERSONAL = "owner@example.com";
		const wrongAccount = byName(await checkCredentials(), "microsoft_personal");
		expect(wrongAccount.status).toBe("fail");
		expect(wrongAccount.detail).toContain("other@example.com");
		expect(wrongAccount.detail).toContain("owner@example.com");
	});
});

