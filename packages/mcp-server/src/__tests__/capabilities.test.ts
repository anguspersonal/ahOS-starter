import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.SUPABASE_URL = "http://localhost:54321";
	process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
	process.env.KMS_USER_ID = "00000000-0000-0000-0000-000000000000";
});

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { supabase } from "../supabase.js";
import { createServer } from "../server.js";
import {
	levenshtein,
	normalizeCapabilityLookup,
	type CapabilityGetInput,
	type CapabilityRegisterInput,
	type CapabilityResolveInput,
} from "@ahkms/core/actions";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { hashBody } from "../skill-sync/hash.js";

const getCapabilitiesHandler = (args: CapabilityGetInput) =>
	toMcpTool(serverRegistry().get("capability_get")!).handler(args as Record<string, unknown>);
const registerCapabilityHandler = (args: CapabilityRegisterInput) =>
	toMcpTool(serverRegistry().get("capability_register")!).handler(args as Record<string, unknown>);
const resolveCapabilityHandler = (args: CapabilityResolveInput) =>
	toMcpTool(serverRegistry().get("capability_resolve")!).handler(args as Record<string, unknown>);

// capability_get freshness header (ADR-031, amendment 2026-09-05 & 2026-09-25 #344).
// The header carries kind, runtime surface, clients, scope, storage, body_sha256,
// body_synced_at, and updated_at.

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

type Row = Record<string, unknown>;

function stubTables(tables: Record<string, Row[]>) {
	function builder(table: string) {
		const preds: Array<(r: Row) => boolean> = [];
		let pendingUpdate: Row | null = null;
		const b: any = {
			select: () => b,
			eq: (col: string, v: unknown) => {
				preds.push((r) => r[col] === v);
				return b;
			},
			order: () => b,
			update: (values: Row) => {
				pendingUpdate = values;
				return b;
			},
			insert: (rows: Row[]) => {
				if (!tables[table]) tables[table] = [];
				tables[table].push(...rows);
				return Promise.resolve({ error: null });
			},
			then: (res: any, rej: any) => {
				if (pendingUpdate) {
					const matching = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
					for (const r of matching) {
						Object.assign(r, pendingUpdate);
					}
					return Promise.resolve({ error: null, data: matching }).then(res, rej);
				}
				return Promise.resolve({
					data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))),
					error: null,
				}).then(res, rej);
			},
		};
		return b;
	}
	(supabase as any).from = vi.fn((table: string) => builder(table));
}

const USER = "00000000-0000-0000-0000-000000000000"; // vitest.config env (KMS_USER_ID)
const BODY = "---\r\nname: dos\r\n---\r\nbody line\r\n";
const BODY_SHA256 = "6753d81c7de32bd384254240624caa4c97f63da0f3b1b4bb0951f18fbe18cabe";

const dos = (extra: Row = {}): Row => ({
	id: "cap-dos",
	user_id: USER,
	entity_type: "capability",
	title: "dos",
	description: null,
	properties: {
		kind: "skill",
		surface: ["claude-code", "cowork", "chat"],
		storage_location: "kms-db",
		storage_url: null,
		body: BODY,
		body_synced_at: "2026-09-04T21:29:35.713Z",
	},
	updated_at: "2026-09-04T21:29:36.000Z",
	archived: false,
	...extra,
});

const HEADER = [
	"dos (skill)",
	"  surface: claude-code, cowork, chat",
	"  storage: kms-db (hosted)",
	`  body_sha256: ${BODY_SHA256}`,
	"  body_synced_at: 2026-09-04T21:29:35.713Z",
	"  updated_at: 2026-09-04T21:29:36.000Z",
];

async function run(args: Parameters<typeof getCapabilitiesHandler>[0]): Promise<string> {
	return (await getCapabilitiesHandler(args)).content[0].text;
}

