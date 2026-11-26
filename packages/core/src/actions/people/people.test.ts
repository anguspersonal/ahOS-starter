import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import type { PeopleRepository, PersonRow } from "../../ports/people.js";
import {
	createPersonGetAction,
	formatPersonGetMcp,
	PERSON_GET_DESCRIPTION,
} from "./get.js";
import {
	createPersonQueryAction,
	formatPersonQueryMcp,
	PERSON_QUERY_DESCRIPTION,
} from "./query.js";
import { formatPersonRow, PEOPLE_SCAN_LIMIT } from "./shared.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const PERSON_ID = "11111111-1111-4111-8111-111111111111";

const CTX: ActionContext = {
	caller: "mcp",
	requestId: "req-people-1",
	userId: USER_ID,
};

const PERSON_GET_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		id: {
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
			description: "Person id.",
		},
	},
	required: ["id"],
	additionalProperties: false,
};

const PERSON_QUERY_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		query: {
			description: "Filter by name, role, organization, email, or relationship.",
			type: "string",
			minLength: 1,
		},
		ids: {
			description: "Limit the operation to these ids.",
			type: "array",
			items: {
				type: "string",
				format: "uuid",
				pattern:
					"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
			},
		},
		team_id: {
			description: "Filter by team id.",
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
		},
		user_id: {
			description: "Filter by user id. Defaults to the current MCP user.",
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
		},
		include_archived: {
			description: "Include archived rows. Defaults to false.",
			type: "boolean",
		},
		limit: {
			description: "Max rows returned after `query` is applied (default 20).",
			type: "integer",
			minimum: 1,
			maximum: 100,
		},
	},
	additionalProperties: false,
};

function makePersonRow(overrides: Partial<PersonRow> = {}): PersonRow {
	return {
		id: PERSON_ID,
		name: "Todd Martinez",
		bio: "Partner at Acme",
		role: "Partner",
		organization: "Acme",
		email: "todd@acme.example",
		phone: "+44 7000 000001",
		relationship: "Colleague",
		last_contact: "2026-10-01T10:00:00.000Z",
		tags: ["investor", "uk"],
		archived: false,
		archived_at: null,
		properties: {},
		source_url: "https://notion.so/people/todd",
		user_id: USER_ID,
		team_id: null,
		created_at: "2026-09-01T00:00:00.000Z",
		updated_at: "2026-10-01T10:00:00.000Z",
		aliases: ["todd", "TM"],
		hot: true,
		...overrides,
	};
}

function makeFakeRepo(overrides: Partial<PeopleRepository> = {}): PeopleRepository {
	return {
		getById: vi.fn(async () => null),
		load: vi.fn(async () => ({ rows: [], truncated: false })),
		...overrides,
	};
}

describe("person_get and person_query core actions (#1508)", () => {
	it("case 1: person_get contract parity (id, JSON schema, description, annotations)", () => {
		const action = createPersonGetAction(makeFakeRepo());
		expect(action.id).toBe("person_get");
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_GET_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(PERSON_GET_DESCRIPTION);
		expect(action.description).toBe("Read a single people row by id.");
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("case 2: person_query contract parity (id, JSON schema, description, annotations)", () => {
		const action = createPersonQueryAction(makeFakeRepo());
		expect(action.id).toBe("person_query");
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_QUERY_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(PERSON_QUERY_DESCRIPTION);
		expect(action.description).toBe(
			"Read people rows from the people view/table. Returns name, bio, role, organization, email, phone, relationship, last_contact, tags, archived state, and timestamps. Supports ids, team/user filters, query filtering, archived inclusion, and limit.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("case 3: person_get returns 'No person found.' when missing or owned by another user, and formatRow output on hit", async () => {
		const row = makePersonRow();
		const repo = makeFakeRepo({
			getById: vi.fn(async (id, userId) =>
				id === PERSON_ID && userId === USER_ID ? row : null,
			),
		});
		const action = createPersonGetAction(repo);

		const missRes = await executeAction(
			action,
			{ id: PERSON_ID },
			{ context: { ...CTX, userId: OTHER_USER_ID } },
		);
		expect(missRes).toEqual({ found: false, person: null });
		expect(formatPersonGetMcp(missRes)).toBe("No person found.");

		const hitRes = await executeAction(action, { id: PERSON_ID }, { context: CTX });
		expect(hitRes).toEqual({ found: true, person: row });
		expect(formatPersonGetMcp(hitRes)).toBe(formatPersonRow(row));
		expect(formatPersonGetMcp(hitRes)).toBe(
			`• [${PERSON_ID}] Todd Martinez | aka: todd, TM | role: Partner | org: Acme | email: todd@acme.example | phone: +44 7000 000001 | rel: Colleague | last_contact: 2026-10-01T10:00:00.000Z | source: https://notion.so/people/todd | hot\n  tags: investor, uk`,
		);
	});

	it("case 4: person_query formats truncation note when scan reaches PEOPLE_SCAN_LIMIT (2000)", async () => {
		const row = makePersonRow();
		const repo = makeFakeRepo({
			load: vi.fn(async () => ({ rows: [row], truncated: true })),
		});
		const action = createPersonQueryAction(repo);

		const res = await executeAction(
			action,
			{ query: "todd", limit: 5 },
			{ context: CTX },
		);
		expect(res.truncated).toBe(true);
		const text = formatPersonQueryMcp(res);
		expect(text).toContain(`People (1):\n${formatPersonRow(row)}`);
		expect(text).toContain(
			`\n⚠️ Scanned the ${PEOPLE_SCAN_LIMIT} most recently updated people only — matches may exist beyond that window.`,
		);

		const emptyTruncated = formatPersonQueryMcp({
			count: 0,
			rows: [],
			truncated: true,
		});
		expect(emptyTruncated).toBe(
			`No people found.\n⚠️ Scanned the ${PEOPLE_SCAN_LIMIT} most recently updated people only — matches may exist beyond that window.`,
		);
	});

	it("case 5: person_query allows user_id equal to ctx.userId and refuses any other user_id naming the field", async () => {
		const row = makePersonRow();
		const repo = makeFakeRepo({
			load: vi.fn(async () => ({ rows: [row], truncated: false })),
		});
		const action = createPersonQueryAction(repo);

		const okRes = await executeAction(
			action,
			{ user_id: USER_ID },
			{ context: CTX },
		);
		expect(okRes.count).toBe(1);
		expect(repo.load).toHaveBeenCalledWith({ user_id: USER_ID }, USER_ID);

		await expect(
			executeAction(action, { user_id: OTHER_USER_ID }, { context: CTX }),
		).rejects.toThrow(/user_id/);
		expect(repo.load).toHaveBeenCalledTimes(1);
	});
});
