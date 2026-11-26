import { describe, expect, it, vi } from "vitest";
import { loadDosConfigDetailed } from "@ahkms/core";

import {
	dosConfigSchema,
	domainConfig,
	pillarNotionOption,
	DEFAULT_DOMAIN,
	DEFAULT_DOS_CONFIG,
	DOMAINS as DOMAINS_VIA_CONFIG,
	formatDomainSummaryLine,
	renderDosConfigSections,
	attachDosConfigToToneRules,
	operatingPrinciples,
} from "./dosConfig.js";
import { DOMAINS as DOMAINS_VIA_AXIS } from "./domains.js";

// Unit tests for the two shapes this config can arrive in. No Supabase: these exercise
// the parse/derivation layer only, which is where the whole compatibility story lives.
//
// Two invariants are load-bearing and each has its own describe block:
//
//  1. #618 / #692 — the strings the ritual sends to Notion must be byte-identical
//     across every blob shape. Migrations 086, 088 and 089 each reshape the config;
//     none of them may change what reaches the owner's workspace.
//  2. #679 / #692 — an OLDER blob must still parse to a working config. This code
//     deploys before migrations 088 and 089 are pushed by hand, so the legacy read is
//     what production actually uses in the meantime; if it breaks, every ritual gets
//     an empty config the moment the server deploys.

const legacyPriorities = [
	{ key: "P1", label: "Launch", description: "Ship the app" },
	{ key: "P2", label: "Round", description: "Close the raise" },
];

// What migration 086 turns the above into, and what production stores until 089 is
// pushed: the projection is there, under the pre-089 key.
const pre089Pillars = [
	{ key: "Pillar 1", label: "Launch", description: "Ship the app", notion_property: "P1 Launch" },
	{ key: "Pillar 2", label: "Round", description: "Close the raise", notion_property: "P2 Round" },
];

// The same pillars as every consumer sees them: one key, `notion_option`, whichever
// shape they were stored in. Doubles as a post-089 input fixture, since parsing it is
// the identity.
const pillarsAsRead = [
	{ key: "Pillar 1", label: "Launch", description: "Ship the app", notion_option: "P1 Launch" },
	{ key: "Pillar 2", label: "Round", description: "Close the raise", notion_option: "P2 Round" },
];

// The production blob as it stands on `dev`: seeded by migration 050, extended by 055,
// renamed by 086, and appended to by 087 — flat, and Work-shaped throughout.
const legacyFlatBlob = {
	workspace: {
		work_entities: ["Work", "Briana", "the round"],
		personal_signals: ["private health", "family", "friends", "side projects"],
	},
	pillars: pre089Pillars,
	domains: ["Apple", "Round", "Personal", "Other"],
	artefact_registers: [{ key: "Bri", tone: "co-founder, signal not status" }],
	types: [{ key: "Note", description: "Passive observation" }],
	tone: ["Plain British English, no jargon"],
	state_doc_rules: { max_words: 2000, open_actions_cap: 10, communications_cap: 10 },
	daily_log_schema: {
		properties: [
			{ name: "Name", notion_type: "title", required: true, notes: "DD Month" },
			{ name: "Synthesis Status", notion_type: "select", required: true },
		],
		body_sections: ["What I did", "Reflection"],
	},
};

const workBlock = (blob: unknown) => domainConfig(dosConfigSchema.parse(blob), "work");
const workPillars = (blob: unknown) => workBlock(blob)?.pillars ?? [];

