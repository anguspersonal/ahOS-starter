import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the DB read is stubbed; pillarNotionOption and domainConfig stay real so the
// rendered strings are the ones the skill would actually send to Notion.
vi.mock("../dosConfig.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../dosConfig.js")>();
	return { ...actual, loadDosConfig: vi.fn() };
});

import { buildRegistry } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/index.js";
import {
	loadDosConfig,
	dosConfigSchema,
	DEFAULT_DOS_CONFIG,
	findAudienceSpec,
	audienceSpecsForDomain,
	type AudienceSpec,
	type Domain,
	type DomainConfig,
	type DosConfig,
} from "../dosConfig.js";

const getDosConfigHandler = (args: { domain?: Domain; audience?: string } = {}) =>
	toMcpTool(
		buildRegistry({
			config: {
				loadDosConfigRow: () => loadDosConfig(),
			} as any,
		}).get("dos_config_get")!,
	).handler(args);

const withDomains = (by_domain: Record<string, Partial<DomainConfig>>): DosConfig =>
	dosConfigSchema.parse({ by_domain, types: [], tone: [] });

const render = async (args: Parameters<typeof getDosConfigHandler>[0] = {}) =>
	(await getDosConfigHandler(args)).content[0].text;

beforeEach(() => {
	vi.mocked(loadDosConfig).mockReset();
});

describe("dos_config_get domain selection (#679)", () => {
	const twoDomains = () =>
		withDomains({
			work: { topics: ["Round"], domain_signals: ["Work"] },
			angus: { topics: ["Health", "Finances"], domain_signals: ["family"] },
		});

	it("defaults to work, so a caller that names no domain is unaffected", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(twoDomains());

		const text = await render();

		expect(text).toContain("dos config — domain: work");
		expect(text).toContain("  Round");
	});

	it("returns the angus block when asked for it", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(twoDomains());

		const text = await render({ domain: "angus" });

		expect(text).toContain("dos config — domain: angus");
		expect(text).toContain("  Health, Finances");
		expect(text).not.toContain("  Round");
	});

	it("lists every domain's routing signals whichever domain is selected", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(twoDomains());

		// Deciding which domain an item belongs to needs both lists, so a single-domain
		// view of the classifier would make the question unanswerable.
		const text = await render({ domain: "work" });

		expect(text).toContain("  work: Work");
		expect(text).toContain("  angus: family");
	});

	it("reports an unconfigured domain as unconfigured, not as empty lists", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(withDomains({ work: { topics: ["Round"] } }));

		const text = await render({ domain: "angus" });

		expect(text).toContain("NO CONFIG BLOCK FOR DOMAIN 'angus'");
		expect(text).toContain("domains present in this config: work");
		// The distinction that matters: nothing invites the ritual to write.
		expect(text).not.toContain("Daily Log schema");
	});

	it("still renders the global keys when the selected domain has no block", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({
				by_domain: { work: {} },
				types: [{ key: "Note", description: "Passive observation" }],
				tone: ["Plain British English"],
			}),
		);

		const text = await render({ domain: "angus" });

		expect(text).toContain("  Note — Passive observation");
		expect(text).toContain("  - Plain British English");
	});

	it("says so for every domain when the config is the empty default", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(DEFAULT_DOS_CONFIG);

		expect(await render()).toContain("NO CONFIG BLOCK FOR DOMAIN 'work'");
		expect(await render({ domain: "angus" })).toContain("domains present in this config: (none)");
	});
});

describe("dos_config_get rendering of a legacy flat blob (#679)", () => {
	// loadDosConfig parses before returning, so this is the shape the handler actually
	// receives for a database migration 088 has not reached yet.
	const legacy = () =>
		dosConfigSchema.parse({
			workspace: {
				work_entities: ["Work"],
				personal_signals: ["family"],
			},
			pillars: [
				{ key: "Pillar 1", label: "Launch", description: "Ship the app", notion_property: "P1 Launch" },
			],
			domains: ["Apple", "Round"],
			types: [{ key: "Note", description: "Passive observation" }],
			tone: ["Plain British English"],
		});

	it("renders a working work view with its original strings intact", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(legacy());

		const text = await render();

		expect(text).toContain("  Apple, Round");
		// A pre-089 `notion_property` renders as the option it now names (#692) — the
		// shape production stores until the migration is pushed by hand.
		expect(text).toContain('[Notion option: "P1 Launch"]');
		expect(text).toContain("  Note — Passive observation");
	});

	it("keeps the personal routing signals reachable before the migration runs", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(legacy());

		const text = await render();

		expect(text).toContain("  angus: family");
	});
});