describe("capability_get freshness header", () => {
	it("prints the header lines in order, with body_sha256 the canonical hash, then the body", async () => {
		stubTables({ entities: [dos()] });
		const out = await run({ name: "dos" });
		expect(out).toBe([...HEADER, "", BODY].join("\n"));
		expect(hashBody(BODY)).toBe(BODY_SHA256);
		expect(hashBody(BODY.replace(/\r\n/g, "\n"))).toBe(BODY_SHA256);
	});

	it("include_body: false omits the body and the blank line, keeping body_sha256 and body_synced_at", async () => {
		stubTables({ entities: [dos()] });
		const out = await run({ name: "dos", include_body: false });
		expect(out).toBe(HEADER.join("\n"));
		expect(out).not.toContain("body line");
		expect(out.endsWith("\n")).toBe(false);
	});

	it("a row with no body prints body: (none) and no body_sha256 line", async () => {
		stubTables({
			entities: [
				dos({
					properties: {
						kind: "skill",
						surface: ["chat"],
						storage_location: "claude",
						storage_url: "https://claude.ai/skills/dos",
						body: null,
						body_synced_at: null,
					},
				}),
			],
		});
		const out = await run({ name: "dos" });
		expect(out).toBe(
			[
				"dos (skill)",
				"  surface: chat",
				"  storage: claude (indexed) -> https://claude.ai/skills/dos",
				"  body: (none)",
				"  updated_at: 2026-09-04T21:29:36.000Z",
				"",
				"(no body stored)",
			].join("\n"),
		);
		expect(out).not.toContain("body_sha256");
	});

	it("the list view is unchanged: a count line then one bullet per capability", async () => {
		stubTables({
			entities: [
				dos(),
				dos({ id: "cap-other", user_id: "11111111-1111-1111-1111-111111111111" }),
				dos({ id: "person-dos", entity_type: "person" }),
			],
		});
		const out = await run({});
		expect(out).toBe("Capabilities (1):\n• dos [skill] surface=claude-code+cowork+chat home=kms-db");
		expect(out).not.toContain("body_sha256");
	});

	it("prepends snapshot preamble for kms-repo capability while keeping body_sha256 untouched (#810)", async () => {
		stubTables({
			entities: [
				dos({
					properties: {
						kind: "skill",
						surface: ["claude-code"],
						storage_location: "kms-repo",
						storage_url: "docs/skills/dos/SKILL.md",
						body: BODY,
						body_synced_at: "2026-09-04T21:29:35.713Z",
					},
				}),
			],
		});
		const out = await run({ name: "dos" });
		// body_sha256 is the hash of the stored raw BODY, not the served body
		expect(out).toContain(`body_sha256: ${BODY_SHA256}`);
		expect(out).toContain("> ⚠ SNAPSHOT. Canonical home: `kms-repo` at `docs/skills/dos/SKILL.md`.");
		expect(out).toContain("This copy is served for execution only; editing it changes nothing");
	});
});