describe("legacy flat blob (pre-088) still parses to a working `work` config (#679)", () => {
	it("maps every flat key onto the work domain block", () => {
		const block = workBlock(legacyFlatBlob);

		expect(block).toEqual({
			// `domains` was the TOPIC list all along — ADR-054 §2's rename.
			topics: ["Apple", "Round", "Personal", "Other"],
			pillars: pillarsAsRead,
			// `workspace.work_entities` repurposed as the routing classifier.
			domain_signals: ["Work", "Briana", "the round"],
			artefact_registers: [{ key: "Bri", tone: "co-founder, signal not status" }],
			state_doc_rules: { max_words: 2000, open_actions_cap: 10, communications_cap: 10 },
			daily_log_schema: legacyFlatBlob.daily_log_schema,
		});
	});

	it("keeps the global keys global", () => {
		const parsed = dosConfigSchema.parse(legacyFlatBlob);

		expect(parsed.types).toEqual(legacyFlatBlob.types);
		expect(parsed.tone).toEqual(legacyFlatBlob.tone);
	});

	it("carries migration 087's `Synthesis Status` through into the work block", () => {
		// 087 appends to the FLAT daily_log_schema. Whichever order the owner pushes
		// 087 and 088 in, the property must end up readable under `work` — this is
		// the read half of that guarantee.
		expect(workBlock(legacyFlatBlob)?.daily_log_schema.properties).toContainEqual({
			name: "Synthesis Status",
			notion_type: "select",
			required: true,
		});
	});

	it("reports the blob as it is stored, without applying §2's `Personal` removal itself", () => {
		// Dropping the value is migration 088's job. A reader that also edited would be
		// a second source of truth about what the blob contains.
		expect(workBlock(legacyFlatBlob)?.topics).toContain("Personal");
	});

	it("carries `personal_signals` to `angus` — routing needs both halves", () => {
		const block = domainConfig(dosConfigSchema.parse(legacyFlatBlob), "angus");

		expect(block?.domain_signals).toEqual([
			"private health",
			"family",
			"friends",
			"side projects",
		]);
	});

	it("invents nothing else for `angus`: no pillars, no schema, no topics", () => {
		const block = domainConfig(dosConfigSchema.parse(legacyFlatBlob), "angus");

		// A pillar list or property name conjured at the read boundary would be a guess
		// written into the owner's real Notion workspace. Only migration 088 supplies
		// these, and until it runs they are legitimately absent.
		expect(block?.pillars).toEqual([]);
		expect(block?.topics).toEqual([]);
		expect(block?.artefact_registers).toEqual([]);
		expect(block?.daily_log_schema).toEqual({ properties: [], body_sections: [] });
	});

	it("omits `angus` entirely when the legacy blob has no personal signals", () => {
		const parsed = dosConfigSchema.parse({ ...legacyFlatBlob, workspace: { work_entities: [] } });

		// Absent, not present-and-empty: there is nothing to say about that domain.
		expect(Object.keys(parsed.by_domain)).toEqual(["work"]);
		expect(domainConfig(parsed, "angus")).toBeNull();
	});

	it("falls back for a blob whose only per-domain content is the legacy `priorities` key", () => {
		expect(workPillars({ priorities: legacyPriorities })).toEqual(
			legacyPriorities.map((p) => ({ ...p, notion_option: `${p.key} ${p.label}` })),
		);
	});
});

// #708: the routing axis used to be declared in full in BOTH this module and
// `domains.ts`. Nothing typechecked red, because two identical `as const` tuples are
// structurally assignable in either direction — which is exactly why the drift would
// have been silent. Add a third domain to one file and not the other and you get a
// tool whose input enum accepts a value the resolver cannot map, or the reverse.
//
// Identity, not equality. Two separately-declared arrays with the same members pass
// `toEqual` and would let the duplicate quietly come back; only a shared reference
// proves there is one declaration.
describe("the routing axis has exactly one declaration (#708)", () => {
	it("re-exports the same array instance the axis module declares", () => {
		expect(DOMAINS_VIA_CONFIG).toBe(DOMAINS_VIA_AXIS);
	});

	it("still exposes the members callers depend on", () => {
		expect([...DOMAINS_VIA_CONFIG]).toEqual(["work", "angus"]);
		expect(DOMAINS_VIA_CONFIG).toContain(DEFAULT_DOMAIN);
	});
});

