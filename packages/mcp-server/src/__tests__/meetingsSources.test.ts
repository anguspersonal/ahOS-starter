import { describe, expect, it } from "vitest";
import { notionConfigSchema } from "../integrations.js";
import { meetingsSources } from "../meetingsSources.js";

// Obviously fake ids — never a real Notion data source.
const PUBLIC_SOURCE = "00000000-fake-public-meetings";
const PRIVATE_SOURCE = "00000000-fake-private-meetings";

const configured = {
	meetings_source_data_source_id: PUBLIC_SOURCE,
	private_meetings_source_data_source_id: PRIVATE_SOURCE,
};

/**
 * A meetings feed spanning both databases. The private rows carry exactly the material
 * ADR-053 §6 names as the reason the source was split off in the first place; if any of
 * it survives into the projection, these tests fail loudly rather than describing a rule
 * nobody checks.
 */
const MEETINGS = [
	{ source: PUBLIC_SOURCE, title: "Weekly product sync", note: "4.8 build resubmitted" },
	{ source: PRIVATE_SOURCE, title: "Briana/Angus weekly", note: "contractor pay; open contractual dispute" },
	{ source: PUBLIC_SOURCE, title: "Apple review call", note: "SIWA fix accepted" },
	{ source: PRIVATE_SOURCE, title: "Runway review", note: "runway detail; candid remarks on a named member" },
];

/**
 * The Recent Communications projection, reduced to its one load-bearing decision:
 * which sources it is allowed to select rows from. Everything else about the section
 * (cap, ordering, wording) is drafted by the ritual; this is the part that decides
 * whether private content can reach the State Doc at all.
 */
const projectRecentCommunications = (config: Parameters<typeof meetingsSources>[0]) => {
	const { project } = meetingsSources(config);
	return MEETINGS.filter((m) => project.includes(m.source));
};

describe("meetingsSources (#617, ADR-053 §6)", () => {
	it("reads both sources but offers only the public one for projection", () => {
		const sources = meetingsSources(configured);

		expect(sources.read).toEqual([PUBLIC_SOURCE, PRIVATE_SOURCE]);
		expect(sources.project).toEqual([PUBLIC_SOURCE]);
		expect(sources.project).not.toContain(PRIVATE_SOURCE);
	});

	it("keeps the public source as the single capture WRITE destination", () => {
		// The reason this is a second named key and not an array: a meeting can be read
		// from two databases, but written to exactly one, and a list says nothing about
		// which element wins.
		expect(meetingsSources(configured).captureWrite).toBe(PUBLIC_SOURCE);
	});

	it("keeps private-source meetings out of the Recent Communications projection", () => {
		const projected = projectRecentCommunications(configured);

		expect(projected.map((m) => m.title)).toEqual([
			"Weekly product sync",
			"Apple review call",
		]);

		// Nothing from the private DB — not the id, not a title, not a fragment of a note.
		const serialised = JSON.stringify(projected);
		expect(serialised).not.toContain(PRIVATE_SOURCE);
		expect(serialised).not.toContain("Briana/Angus weekly");
		expect(serialised).not.toContain("Runway review");
		expect(serialised).not.toContain("contractual dispute");
		expect(serialised).not.toContain("runway detail");
	});

	it("does not fall back to the private source when the public one is unset", () => {
		const privateOnly = { private_meetings_source_data_source_id: PRIVATE_SOURCE };
		const sources = meetingsSources(privateOnly);

		expect(sources.read).toEqual([PRIVATE_SOURCE]);
		expect(sources.project).toEqual([]); // no source beats the wrong source
		expect(sources.captureWrite).toBeUndefined();
		expect(projectRecentCommunications(privateOnly)).toEqual([]);
	});

	it("behaves exactly as before for a config that never sets the private key (additive)", () => {
		const sources = meetingsSources({ meetings_source_data_source_id: PUBLIC_SOURCE });

		expect(sources.read).toEqual([PUBLIC_SOURCE]);
		expect(sources.project).toEqual([PUBLIC_SOURCE]);
		expect(sources.captureWrite).toBe(PUBLIC_SOURCE);
	});

	it("returns empty roles when neither meetings pointer is configured", () => {
		const sources = meetingsSources({});

		expect(sources.read).toEqual([]);
		expect(sources.project).toEqual([]);
		expect(sources.captureWrite).toBeUndefined();
	});
});

describe("notionConfigSchema private meetings key (#617)", () => {
	it("is optional: an existing config without it still parses untouched", () => {
		const legacy = {
			tasks_database_id: "db_work",
			meetings_source_data_source_id: PUBLIC_SOURCE,
		};

		const parsed = notionConfigSchema.parse(legacy);

		expect(parsed.meetings_source_data_source_id).toBe(PUBLIC_SOURCE);
		expect(parsed.private_meetings_source_data_source_id).toBeUndefined();
	});

	it("accepts the private key alongside the existing one, leaving it unchanged", () => {
		const parsed = notionConfigSchema.parse({
			tasks_database_id: "db_work",
			...configured,
		});

		expect(parsed.meetings_source_data_source_id).toBe(PUBLIC_SOURCE);
		expect(parsed.private_meetings_source_data_source_id).toBe(PRIVATE_SOURCE);
	});
});
