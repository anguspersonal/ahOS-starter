/**
 * Smoke test for the remote HTTP serving surface (issue #84).
 *
 * Boots src/http.ts as a child process and asserts the *unauthenticated* contract — the
 * security-critical half of the acceptance criteria — without needing a browser or a real
 * OAuth login:
 *
 *   1. GET /healthz                                      → 200 { ok: true }
 *   2. GET /.well-known/oauth-authorization-server       → advertises authorize/token/register
 *   3. GET /.well-known/oauth-protected-resource/mcp     → points at the auth server
 *   4. POST /mcp (no token, initialize)                  → 401 + WWW-Authenticate header
 *
 * It does NOT exercise a full token round-trip (that needs the interactive consent screen);
 * the token machinery is unit-tested in src/auth/ownerOAuthProvider.test.ts.
 *
 * Run from repo root (no real Supabase needed — the unauthenticated paths never touch it):
 *   node --import tsx packages/mcp-server/scripts/http-smoke.ts
 *
 * Exits non-zero on the first failed assertion.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.SMOKE_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const httpEntry = path.join(here, "..", "src", "http.ts");
const tsxCli = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

// Dummy-but-valid env: the unauthenticated surface never calls Supabase, so placeholder
// credentials are fine. Real values would be required to actually serve tools.
const childEnv: NodeJS.ProcessEnv = {
	...process.env,
	PORT: String(PORT),
	NODE_ENV: process.env.NODE_ENV ?? "production",
	WEB_ORIGIN: process.env.WEB_ORIGIN ?? "https://web.smoke.test",
	MCP_PUBLIC_URL: BASE,
	MCP_OWNER_PASSWORD: process.env.MCP_OWNER_PASSWORD ?? "smoke-test-password",
	MCP_OAUTH_JWT_SECRET:
		process.env.MCP_OAUTH_JWT_SECRET ?? "smoke-test-jwt-secret-not-for-prod",
	SUPABASE_URL: process.env.SUPABASE_URL ?? "http://localhost:54321",
	SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "smoke-key",
	// Raw process.env read, NOT getCurrentUserId() (ADR-045): this forwards the
	// var into the child's env with a placeholder default — it never scopes data.
	// The accessor would throw when KMS_USER_ID is unset and break this script's
	// "no real Supabase needed" contract. Allowlisted in check-user-id-reads.js.
	KMS_USER_ID:
		process.env.KMS_USER_ID ?? "00000000-0000-0000-0000-000000000000",
};

const child = spawn(process.execPath, [tsxCli, httpEntry], {
	env: childEnv,
	stdio: ["ignore", "inherit", "inherit"],
});

// The SDK normalizes the issuer URL through `new URL()`, which appends a trailing slash;
// compare origins, not exact strings.
const sameOrigin = (a: unknown, b: string) =>
	typeof a === "string" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

let failed = false;
function check(name: string, ok: boolean, detail?: unknown) {
	if (ok) {
		console.log(`  ✓ ${name}`);
	} else {
		failed = true;
		console.error(`  ✗ ${name}`, detail ?? "");
	}
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`${BASE}/healthz`);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error("server did not become healthy in time");
		await new Promise((r) => setTimeout(r, 250));
	}
}

async function main() {
	await waitForHealth();

	// 1. health
	const health = await fetch(`${BASE}/healthz`);
	const healthBody = (await health.json().catch(() => ({}))) as Record<string, unknown>;
	check("GET /healthz → ok", health.status === 200 && healthBody.ok === true, healthBody);

	// 2. authorization-server metadata
	const asRes = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
	const as = (await asRes.json().catch(() => ({}))) as Record<string, unknown>;
	check(
		"authorization-server metadata advertises endpoints",
		asRes.status === 200 &&
			typeof as.authorization_endpoint === "string" &&
			typeof as.token_endpoint === "string" &&
			typeof as.registration_endpoint === "string" &&
			sameOrigin(as.issuer, BASE),
		as,
	);

	// 3. protected-resource metadata
	const prRes = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
	const pr = (await prRes.json().catch(() => ({}))) as Record<string, unknown>;
	check(
		"protected-resource metadata points at this server",
		prRes.status === 200 &&
			Array.isArray(pr.authorization_servers) &&
			pr.authorization_servers.some((s: unknown) => sameOrigin(s, BASE)),
		pr,
	);

	// 4. unauthenticated MCP call is rejected
	const init = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "http-smoke", version: "0.0.0" },
		},
	};
	const mcpRes = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(init),
	});
	check(
		"POST /mcp without a token → 401 + WWW-Authenticate",
		mcpRes.status === 401 && mcpRes.headers.has("www-authenticate"),
		`status=${mcpRes.status} www-authenticate=${mcpRes.headers.get("www-authenticate")}`,
	);

	// 5. OPTIONS /api/actions/task_crud from WEB_ORIGIN (ADR-100 / ADR-101 / #1440)
	const webOrigin = childEnv.WEB_ORIGIN ?? "https://web.smoke.test";
	const actionPreflightRes = await fetch(`${BASE}/api/actions/task_crud`, {
		method: "OPTIONS",
		headers: {
			Origin: webOrigin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers":
				"authorization,content-type,x-action-caller,x-request-id",
		},
	});
	const actionAcao = actionPreflightRes.headers.get("access-control-allow-origin");
	const actionAcah = (
		actionPreflightRes.headers.get("access-control-allow-headers") ?? ""
	).toLowerCase();
	const hasRequiredHeaders =
		actionAcah.includes("x-request-id") && actionAcah.includes("x-action-caller");
	check(
		"OPTIONS /api/actions/task_crud from WEB_ORIGIN → 2xx + allowed origin + action headers",
		actionPreflightRes.ok && actionAcao === webOrigin && hasRequiredHeaders,
		`status=${actionPreflightRes.status} acao=${actionAcao} acah=${actionAcah}`,
	);

	// 6. Preflight from unauthorized origins carries no Access-Control-Allow-Origin for that origin (#1440)
	const evilOrigin = "https://evil.smoke.test";
	const evilRes = await fetch(`${BASE}/api/actions/task_crud`, {
		method: "OPTIONS",
		headers: {
			Origin: evilOrigin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers":
				"authorization,content-type,x-action-caller,x-request-id",
		},
	});
	const evilAcao = evilRes.headers.get("access-control-allow-origin");

	const localOrigin = "http://localhost:5173";
	const localRes = await fetch(`${BASE}/api/actions/task_crud`, {
		method: "OPTIONS",
		headers: {
			Origin: localOrigin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers":
				"authorization,content-type,x-action-caller,x-request-id",
		},
	});
	const localAcao = localRes.headers.get("access-control-allow-origin");
	check(
		"OPTIONS /api/actions/task_crud from unauthorized origins carries no Access-Control-Allow-Origin",
		evilAcao !== evilOrigin && localAcao !== localOrigin,
		`evilAcao=${evilAcao} localAcao=${localAcao}`,
	);

	// 7. OPTIONS /mcp from claude.ai still returns Access-Control-Allow-Origin: https://claude.ai
	const claudeOrigin = "https://claude.ai";
	const claudeRes = await fetch(`${BASE}/mcp`, {
		method: "OPTIONS",
		headers: {
			Origin: claudeOrigin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers":
				"content-type,authorization,mcp-session-id",
		},
	});
	const claudeAcao = claudeRes.headers.get("access-control-allow-origin");
	check(
		"OPTIONS /mcp from https://claude.ai returns Access-Control-Allow-Origin: https://claude.ai",
		claudeRes.ok && claudeAcao === claudeOrigin,
		`status=${claudeRes.status} acao=${claudeAcao}`,
	);
}

main()
	.catch((err) => {
		failed = true;
		console.error("Smoke run threw:", err);
	})
	.finally(() => {
		child.kill();
		if (failed) {
			console.error("\nHTTP smoke FAILED");
			process.exit(1);
		}
		console.log("\nHTTP smoke PASSED");
		process.exit(0);
	});