describe("`by_domain` shape (post-088)", () => {
	const byDomainBlob = {
		by_domain: {
			work: { topics: ["Round"], pillars: pillarsAsRead },
			angus: { topics: ["Health"], domain_signals: ["family"] },
		},
		types: [{ key: "Note", description: "Passive observation" }],
		tone: ["Plain British English, no jargon"],
	};

	it("fills per-domain defaults for keys a block omits", () => {
		expect(domainConfig(dosConfigSchema.parse(byDomainBlob), "angus")).toEqual({
			topics: ["Health"],
			pillars: [],
			domain_signals: ["family"],
			artefact_registers: [],
			state_doc_rules: { max_words: 2000, open_actions_cap: 10, communications_cap: 10 },
			daily_log_schema: { properties: [], body_sections: [] },
		});
	});

	it("wins over the flat keys when a blob carries both", () => {
		const parsed = dosConfigSchema.parse({ ...legacyFlatBlob, ...byDomainBlob });

		expect(domainConfig(parsed, "work")?.topics).toEqual(["Round"]);
	});

	it("never surfaces the flat keys on the parsed shape", () => {
		const parsed = dosConfigSchema.parse(legacyFlatBlob);

		for (const losing of ["workspace", "domains", "priorities", "state_doc_rules"]) {
			expect(parsed).not.toHaveProperty(losing);
		}
	});

	it("treats an empty `by_domain` as absent and reads the legacy keys instead", () => {
		// A half-written blob should degrade to the old answer, not to silence.
		expect(workBlock({ ...legacyFlatBlob, by_domain: {} })?.topics).toEqual(
			legacyFlatBlob.domains,
		);
	});

	it("keeps an unknown domain key visible rather than failing the whole parse", () => {
		const parsed = dosConfigSchema.parse({ by_domain: { work: {}, mars: { topics: ["Ops"] } } });

		expect(Object.keys(parsed.by_domain).sort()).toEqual(["work", "mars"]);
	});
});

describe("domainConfig", () => {
	it("returns null for a domain the blob has no block for", () => {
		expect(domainConfig(dosConfigSchema.parse({ by_domain: { work: {} } }), "angus")).toBeNull();
	});

	it("returns null for every domain of the empty default config", () => {
		expect(domainConfig(DEFAULT_DOS_CONFIG, "work")).toBeNull();
		expect(domainConfig(DEFAULT_DOS_CONFIG, "angus")).toBeNull();
	});

	it("defaults to work — the domain every pre-axis caller means", () => {
		expect(DEFAULT_DOMAIN).toBe("work");
	});
});

describe("pillar/priority key resolution within a domain (#618)", () => {
	it("reads the new `pillars` key", () => {
		expect(workPillars({ pillars: pillarsAsRead })).toEqual(pillarsAsRead);
	});

	it("falls back to the legacy `priorities` key when `pillars` is absent", () => {
		// Entries survive intact; the legacy path additionally fills notion_option,
		// which has its own test below.
		expect(workPillars({ priorities: legacyPriorities })).toEqual(
			legacyPriorities.map((p) => ({ ...p, notion_option: `${p.key} ${p.label}` })),
		);
	});

	it("prefers `pillars` when a blob carries both keys", () => {
		expect(workPillars({ pillars: pillarsAsRead, priorities: legacyPriorities })).toEqual(
			pillarsAsRead,
		);
	});

	it("defaults to an empty pillar list when neither key is present", () => {
		expect(workPillars({})).toEqual([]);
	});
});

describe("pillarNotionOption", () => {
	it("uses an explicit notion_option verbatim", () => {
		expect(
			pillarNotionOption({
				key: "Pillar 1",
				label: "Product",
				description: "",
				notion_option: "Product",
			}),
		).toBe("Product");
	});

	it("returns null when notion_option is absent — the pillar does not project", () => {
		expect(pillarNotionOption({ key: "Pillar 1", label: "Product", description: "" })).toBeNull();
	});

	it("treats a blank notion_option as absent rather than selecting an empty option", () => {
		expect(
			pillarNotionOption({
				key: "Pillar 1",
				label: "Product",
				description: "",
				notion_option: "   ",
			}),
		).toBeNull();
	});
});