describe("ADR-031 schema refinements (#344)", () => {
	it("renders twin capabilities with kind array, runtime surface, clients and scope", async () => {
		const twin: Row = {
			id: "cap-architect",
			user_id: USER,
			entity_type: "capability",
			title: "architect-senior-engineer",
			description: "Senior engineering architect",
			properties: {
				kind: ["skill", "agent"],
				surface: ["claude-code", "claude-synced"],
				clients: ["chat", "cowork"],
				scope: "global",
				storage_location: "kms-db",
				storage_url: null,
				body: "---\nname: architect\n---\nRules\n",
				body_synced_at: "2026-09-25T12:00:00.000Z",
			},
			updated_at: "2026-09-25T12:00:00.000Z",
			archived: false,
		};
		stubTables({ entities: [twin] });

		const out = await run({ name: "architect-senior-engineer" });
		expect(out).toContain("architect-senior-engineer (skill+agent)");
		expect(out).toContain("  Senior engineering architect");
		expect(out).toContain("  surface: claude-code, claude-synced");
		expect(out).toContain("  clients: chat, cowork");
		expect(out).toContain("  scope: global");
		expect(out).toContain("  storage: kms-db (hosted)");
		expect(out).toContain("Rules");

		// List view includes kind combination and scope
		const list = await run({});
		expect(list).toContain(
			"• architect-senior-engineer [skill+agent] surface=claude-code+claude-synced scope=global home=kms-db",
		);
	});

	it("falls back to reading legacy scope tag if properties.scope is unset", async () => {
		const cap: Row = {
			id: "cap-legacy-scope",
			user_id: USER,
			entity_type: "capability",
			title: "legacy-scoped",
			description: null,
			tags: ["scope:work", "domain:work"],
			properties: {
				kind: "command",
				surface: ["api"],
				storage_location: "kms-db",
				storage_url: null,
				body: "cmd body",
				body_synced_at: "2026-09-25T12:00:00.000Z",
			},
			updated_at: "2026-09-25T12:00:00.000Z",
			archived: false,
		};
		stubTables({ entities: [cap] });

		const out = await run({ name: "legacy-scoped" });
		expect(out).toContain("  scope: work");

		const filtered = await run({ scope: "work" });
		expect(filtered).toContain("legacy-scoped");

		const excluded = await run({ scope: "personal" });
		expect(excluded).toBe("No capabilities found.");
	});

	it("filters by kind (matches twins), surface, client, and scope", async () => {
		const cap1: Row = {
			id: "c1",
			user_id: USER,
			entity_type: "capability",
			title: "twin-tool",
			properties: {
				kind: ["skill", "agent"],
				surface: ["claude-code"],
				clients: ["terminal"],
				scope: "personal",
				storage_location: "kms-db",
				body: "b1",
			},
			archived: false,
		};
		const cap2: Row = {
			id: "c2",
			user_id: USER,
			entity_type: "capability",
			title: "agent-tool",
			properties: {
				kind: ["agent"],
				surface: ["claude-synced"],
				clients: ["chat"],
				scope: "work",
				storage_location: "kms-db",
				body: "b2",
			},
			archived: false,
		};
		stubTables({ entities: [cap1, cap2] });

		// Kind filter: skill matches twin-tool only; agent matches both
		expect(await run({ kind: "skill" })).toContain("twin-tool");
		expect(await run({ kind: "skill" })).not.toContain("agent-tool");

		const agentFilter = await run({ kind: "agent" });
		expect(agentFilter).toContain("twin-tool");
		expect(agentFilter).toContain("agent-tool");

		// Surface filter
		expect(await run({ surface: "claude-code" })).toContain("twin-tool");
		expect(await run({ surface: "claude-code" })).not.toContain("agent-tool");

		// Client filter
		expect(await run({ client: "chat" })).toContain("agent-tool");
		expect(await run({ client: "chat" })).not.toContain("twin-tool");

		// Scope filter
		expect(await run({ scope: "personal" })).toContain("twin-tool");
		expect(await run({ scope: "personal" })).not.toContain("agent-tool");
	});

	it("registerCapabilityHandler creates a new capability with array kind, clients, and scope", async () => {
		const tables: Record<string, Row[]> = { entities: [] };
		stubTables(tables);

		const res = await registerCapabilityHandler({
			name: "my-twin",
			description: "Twin test capability",
			kind: ["skill", "agent"],
			surface: ["claude-code", "claude-synced"],
			clients: ["chat", "cowork"],
			scope: "global",
			storage_location: "kms-db",
			body: "Authoritative body",
		});

		expect(res.content[0].text).toContain("Registered capability [");
		expect(res.content[0].text).toContain("my-twin (skill+agent, kms-db)");

		expect(tables.entities).toHaveLength(1);
		const row = tables.entities[0];
		expect(row.title).toBe("my-twin");
		expect((row.properties as any).kind).toEqual(["skill", "agent"]);
		expect((row.properties as any).surface).toEqual(["claude-code", "claude-synced"]);
		expect((row.properties as any).clients).toEqual(["chat", "cowork"]);
		expect((row.properties as any).scope).toBe("global");
		expect((row.properties as any).body).toBe("Authoritative body");
	});

	it("registerCapabilityHandler updates existing capability and cleans legacy tags", async () => {
		const existing: Row = {
			id: "cap-existing",
			user_id: USER,
			entity_type: "capability",
			title: "existing-twin",
			description: "Old desc",
			tags: ["also:skill", "drift:twin-unsourced", "scope:personal", "keep-me"],
			properties: {
				kind: "agent",
				surface: ["cowork"],
				storage_location: "kms-db",
				body: "Old body",
			},
			archived: false,
		};
		const tables: Record<string, Row[]> = { entities: [existing] };
		stubTables(tables);

		const res = await registerCapabilityHandler({
			name: "existing-twin",
			description: "New desc",
			kind: ["skill", "agent"],
			surface: ["claude-synced"],
			clients: ["cowork"],
			scope: "personal",
			storage_location: "kms-db",
			body: "New body",
		});

		expect(res.content[0].text).toContain("Updated capability [cap-existing]");
		expect(res.content[0].text).toContain("existing-twin (skill+agent, kms-db)");

		expect(existing.tags).toEqual(["keep-me"]);
		expect((existing.properties as any).kind).toEqual(["skill", "agent"]);
		expect((existing.properties as any).surface).toEqual(["claude-synced"]);
		expect((existing.properties as any).clients).toEqual(["cowork"]);
		expect((existing.properties as any).scope).toBe("personal");
		expect((existing.properties as any).body).toBe("New body");
	});

	// round-1 QA (#1170): `domain` (#1062 compatibility) was completely untested, and
	// the fix for the domain/scope silent-precedence finding must not regress the
	// `scope` values (`global`, `ahLtd`) that have no `domain` equivalent.
	describe("`domain` -> `scope` compatibility (#1062)", () => {
		it("registerCapabilityHandler maps domain alone to scope ('angus' -> 'personal', 'work' -> 'work')", async () => {
			const tables: Record<string, Row[]> = { entities: [] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "domain-angus",
				kind: "skill",
				surface: ["claude-code"],
				domain: "angus",
				storage_location: "kms-db",
				body: "b",
			});
			expect((tables.entities[0].properties as any).scope).toBe("personal");

			await registerCapabilityHandler({
				name: "domain-work",
				kind: "skill",
				surface: ["claude-code"],
				domain: "work",
				storage_location: "kms-db",
				body: "b",
			});
			expect((tables.entities[1].properties as any).scope).toBe("work");
		});

		it("registerCapabilityHandler accepts domain and scope together when they agree", async () => {
			const tables: Record<string, Row[]> = { entities: [] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "agree",
				kind: "skill",
				surface: ["claude-code"],
				domain: "angus",
				scope: "personal",
				storage_location: "kms-db",
				body: "b",
			});
			expect((tables.entities[0].properties as any).scope).toBe("personal");
		});

		it("registerCapabilityHandler refuses when domain and scope disagree instead of silently picking one", async () => {
			stubTables({ entities: [] });

			await expect(
				registerCapabilityHandler({
					name: "conflict",
					kind: "skill",
					surface: ["claude-code"],
					domain: "work",
					scope: "personal",
					storage_location: "kms-db",
					body: "b",
				}),
			).rejects.toThrow(/disagree/);
		});

		it("leaves scope values with no domain equivalent ('global', 'ahLtd') untouched when domain is absent", async () => {
			const tables: Record<string, Row[]> = { entities: [] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "global-only",
				kind: "skill",
				surface: ["claude-code"],
				scope: "global",
				storage_location: "kms-db",
				body: "b",
			});
			expect((tables.entities[0].properties as any).scope).toBe("global");

			await registerCapabilityHandler({
				name: "ahltd-only",
				kind: "skill",
				surface: ["claude-code"],
				scope: "ahLtd",
				storage_location: "kms-db",
				body: "b",
			});
			expect((tables.entities[1].properties as any).scope).toBe("ahLtd");
		});

		it("getCapabilitiesHandler filters by domain the same way it filters by scope", async () => {
			const personalCap: Row = {
				id: "c-personal",
				user_id: USER,
				entity_type: "capability",
				title: "personal-tool",
				properties: { kind: "skill", surface: ["claude-code"], scope: "personal", storage_location: "kms-db" },
				archived: false,
			};
			const workCap: Row = {
				id: "c-work",
				user_id: USER,
				entity_type: "capability",
				title: "work-tool",
				properties: { kind: "skill", surface: ["claude-code"], scope: "work", storage_location: "kms-db" },
				archived: false,
			};
			stubTables({ entities: [personalCap, workCap] });

			const angusView = await run({ domain: "angus" });
			expect(angusView).toContain("personal-tool");
			expect(angusView).not.toContain("work-tool");

			const workView = await run({ domain: "work" });
			expect(workView).toContain("work-tool");
			expect(workView).not.toContain("personal-tool");
		});

		it("getCapabilitiesHandler refuses a domain/scope disagreement rather than silently filtering by one", async () => {
			stubTables({ entities: [] });
			await expect(run({ domain: "angus", scope: "work" })).rejects.toThrow(/disagree/);
		});

		it("falls back to global capability when named lookup specifies domain (#1833)", async () => {
			const globalUnset: Row = {
				id: "c-wfa",
				user_id: USER,
				entity_type: "capability",
				title: "writing-for-agents",
				properties: {
					kind: "skill",
					surface: ["claude-code"],
					storage_location: "kms-db",
					body: "global wfa body",
					body_synced_at: "2026-10-15T12:00:00.000Z",
				},
				archived: false,
			};
			const workOnly: Row = {
				id: "c-hl",
				user_id: USER,
				entity_type: "capability",
				title: "work-only",
				properties: {
					kind: "skill",
					surface: ["claude-code"],
					scope: "work",
					storage_location: "kms-db",
					body: "hl body",
				},
				archived: false,
			};
			stubTables({ entities: [globalUnset, workOnly] });

			// Named lookup with domain: "angus" falls back to unscoped/global capability
			const out = await run({ name: "writing-for-agents", domain: "angus" });
			expect(out).toContain("writing-for-agents (skill)");
			expect(out).toContain("global wfa body");

			// Does NOT leak another domain's capability on named lookup
			expect(await run({ name: "work-only", domain: "angus" })).toBe("No capabilities found.");

			// Explicit scope filter without domain does NOT fall back to unscoped
			expect(await run({ name: "writing-for-agents", scope: "personal" })).toBe("No capabilities found.");
		});

		it("prefers domain-scoped capability over global capability on named domain lookup (#1833)", async () => {
			const globalRetro: Row = {
				id: "c-retro-global",
				user_id: USER,
				entity_type: "capability",
				title: "retro",
				properties: {
					kind: "skill",
					surface: ["claude-code"],
					storage_location: "kms-db",
					body: "global retro body",
					body_synced_at: "2026-10-15T12:00:00.000Z",
				},
				archived: false,
			};
			const personalRetro: Row = {
				id: "c-retro-personal",
				user_id: USER,
				entity_type: "capability",
				title: "retro",
				properties: {
					kind: "skill",
					surface: ["claude-code"],
					scope: "personal",
					storage_location: "kms-db",
					body: "personal retro body",
					body_synced_at: "2026-10-15T12:00:00.000Z",
				},
				archived: false,
			};
			stubTables({ entities: [globalRetro, personalRetro] });

			const out = await run({ name: "retro", domain: "angus" });
			expect(out).toContain("  scope: personal");
			expect(out).toContain("personal retro body");
			expect(out).not.toContain("global retro body");
		});
	});

	describe("maps scope personal to domain_override angus (#1758)", () => {
		it("sets domain_override 'angus' on insert when scope: 'personal' is supplied", async () => {
			const tables: Record<string, Row[]> = { entities: [] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "personal-create-scope",
				kind: "skill",
				surface: ["claude-code"],
				scope: "personal",
				storage_location: "kms-db",
				body: "b",
			});

			expect(tables.entities[0].domain_override).toBe("angus");
		});

		it("sets domain_override 'angus' on insert when domain: 'angus' is supplied", async () => {
			const tables: Record<string, Row[]> = { entities: [] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "personal-create-domain",
				kind: "skill",
				surface: ["claude-code"],
				domain: "angus",
				storage_location: "kms-db",
				body: "b",
			});

			expect(tables.entities[0].domain_override).toBe("angus");
		});

		it("sets domain_override 'angus' on update when scope: 'personal' is supplied", async () => {
			const existing: Row = {
				id: "cap-existing-scope",
				user_id: USER,
				entity_type: "capability",
				title: "existing-cap-scope",
				properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
				archived: false,
			};
			const tables: Record<string, Row[]> = { entities: [existing] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "existing-cap-scope",
				kind: "skill",
				surface: ["claude-code"],
				scope: "personal",
				storage_location: "kms-db",
				body: "b",
			});

			expect(existing.domain_override).toBe("angus");
		});

		it("sets domain_override 'angus' on update when domain: 'angus' is supplied", async () => {
			const existing: Row = {
				id: "cap-existing-domain",
				user_id: USER,
				entity_type: "capability",
				title: "existing-cap-domain",
				properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
				archived: false,
			};
			const tables: Record<string, Row[]> = { entities: [existing] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "existing-cap-domain",
				kind: "skill",
				surface: ["claude-code"],
				domain: "angus",
				storage_location: "kms-db",
				body: "b",
			});

			expect(existing.domain_override).toBe("angus");
		});

		it("does not set domain_override on insert when scope is not personal", async () => {
			const tables: Record<string, Row[]> = { entities: [] };
			stubTables(tables);

			await registerCapabilityHandler({
				name: "work-cap",
				kind: "skill",
				surface: ["claude-code"],
				scope: "work",
				storage_location: "kms-db",
				body: "b",
			});

			expect(tables.entities[0].domain_override).toBeUndefined();
		});
	});
});

