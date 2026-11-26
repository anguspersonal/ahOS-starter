import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_DOS_CONFIG,
	dosConfigSchema,
	findAudienceSpec,
	audienceSpecsForDomain,
	type AudienceSpec,
	type DomainConfig,
	type DosConfig,
} from "../../domain/dosConfig.js";
import type { ConfigRepository } from "../../ports/config.js";
import { createDosConfigGetAction, type DosConfigGetInput } from "./configGet.js";

const withDomains = (by_domain: Record<string, Partial<DomainConfig>>): DosConfig =>
	dosConfigSchema.parse({ by_domain, types: [], tone: [] });

function makeRepo(rawOrConfig: unknown): ConfigRepository {
	return {
		loadConfigDetailed: async () => ({ status: "unwired" }),
		loadConfig: async () => null,
		loadIntegration: async () => null,
		listByFamily: async () => [],
		updateConfig: async () => {},
		listIntegrations: async () => [],
		loadDosConfigRow: async () => rawOrConfig,
	};
}

async function render(rawOrConfig: unknown, args: DosConfigGetInput = {}): Promise<string> {
	const action = createDosConfigGetAction(makeRepo(rawOrConfig));
	const output = await action.run(args, { caller: "test", requestId: "req-1" });
	return action.formatMcp!(output);
}

describe("dos_config_get domain selection (#679, #1603)", () => {
	const twoDomains = () =>
		withDomains({
			work: { topics: ["Round"], domain_signals: ["Work"] },
			angus: { topics: ["Health", "Finances"], domain_signals: ["family"] },
		});

	it("defaults to work, so a caller that names no domain is unaffected", async () => {
		const text = await render(twoDomains());

		expect(text).toContain("dos config — domain: work");
		expect(text).toContain("  Round");
	});

	it("returns the angus block when asked for it", async () => {
		const text = await render(twoDomains(), { domain: "angus" });

		expect(text).toContain("dos config — domain: angus");
		expect(text).toContain("  Health, Finances");
		expect(text).not.toContain("  Round");
	});

	it("lists every domain's routing signals whichever domain is selected", async () => {
		const text = await render(twoDomains(), { domain: "work" });

		expect(text).toContain("  work: Work");
		expect(text).toContain("  angus: family");
	});

	it("reports an unconfigured domain as unconfigured, not as empty lists", async () => {
		const text = await render(withDomains({ work: { topics: ["Round"] } }), {
			domain: "angus",
		});

		expect(text).toContain("NO CONFIG BLOCK FOR DOMAIN 'angus'");
		expect(text).toContain("domains present in this config: work");
		expect(text).not.toContain("Daily Log schema");
	});

	it("still renders the global keys when the selected domain has no block", async () => {
		const text = await render(
			{
				by_domain: { work: {} },
				types: [{ key: "Note", description: "Passive observation" }],
				tone: ["Plain British English"],
			},
			{ domain: "angus" },
		);

		expect(text).toContain("  Note — Passive observation");
		expect(text).toContain("  - Plain British English");
	});

	it("says so for every domain when the config is the empty default or null", async () => {
		expect(await render(DEFAULT_DOS_CONFIG)).toContain("NO CONFIG BLOCK FOR DOMAIN 'work'");
		expect(await render(null, { domain: "angus" })).toContain(
			"domains present in this config: (none)",
		);
	});
});

describe("dos_config_get rendering of a legacy flat blob (#679)", () => {
	const legacy = () => ({
		workspace: {
			work_entities: ["Work"],
			personal_signals: ["family"],
		},
		pillars: [
			{
				key: "Pillar 1",
				label: "Launch",
				description: "Ship the app",
				notion_property: "P1 Launch",
			},
		],
		domains: ["Apple", "Round"],
		types: [{ key: "Note", description: "Passive observation" }],
		tone: ["Plain British English"],
	});

	it("renders a working work view with its original strings intact", async () => {
		const text = await render(legacy());

		expect(text).toContain("  Apple, Round");
		expect(text).toContain('[Notion option: "P1 Launch"]');
		expect(text).toContain("  Note — Passive observation");
	});

	it("keeps the personal routing signals reachable before the migration runs", async () => {
		const text = await render(legacy());

		expect(text).toContain("  angus: family");
	});
});