// THE STANDING CORRECTNESS RISK, PINNED. Migration 089 is pushed by hand long after
// this code deploys, so for an unknown window production stores `notion_property` and
// runs code that only knows `notion_option`. Every assertion here is about that window.
describe("pre-089 blobs still read, with the same strings (#692)", () => {
	const pre089ByDomain = { by_domain: { work: { pillars: pre089Pillars } } };

	it("reads a pre-089 `notion_property` as the pillar's option value", () => {
		// This is the only non-breaking reading: the checkbox properties these strings
		// named are already deleted from Notion, while the strings themselves are live
		// options the backfill preserved.
		expect(workPillars(pre089ByDomain).map(pillarNotionOption)).toEqual([
			"P1 Launch",
			"P2 Round",
		]);
	});

	it("normalises the legacy key away, so no consumer can read the losing name", () => {
		expect(workPillars(pre089ByDomain)).toEqual(pillarsAsRead);
		for (const pillar of workPillars(pre089ByDomain)) {
			expect(pillar).not.toHaveProperty("notion_property");
		}
	});

	it("normalises it on the flat pre-088 path too — both migrations are outstanding", () => {
		expect(workPillars({ pillars: pre089Pillars })).toEqual(pillarsAsRead);
	});

	it("prefers `notion_option` when a pillar somehow carries both keys", () => {
		// Same precedence as `pillars` over `priorities` and `by_domain` over the flat
		// keys: the newest name wins, so a half-written blob cannot be read two ways.
		const pillars = workPillars({
			pillars: [
				{
					key: "Pillar 1",
					label: "Product",
					description: "",
					notion_option: "Product",
					notion_property: "P1 Launch",
				},
			],
		});

		expect(pillars.map(pillarNotionOption)).toEqual(["Product"]);
	});

	it("leaves a pillar with neither key non-projecting rather than inventing one", () => {
		expect(
			workPillars({ pillars: [{ key: "Pillar 5", label: "Hiring", description: "" }] }).map(
				pillarNotionOption,
			),
		).toEqual([null]);
	});
});

describe("projection is a per-pillar choice, decided at the read boundary", () => {
	it("fills notion_option on the legacy `priorities` path, so absence is never guesswork", () => {
		// The derivation happens once, on the way in — not at every point of use.
		expect(workPillars({ priorities: legacyPriorities }).map((p) => p.notion_option)).toEqual([
			"P1 Launch",
			"P2 Round",
		]);
	});

	it("does NOT invent an option for a `pillars` entry authored without one", () => {
		const pillars = workPillars({
			pillars: [{ key: "Pillar 5", label: "Hiring", description: "Build the team" }],
		});

		expect(pillars[0].notion_option).toBeUndefined();
		expect(pillars.map(pillarNotionOption)).toEqual([null]);
	});

	it("lets projecting and non-projecting pillars coexist in one domain", () => {
		const pillars = workPillars({
			pillars: [
				{ key: "Pillar 1", label: "Product", description: "", notion_option: "Product" },
				{ key: "Pillar 5", label: "Hiring", description: "" },
			],
		});

		expect(pillars.map(pillarNotionOption)).toEqual(["Product", null]);
	});
});

describe("the strings sent to Notion survive migrations 086, 088 and 089 unchanged (#618 / #692)", () => {
	const options = (blob: unknown) => workPillars(blob).map(pillarNotionOption);

	it("yields the same strings across every blob shape the reader accepts", () => {
		const preRename = options({ priorities: legacyPriorities });
		const flat = options({ pillars: pre089Pillars });
		const byDomain = options({ by_domain: { work: { pillars: pre089Pillars } } });
		const post089 = options({ by_domain: { work: { pillars: pillarsAsRead } } });

		expect(preRename).toEqual(["P1 Launch", "P2 Round"]);
		// This equality IS the safety guarantee: reshaping the config must not change a
		// single string the ritual sends to Notion. What those strings MEAN changed with
		// #692 — checkbox property name to multi-select option value — and the workspace
		// changed with them, but no reshape may silently rewrite one string into another.
		expect(flat).toEqual(preRename);
		expect(byDomain).toEqual(preRename);
		expect(post089).toEqual(preRename);
	});
});

