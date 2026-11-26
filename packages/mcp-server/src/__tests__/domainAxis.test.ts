import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// #1062. The identity axis used to have four parameter names and three value
// vocabularies for one question: `domain: work|angus`, `workspace:
// notion_work|notion_personal`, `account: personal|work`, `scope:
// personal|work`. A caller who had learned one tool had learned nothing about
// its neighbour, and the wrong answer is not an error — it is a correct-looking
// result from the wrong mailbox, workspace or calendar (#1002, #820).
//
// Same stub posture as gmail.test.ts: mock only the token mint, and keep the real
// credential resolution inside it, so an account assertion still fails when the
// account genuinely cannot be resolved.
vi.mock("../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/oauth.js")>();
	const { getCredential } = await import("../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import("../google/accounts.js");
	return {
		...actual,
		getGoogleAccessToken: vi.fn(async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
			await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
			return "fake_access_token";
		}),
	};
});

import { createServer } from "../server.js";
import { DOMAINS, parseDomain, reconcileDomain } from "../domains.js";
import { TOOL_SUPERSEDED } from "../toolAliases.js";
import { requireGoogleAccount, resolveGoogleAccount } from "../tools/googleAccountInput.js";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const RETIRED = ["account", "workspace", "scope"] as const;

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

type Schema = { properties?: Record<string, unknown>; required?: string[] };

describe("the domain axis, across the whole surface", () => {
	it("gives `domain` the same values everywhere it appears", async () => {
		// The property that actually prevents drift. Descriptions stay per-tool on
		// purpose — 'work' (Meetings) or 'angus' (Meeting Notes) tells a caller
		// something a shared sentence cannot — but the VOCABULARY may not vary, or
		// the axis is four axes again under one name.
		const tools = await listTools();
		const wrong: string[] = [];
		let seen = 0;
		for (const t of tools) {
			const prop = (t.inputSchema as Schema).properties?.domain as
				| { enum?: string[] }
				| undefined;
			if (!prop) continue;
			seen++;
			const values = [...(prop.enum ?? [])].sort();
			if (JSON.stringify(values) !== JSON.stringify([...DOMAINS].sort())) {
				wrong.push(`${t.name}: ${JSON.stringify(prop.enum)}`);
			}
		}
		expect(seen, "no tool declares `domain` — the surface test is vacuous").toBeGreaterThan(30);
		expect(wrong).toEqual([]);
	});

	it("never requires a retired parameter name", async () => {
		// The migration window's whole promise: a caller that has moved to `domain`
		// is never forced back to `account` / `workspace` / `scope` by the schema.
		const tools = await listTools();
		const forced = tools.flatMap((t) => {
			if (t.name in TOOL_SUPERSEDED) return [];
			const required = (t.inputSchema as Schema).required ?? [];
			return RETIRED.filter((name) => required.includes(name)).map((name) => `${t.name}.${name}`);
		});

		expect(forced).toEqual([]);
	});

	it("offers `domain` on every tool that still accepts a retired name", async () => {
		// The other half: no tool may be reachable ONLY by the old vocabulary, or the
		// old name cannot be removed and the window never closes.
		const tools = await listTools();
		const stranded = tools
			.filter((t) => {
				// A tool that is itself going away does not get a new parameter. #1061
				// marked get_notion_tasks_schema superseded by notion_database_get, which
				// takes `domain` and different arguments besides — giving the old one a
				// `domain` it will never honour would advertise a migration path that is
				// not the one a caller has to take.
				if (t.name in TOOL_SUPERSEDED) return false;
				const props = (t.inputSchema as Schema).properties ?? {};
				return RETIRED.some((name) => name in props) && !("domain" in props);
			})
			.map((t) => t.name);

		expect(stranded).toEqual([]);
	});
});

