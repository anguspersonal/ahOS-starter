import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env.ts reads process.env at import time, so each case needs a fresh module
// instance (vi.resetModules) after mutating process.env. The base vars below
// mirror vitest.config.ts's stubs — required() would otherwise throw.
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

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of NOTION_VARS) originalEnv[key] = process.env[key];
	for (const [key, value] of Object.entries(baseEnv)) process.env[key] = value;
});

afterEach(() => {
	for (const key of NOTION_VARS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	for (const key of Object.keys(baseEnv)) delete process.env[key];
	vi.resetModules();
});

describe("env Notion token resolution", () => {
	it("prefers NOTION_WORK_ACCESS_TOKEN when both it and NOTION_API_KEY are set", async () => {
		process.env.NOTION_WORK_ACCESS_TOKEN = "work_token";
		process.env.NOTION_API_KEY = "legacy_token";
		vi.resetModules();

		const { env } = await import("../env.js");
		expect(env.notionApiKey).toBe("work_token");
	});

	it("falls back to NOTION_API_KEY when NOTION_WORK_ACCESS_TOKEN is unset", async () => {
		delete process.env.NOTION_WORK_ACCESS_TOKEN;
		process.env.NOTION_API_KEY = "legacy_token";
		vi.resetModules();

		const { env } = await import("../env.js");
		expect(env.notionApiKey).toBe("legacy_token");
	});

	it("plumbs NOTION_PERSONAL_ACCESS_TOKEN separately, defaulting to null", async () => {
		delete process.env.NOTION_PERSONAL_ACCESS_TOKEN;
		vi.resetModules();
		const unset = await import("../env.js");
		expect(unset.env.notionPersonalToken).toBeNull();

		process.env.NOTION_PERSONAL_ACCESS_TOKEN = "personal_token";
		vi.resetModules();
		const set = await import("../env.js");
		expect(set.env.notionPersonalToken).toBe("personal_token");
	});
});

describe("env lazy resolution (#508)", () => {
	// The motivating case: scripts/google-oauth.ts must be able to boot with a
	// .env containing ONLY GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET. Under eager
	// resolution, importing env.js without the Supabase vars threw at import;
	// lazily, required() must only fire when the missing key is ACCESSED.
	const TOUCHED = [
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"KMS_USER_ID",
		"GOOGLE_CLIENT_ID",
		"GOOGLE_CLIENT_SECRET",
		"GOOGLE_OAUTH_REDIRECT",
	] as const;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of TOUCHED) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of TOUCHED) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		vi.resetModules();
	});

	it("imports with only the Google client vars set, and resolves them on access", async () => {
		process.env.GOOGLE_CLIENT_ID = "test-client-id";
		process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
		vi.resetModules();

		// Import must not throw even though SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
		// KMS_USER_ID are all unset.
		const { env } = await import("../env.js");

		expect(env.googleClientId).toBe("test-client-id");
		expect(env.googleClientSecret).toBe("test-client-secret");
		expect(env.googleOAuthRedirect).toBe("http://localhost:53682/oauth2callback");
	});

	it("still fails fast with the exact message when an unset required key is accessed", async () => {
		vi.resetModules();
		const { env } = await import("../env.js");

		expect(() => env.supabaseUrl).toThrowError(
			"Missing required env var SUPABASE_URL. See packages/mcp-server/.env.example",
		);
		expect(() => env.supabaseServiceRoleKey).toThrowError(
			"Missing required env var SUPABASE_SERVICE_ROLE_KEY. See packages/mcp-server/.env.example",
		);
		expect(() => env.userId).toThrowError(
			"Missing required env var KMS_USER_ID. See packages/mcp-server/.env.example",
		);
	});

	it("resolves a required key set AFTER import (resolution is per-access, not snapshotted)", async () => {
		vi.resetModules();
		const { env } = await import("../env.js");
		expect(() => env.supabaseUrl).toThrow();

		process.env.SUPABASE_URL = "http://localhost:54321";
		expect(env.supabaseUrl).toBe("http://localhost:54321");
	});
});

describe("httpEnv token TTLs (#2025)", () => {
	const HTTP_VARS = [
		"MCP_PUBLIC_URL",
		"MCP_OWNER_PASSWORD",
		"MCP_OAUTH_JWT_SECRET",
		"MCP_ACCESS_TOKEN_TTL",
		"MCP_REFRESH_TOKEN_TTL",
	] as const;
	const savedHttp: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of HTTP_VARS) {
			savedHttp[key] = process.env[key];
			delete process.env[key];
		}
		process.env.MCP_PUBLIC_URL = "https://ahkms.example.com";
		process.env.MCP_OWNER_PASSWORD = "test-owner-password";
		process.env.MCP_OAUTH_JWT_SECRET = "test-jwt-secret";
	});

	afterEach(() => {
		for (const key of HTTP_VARS) {
			if (savedHttp[key] === undefined) delete process.env[key];
			else process.env[key] = savedHttp[key];
		}
		vi.resetModules();
	});

	it("defaults accessTokenTtl to 30 days (2592000s) and honours MCP_ACCESS_TOKEN_TTL override", async () => {
		const { httpEnv } = await import("../env.js");
		expect(httpEnv().accessTokenTtl).toBe(2592000);
		expect(httpEnv().refreshTokenTtl).toBe(2592000);

		process.env.MCP_ACCESS_TOKEN_TTL = "3600";
		expect(httpEnv().accessTokenTtl).toBe(3600);
	});
});