describe("MCP handshake and system instructions config extensions (#1987)", () => {
	it("parses operating_principles, handshake_instructions, system_instructions, and system_instructions_sync", () => {
		const syncRecord = {
			sha256: "a".repeat(64),
			pasted_at: "2026-10-30T12:00:00Z",
		};
		const parsed = dosConfigSchema.parse({
			tone: ["Rule 1"],
			operating_principles: ["Bias to action", "Never invent state"],
			handshake_instructions: "DB-backed handshake guidance.",
			system_instructions: "DB-backed canonical prose prefix.",
			system_instructions_sync: syncRecord,
		});

		expect(parsed.operating_principles).toEqual(["Bias to action", "Never invent state"]);
		expect(parsed.handshake_instructions).toBe("DB-backed handshake guidance.");
		expect(parsed.system_instructions).toBe("DB-backed canonical prose prefix.");
		expect(parsed.system_instructions_sync).toEqual(syncRecord);
		expect(parsed.pasted_instructions).toEqual(syncRecord);
	});

	it("supports backward-compatible read fallback for claude-instructions and claude_instructions_sync", () => {
		const syncRecord = {
			sha256: "b".repeat(64),
			pasted_at: "2026-10-29T12:00:00Z",
		};
		const parsed = dosConfigSchema.parse({
			"claude-instructions": "Legacy claude instructions prose.",
			claude_instructions_sync: syncRecord,
		});

		expect(parsed.system_instructions).toBe("Legacy claude instructions prose.");
		expect(parsed.system_instructions_sync).toEqual(syncRecord);
	});

	it("renders all dos_config sections without a 20-rule truncation cap and with compact single-line by_domain summaries", () => {
		const manyToneRules = Array.from({ length: 25 }, (_, i) => `Custom tone rule #${i + 1}`);
		const config = dosConfigSchema.parse({
			tone: manyToneRules,
			operating_principles: ["Verify against source of truth", "Keep surface parity"],
			types: [{ key: "Decision", description: "Committed choice" }],
			audiences: [{ key: "Board", register: "concise, metric-led" }],
			by_domain: {
				work: {
					topics: ["Round", "Product"],
					pillars: [{ key: "P1", label: "Launch", description: "Ship app", notion_option: "P1 Launch" }],
					artefact_registers: [{ key: "Bri", tone: "co-founder, signal not status" }],
					domain_signals: ["Work", "Briana"],
					waiting_on_status: "Waiting on",
				},
			},
		});

		const sections = renderDosConfigSections(config);
		const joined = sections.join("\n\n");

		expect(joined).toContain(
			"Owner's writing rules (source of truth: user_preferences.dos_config.tone - ADR-030; re-read each session, #819).",
		);
		expect(joined).toContain("- Custom tone rule #1");
		expect(joined).toContain("- Custom tone rule #25");
		expect(joined).toContain(
			"Operating principles (source of truth: user_preferences.dos_config.operating_principles):",
		);
		expect(joined).toContain("- Verify against source of truth");
		expect(joined).toContain("Atom types (source of truth: user_preferences.dos_config.types):");
		expect(joined).toContain("- Decision: Committed choice");
		expect(joined).toContain("Audiences (source of truth: user_preferences.dos_config.audiences):");
		expect(joined).toContain("- Board: concise, metric-led");
		expect(joined).toContain("Domains (source of truth: user_preferences.dos_config.by_domain):");
		expect(joined).toContain(
			"- work: topics: Round, Product | pillars: P1 Launch | registers: Bri (co-founder, signal not status) | signals: Work, Briana | waiting_on_status: Waiting on",
		);
	});

	it("formatDomainSummaryLine renders (configured) when a domain block has no populated lists", () => {
		const emptyBlock = domainConfig(
			dosConfigSchema.parse({ by_domain: { work: {} } }),
			"work",
		);
		expect(emptyBlock).not.toBeNull();
		expect(formatDomainSummaryLine("work", emptyBlock!)).toBe("- work: (configured)");
	});

	it("attachDosConfigToToneRules attaches a non-enumerable dosConfig property", () => {
		const rules = attachDosConfigToToneRules(["Rule A"], DEFAULT_DOS_CONFIG);
		expect([...rules]).toEqual(["Rule A"]);
		expect(Object.keys(rules)).toEqual(["0"]);
		expect(rules.dosConfig).toBe(DEFAULT_DOS_CONFIG);
	});
});

