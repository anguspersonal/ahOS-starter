/**
 * Place entity dedupe (#188).
 *
 * artifact_sync_entities matches candidates by (user_id, entity_type, title)
 * before falling back to fuzzy scoring. For places that's not enough: two
 * different KINDS of place can share a title ("Edinburgh" the city vs. a venue
 * also named "Edinburgh"), and title+entity_type alone would silently conflate
 * them into one node. These tests pin:
 *   1. a place mentioned twice with the same (title, place_type) dedupes via
 *      the exact-match path (no duplicate created);
 *   2. a place_type mismatch on an otherwise title-identical place is NOT
 *      treated as the same entity (falls through to create, not merge);
 *   3. a place with no place_type declared still matches an existing place of
 *      the same title that also has none (place_type absence isn't a
 *      mismatch).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";

const artifactEntitySyncHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("artifact_sync_entities")!).handler(args);

const ART_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const EDINBURGH_CITY_ID = "cccccccc-0000-0000-0000-000000000001";
const EDINBURGH_VENUE_ID = "cccccccc-0000-0000-0000-000000000002";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/**
 * A chainable query-builder stub. `.eq(col, val)` records every (column, value)
 * pair applied to the chain so tests can assert the place_type scoping was
 * actually sent to Postgrest, not just that *a* result came back.
 */
function chainBuilder(result: unknown) {
	const calls: Array<[string, unknown]> = [];
	const b: any = {
		select: () => b,
		eq: (col: string, val: unknown) => {
			calls.push([col, val]);
			return b;
		},
		ilike: (col: string, val: unknown) => {
			calls.push([`ilike:${col}`, val]);
			return b;
		},
		in: () => b,
		limit: (n: number) => {
			calls.push(["limit", n]);
			return b;
		},
		maybeSingle: () => Promise.resolve(result),
		then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
		_calls: calls,
	};
	return b;
}

function upsertLinkStub() {
	return vi.fn().mockReturnValue({
		select: vi.fn().mockResolvedValue({
			data: [{ id: "link-place-001", artifact_id: ART_ID, entity_id: EDINBURGH_CITY_ID, link_type: "mentioned" }],
			error: null,
		}),
	});
}