describe("the retired vocabularies map onto domains", () => {
	it("maps all three retired names", () => {
		expect(parseDomain("personal")).toBe("angus"); // account, scope
		expect(parseDomain("work")).toBe("work");
		expect(parseDomain("notion_personal")).toBe("angus"); // workspace
		expect(parseDomain("notion_work")).toBe("work");
	});

	it("treats the old and new spellings as the same call", () => {
		expect(resolveGoogleAccount({ account: "personal" })).toBe(
			resolveGoogleAccount({ domain: "angus" }),
		);
		expect(resolveGoogleAccount({ account: "work" })).toBe(
			resolveGoogleAccount({ domain: "work" }),
		);
	});

	it("returns undefined when the caller names neither", () => {
		// Not a default. `undefined` is how each tool's own pre-existing behaviour
		// survives — personal for Drive, BOTH calendars for calendar_list_events,
		// domain-agnostic for a binding. Substituting a domain here would silently
		// change three different things.
		expect(resolveGoogleAccount({})).toBeUndefined();
		expect(reconcileDomain(undefined, undefined, "account")).toBeUndefined();
	});

	it("REFUSES a call that names two different domains", () => {
		// Neither tie-break is safe. Preferring `domain` redirects a call that says
		// work; preferring the old name makes `domain` decorative. On a send tool
		// either one puts mail in an inbox from the wrong person.
		for (const legacy of RETIRED) {
			expect(() => reconcileDomain("angus", "work", legacy)).toThrow(/different domains/);
			expect(() => reconcileDomain("work", "personal", legacy)).toThrow(/different domains/);
		}
		expect(() => resolveGoogleAccount({ account: "work", domain: "angus" })).toThrow(
			/different domains/,
		);
	});

	it("accepts a call that names the same domain twice", () => {
		expect(resolveGoogleAccount({ account: "personal", domain: "angus" })).toBe("personal");
		expect(reconcileDomain("work", "notion_work", "workspace")).toBe("work");
	});

	it("still refuses to send with no identity at all", () => {
		// #1006: the send tools take no default. Making the zod field optional (so a
		// `domain`-only caller is not rejected before the handler sees it) moved that
		// rule here rather than removing it — this is the test that it moved.
		expect(() => requireGoogleAccount({})).toThrow(/required to send/);
		expect(requireGoogleAccount({ domain: "work" })).toBe("work");
		expect(requireGoogleAccount({ account: "personal" })).toBe("personal");
	});
});

describe("gmail_search through both spellings", () => {
	const origClientId = process.env.GOOGLE_CLIENT_ID;
	const origClientSecret = process.env.GOOGLE_CLIENT_SECRET;
	const origRefresh = process.env.GOOGLE_REFRESH_TOKEN;
	const origWork = process.env.GOOGLE_REFRESH_TOKEN_WORK;

	beforeEach(() => {
		process.env.GOOGLE_CLIENT_ID = "fake_client_id";
		process.env.GOOGLE_CLIENT_SECRET = "fake_client_secret";
		process.env.GOOGLE_REFRESH_TOKEN = "fake_refresh_token";
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work_refresh_token";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ access_token: "fake_access_token" }), { status: 200 })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (origClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
		else process.env.GOOGLE_CLIENT_ID = origClientId;
		if (origClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
		else process.env.GOOGLE_CLIENT_SECRET = origClientSecret;
		if (origRefresh === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
		else process.env.GOOGLE_REFRESH_TOKEN = origRefresh;
		if (origWork === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_WORK;
		else process.env.GOOGLE_REFRESH_TOKEN_WORK = origWork;
	});

	it("returns the same answer for account:personal and domain:angus", async () => {
		// End to end rather than through the resolver: gmail_search names the mailbox
		// it searched in its own output, so identical text is the mailbox agreeing.
		const gmailSearch = toMcpTool(serverRegistry().get("gmail_search")!).handler;
		const viaAccount = await gmailSearch({ query: "from:nobody", account: "personal" });
		const viaDomain = await gmailSearch({ query: "from:nobody", domain: "angus" });

		expect(viaAccount.content[0].text).toContain("'personal'");
		expect(viaDomain.content[0].text).toEqual(viaAccount.content[0].text);
	});

	it("returns the same answer for account:work and domain:work", async () => {
		const gmailSearch = toMcpTool(serverRegistry().get("gmail_search")!).handler;
		const viaAccount = await gmailSearch({ query: "from:nobody", account: "work" });
		const viaDomain = await gmailSearch({ query: "from:nobody", domain: "work" });

		expect(viaAccount.content[0].text).toContain("'work'");
		expect(viaDomain.content[0].text).toEqual(viaAccount.content[0].text);
	});
});