describe("operating_principles (#1984)", () => {
	it("defaults operating_principles to [] for older rows that only carry tone", () => {
		const legacyParsed = dosConfigSchema.parse(legacyFlatBlob);
		expect(legacyParsed.operating_principles).toEqual([]);
		expect(operatingPrinciples(legacyParsed)).toEqual([]);

		const domainOnlyParsed = dosConfigSchema.parse({
			by_domain: { work: {} },
			tone: ["Plain British English, no jargon"],
		});
		expect(domainOnlyParsed.operating_principles).toEqual([]);
		expect(operatingPrinciples(domainOnlyParsed)).toEqual([]);
		expect(DEFAULT_DOS_CONFIG.operating_principles).toEqual([]);
	});

	it("keeps prose tone rules separate from operating_principles in parsed config and rendered sections", () => {
		const parsed = dosConfigSchema.parse({
			tone: [
				"Plain British English, no jargon",
				"NEVER use the em-dash. Use commas, semicolons, parentheses, or sentence breaks instead.",
			],
			operating_principles: [
				"Global max over local max: optimise for the whole system and long-term architecture over a local shortcut or single-surface fix.",
				"Check what already exists before building: inspect existing tables, actions, skills, and capabilities in the repo and kms-db before introducing anything new.",
			],
		});

		expect(parsed.tone).toEqual([
			"Plain British English, no jargon",
			"NEVER use the em-dash. Use commas, semicolons, parentheses, or sentence breaks instead.",
		]);
		expect(operatingPrinciples(parsed)).toEqual([
			"Global max over local max: optimise for the whole system and long-term architecture over a local shortcut or single-surface fix.",
			"Check what already exists before building: inspect existing tables, actions, skills, and capabilities in the repo and kms-db before introducing anything new.",
		]);

		const sections = renderDosConfigSections(parsed);
		expect(sections[0]).toContain("user_preferences.dos_config.tone");
		expect(sections[0]).not.toContain("Global max over local max");
		expect(sections[1]).toContain("user_preferences.dos_config.operating_principles");
		expect(sections[1]).toContain("Global max over local max");
		expect(sections[1]).toContain("Check what already exists before building");
	});
});

describe("writer-shaped operating_principles and soft-key isolation (#2256)", () => {
	const byDomain = { work: { topics: ["Round"] }, angus: { topics: ["Health"] } };
	const reader = (raw: unknown) => ({ loadDosConfigRow: async () => raw });
	const quietly = async <T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await run();
			return { result, logged: errors.mock.calls.map((c) => String(c[0])).join("\n") };
		} finally {
			errors.mockRestore();
		}
	};

	it("accepts { key, description } principles alongside strings and normalises them to strings", () => {
		const parsed = dosConfigSchema.safeParse({
			by_domain: { work: { topics: ["Round"] } },
			operating_principles: [
				"Plain rule",
				{ key: "slack_direct_message_urls", description: "Always include direct URLs" },
			],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(operatingPrinciples(parsed.data)).toEqual([
			"Plain rule",
			"slack_direct_message_urls: Always include direct URLs",
		]);
		expect(domainConfig(parsed.data, "work")?.topics).toEqual(["Round"]);
	});

	it.each([
		["tone", [123, "Plain"]],
		["operating_principles", [{ nope: true }]],
		["types", [{ key: 1 }]],
		["audiences", ["not an audience"]],
	])("degrades only %s when it is malformed, keeping by_domain", (key, value) => {
		const parsed = dosConfigSchema.safeParse({ by_domain: byDomain, tone: ["Plain"], [key]: value });

		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(Object.keys(parsed.data.by_domain)).toEqual(["work", "angus"]);
		expect((parsed.data as Record<string, unknown>)[key]).toEqual([]);
		if (key !== "tone") expect(parsed.data.tone).toEqual(["Plain"]);
	});

	it("loadDosConfigDetailed reports 'absent' for a null row and 'ok' for a clean one", async () => {
		expect(await loadDosConfigDetailed(reader(null))).toEqual({
			config: DEFAULT_DOS_CONFIG,
			status: "absent",
			issues: [],
		});
		const ok = await loadDosConfigDetailed(reader({ by_domain: byDomain }));
		expect(ok.status).toBe("ok");
		expect(ok.issues).toEqual([]);
	});

	it("loadDosConfigDetailed reports 'degraded' with the issue path, logs it, and keeps by_domain", async () => {
		const { result, logged } = await quietly(() =>
			loadDosConfigDetailed(reader({ by_domain: byDomain, tone: [123] })),
		);

		expect(result.status).toBe("degraded");
		expect(result.issues.join("; ")).toContain("tone.0");
		expect(Object.keys(result.config.by_domain)).toEqual(["work", "angus"]);
		expect(logged).toContain("tone.0");
	});

	it("loadDosConfigDetailed reports 'unparseable' with the issue path and logs it", async () => {
		const { result, logged } = await quietly(() =>
			loadDosConfigDetailed(reader({ by_domain: { work: { topics: "Round" } } })),
		);

		expect(result.status).toBe("unparseable");
		expect(result.config).toBe(DEFAULT_DOS_CONFIG);
		expect(result.issues.join("; ")).toContain("by_domain.work.topics");
		expect(logged).toContain("by_domain.work.topics");
	});
});