describe("artifactEntitySyncHandler — place dedupe (#188)", () => {
	it("dedupes a place mentioned twice with the same title + place_type (exact match, no create)", async () => {
		const existingCity = {
			id: EDINBURGH_CITY_ID,
			entity_type: "place",
			title: "Edinburgh",
			description: null,
			archived: false,
			properties: { place_type: "city" },
			tags: [],
		};

		const entitiesBuilder = chainBuilder({ data: existingCity, error: null });
		const upsertLink = upsertLinkStub();

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			return entitiesBuilder;
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [
				{
					entity_type: "place",
					title: "Edinburgh",
					properties: { place_type: "city" },
				},
			],
		});

		// findExactEntity's place_type scoping was applied to the query.
		expect(entitiesBuilder._calls).toContainEqual(["properties->>place_type", "city"]);
		expect(result.content[0].text).toContain("0 created, 1 matched/linked");
		expect(result.content[0].text).toContain(EDINBURGH_CITY_ID);
		expect(result.content[0].text).toContain("linked-existing");
	});

	it("does NOT merge a place_type mismatch on a title-identical place (falls through to create)", async () => {
		const existingCity = {
			id: EDINBURGH_CITY_ID,
			entity_type: "place",
			title: "Edinburgh",
			description: null,
			archived: false,
			properties: { place_type: "city" },
			tags: [],
		};

		const upsertLink = upsertLinkStub();
		let call = 0;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			call += 1;
			if (call === 1) {
				// findExactEntity, scoped to place_type='venue': no row matches
				// (the only existing row is place_type='city').
				return chainBuilder({ data: null, error: null });
			}
			if (call === 2) {
				// findBestMatch's candidate scan (entity_type='place', no place_type
				// filter) returns the city row; scoreCandidate must penalise it hard
				// enough to fall below the >=60 acceptance threshold.
				return chainBuilder({ data: [existingCity], error: null });
			}
			// createEntity's insert().select()
			return {
				insert: () => ({
					select: () =>
						Promise.resolve({
							data: [
								{
									id: EDINBURGH_VENUE_ID,
									entity_type: "place",
									title: "Edinburgh",
									description: null,
									archived: false,
									properties: { place_type: "venue" },
									tags: [],
								},
							],
							error: null,
						}),
				}),
			};
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [
				{
					entity_type: "place",
					title: "Edinburgh",
					properties: { place_type: "venue" },
				},
			],
		});

		expect(result.content[0].text).toContain(EDINBURGH_VENUE_ID);
		expect(result.content[0].text).toContain("created");
		expect(result.content[0].text).not.toContain(EDINBURGH_CITY_ID);
	});

	it("matches an existing same-title place when neither side declares a place_type", async () => {
		const existingPlace = {
			id: EDINBURGH_CITY_ID,
			entity_type: "place",
			title: "3 Avenue Villas",
			description: null,
			archived: false,
			properties: {},
			tags: [],
		};

		const entitiesBuilder = chainBuilder({ data: existingPlace, error: null });
		const upsertLink = upsertLinkStub();

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			return entitiesBuilder;
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [{ entity_type: "place", title: "3 Avenue Villas" }],
		});

		// No place_type declared on the source -> the query is not scoped by it.
		const calls = entitiesBuilder._calls as Array<[string, unknown]>;
		expect(calls.some(([col]: [string, unknown]) => col === "properties->>place_type")).toBe(false);
		expect(result.content[0].text).toContain(EDINBURGH_CITY_ID);
		expect(result.content[0].text).toContain("linked-existing");
	});

	it("does NOT fuzzy-match an unrelated entity of the same type merely because of overlapping tags", async () => {
		const existingOrg = {
			id: "dddddddd-0000-0000-0000-000000000001",
			entity_type: "organization",
			title: "LogicRays Technologies",
			description: "Existing software agency",
			archived: false,
			properties: {},
			tags: ["service", "removals"],
		};
		const newOrgId = "dddddddd-0000-0000-0000-000000000002";

		const upsertLink = upsertLinkStub();
		let call = 0;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			call += 1;
			if (call === 1) {
				// findExactEntity returns no match
				return chainBuilder({ data: null, error: null });
			}
			if (call === 2) {
				// findBestMatch returns an unrelated organization that shares entity_type + tags
				return chainBuilder({ data: [existingOrg], error: null });
			}
			return {
				insert: () => ({
					select: () =>
						Promise.resolve({
							data: [
								{
									id: newOrgId,
									entity_type: "organization",
									title: "Man and Van Collective",
									description: "Edinburgh removals service",
									archived: false,
									properties: {},
									tags: ["service", "removals"],
								},
							],
							error: null,
						}),
				}),
			};
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [
				{
					entity_type: "organization",
					title: "Man and Van Collective",
					description: "Edinburgh removals service",
					tags: ["service", "removals"],
				},
			],
		});

		expect(result.content[0].text).toContain("1 created, 0 matched/linked");
		expect(result.content[0].text).toContain(newOrgId);
		expect(result.content[0].text).not.toContain(existingOrg.id);
	});

	it("does NOT false-match a short 2-3 char title ('AI') as a substring of an unrelated title ('Fairview')", async () => {
		const existingOrg = {
			id: "dddddddd-0000-0000-0000-000000000010",
			entity_type: "organization",
			title: "AI",
			description: "Short acronym org",
			archived: false,
			properties: {},
			tags: [],
		};
		const newOrgId = "dddddddd-0000-0000-0000-000000000011";

		const upsertLink = upsertLinkStub();
		let call = 0;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			call += 1;
			if (call === 1) return chainBuilder({ data: null, error: null });
			if (call === 2) return chainBuilder({ data: [existingOrg], error: null });
			return {
				insert: () => ({
					select: () =>
						Promise.resolve({
							data: [
								{
									id: newOrgId,
									entity_type: "organization",
									title: "Fairview",
									description: "Unrelated organization containing 'ai' substring",
									archived: false,
									properties: {},
									tags: [],
								},
							],
							error: null,
						}),
				}),
			};
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [{ entity_type: "organization", title: "Fairview" }],
		});

		expect(result.content[0].text).toContain("1 created, 0 matched/linked");
		expect(result.content[0].text).toContain(newOrgId);
		expect(result.content[0].text).not.toContain(existingOrg.id);
	});

	it("links an existing entity when source title matches an alias in entity.aliases or properties.aliases", async () => {
		const existingOrg = {
			id: "dddddddd-0000-0000-0000-000000000020",
			entity_type: "organization",
			title: "Man and Van Collective",
			description: "Edinburgh & London removals",
			archived: false,
			properties: { aliases: ["Man & Van"] },
			tags: ["vendor"],
			aliases: ["MVC"],
		};

		const upsertLink = upsertLinkStub();
		let call = 0;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			call += 1;
			if (call === 1) return chainBuilder({ data: null, error: null });
			// ilike("title", "%MVC%") returns empty -> fallback query returns existingOrg with aliases: ["MVC"]
			if (call === 2) return chainBuilder({ data: [], error: null });
			return chainBuilder({ data: [existingOrg], error: null });
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [{ entity_type: "organization", title: "MVC" }],
		});

		expect(result.content[0].text).toContain("0 created, 1 matched/linked");
		expect(result.content[0].text).toContain(existingOrg.id);
		expect(result.content[0].text).toContain("linked-existing");
	});

	it("finds and links a matching candidate beyond the first 10 rows via ilike filtering and widened limit", async () => {
		const fillerOrgs = Array.from({ length: 12 }, (_, idx) => ({
			id: `eeeeeeee-0000-0000-0000-0000000000${String(idx + 1).padStart(2, "0")}`,
			entity_type: "organization",
			title: `Unrelated Org ${idx + 1}`,
			description: null,
			archived: false,
			properties: {},
			tags: ["vendor"],
			aliases: [],
		}));
		const targetOrg = {
			id: "eeeeeeee-0000-0000-0000-000000000099",
			entity_type: "organization",
			title: "Man and Van Collective",
			description: "Removals service",
			archived: false,
			properties: {},
			tags: ["vendor"],
			aliases: [],
		};

		const upsertLink = upsertLinkStub();
		let findBestMatchBuilder: any;
		let call = 0;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") return { upsert: upsertLink };
			call += 1;
			if (call === 1) return chainBuilder({ data: null, error: null });
			findBestMatchBuilder = chainBuilder({ data: [...fillerOrgs, targetOrg], error: null });
			return findBestMatchBuilder;
		});

		const result = await artifactEntitySyncHandler({
			artifact_id: ART_ID,
			entities: [{ entity_type: "organization", title: "Man and Van Collective (London)", tags: ["vendor"] }],
		});

		expect(findBestMatchBuilder._calls).toContainEqual(["ilike:title", "%Man and Van Collective (London)%"]);
		expect(findBestMatchBuilder._calls).toContainEqual(["limit", 100]);
		expect(result.content[0].text).toContain("0 created, 1 matched/linked");
		expect(result.content[0].text).toContain(targetOrg.id);
		expect(result.content[0].text).toContain("linked-existing");
	});
});