describe("dos_config_get pillar rendering (#618) and role resolution (#703, #1016, #1028)", () => {
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

	it("labels the section Pillars and shows Notion multi-select option value", async () => {
		const text = await render(onePillar());

		expect(text).toContain("Pillars (strategic objectives");
		expect(text).not.toMatch(/^Priorities:/m);
		expect(text).toContain(
			'Pillar 1 Product — Deliver exceptional product [Notion option: "Product"]',
		);
		expect(text).not.toContain("Notion checkbox");
		expect(text).toContain("never invent one");
		expect(text).toContain("never a rename");
	});

	it("says so out loud when a pillar has no Notion option at all", async () => {
		const text = await render(
			withDomains({
				work: { pillars: [{ key: "Pillar 5", label: "Hiring", description: "Build the team" }] },
			}),
		);

		expect(text).toContain("Pillar 5 Hiring — Build the team [no Notion option]");
		expect(text).not.toContain("Notion option: ");
	});

	it("shows property roles, pillars role resolution, and waiting_on_status", async () => {
		const text = await render(
			withDomains({
				work: {
					waiting_on_status: "Awaiting/Review",
					pillars: [
						{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Product" },
					],
					daily_log_schema: {
						properties: [
							{ name: "Date", notion_type: "date", required: true },
							{ name: "Covers", notion_type: "rich_text", required: false, role: "covers" },
							{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
						],
						body_sections: [],
					},
				},
			}),
			{ domain: "work" },
		);

		expect(text).toContain("  Covers (rich_text) [role: covers]");
		expect(text).toContain('pillars → "Pillars" (multi_select)');
		expect(text).toContain("written verbatim into \"Pillars\" (declared with role 'pillars')");
		expect(text).toContain("Waiting-on task status: Awaiting/Review");
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

	it("renders audiences in the global section and detailed spec when audience argument is specified", async () => {
		const blob = {
			by_domain: { work: {} },
			types: [],
			tone: [],
			audiences: sampleAudiences,
		};

		const text = await render(blob, { domain: "work", audience: "advisor" });
		expect(text).toContain(
			"Audience spec: advisor (External Strategic Advisor) [cadence: weekly] [domain: work]",
		);
		expect(text).toContain("Register: Executive, strategic, and concise.");
		expect(text).toContain("Audiences (ADR-051 section 4 / ADR-054 section 4):");
		expect(text).toContain("Compensation & Pay: Individual salaries.");

		const missingText = await render(blob, { domain: "work", audience: "unknown_person" });
		expect(missingText).toContain(
			"NO AUDIENCE SPEC FOUND FOR 'unknown_person'. Known audiences: advisor, team",
		);
	});

	it("helper functions findAudienceSpec and audienceSpecsForDomain resolve correctly", () => {
		const config = dosConfigSchema.parse({
			by_domain: { work: {}, angus: {} },
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
		expect(audienceSpecsForDomain(config, "work").map((a) => a.key)).toEqual(["advisor", "team"]);
		expect(audienceSpecsForDomain(config, "angus").map((a) => a.key)).toEqual(["mentor"]);
	});
});

describe("dos_config_get tells stored-but-unparseable from absent (#2256)", () => {
	// The production shape: `config_preferences_update` and the settings canvas write
	// `{ key, description }` objects, which the reader used to reject wholesale.
	const incidentShape = () => ({
		by_domain: {
			work: { topics: ["Round"], domain_signals: ["Work"] },
			angus: { topics: ["Health"], domain_signals: ["family"] },
		},
		tone: ["Plain British English"],
		operating_principles: [
			"Plain rule",
			{ key: "slack_direct_message_urls", description: "Always include direct URLs" },
		],
	});

	it("returns the real domain blocks when operating_principles holds writer-shaped objects", async () => {
		const text = await render(incidentShape(), { domain: "angus" });

		expect(text).toContain("dos config — domain: angus");
		expect(text).toContain("  Health");
		expect(text).not.toContain("NO CONFIG BLOCK FOR DOMAIN");
		expect(text).not.toContain("UNPARSEABLE");
	});

	it("normalises object principles to strings on the action output", async () => {
		const action = createDosConfigGetAction(makeRepo(incidentShape()));
		const output = await action.run({}, { caller: "test", requestId: "req-1" });

		expect(output.dos_config.operating_principles).toEqual([
			"Plain rule",
			"slack_direct_message_urls: Always include direct URLs",
		]);
		expect(output.load_status).toBe("ok");
	});

	it("keeps by_domain and names the degraded key when a soft global key is malformed", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const text = await render({ ...incidentShape(), tone: [123, "Plain British English"] });
		errors.mockRestore();

		expect(text).toContain("  Round");
		expect(text).not.toContain("NO CONFIG BLOCK FOR DOMAIN");
		expect(text).toContain("DEGRADED GLOBAL KEYS");
		expect(text).toContain("tone.0");
	});

	it("reports a stored but unparseable config with its issue paths, not a missing block", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const text = await render({ by_domain: { work: { topics: "Round" } } });
		errors.mockRestore();

		expect(text).toContain("CONFIG STORED BUT UNPARSEABLE");
		expect(text).toContain("by_domain.work.topics");
		expect(text).not.toContain("NO CONFIG BLOCK FOR DOMAIN");
		expect(text).not.toContain("fix: land the domain's block");
	});

	it("still reports a genuinely absent config as a missing block", async () => {
		const text = await render(null);

		expect(text).toContain("NO CONFIG BLOCK FOR DOMAIN 'work'");
		expect(text).not.toContain("UNPARSEABLE");
	});
});
