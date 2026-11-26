import { describe, expect, it } from "vitest";

import { dosConfigSchema, type DomainConfig } from "./dosConfig.js";
import {
	hasDrift,
	hasPropertyDrift,
	quarantinedValues,
	reconcileDomainConfig,
	unverifiedVocabularies,
	propertyDriftFindings,
	unverifiedProperties,
	type VocabularyKey,
	type VocabularyReconciliation,
} from "./dosConfigDrift.js";
import type { NotionDatabaseSchema } from "../index.js";

// The reconciliation core, pinned against REAL data on both sides (#656).
//
// The fixtures below are not invented. `liveWorkDailyLog` is the Work Daily Log
// schema as read from Notion on 2026-08-21, and the three config fixtures are the three
// states the blob passes through as migrations 089 and 090 are pushed by hand:
//
//   pre-089, pre-090   what PRODUCTION carried on the day this code was written
//   post-089, pre-090  after the pillars migration, before this PR's
//   post-089, post-090 the intended end state
//
// Migrations reach prod by hand AFTER the code deploys, so the first two are not edge
// cases — they are the states this check runs in first, for an unknown length of time.
// Every one of them must produce a usable report and none may look like a reason to
// stop the ritual. That is what these tests exist to hold.

const parseBlock = (block: unknown): DomainConfig => {
	const parsed = dosConfigSchema.parse({ by_domain: { work: block }, types: [], tone: [] });
	return parsed.by_domain.work;
};

/** The Daily Log properties config declared BEFORE migration 089 — note: no `Pillars`. */
const PRE_089_PROPERTIES = [
	{ name: "Name", notion_type: "title", required: true },
	{ name: "Date", notion_type: "date", required: true },
	{ name: "Type", notion_type: "select", required: true },
	{ name: "Summary", notion_type: "rich_text", required: true },
	{ name: "Other domains", notion_type: "multi_select", required: false },
	{ name: "Reflection included", notion_type: "checkbox", required: false },
	{ name: "Artefacts generated", notion_type: "multi_select", required: false },
	{ name: "Synthesis Status", notion_type: "select", required: true },
];