describe("dos_config_get pillar rendering (#618)", () => {
	const onePillar = () =>
		withDomains({
			work: {
				pillars: [
					{
						key: "Pillar 1",
						label: "Product",
						description: "Deliver exceptional product",
						notion_option: "Product",
					},
				],
			},
		});

	it("labels the section Pillars and never Priorities", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(onePillar());

		const text = await render();

		expect(text).toContain("Pillars (strategic objectives");
		expect(text).not.toMatch(/^Priorities:/m);
	});

	it("shows the Notion multi-select option value alongside each pillar", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(onePillar());

		expect(await render()).toContain(
			'Pillar 1 Product — Deliver exceptional product [Notion option: "Product"]',
		);
	});

	it("never calls a pillar projection a checkbox — the checkboxes are gone (#692)", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(onePillar());

		// `Reflection included` is still a checkbox, so the word may legitimately appear
		// in a schema declaration; what must not come back is a pillar described as one.
		expect(await render()).not.toContain("Notion checkbox");
	});

	it("tells the reader never to invent an option, because Notion creates unknown ones", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(onePillar());

		// The rule has to reach the skill in the same tool call as the values, or the
		// only place it lives is a migration comment nobody reads at write time.
		const text = await render();

		expect(text).toContain("never invent one");
		expect(text).toContain("never a rename");
	});

	it("says so out loud when a pillar has no Notion option at all", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			withDomains({
				work: { pillars: [{ key: "Pillar 5", label: "Hiring", description: "Build the team" }] },
			}),
		);

		const text = await render();

		// Visible in one tool call, not inferred from a missing annotation.
		expect(text).toContain("Pillar 5 Hiring — Build the team [no Notion option]");
		expect(text).not.toContain("Notion option: ");
	});

	it("renders (none) for a domain whose pillar list is deliberately empty", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(withDomains({ work: { pillars: [] } }));

		expect(await render()).toMatch(/Pillars \(strategic objectives[^\n]*\n {2}\(none\)/);
	});
});

describe("dos_config_get Daily Log property roles (#1016)", () => {
	it("shows a property's declared role, so the Covers join is read, not inferred", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			withDomains({
				angus: {
					daily_log_schema: {
						properties: [
							{ name: "Date", notion_type: "date", required: true },
							{ name: "Covers", notion_type: "rich_text", required: false, role: "covers" },
						],
						body_sections: [],
					},
				},
			}),
		);

		const text = await render({ domain: "angus" });

		expect(text).toContain("  Covers (rich_text) [role: covers]");
		expect(text).toContain("  Date (date) *");
		expect(text).not.toContain("Date (date) * [role");
	});
});

describe("dos_config_get Daily Log pillars role resolution (#703)", () => {
	it("prints 'pillars → none declared; write none' when no property carries role 'pillars'", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			withDomains({
				work: {
					pillars: [
						{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Product" },
					],
					daily_log_schema: {
						properties: [
							{ name: "Date", notion_type: "date", required: true },
							{ name: "Other domains", notion_type: "multi_select", required: false },
						],
						body_sections: [],
					},
				},
			}),
		);

		const text = await render({ domain: "work" });

		expect(text).toContain("pillars → none declared; write none");
	});

	it("prints the resolved property and multi_select when a property carries role 'pillars'", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			withDomains({
				work: {
					pillars: [
						{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Product" },
					],
					daily_log_schema: {
						properties: [
							{ name: "Date", notion_type: "date", required: true },
							{
								name: "Pillars",
								notion_type: "multi_select",
								required: false,
								role: "pillars",
							},
						],
						body_sections: [],
					},
				},
			}),
		);

		const text = await render({ domain: "work" });

		expect(text).toContain('pillars → "Pillars" (multi_select)');
		expect(text).toContain("written verbatim into \"Pillars\" (declared with role 'pillars')");
	});
});

describe("dos_config_get waiting_on_status (#1028)", () => {
	it("renders Waiting-on task status when configured", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			withDomains({
				work: { waiting_on_status: "Awaiting/Review" },
			}),
		);

		const text = await render({ domain: "work" });
		expect(text).toContain("Waiting-on task status: Awaiting/Review");
	});

	it("omits waiting-on status line when not configured", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			withDomains({
				work: {},
			}),
		);

		const text = await render({ domain: "work" });
		expect(text).not.toContain("Waiting-on task status:");
	});
});

