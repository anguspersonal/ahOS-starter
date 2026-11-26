import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import type { PeopleRepository, PersonRow } from "../../ports/people.js";
import { createPersonMatchAction, formatPersonMatchMcp, PERSON_MATCH_DESCRIPTION } from "./match.js";
import { scoreCandidate } from "./scoring.js";
import { PEOPLE_SCAN_LIMIT } from "./shared.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CTX: ActionContext = { caller: "mcp", requestId: "req-person-match-1", userId: USER_ID };
const EMAIL_PATTERN =
	"^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";

const PERSON_MATCH_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		name: { description: "Name to match (required unless `candidates` is provided).", type: "string", minLength: 1 },
		email: { description: "Optional email address from the source.", type: "string", format: "email", pattern: EMAIL_PATTERN },
		organization: { description: "Optional organization from the source.", type: "string" },
		role: { description: "Optional role from the source.", type: "string" },
		relationship: { description: "Optional relationship from the source.", type: "string" },
		candidates: {
			description:
				"Batch of 1\u201320 candidates to match in a single query. Each item may be a candidate object ({ name, email?, organization?, role?, relationship? }) or a name string.",
			minItems: 1,
			maxItems: 20,
			type: "array",
			items: {
				anyOf: [
					{
						type: "object",
						properties: {
							name: { type: "string", minLength: 1, description: "Name to match." },
							email: { description: "Optional email address from the source.", type: "string", format: "email", pattern: EMAIL_PATTERN },
							organization: { description: "Optional organization from the source.", type: "string" },
							role: { description: "Optional role from the source.", type: "string" },
							relationship: { description: "Optional relationship from the source.", type: "string" },
						},
						required: ["name"],
						additionalProperties: false,
					},
					{ type: "string", minLength: 1 },
				],
			},
		},
		limit: { description: "Max candidates to return (default 5).", type: "integer", minimum: 1, maximum: 20 },
		include_archived: { description: "Include archived rows. Defaults to false.", type: "boolean" },
	},
	additionalProperties: false,
};

const makePerson = (id: string, name: string, overrides: Partial<PersonRow> = {}): PersonRow => ({
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
	source_url: null,
	user_id: USER_ID,
	team_id: null,
	created_at: null,
	updated_at: null,
	aliases: [],
	hot: false,
	...overrides,
});

const makeFakeRepo = (overrides: Partial<PeopleRepository> = {}): PeopleRepository => ({
	getById: vi.fn(async () => null),
	load: vi.fn(async () => ({ rows: [], truncated: false })),
	...overrides,
});

