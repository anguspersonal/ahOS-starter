import { URLSearchParams } from "node:url";
import {
	CREDENTIAL_PROVIDERS,
	connectionFamilyPrefixes,
	describeCredential,
	type CredentialProvider,
} from "../credentials.js";
import { GOOGLE_MINT_SCOPES } from "../google/scopes.js";
import type { DoctorCheck, DoctorStatus } from "./report.js";

// ahos_doctor, family 1: credentials (#1024).
//
// Three questions per credential, answered separately because each has failed on its own:
//   1. PRESENT, and under which accepted name. #1021: GITHUB_TOKEN was set while the
//      ingest read GITHUB_TOKEN_INGEST; SLACK_USER_TOKEN was the name in code while
//      SLACK_TOKEN_USER_OAUTH was provisioned. Both read as "missing credential" at the
//      call site, one failed tool call at a time.
//   2. AUTHENTICATES. One cheap, read-only identity call per provider.
//   3. IS THE EXPECTED ACCOUNT. The check-google-scopes.mjs model, folded in here: a
//      token that authenticates and opens the WRONG mailbox fails as wrong data, never as
//      an auth error (2026-09-05, a personal token in the work slot). Where an
//      expected identity is pinned in env it is enforced; where two slots must be two
//      different accounts (the Google pair, the Notion pair) that is enforced with no
//      pin at all, because a swap is exactly two slots answering the same.
//
// Runs inside the deployed MCP process, so it inspects the env that actually serves
// tools, not a developer's .env. Never prints a secret: names, identities and HTTP
// statuses only.

const PROBE_TIMEOUT_MS = 10_000;

/** Missing one of these breaks the dos ritual or the Drive/Calendar core, so it fails. */
const CORE: ReadonlySet<CredentialProvider> = new Set([
	"notion_work",
	"notion_personal",
	"google_personal",
]);

/**
 * Names that have been mistaken for a provider's real env var. When the real one is
 * unset and one of these is set, the check says so — the fix is a rename, not a mint.
 */
const DECOYS: Partial<Record<CredentialProvider, string[]>> = {
	github: ["GITHUB_TOKEN", "GITHUB_WORK_ACCESS_TOKEN"],
	github_issues: ["GITHUB_TOKEN", "GITHUB_TOKEN_INGEST", "GITHUB_WORK_ACCESS_TOKEN"],
	github_pulls: ["GITHUB_TOKEN", "GITHUB_TOKEN_INGEST", "GITHUB_TOKEN_ISSUES", "GITHUB_WORK_ACCESS_TOKEN"],
	github_work: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "GITHUB_TOKEN_INGEST", "GITHUB_TOKEN_PULLS"],
	slack: ["SLACK_USER_TOKEN", "SLACK_TOKEN_BOT_OAUTH"],
};

type Probe = { ok: true; identity: string; key?: string } | { ok: false; error: string };