describe("dos_config_get audiences (#743)", () => {
	const sampleAudiences: AudienceSpec[] = [
		{
			key: "advisor",
			role: "External Strategic Advisor",
			domain: "work",
			cadence: "weekly",
			register: "Executive, strategic, and concise.",
			standing_exclusions: [
				"Personnel & Team Details: Individual appraisals.",
				"Compensation & Pay: Individual salaries.",
			],
			examples: [],
		},
		{
			key: "team",
			role: "Internal Core Team",
			domain: "work",
			cadence: "nightly",
			register: "All-hands Slack update, bulleted, lowercase.",
			standing_exclusions: [],
			examples: [],
		},
	];

	it("renders audiences in the global section", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({
				by_domain: { work: {} },
				types: [],
				tone: [],
				audiences: sampleAudiences,
			}),
		);

		const text = await render({ domain: "work" });
		expect(text).toContain("Audiences (ADR-051 section 4 / ADR-054 section 4):");
		expect(text).toContain("advisor (External Strategic Advisor) [cadence: weekly] [domain: work]:");
		expect(text).toContain("Register: Executive, strategic, and concise.");
		expect(text).toContain("Personnel & Team Details: Individual appraisals.");
	});

	it("renders detailed audience spec when audience argument is specified", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({
				by_domain: { work: {} },
				types: [],
				tone: [],
				audiences: sampleAudiences,
			}),
		);

		const text = await render({ domain: "work", audience: "advisor" });
		expect(text).toContain("Audience spec: advisor (External Strategic Advisor) [cadence: weekly] [domain: work]");
		expect(text).toContain("Register: Executive, strategic, and concise.");
		expect(text).toContain("Standing exclusions:");
		expect(text).toContain("Compensation & Pay: Individual salaries.");
	});

	it("reports unknown audience key cleanly", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({
				by_domain: { work: {} },
				types: [],
				tone: [],
				audiences: sampleAudiences,
			}),
		);

		const text = await render({ domain: "work", audience: "unknown_person" });
		expect(text).toContain("NO AUDIENCE SPEC FOUND FOR 'unknown_person'. Known audiences: advisor, team");
	});

	it("helper functions findAudienceSpec and audienceSpecsForDomain resolve correctly", () => {
		const config = dosConfigSchema.parse({
			by_domain: {
				work: {},
				angus: {},
			},
			types: [],
			tone: [],
			audiences: [
				...sampleAudiences,
				{
					key: "mentor",
					domain: "angus",
					register: "Casual, personal.",
					standing_exclusions: [],
					examples: [],
				},
			],
		});

		expect(findAudienceSpec(config, "advisor")?.role).toBe("External Strategic Advisor");
		expect(findAudienceSpec(config, "advisor")?.role).toBe("External Strategic Advisor");
		expect(findAudienceSpec(config, "missing")).toBeNull();

		const workAudiences = audienceSpecsForDomain(config, "work");
		expect(workAudiences.map((a) => a.key)).toEqual(["advisor", "team"]);

		const angusAudiences = audienceSpecsForDomain(config, "angus");
		expect(angusAudiences.map((a) => a.key)).toEqual(["mentor"]);
	});
});


describe("dos_config_get over MCP: unparseable is not absent (#2256)", () => {
	it("returns the stored domain blocks when operating_principles holds { key, description } objects", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue({
			by_domain: {
				work: { topics: ["Round"] },
				angus: { topics: ["Health", "Finances"] },
			},
			operating_principles: [
				"Plain rule",
				{ key: "slack_direct_message_urls", description: "Always include direct URLs" },
			],
		} as never);

		const text = await render({ domain: "angus" });

		expect(text).toContain("  Health, Finances");
		expect(text).not.toContain("NO CONFIG BLOCK FOR DOMAIN");
	});

	it("names the failing path when the stored config cannot be parsed", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(loadDosConfig).mockResolvedValue({
			by_domain: { work: { topics: "Round" } },
		} as never);

		const text = await render();
		errors.mockRestore();

		expect(text).toContain("CONFIG STORED BUT UNPARSEABLE");
		expect(text).toContain("by_domain.work.topics");
		expect(text).not.toContain("NO CONFIG BLOCK FOR DOMAIN");
	});
});
