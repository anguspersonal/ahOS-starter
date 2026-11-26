import { afterEach, describe, expect, it, vi } from "vitest";

import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entitiesQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_query")!).handler(args);
const peopleMatchHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_match")!).handler(args);
const peopleQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_query")!).handler(args);
const peopleUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_update")!).handler(args);
const peopleUpsertHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_upsert")!).handler(args);

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/**
 * Stub the query builder and record the row cap the handler asked the database for.
 * `rows` is treated as the full table ordered by updated_at desc; the stub returns
 * only the first `cap` of them, exactly as Postgres would.
 */
function stubTable(rows: unknown[]) {
	const seen = { limit: 0 };
	const b: any = {
		select: () => b,
		eq: () => b,
		in: () => b,
		order: () => b,
		limit: (n: number) => {
			seen.limit = n;
			return Promise.resolve({ data: rows.slice(0, n), error: null });
		},
		// ADR-084's resolver (entities_query wiring) also reads
		// `user_preferences.dos_config` (`.maybeSingle()`, no terminal `.limit()`)
		// once per call (QA round 1, Medium) and batches each page's primary
		// `belongs_to` parent via a plain `.eq()`/`.in()` chain with no terminal
		// call at all — awaiting `b` itself (no `.then`) resolves to `b`, whose
		// undefined `data`/`error` read as "no parent found", which is correct
		// here since none of these fixtures set up containment.
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
	return seen;
}

const person = (id: string, name: string) => ({
	id,
	name,
	bio: null,
	role: null,
	organization: null,
	email: null,
	phone: null,
	relationship: null,
	last_contact: null,
	tags: [],
	archived: false,
	archived_at: null,
	properties: {},
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
});

/** 30 filler people, then the target — so the target sits outside a limit of 5 or 20. */
function peopleWithBuriedTarget() {
	const filler = Array.from({ length: 30 }, (_, i) => person(`filler-${i}`, `Filler ${i}`));
	return [...filler, person("sam-1", "Sam")];
}

describe("people limit is applied after filtering (#423)", () => {
	it("finds a match buried past the default limit", async () => {
		const seen = stubTable(peopleWithBuriedTarget());

		const res = await peopleMatchHandler({ name: "Sam" });

		expect(seen.limit).toBeGreaterThan(30);
		expect(res.content[0].text).toContain("sam-1");
		expect(res.content[0].text).not.toContain("No candidates found");
	});

	it("scores every matching candidate, not just `limit` of them", async () => {
		// Two rivals bracket the target: an exact "Sam" buried last, a weaker
		// "Samantha" first. Truncating before scoring would crown Samantha.
		const rows = [
			person("samantha-1", "Samantha"),
			...Array.from({ length: 30 }, (_, i) => person(`filler-${i}`, `Sample ${i}`)),
			person("sam-1", "Sam"),
		];
		stubTable(rows);

		const res = await peopleMatchHandler({ name: "Sam", limit: 1 });
		const text = res.content[0].text;

		expect(text).toContain("Best candidate: [sam-1]");
		expect(text).toContain("exact name match");
		// `limit` caps what is shown, but the total matched is still reported so a
		// caller can see the match was ambiguous.
		expect(text).toContain("showing 1 of 32 matched");
	});

	it("still honours limit as a cap on rows returned", async () => {
		stubTable(peopleWithBuriedTarget());

		const res = await peopleQueryHandler({ query: "Filler", limit: 3 });

		expect(res.content[0].text).toContain("People (3):");
	});

	it("reports no people found when nothing matches", async () => {
		stubTable(peopleWithBuriedTarget());

		const res = await peopleQueryHandler({ query: "Nobody" });

		expect(res.content[0].text).toBe("No people found.");
	});

	it("uses the plain limit as the database cap when there is no query", async () => {
		const seen = stubTable(peopleWithBuriedTarget());

		await peopleQueryHandler({ limit: 7 });

		expect(seen.limit).toBe(7);
	});
});

const entity = (id: string, title: string, properties: Record<string, unknown> = {}) => ({
	id,
	entity_type: "concept",
	title,
	description: null,
	archived: false,
	archived_at: null,
	properties,
	tags: [],
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
});

describe("entities limit is applied after filtering (#423)", () => {
	it("finds a match buried past the default limit", async () => {
		const rows = [
			...Array.from({ length: 30 }, (_, i) => entity(`filler-${i}`, `Filler ${i}`)),
			entity("target-1", "Provenance laundering"),
		];
		stubTable(rows);

		const res = await entitiesQueryHandler({ query: "laundering" });

		expect(res.content[0].text).toContain("target-1");
	});

	it("matches on stringified properties beyond the limit window", async () => {
		const rows = [
			...Array.from({ length: 30 }, (_, i) => entity(`filler-${i}`, `Filler ${i}`)),
			entity("target-2", "Untitled", { source_url: "https://notion.so/abc" }),
		];
		stubTable(rows);

		const res = await entitiesQueryHandler({ query: "notion.so" });

		expect(res.content[0].text).toContain("target-2");
	});
});

describe("people previous_emails preservation and matching (#2053)", () => {
	const PERSON_ID = "11111111-1111-1111-1111-111111111111";

	it("preserves existing non-null email in properties.previous_emails (lowercased, deduplicated) on peopleUpdateHandler", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: () => {
						const b: any = {
							eq: () => b,
							in: () => b,
							limit: () =>
								Promise.resolve({
									data: [
										{
											id: PERSON_ID,
											properties: {
												email: "Alice@example.com",
												role: "Staff Engineer",
												previous_emails: ["alice@ earlier.com "],
											},
										},
									],
									error: null,
								}),
						};
						return b;
					},
					update: (payload: Record<string, unknown>) => {
						updatePayload = payload;
						const b: any = {
							eq: () => b,
							in: () => b,
							select: () =>
								Promise.resolve({
									data: [
										{
											id: PERSON_ID,
											title: "Alice",
											description: null,
											properties: payload.properties ?? {},
											aliases: [],
										},
									],
									error: null,
								}),
						};
						return b;
					},
				};
			}
			return {
				upsert: () => Promise.resolve({ error: null }),
			};
		});

		await peopleUpdateHandler({
			ids: [PERSON_ID],
			patch: { email: "alice@example.com" },
		});

		expect(updatePayload?.properties).toEqual({
			email: "alice@example.com",
			role: "Staff Engineer",
			previous_emails: ["alice@ earlier.com", "alice@example.com"],
		});
	});

	it("preserves existing non-null email in properties.previous_emails on peopleUpsertHandler without duplicating when re-used", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: () => {
						const b: any = {
							eq: () => b,
							in: () => b,
							limit: () =>
								Promise.resolve({
									data: [
										{
											id: PERSON_ID,
											properties: {
												email: "Bob@example.com",
												previous_emails: ["bob@example.com", "bob@example.com"],
											},
										},
									],
									error: null,
								}),
						};
						return b;
					},
					update: (payload: Record<string, unknown>) => {
						updatePayload = payload;
						const b: any = {
							eq: () => b,
							select: () =>
								Promise.resolve({
									data: [
										{
											id: PERSON_ID,
											title: "Bob",
											description: null,
											properties: payload.properties ?? {},
											aliases: [],
										},
									],
									error: null,
								}),
						};
						return b;
					},
				};
			}
			return {
				upsert: () => Promise.resolve({ error: null }),
			};
		});

		await peopleUpsertHandler({
			people: [{ id: PERSON_ID, name: "Bob", email: "bob@example.com" }],
		});

		expect(updatePayload?.properties).toEqual({
			email: "bob@example.com",
			previous_emails: ["bob@example.com", "bob@example.com"],
		});
	});

	it("matches against properties.previous_emails in peopleQueryHandler and scores 65 ('previous email match') in peopleMatchHandler", async () => {
		const rows = [
			{
				...person(PERSON_ID, "Alice Smith"),
				email: "alice@example.com",
				properties: {
					email: "alice@example.com",
					previous_emails: ["alice@example.com"],
				},
			},
		];
		stubTable(rows);

		const queryRes = await peopleQueryHandler({ query: "alice@example.com" });
		expect(queryRes.content[0].text).toContain(PERSON_ID);

		const matchRes = await peopleMatchHandler({
			name: "Alice Smith",
			email: "ALICE@example.com",
		});
		const matchText = matchRes.content[0].text;
		// 60 (exact name match) + 65 (previous email match) = 125
		expect(matchText).toContain(`score 125`);
		expect(matchText).toContain("exact name match, previous email match");
	});
});