describe("registration", () => {
	it("serves capability_get over a real client connection with include_body in its schema", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tool = (await client.listTools()).tools.find((t) => t.name === "capability_get");
		expect(tool).toBeDefined();
		const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
		const props = Object.keys(schema.properties ?? {});
		expect(props).toContain("include_body");
		expect(props).toContain("name");
		expect(props).toContain("client");
		expect(props).toContain("scope");
		expect(tool!.description).toContain("body_sha256");

		await client.close();
		await server.close();
	});
});

describe("fuzzy suggestions on name miss (#1747)", () => {
	it("levenshtein calculates expected edit distance", () => {
		expect(levenshtein("retro", "retro")).toBe(0);
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
		expect(levenshtein("rero", "retro")).toBe(1);
		expect(levenshtein("triagee", "triage")).toBe(1);
		expect(levenshtein("kitten", "sitting")).toBe(3);
	});

	it("returns standard 'No capabilities found.' when completely unrelated string is queried", async () => {
		stubTables({ entities: [dos()] });
		const out = await run({ name: "xyz123abc" });
		expect(out).toBe("No capabilities found.");
	});

	it("returns standard 'No capabilities found.' for blank name queries", async () => {
		stubTables({ entities: [dos()] });
		const out = await run({ name: "   " });
		expect(out).toBe("No capabilities found.");
	});

	it("suggests close match for near-miss typo within edit distance <= 2 (rero -> retro)", async () => {
		const retro: Row = {
			id: "cap-retro",
			user_id: USER,
			entity_type: "capability",
			title: "retro",
			description: "Sprint retrospectives",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "retro body",
			},
			archived: false,
		};
		stubTables({ entities: [retro] });

		const out = await run({ name: "rero" });
		expect(out).toBe("No capabilities found matching 'rero'. Did you mean: 'retro'?");
	});

	it("suggests close match for near-miss typo (triagee -> triage)", async () => {
		const triage: Row = {
			id: "cap-triage",
			user_id: USER,
			entity_type: "capability",
			title: "triage",
			description: "Issue triage tool",
			properties: {
				kind: "command",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "triage body",
			},
			archived: false,
		};
		stubTables({ entities: [triage] });

		const out = await run({ name: "triagee" });
		expect(out).toBe("No capabilities found matching 'triagee'. Did you mean: 'triage'?");
	});

	it("suggests multiple close matches sorted by distance and name", async () => {
		const retro: Row = {
			id: "cap-retro",
			user_id: USER,
			entity_type: "capability",
			title: "retro",
			properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
			archived: false,
		};
		const redo: Row = {
			id: "cap-redo",
			user_id: USER,
			entity_type: "capability",
			title: "redo",
			properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
			archived: false,
		};
		stubTables({ entities: [retro, redo] });

		const out = await run({ name: "relo" });
		// 'relo' -> 'redo' (dist 1), 'relo' -> 'retro' (dist 2)
		expect(out).toBe("No capabilities found matching 'relo'. Did you mean: 'redo', 'retro'?");
	});

	it("suggests match when relative distance <= 0.3 on long title with > 2 edits", async () => {
		const longCap: Row = {
			id: "cap-arch",
			user_id: USER,
			entity_type: "capability",
			title: "architect-senior-engineer",
			properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
			archived: false,
		};
		stubTables({ entities: [longCap] });

		// 3 edits on 25-char string = 3/25 = 0.12 <= 0.3
		const out = await run({ name: "architet-senor-enginer" });
		expect(out).toBe("No capabilities found matching 'architet-senor-enginer'. Did you mean: 'architect-senior-engineer'?");
	});

	it("preserves exact match without suggestion when name matches exactly (case-insensitive)", async () => {
		stubTables({ entities: [dos()] });
		const out = await run({ name: "DOS" });
		expect(out).toContain("dos (skill)");
		expect(out).not.toContain("Did you mean");
	});

	it("suggestions respect active filters (archived, kind, surface, scope)", async () => {
		const archivedRetro: Row = {
			id: "cap-retro-archived",
			user_id: USER,
			entity_type: "capability",
			title: "retro",
			properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
			archived: true,
		};
		stubTables({ entities: [archivedRetro] });

		// Default excludes archived -> returns standard "No capabilities found."
		expect(await run({ name: "rero" })).toBe("No capabilities found.");

		// include_archived: true -> finds the suggestion
		expect(await run({ name: "rero", include_archived: true })).toBe(
			"No capabilities found matching 'rero'. Did you mean: 'retro'?",
		);

		// Kind filter exclusion
		const skillOnly: Row = {
			id: "cap-skill",
			user_id: USER,
			entity_type: "capability",
			title: "retro",
			properties: { kind: "skill", surface: ["claude-code"], storage_location: "kms-db" },
			archived: false,
		};
		stubTables({ entities: [skillOnly] });
		expect(await run({ name: "rero", kind: "agent" })).toBe("No capabilities found.");
		expect(await run({ name: "rero", kind: "skill" })).toBe(
			"No capabilities found matching 'rero'. Did you mean: 'retro'?",
		);
	});
});