const POST_089_PROPERTIES = [
	...PRE_089_PROPERTIES,
	{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
];

const PRE_090_TOPICS = [
	"Apple",
	"Google Play",
	"Round",
	"Product",
	"EHS",
	"Pricing",
	"Team",
	"Advisors",
	"Legal",
	"Ops",
	"Other",
];

const POST_090_TOPICS = ["Apple", "Google Play", "Pricing", "Team", "Advisors", "Legal", "Ops", "Other"];

/** Pre-089 pillars carry the option under the old `notion_property` key. */
const PRE_089_PILLARS = [
	{ key: "Pillar 1", label: "Launch", description: "…", notion_property: "P1 Launch" },
	{ key: "Pillar 2", label: "Round", description: "…", notion_property: "P2 Round" },
	{ key: "Pillar 3", label: "EHS", description: "…", notion_property: "P3 EHS" },
	{ key: "Pillar 4", label: "Retention/WTP", description: "…", notion_property: "P4 Retention/WTP" },
];

const POST_089_PILLARS = [
	{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Product" },
	{ key: "Pillar 2", label: "Operations", description: "…", notion_option: "Operations" },
	{ key: "Pillar 3", label: "Investment", description: "…", notion_option: "Investment" },
	{ key: "Pillar 4", label: "Marketing", description: "…", notion_option: "Marketing" },
];

/** Read live from Notion data source 3499e609-fe01-80d5-9e29-000b6c895f47 on 2026-08-21. */
const liveWorkDailyLog: NotionDatabaseSchema = {
	properties: [
		{ name: "Name", type: "title" },
		{ name: "Date", type: "date" },
		{ name: "Summary", type: "rich_text" },
		{ name: "Reflection included", type: "checkbox" },
		{ name: "Type", type: "select", options: ["Daily", "Catch-up", "Weekly Reflection"] },
		{ name: "Synthesis Status", type: "select", options: ["Confirmed", "Unconfirmed"] },
		{
			name: "Other domains",
			type: "multi_select",
			options: [
				"Apple",
				"Google Play",
				"Pricing",
				"Legal",
				"Team",
				"Advisors",
				"Ops",
				"Personal",
				"Other",
				"Product",
			],
		},
		{
			name: "Pillars",
			type: "multi_select",
			options: [
				"P1 Launch",
				"P2 Round",
				"P3 EHS",
				"P4 Retention/WTP",
				"Product",
				"Operations",
				"Investment",
				"Marketing",
			],
		},
		{
			name: "Artefacts generated",
			type: "multi_select",
			options: ["Bri", "Team", "Mitesh", "Investor", "Advisor", "Personal Log", "Other"],
		},
	],
};

const workBlock = (
	topics: string[],
	pillars: unknown[],
	properties: unknown[],
): DomainConfig =>
	parseBlock({ topics, pillars, daily_log_schema: { properties, body_sections: [] } });

const find = (
	result: ReturnType<typeof reconcileDomainConfig>,
	vocabulary: VocabularyKey,
): VocabularyReconciliation => {
	const hit = result.vocabularies.find((v) => v.vocabulary === vocabulary);
	if (!hit) throw new Error(`no reconciliation for ${vocabulary}`);
	return hit;
};

describe("config ⊆ notion, in that direction only (#656)", () => {
	it("flags a configured topic Notion has no option for", () => {
		const block = workBlock(PRE_090_TOPICS, POST_089_PILLARS, POST_089_PROPERTIES);
		const topics = find(reconcileDomainConfig(block, liveWorkDailyLog), "topics");

		expect(topics.status).toBe("drift");
		// `Product` is NOT here: it comes out of config because it is a pillar, but it
		// does exist as an `Other domains` option, so it is writable and not a fault.
		expect(topics.missing).toEqual(["Round", "EHS"]);
	});

	it("never fails for a Notion option config does not offer", () => {
		const block = workBlock(POST_090_TOPICS, POST_089_PILLARS, POST_089_PROPERTIES);
		const result = reconcileDomainConfig(block, liveWorkDailyLog);

		expect(find(result, "topics").status).toBe("ok");
		expect(find(result, "pillars").status).toBe("ok");
		expect(hasDrift(result)).toBe(false);

		// Retired vocabulary is still in Notion, is reported, and is not a fault. It
		// cannot be deleted there without stripping it from every historical page.
		expect(find(result, "topics").unused).toEqual(["Personal", "Product"]);
		expect(find(result, "pillars").unused).toEqual([
			"P1 Launch",
			"P2 Round",
			"P3 EHS",
			"P4 Retention/WTP",
		]);
	});
});

describe("the hand-pushed migration windows (#656)", () => {
	// The three states prod passes through. None may look like a reason to stop.

	it("window 1 — code deployed, 089 and 090 both unpushed: topics drift, pillars drift because role undeclared (#703)", () => {
		const block = workBlock(PRE_090_TOPICS, PRE_089_PILLARS, PRE_089_PROPERTIES);
		const result = reconcileDomainConfig(block, liveWorkDailyLog);

		expect(find(result, "topics").status).toBe("drift");

		// #703: The pre-089 blob declares no property with role `pillars`.
		// With non-empty pillars, this is flagged as drift rather than silently ignored,
		// and all configured pillars are quarantined.
		const pillars = find(result, "pillars");
		expect(pillars.status).toBe("drift");
		expect(pillars.property).toBeNull();
		expect(quarantinedValues(result)).toEqual([
			"Round",
			"EHS",
			"P1 Launch",
			"P2 Round",
			"P3 EHS",
			"P4 Retention/WTP",
		]);
	});

	it("window 2 — 089 pushed, 090 not: pillars clean, topics still drift, still no hard fault", () => {
		const block = workBlock(PRE_090_TOPICS, POST_089_PILLARS, POST_089_PROPERTIES);
		const result = reconcileDomainConfig(block, liveWorkDailyLog);

		expect(find(result, "pillars").status).toBe("ok");
		expect(find(result, "topics").missing).toEqual(["Round", "EHS"]);
	});

	it("window 3 — both pushed: everything reconciles and nothing is quarantined", () => {
		const block = workBlock(POST_090_TOPICS, POST_089_PILLARS, POST_089_PROPERTIES);
		const result = reconcileDomainConfig(block, liveWorkDailyLog);

		expect(hasDrift(result)).toBe(false);
		expect(quarantinedValues(result)).toEqual([]);
	});

	it("reads a pre-089 pillar's notion_property as an option, and those options are live", () => {
		// The backfill carried every checkbox name over as a `Pillars` option, so the
		// old strings still reconcile. Treating them as PROPERTY names instead would
		// make the whole window look broken.
		const block = workBlock(POST_090_TOPICS, PRE_089_PILLARS, POST_089_PROPERTIES);
		const pillars = find(reconcileDomainConfig(block, liveWorkDailyLog), "pillars");

		expect(pillars.status).toBe("ok");
		expect(pillars.configured).toEqual(["P1 Launch", "P2 Round", "P3 EHS", "P4 Retention/WTP"]);
	});
});

describe("degenerate shapes are reported, never guessed at", () => {
	it("a pillar with no option does not project and is not a missing value", () => {
		const block = workBlock(
			POST_090_TOPICS,
			[
				{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Product" },
				{ key: "Pillar 2", label: "Quiet", description: "no projection" },
			],
			POST_089_PROPERTIES,
		);
		const pillars = find(reconcileDomainConfig(block, liveWorkDailyLog), "pillars");

		expect(pillars.configured).toEqual(["Product"]);
		expect(pillars.status).toBe("ok");
	});

	it("a declared property Notion does not have quarantines the whole vocabulary", () => {
		const block = workBlock(
			["Apple"],
			[],
			[{ name: "Other domains", notion_type: "multi_select", required: false }],
		);
		const topics = find(
			reconcileDomainConfig(block, { properties: [{ name: "Name", type: "title" }] }),
			"topics",
		);

		expect(topics.status).toBe("absent");
		// Nothing is individually `missing`: with no property there is no option set to
		// compare each value against. The QUARANTINE is still the whole vocabulary, and
		// that is the number the verdict line counts — reading `missing` there would
		// report zero unwritable values above a line saying to write none of them.
		expect(topics.missing).toEqual([]);
		expect(
			quarantinedValues(
				reconcileDomainConfig(block, { properties: [{ name: "Name", type: "title" }] }),
			),
		).toEqual(["Apple"]);
		expect(hasDrift(reconcileDomainConfig(block, { properties: [] }))).toBe(true);
	});

	it("a live property with no options is unenforceable, not drift", () => {
		// The `angus` Daily Log is documented this way. Every value would be CREATED on
		// write (#695) rather than rejected, which is a different fault with a different
		// fix — so it gets a different status and quarantines nothing.
		const block = workBlock(["Health", "Fitness"], [], POST_089_PROPERTIES);
		const result = reconcileDomainConfig(block, {
			properties: [{ name: "Other domains", type: "multi_select" }],
		});

		expect(find(result, "topics").status).toBe("no_options");
		expect(quarantinedValues(result)).toEqual([]);
		expect(hasDrift(result)).toBe(false);
		// …and "no drift" must not be readable as "verified". Nothing was compared here.
		expect(unverifiedVocabularies(result).map((v) => v.vocabulary)).toEqual(["topics"]);
	});

	it("counts an unresolved binding as unverified, and a clean or empty one as not", () => {
		// Topics has no declared property in daily_log_schema.
		// A verdict that folded that into an all-clear would claim to have checked a
		// vocabulary it never looked at.
		const unresolvedTopics = reconcileDomainConfig(
			workBlock(POST_090_TOPICS, [], [
				{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
			]),
			liveWorkDailyLog,
		);
		expect(find(unresolvedTopics, "topics").status).toBe("unresolved");
		expect(unverifiedVocabularies(unresolvedTopics).map((v) => v.vocabulary)).toEqual(["topics"]);

		// `empty` is not unverified: a vocabulary that writes nothing has nothing to
		// verify, so an all-clear is true of it rather than unknown.
		const clean = reconcileDomainConfig(
			workBlock(POST_090_TOPICS, [], POST_089_PROPERTIES),
			liveWorkDailyLog,
		);
		expect(find(clean, "pillars").status).toBe("empty");
		expect(unverifiedVocabularies(clean)).toEqual([]);
	});

	it("an empty vocabulary is checked as empty rather than as an all-clear", () => {
		const block = workBlock([], [], POST_089_PROPERTIES);
		const result = reconcileDomainConfig(block, liveWorkDailyLog);

		expect(find(result, "topics").status).toBe("empty");
		expect(find(result, "pillars").status).toBe("empty");
	});

	it("trims blank values out rather than reporting them as missing options", () => {
		const block = workBlock(["Apple", "  ", ""], [], POST_089_PROPERTIES);
		const topics = find(reconcileDomainConfig(block, liveWorkDailyLog), "topics");

		expect(topics.configured).toEqual(["Apple"]);
		expect(topics.status).toBe("ok");
	});
});

describe("schema properties validation (#1728)", () => {
	const findProp = (report: ReturnType<typeof reconcileDomainConfig>, name: string) => {
		const p = report.properties?.find((prop) => prop.name === name);
		if (!p) throw new Error(`Property ${name} not in report`);
		return p;
	};

	it("detects the Angus Type deadlock: required 'Daily' option missing when only 'Catch-up' is live", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Type", notion_type: "select", required: true },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Type", type: "select", options: ["Catch-up"] },
			],
		};

		const result = reconcileDomainConfig(block, liveSchema, "angus");
		expect(hasPropertyDrift(result)).toBe(true);

		const prop = findProp(result, "Type");
		expect(prop.status).toBe("missing_options");
		expect(prop.missingOptions).toEqual(["Daily"]);
		expect(prop.availableOptions).toEqual(["Catch-up"]);
		expect(prop.remediation).toContain("Add option(s) 'Daily' to the 'Type' property in Notion (angus workspace)");
	});

	it("detects Work Covers property type mismatch (role 'covers' requires rich_text or multi_select)", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Covers", notion_type: "rich_text", required: false, role: "covers" },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Covers", type: "people" },
			],
		};

		const result = reconcileDomainConfig(block, liveSchema, "work");
		expect(hasPropertyDrift(result)).toBe(true);

		const prop = findProp(result, "Covers");
		expect(prop.status).toBe("type_mismatch");
		expect(prop.expectedType).toBe("rich_text | multi_select");
		expect(prop.actualType).toBe("people");
		expect(prop.detail).toContain("#1016");
		expect(prop.remediation).toContain("rich_text or multi_select");
	});

	it("flags missing Covers property as drift with remediation per #1016", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Covers", notion_type: "rich_text", required: false, role: "covers" },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [{ name: "Name", type: "title" }],
		};

		const result = reconcileDomainConfig(block, liveSchema, "work");
		expect(hasPropertyDrift(result)).toBe(true);

		const prop = findProp(result, "Covers");
		expect(prop.status).toBe("missing_optional");
		expect(prop.remediation).toContain("rich_text or multi_select");
	});

	it("flags missing required property as drift", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Summary", notion_type: "rich_text", required: true },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [{ name: "Name", type: "title" }],
		};

		const result = reconcileDomainConfig(block, liveSchema);
		expect(hasPropertyDrift(result)).toBe(true);

		const prop = findProp(result, "Summary");
		expect(prop.status).toBe("missing_required");
		expect(prop.remediation).toContain("Add property 'Summary' (rich_text)");
	});

	it("flags general property type mismatch (e.g. Type is text instead of select)", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Type", notion_type: "select", required: true },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Type", type: "rich_text" },
			],
		};

		const result = reconcileDomainConfig(block, liveSchema);
		expect(hasPropertyDrift(result)).toBe(true);

		const prop = findProp(result, "Type");
		expect(prop.status).toBe("type_mismatch");
		expect(prop.actualType).toBe("rich_text");
		expect(prop.expectedType).toBe("select");
	});

	it("reports property with no options as unenforceable, not drift", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Type", notion_type: "select", required: true },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Type", type: "select", options: [] },
			],
		};

		const result = reconcileDomainConfig(block, liveSchema);
		expect(hasPropertyDrift(result)).toBe(false);

		const prop = findProp(result, "Type");
		expect(prop.status).toBe("no_options");
		expect(unverifiedProperties(result).map((p) => p.name)).toEqual(["Type"]);
	});

	it("validates explicitly declared property options in config", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Custom", notion_type: "select", required: false, options: ["Alpha", "Beta"] },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Custom", type: "select", options: ["Alpha"] },
			],
		};

		const result = reconcileDomainConfig(block, liveSchema);
		expect(hasPropertyDrift(result)).toBe(true);

		const prop = findProp(result, "Custom");
		expect(prop.status).toBe("missing_options");
		expect(prop.missingOptions).toEqual(["Beta"]);
	});

	it("passes cleanly when all declared properties match Notion types and required options", () => {
		const block = parseBlock({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Date", notion_type: "date", required: true },
					{ name: "Type", notion_type: "select", required: true },
					{ name: "Summary", notion_type: "rich_text", required: true },
					{ name: "Covers", notion_type: "rich_text", required: false, role: "covers" },
					{ name: "Synthesis Status", notion_type: "select", required: true },
				],
				body_sections: [],
			},
		});

		const liveSchema: NotionDatabaseSchema = {
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Date", type: "date" },
				{ name: "Type", type: "select", options: ["Daily", "Catch-up"] },
				{ name: "Summary", type: "rich_text" },
				{ name: "Covers", type: "rich_text" },
				{ name: "Synthesis Status", type: "select", options: ["Confirmed", "Unconfirmed"] },
			],
		};

		const result = reconcileDomainConfig(block, liveSchema);
		expect(hasPropertyDrift(result)).toBe(false);
		expect(propertyDriftFindings(result)).toEqual([]);
		expect(unverifiedProperties(result)).toEqual([]);
		expect(result.properties?.every((p) => p.status === "ok")).toBe(true);
	});
});