describe("person_match core action and candidate scoring (#1516)", () => {
	it("case 1: contract parity (id, JSON schema snapshot, description, annotations)", () => {
		const action = createPersonMatchAction(makeFakeRepo());
		expect(action.id).toBe("person_match");
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_MATCH_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(PERSON_MATCH_DESCRIPTION);
		expect(action.description).toBe(
			"Rank candidate people rows for a source person using name plus optional email, organization, role, and relationship clues.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("case 2: scans with PEOPLE_SCAN_LIMIT and cuts only sorted results to limit (single and batch modes)", async () => {
		const rows = [
			makePerson("samantha-1", "Samantha"),
			...Array.from({ length: 6 }, (_, i) => makePerson(`sample-${i}`, `Sample ${i}`)),
			makePerson("sam-1", "Sam"),
		];
		const repo = makeFakeRepo({ load: vi.fn(async () => ({ rows, truncated: false })) });
		const action = createPersonMatchAction(repo);

		const res = await executeAction(action, { name: "Sam" }, { context: CTX });
		expect(repo.load).toHaveBeenCalledWith({ query: "Sam", include_archived: undefined, limit: PEOPLE_SCAN_LIMIT }, USER_ID);
		expect(res.sections[0].candidates).toHaveLength(5);
		expect(res.sections[0].candidates[0].person.id).toBe("sam-1");
		expect(res.sections[0].totalMatched).toBe(8);

		const batchRepo = makeFakeRepo({
			load: vi.fn(async () => ({
				rows: [makePerson("anna-1", "Anna Sharp", { email: "anna@example.com" }), makePerson("laura-1", "Laura Sharp", { aliases: ["Lara"] })],
				truncated: false,
			})),
		});
		const batchRes = await executeAction(
			createPersonMatchAction(batchRepo),
			{ candidates: [{ name: "Anna", email: "anna@example.com" }, "Lara", "Nobody"], limit: 1, include_archived: true },
			{ context: CTX },
		);
		expect(batchRepo.load).toHaveBeenCalledTimes(1);
		expect(batchRepo.load).toHaveBeenCalledWith({ include_archived: true, limit: PEOPLE_SCAN_LIMIT }, USER_ID);
		const batchText = formatPersonMatchMcp(batchRes);
		expect(batchText).toContain("### Anna\nMatch result: exact or near-exact match");
		expect(batchText).toContain("### Lara\nMatch result: probable match");
		expect(batchText).toContain("### Nobody\nNo candidates found.");

		await expect(executeAction(action, {}, { context: CTX })).rejects.toThrow(/provide `name` or `candidates`/);
	});

	it("case 3: preserves verdict thresholds (>=90 exact/near-exact, >=60 probable, <60 possible) and pure scoring weights", async () => {
		const p90 = makePerson("p-90", "Robert Smith", {
			aliases: ["Bobby"],
			organization: "Acme Corp",
			role: "Staff Engineer",
			relationship: "colleague",
		});
		expect(scoreCandidate(p90, { name: "Bob", organization: "Acme", role: "Engineer", relationship: "coworker" })).toEqual({
			score: 90,
			reasons: ["alias contains search term", "organization match", "role match", "relationship match"],
		});

		const p55 = makePerson("p-55", "Unrelated Canonical", { archived: true, properties: { previous_emails: ["old@example.com"] } });
		expect(scoreCandidate(p55, { name: "Nomatch", email: "OLD@example.com" })).toEqual({
			score: 55,
			reasons: ["previous email match", "archived penalty"],
		});

		const runWith = async (person: PersonRow, input: Parameters<typeof scoreCandidate>[1]) => {
			const act = createPersonMatchAction(makeFakeRepo({ load: vi.fn(async () => ({ rows: [person], truncated: false })) }));
			return formatPersonMatchMcp(await executeAction(act, input, { context: CTX }));
		};

		expect(await runWith(p90, { name: "Bob", organization: "Acme", role: "Engineer", relationship: "coworker" })).toContain(
			"Match result: exact or near-exact match",
		);
		expect(await runWith(makePerson("p-60", "Todd"), { name: "Todd" })).toContain("Match result: probable match");
		expect(await runWith(p55, { name: "Nomatch", email: "old@example.com" })).toContain("Match result: possible match");
	});

	it("case 4 & 5: formatMcp reports showing N of M matched, truncation note, and No candidates found", async () => {
		const note = `\n\u26a0\ufe0f Scanned the ${PEOPLE_SCAN_LIMIT} most recently updated people only \u2014 other candidates may exist beyond that window.`;
		const action = createPersonMatchAction(
			makeFakeRepo({
				load: vi.fn(async () => ({
					rows: [makePerson("sam-1", "Sam"), makePerson("sam-2", "Samantha"), makePerson("sam-3", "Samson")],
					truncated: true,
				})),
			}),
		);
		const text = formatPersonMatchMcp(await executeAction(action, { name: "Sam", limit: 2 }, { context: CTX }));
		expect(text).toContain("Candidates (showing 2 of 3 matched):");
		expect(text.endsWith(note)).toBe(true);

		const empty = createPersonMatchAction(makeFakeRepo({ load: vi.fn(async () => ({ rows: [], truncated: false })) }));
		expect(formatPersonMatchMcp(await executeAction(empty, { name: "Ghost" }, { context: CTX }))).toBe("No candidates found.");

		const emptyTrunc = createPersonMatchAction(makeFakeRepo({ load: vi.fn(async () => ({ rows: [], truncated: true })) }));
		expect(formatPersonMatchMcp(await executeAction(emptyTrunc, { name: "Ghost" }, { context: CTX }))).toBe(`No candidates found.${note}`);
	});
});