describe("ADR-112 capability prefix stripping and ritual alias resolution (#1947)", () => {
	it("normalizes ahos/ and ahkms/ prefixes (case-insensitive) and returns canonical-first ritual alias candidates", () => {
		expect(normalizeCapabilityLookup("ahOS/sync")).toEqual({
			stripped: "sync",
			candidates: ["sync", "dos", "synth"],
		});
		expect(normalizeCapabilityLookup("ahkms/SYNTH")).toEqual({
			stripped: "synth",
			candidates: ["sync", "dos", "synth"],
		});
		expect(normalizeCapabilityLookup("  ahos/dos  ")).toEqual({
			stripped: "dos",
			candidates: ["sync", "dos", "synth"],
		});
		expect(normalizeCapabilityLookup("ahOS/reflect")).toEqual({
			stripped: "reflect",
			candidates: ["reflect", "dos-reflect"],
		});
		expect(normalizeCapabilityLookup("dos-reflect")).toEqual({
			stripped: "dos-reflect",
			candidates: ["reflect", "dos-reflect"],
		});
		expect(normalizeCapabilityLookup("ahos/prep")).toEqual({
			stripped: "prep",
			candidates: ["prep", "prep-day-unattended"],
		});
		expect(normalizeCapabilityLookup("prep-day-unattended")).toEqual({
			stripped: "prep-day-unattended",
			candidates: ["prep", "prep-day-unattended"],
		});
		expect(normalizeCapabilityLookup("unblock")).toEqual({
			stripped: "unblock",
			candidates: ["groom-issues", "unblock"],
		});
		expect(normalizeCapabilityLookup("ahOS/unblock")).toEqual({
			stripped: "unblock",
			candidates: ["groom-issues", "unblock"],
		});
		expect(normalizeCapabilityLookup("ahOS/capture")).toEqual({
			stripped: "capture",
			candidates: ["capture"],
		});
	});

	it("resolves ahOS/sync, synth, and ahos/dos to the synthesis capability in getCapabilitiesHandler", async () => {
		stubTables({ entities: [dos()] });
		expect(await run({ name: "ahOS/dos" })).toContain("dos (skill)");
		expect(await run({ name: "ahos/sync" })).toContain("dos (skill)");
		expect(await run({ name: "synth" })).toContain("dos (skill)");
		expect(await run({ name: "ahkms/SYNTH" })).toContain("dos (skill)");
	});

	it("returns the canonical sync capability (not a multi-row summary or stale legacy dos row) when both sync and dos rows exist in entities", async () => {
		const syncRow = dos({
			id: "cap-sync",
			title: "sync",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-repo",
				storage_url: ".claude/skills/sync/SKILL.md",
				body: "---\nname: sync\n---\nsync body\n",
				body_synced_at: "2026-10-25T10:00:00.000Z",
			},
		});
		stubTables({ entities: [dos(), syncRow] });

		const syncOut = await run({ name: "ahOS/sync" });
		expect(syncOut).toContain("sync (skill)");
		expect(syncOut).toContain("sync body");

		const synthOut = await run({ name: "synth" });
		expect(synthOut).toContain("sync (skill)");
		expect(synthOut).toContain("sync body");

		const dosOut = await run({ name: "dos" });
		expect(dosOut).toContain("sync (skill)");
		expect(dosOut).toContain("sync body");
	});

	it("prefers canonical reflect and prep rows over legacy dos-reflect and prep-day-unattended rows when both exist in entities", async () => {
		const legacyReflectRow = dos({
			id: "cap-dos-reflect",
			title: "dos-reflect",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				storage_url: null,
				body: "legacy dos-reflect body",
				body_synced_at: "2026-09-26T10:00:00.000Z",
			},
		});
		const canonicalReflectRow = dos({
			id: "cap-reflect",
			title: "reflect",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-repo",
				storage_url: ".claude/skills/reflect/SKILL.md",
				body: "canonical reflect body",
				body_synced_at: "2026-10-25T10:00:00.000Z",
			},
		});
		const legacyPrepRow = dos({
			id: "cap-prep-day-unattended",
			title: "prep-day-unattended",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				storage_url: null,
				body: "legacy prep-day-unattended body",
				body_synced_at: "2026-10-13T10:00:00.000Z",
			},
		});
		const canonicalPrepRow = dos({
			id: "cap-prep",
			title: "prep",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-repo",
				storage_url: ".claude/skills/prep/SKILL.md",
				body: "canonical prep body",
				body_synced_at: "2026-10-25T10:00:00.000Z",
			},
		});
		const domainEntity: Row = {
			id: "dom-work",
			user_id: USER,
			entity_type: "domain",
			title: "Work",
			properties: { slug: "work" },
			archived: false,
		};
		stubTables({
			entities: [
				domainEntity,
				legacyReflectRow,
				canonicalReflectRow,
				legacyPrepRow,
				canonicalPrepRow,
			],
		});

		const getDosReflect = await run({ name: "dos-reflect" });
		expect(getDosReflect).toContain("reflect (skill)");
		expect(getDosReflect).toContain("canonical reflect body");
		expect(getDosReflect).not.toContain("legacy dos-reflect body");

		const getPrepUnattended = await run({ name: "prep-day-unattended" });
		expect(getPrepUnattended).toContain("prep (skill)");
		expect(getPrepUnattended).toContain("canonical prep body");
		expect(getPrepUnattended).not.toContain("legacy prep-day-unattended body");

		const resolvedReflect = await resolveCapabilityHandler({
			name: "dos-reflect",
			domain: "work",
		});
		expect(resolvedReflect.content[0].text).toContain("canonical reflect body");

		const resolvedPrep = await resolveCapabilityHandler({
			name: "prep-day-unattended",
			domain: "work",
		});
		expect(resolvedPrep.content[0].text).toContain("canonical prep body");
	});

	it("falls back to legacy dos-reflect and prep-day-unattended rows when canonical rows are absent", async () => {
		const reflectRow = dos({
			id: "cap-dos-reflect",
			title: "dos-reflect",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				storage_url: null,
				body: "reflect body",
				body_synced_at: "2026-10-25T10:00:00.000Z",
			},
		});
		const prepRow = dos({
			id: "cap-prep",
			title: "prep-day-unattended",
			properties: {
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				storage_url: null,
				body: "prep body",
				body_synced_at: "2026-10-25T10:00:00.000Z",
			},
		});
		stubTables({ entities: [reflectRow, prepRow] });

		expect(await run({ name: "reflect" })).toContain("reflect body");
		expect(await run({ name: "ahOS/reflect" })).toContain("reflect body");
		expect(await run({ name: "prep" })).toContain("prep body");
		expect(await run({ name: "ahos/prep" })).toContain("prep body");
	});

	it("strips ahos/ prefix and resolves ritual aliases in resolveCapabilityHandler", async () => {
		const domainEntity: Row = {
			id: "dom-work",
			user_id: USER,
			entity_type: "domain",
			title: "Work",
			properties: { slug: "work" },
			archived: false,
		};
		stubTables({ entities: [domainEntity, dos()] });

		const resolved = await resolveCapabilityHandler({
			name: "ahOS/sync",
			domain: "work",
		});
		expect(resolved.content[0].text).toContain("body line");
	});
});