async function get(url: string, headers: Record<string, string>, init: RequestInit = {}) {
	return fetch(url, { ...init, headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function probeNotion(token: string): Promise<Probe> {
	const res = await get("https://api.notion.com/v1/users/me", {
		Authorization: `Bearer ${token}`,
		"Notion-Version": "2022-06-28",
	});
	const body = (await res.json().catch(() => ({}))) as {
		id?: string;
		name?: string;
		message?: string;
		bot?: { workspace_name?: string };
	};
	if (!res.ok) return { ok: false, error: `Notion users/me ${res.status}: ${body.message ?? res.statusText}` };
	const workspace = body.bot?.workspace_name ?? "(unnamed workspace)";
	return { ok: true, identity: `workspace "${workspace}"`, key: body.id ?? workspace };
}

async function probeGithub(token: string): Promise<Probe> {
	const res = await get("https://api.github.com/user", {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "ahos-doctor",
	});
	const body = (await res.json().catch(() => ({}))) as { login?: string; message?: string };
	if (!res.ok || !body.login) return { ok: false, error: `GitHub /user ${res.status}: ${body.message ?? res.statusText}` };
	return { ok: true, identity: `login ${body.login}` };
}

async function probeSlack(token: string): Promise<Probe> {
	const res = await get("https://slack.com/api/auth.test", { Authorization: `Bearer ${token}` });
	// Slack answers 200 {ok:false} for a bad token; HTTP status alone would pass it.
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: string; team?: string };
	if (!res.ok || !body.ok) return { ok: false, error: `Slack auth.test: ${body.error ?? `HTTP ${res.status}`}` };
	return { ok: true, identity: `user ${body.user ?? "?"} in ${body.team ?? "?"}` };
}

async function probeDex(key: string): Promise<Probe> {
	const res = await fetch("https://mcp.getdex.com/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: "doctor" }),
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		return { ok: false, error: `Dex MCP ${res.status}: ${detail.slice(0, 120) || res.statusText}` };
	}
	return { ok: true, identity: "Dex MCP accepted the key" };
}

async function probeOpenai(key: string): Promise<Probe> {
	const res = await get("https://api.openai.com/v1/models", {
		Authorization: `Bearer ${key}`,
	});
	const body = (await res.json().catch(() => ({}))) as {
		error?: { message?: string } | string;
		message?: string;
	};
	if (!res.ok) {
		const rawMessage =
			(typeof body.error === "object" && body.error !== null ? body.error.message : body.error) ??
			body.message ??
			res.statusText;
		const message = String(rawMessage).replaceAll(key, "[REDACTED]");
		return { ok: false, error: `OpenAI /v1/models ${res.status}: ${message}` };
	}
	return { ok: true, identity: "OpenAI /v1/models accepted the key" };
}

const GEMINI_MODELS_URL = `https://${"generativelanguage"}.googleapis.com/v1beta/models?pageSize=1`;

async function probeGemini(key: string): Promise<Probe> {
	const res = await get(GEMINI_MODELS_URL, {
		"x-goog-api-key": key,
	});
	const body = (await res.json().catch(() => ({}))) as {
		error?: { message?: string } | string;
		message?: string;
	};
	if (!res.ok) {
		const rawMessage =
			(typeof body.error === "object" && body.error !== null ? body.error.message : body.error) ??
			body.message ??
			res.statusText;
		const message = String(rawMessage).replaceAll(key, "[REDACTED]");
		return { ok: false, error: `Gemini /v1beta/models ${res.status}: ${message}` };
	}
	return { ok: true, identity: "Gemini /v1beta/models accepted the key" };
}

const GOOGLE_ACCOUNT_OF: Record<"google_personal" | "google_work", "personal" | "work"> = {
	google_personal: "personal",
	google_work: "work",
};
const GOOGLE_EMAIL_ENV = {
	personal: "GOOGLE_ACCOUNT_EMAIL_PERSONAL",
	work: "GOOGLE_ACCOUNT_EMAIL_WORK",
} as const;

/** Scopes, then mailbox identity — check-google-scopes.mjs, as a function. */
async function probeGoogle(refreshToken: string, account: "personal" | "work"): Promise<Probe> {
	const clientId = process.env.GOOGLE_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		return { ok: false, error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not both set, so no refresh token can be exchanged" };
	}
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString(),
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	const token = (await res.json().catch(() => ({}))) as {
		access_token?: string;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (!res.ok || !token.access_token) {
		const rawErr = `token exchange ${res.status}: ${token.error ?? "?"} ${token.error_description ?? ""}`.trim();
		const testingHint =
			token.error === "invalid_grant"
				? " (if this recurs every 7 days, check Google Cloud Console -> APIs & Services -> OAuth consent screen and ensure Publishing status is set to In production rather than Testing, #2052)"
				: "";
		return { ok: false, error: `${rawErr.replaceAll(refreshToken, "[REDACTED]")}${testingHint}` };
	}

	const granted = (token.scope ?? "").split(" ").filter(Boolean);
	const absent = GOOGLE_MINT_SCOPES.filter((s) => !granted.includes(s));
	if (absent.length > 0) {
		return { ok: false, error: `scopes missing: ${absent.join(", ")} (Drive working while Gmail 403s is this signature)` };
	}

	const profile = await get("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
		Authorization: `Bearer ${token.access_token}`,
	});
	const me = (await profile.json().catch(() => ({}))) as { emailAddress?: string };
	if (!profile.ok || !me.emailAddress) {
		return { ok: false, error: `scopes ok, but the mailbox identity could not be read (${profile.status})` };
	}

	const expected = process.env[GOOGLE_EMAIL_ENV[account]];
	if (expected && expected.toLowerCase() !== me.emailAddress.toLowerCase()) {
		return {
			ok: false,
			error: `valid and correctly scoped, but opens ${me.emailAddress}, not the expected ${expected}: a token for another account is in this slot`,
		};
	}
	return {
		ok: true,
		identity: `mailbox ${me.emailAddress}${expected ? " (matches pin)" : ` (not pinned; set ${GOOGLE_EMAIL_ENV[account]} to enforce)`}`,
		key: me.emailAddress.toLowerCase(),
	};
}

async function probeMicrosoft(refreshToken: string): Promise<Probe> {
	const clientId = process.env.MICROSOFT_CLIENT_ID;
	const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
	if (!clientId) {
		return {
			ok: false,
			error:
				"MICROSOFT_CLIENT_ID is not set, so no Microsoft refresh token can be exchanged",
		};
	}

	const params = new URLSearchParams({
		client_id: clientId,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
		scope: "Files.ReadWrite offline_access User.Read",
	});
	if (clientSecret) {
		params.set("client_secret", clientSecret);
	}

	const res = await fetch(
		"https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		},
	);
	const token = (await res.json().catch(() => ({}))) as {
		access_token?: string;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (!res.ok || !token.access_token) {
		const rawErr =
			`token exchange ${res.status}: ${token.error ?? "?"} ${token.error_description ?? ""}`.trim();
		return {
			ok: false,
			error: rawErr.replaceAll(refreshToken, "[REDACTED]"),
		};
	}

	const granted = (token.scope ?? "").split(" ").filter(Boolean);
	const hasFilesReadWrite =
		granted.includes("Files.ReadWrite") ||
		granted.includes("Files.ReadWrite.All");
	if (!hasFilesReadWrite) {
		return {
			ok: false,
			error:
				"scopes missing: Files.ReadWrite (re-run microsoft-auth to grant OneDrive access)",
		};
	}

	const driveRes = await get(
		"https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType,owner,quota",
		{
			Authorization: `Bearer ${token.access_token}`,
		},
	);
	const drive = (await driveRes.json().catch(() => ({}))) as {
		id?: string;
		driveType?: string;
		owner?: {
			user?: {
				displayName?: string;
				email?: string;
				id?: string;
			};
		};
		error?: { message?: string };
	};
	if (!driveRes.ok) {
		return {
			ok: false,
			error: `Graph /me/drive ${driveRes.status}: ${drive.error?.message ?? driveRes.statusText}`,
		};
	}

	const user = drive.owner?.user;
	const ownerLabel =
		user?.email ?? user?.displayName ?? user?.id ?? drive.id ?? "unknown";
	const expected = process.env.MICROSOFT_ACCOUNT_EMAIL_PERSONAL;
	if (
		expected &&
		user?.email &&
		expected.toLowerCase() !== user.email.toLowerCase()
	) {
		return {
			ok: false,
			error: `valid and correctly scoped, but opens ${user.email}, not the expected ${expected}: a token for another account is in this slot`,
		};
	}

	const driveType = drive.driveType ?? "personal";
	return {
		ok: true,
		identity: `OneDrive ${ownerLabel} (${driveType})`,
		key: ownerLabel.toLowerCase(),
	};
}

function fixFor(provider: CredentialProvider, envVars: readonly string[]): string {
	if (provider === "google_personal" || provider === "google_work") {
		const account = GOOGLE_ACCOUNT_OF[provider];
		return `re-mint with \`npm --workspace @ahkms/mcp-server run google-auth -- --account ${account}\` signed in as the ${account} Google user, set ${envVars[0]} in the MCP server's Railway variables, redeploy`;
	}
	if (provider === "microsoft_personal") {
		return `re-mint with \`npm --workspace @ahkms/mcp-server run microsoft-auth\` signed in as the personal Microsoft user, set ${envVars[0]} in the MCP server's Railway variables, redeploy`;
	}
	return `set ${envVars[0]} in the MCP server's Railway variables, then redeploy`;
}

const PROBES: Partial<Record<CredentialProvider, (secret: string) => Promise<Probe>>> = {
	notion_work: probeNotion,
	notion_personal: probeNotion,
	github: probeGithub,
	github_issues: probeGithub,
	github_pulls: probeGithub,
	github_work: probeGithub,
	slack: probeSlack,
	slack_bot: probeSlack,
	google_personal: (t) => probeGoogle(t, "personal"),
	google_work: (t) => probeGoogle(t, "work"),
	microsoft_personal: probeMicrosoft,
	gemini: probeGemini,
};

type ProviderResult = { check: DoctorCheck; key?: string };

async function checkProvider(provider: CredentialProvider): Promise<ProviderResult> {
	const { envVars, setUnder } = describeCredential(provider);
	const base = { family: "credentials" as const, name: provider };

	if (!setUnder) {
		const decoy = (DECOYS[provider] ?? []).find((name) => Boolean(process.env[name]));
		const decoyNote = decoy ? ` ${decoy} is set, but this provider reads ${envVars.join(" / ")} and never falls back to it.` : "";
		return {
			check: {
				...base,
				status: CORE.has(provider) ? "fail" : "warn",
				detail: `not set (accepted: ${envVars.join(", ")}).${decoyNote}`,
				fix: fixFor(provider, envVars),
			},
		};
	}

	const legacy = setUnder !== envVars[0];
	const where = `set under ${setUnder}${legacy ? " (a legacy name)" : ""}`;
	const secret = process.env[setUnder] as string;
	const probe = PROBES[provider];

	if (!probe) {
		return {
			check: {
				...base,
				status: legacy ? "warn" : "ok",
				detail: `${where}; presence only, no read-only probe exists for this provider.`,
				fix: legacy ? `rename ${setUnder} to ${envVars[0]}` : "",
			},
		};
	}

	let result: Probe;
	try {
		result = await probe(secret);
	} catch (err) {
		result = { ok: false, error: `probe did not complete: ${errText(err)}` };
	}

	if (!result.ok) {
		return { check: { ...base, status: "fail", detail: `${where}; ${result.error}`, fix: fixFor(provider, envVars) } };
	}
	const status: DoctorStatus = legacy ? "warn" : "ok";
	return {
		check: {
			...base,
			status,
			detail: `${where}; authenticates as ${result.identity}.`,
			fix: legacy ? `rename ${setUnder} to ${envVars[0]} (the working value is fine; the name is not)` : "",
		},
		key: result.key,
	};
}

/** Two slots that must be two different accounts. Enforced without any pin. */
function distinctPair(name: string, a: ProviderResult, b: ProviderResult, fix: string): DoctorCheck | null {
	if (!a.key || !b.key) return null;
	const same = a.key === b.key;
	return {
		family: "credentials",
		name,
		status: same ? "fail" : "ok",
		detail: same
			? `${a.check.name} and ${b.check.name} authenticate as the same account (${a.key}): one slot holds the other's token`
			: `${a.check.name} and ${b.check.name} are different accounts.`,
		fix,
	};
}

async function checkDex(): Promise<DoctorCheck> {
	const base = { family: "credentials" as const, name: "dex" };
	const key = process.env.DEX_API_KEY;
	if (!key) {
		return { ...base, status: "warn", detail: "DEX_API_KEY is not set; only the dex_* tools are affected.", fix: "set DEX_API_KEY (a Dex Professional API key) in the MCP server's Railway variables, then redeploy" };
	}
	let result: Probe;
	try {
		result = await probeDex(key);
	} catch (err) {
		result = { ok: false, error: `probe did not complete: ${errText(err)}` };
	}
	return result.ok
		? { ...base, status: "ok", detail: `set under DEX_API_KEY; ${result.identity}.`, fix: "" }
		: { ...base, status: "fail", detail: `set under DEX_API_KEY; ${result.error}`, fix: "replace DEX_API_KEY with a current key from Dex → Settings → API, then redeploy" };
}

async function checkOpenai(): Promise<DoctorCheck> {
	const base = { family: "credentials" as const, name: "openai" };
	const key = process.env.OPENAI_API_KEY;
	if (!key) {
		return {
			...base,
			status: "warn",
			detail: "OPENAI_API_KEY is not set; affects embeddings; search degrades to full-text only.",
			fix: "set OPENAI_API_KEY in the MCP server's Railway variables if you use embeddings; search degrades to full-text only",
		};
	}
	let result: Probe;
	try {
		result = await probeOpenai(key);
	} catch (err) {
		result = { ok: false, error: `probe did not complete: ${errText(err)}` };
	}
	return result.ok
		? { ...base, status: "ok", detail: `set under OPENAI_API_KEY; authenticates as ${result.identity}.`, fix: "" }
		: {
				...base,
				status: "fail",
				detail: `set under OPENAI_API_KEY; ${result.error}`,
				fix: "replace OPENAI_API_KEY with a valid key from https://platform.openai.com/api-keys in the MCP server's Railway variables, then redeploy",
			};
}

/** Env-only keys read directly by their client modules (not yet on the credential seam). */
const PRESENCE_ONLY: { name: string; envVar: string; affects: string }[] = [
	{ name: "brevo", envVar: "BREVO_MCP_API_KEY", affects: "the brevo_* tools" },
	{ name: "anthropic", envVar: "ANTHROPIC_API_KEY", affects: "artifact_extract_text" },
];

function checkPresenceOnly(): DoctorCheck[] {
	return PRESENCE_ONLY.map(({ name, envVar, affects }) =>
		process.env[envVar]
			? { family: "credentials", name, status: "ok", detail: `set under ${envVar}; presence only.`, fix: "" }
			: { family: "credentials", name, status: "warn", detail: `${envVar} is not set; affects ${affects}.`, fix: `set ${envVar} in the MCP server's Railway variables if you use ${affects}` },
	);
}

/** Connection families (ADR-060): whichever connections exist in env, by prefix. */
function checkConnections(): DoctorCheck[] {
	const out: DoctorCheck[] = [];
	for (const [family, prefix] of Object.entries(connectionFamilyPrefixes())) {
		for (const name of Object.keys(process.env).sort()) {
			if (!name.startsWith(`${prefix}_`) || name.endsWith("_WRITE") || !process.env[name]) continue;
			const slug = name.slice(prefix.length + 1).toLowerCase();
			out.push({ family: "credentials", name: `${family}:${slug}`, status: "ok", detail: `set under ${name}; presence only.`, fix: "" });
		}
	}
	return out;
}

export async function checkCredentials(): Promise<DoctorCheck[]> {
	const [results, dex, openai] = await Promise.all([
		Promise.all(CREDENTIAL_PROVIDERS.map(checkProvider)),
		checkDex(),
		checkOpenai(),
	]);
	const by = new Map(results.map((r) => [r.check.name, r]));
	const pairs = [
		distinctPair(
			"notion workspaces are distinct",
			by.get("notion_work") as ProviderResult,
			by.get("notion_personal") as ProviderResult,
			"NOTION_WORK_ACCESS_TOKEN must be the Work integration's token and NOTION_PERSONAL_ACCESS_TOKEN the personal one; replace whichever is in the wrong slot, then redeploy",
		),
		distinctPair(
			"google accounts are distinct",
			by.get("google_personal") as ProviderResult,
			by.get("google_work") as ProviderResult,
			"re-mint the wrong slot with `npm --workspace @ahkms/mcp-server run google-auth -- --account <personal|work>` signed in as that account, and set GOOGLE_ACCOUNT_EMAIL_PERSONAL / _WORK so this is caught by pin next time",
		),
	].filter((c): c is DoctorCheck => c !== null);

	return [...results.map((r) => r.check), ...pairs, dex, openai, ...checkPresenceOnly(), ...checkConnections()];
}
