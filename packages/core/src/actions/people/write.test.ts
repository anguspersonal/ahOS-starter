import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { PeopleWriteRepository, PersonWrittenRow } from "../../ports/people.js";
import {
	createPersonCreateAction,
	formatPersonCreateMcp,
	PERSON_CREATE_DESCRIPTION,
} from "./create.js";
import {
	createPersonUpsertAction,
	formatPersonUpsertMcp,
	PERSON_UPSERT_DESCRIPTION,
} from "./upsert.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const EXISTING_ID = "11111111-1111-4111-8111-111111111111";
const CTX: ActionContext = { caller: "mcp", requestId: "req-people-write-1", userId: USER_ID };

const UUID_PATTERN =
	"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
const DATETIME_PATTERN =
	"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$";

const PERSON_ITEM_SCHEMA_SNAPSHOT = {
	type: "object",
	properties: {
		id: {
			description: "Existing person id, used by update/upsert flows.",
			type: "string",
			format: "uuid",
			pattern: UUID_PATTERN,
		},
		name: { description: "Person name.", type: "string", minLength: 1 },
		bio: { description: "Short bio / notes.", anyOf: [{ type: "string" }, { type: "null" }] },
		role: { description: "Role or title.", anyOf: [{ type: "string" }, { type: "null" }] },
		organization: {
			description: "Organization / company.",
			anyOf: [{ type: "string" }, { type: "null" }],
		},
		email: { description: "Email address.", anyOf: [{ type: "string" }, { type: "null" }] },
		phone: { description: "Phone number.", anyOf: [{ type: "string" }, { type: "null" }] },
		relationship: {
			description: "Relationship to the user.",
			anyOf: [{ type: "string" }, { type: "null" }],
		},
		last_contact: {
			description: "Last contact timestamp in ISO 8601.",
			anyOf: [{ type: "string", format: "date-time", pattern: DATETIME_PATTERN }, { type: "null" }],
		},
		tags: {
			description: "Tags.",
			anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
		},
		archived: { description: "Archived state.", type: "boolean" },
		archived_at: {
			description: "Archived timestamp in ISO 8601.",
			anyOf: [{ type: "string", format: "date-time", pattern: DATETIME_PATTERN }, { type: "null" }],
		},
		properties: {
			description: "Extra JSON properties to merge or replace.",
			anyOf: [
				{ type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
				{ type: "null" },
			],
		},
		source_url: {
			description:
				"URL of the external record that IS this person (e.g. their Notion People row), not pages that mention them. null = native to the graph (#426).",
			anyOf: [{ type: "string" }, { type: "null" }],
		},
		aliases: {
			description:
				"Other names this person answers to: nicknames, first-name-only, initials (e.g. ['todd', 'TM']). people_match reads them. Replaces the whole list on update, so read it first to append. Needs migration 110 (#1023).",
			type: "array",
			items: { type: "string" },
		},
		hot: {
			description:
				"Put this person in the hot tier: the always-loaded decoder table shipped in every session's MCP instructions (ADR-092, capped at 100 lines). Hand-curated; keep it to the ~30 people referred to by shorthand most often. Needs migration 110 (#1023).",
			type: "boolean",
		},
	},
	additionalProperties: false,
};

const PERSON_CREATE_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		people: {
			minItems: 1,
			maxItems: 100,
			type: "array",
			items: PERSON_ITEM_SCHEMA_SNAPSHOT,
			description: "One or many people to create.",
		},
	},
	required: ["people"],
	additionalProperties: false,
};

const PERSON_UPSERT_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		people: {
			minItems: 1,
			maxItems: 100,
			type: "array",
			items: PERSON_ITEM_SCHEMA_SNAPSHOT,
			description: "One or many people to upsert.",
		},
	},
	required: ["people"],
	additionalProperties: false,
};

function makeFakeDeps(overrides: Partial<PeopleWriteRepository> = {}) {
	const repo: PeopleWriteRepository = {
		insertPeople: vi.fn(async (rows) =>
			rows.map((r): PersonWrittenRow => ({
				id: r.id,
				title: r.title ?? null,
				description: r.description,
				properties: r.properties,
				aliases: r.aliases,
			})),
		),
		updatePersonById: vi.fn(async (id, updates) => ({
			id,
			title: (updates.title as string | undefined) ?? "Existing",
			description: (updates.description as string | null | undefined) ?? null,
			properties: (updates.properties as Record<string, unknown> | undefined) ?? {},
			aliases: (updates.aliases as string[] | undefined) ?? [],
		})),
		findExistingPeopleForEmails: vi.fn(async () => new Map()),
		...overrides,
	};
	const embeddings: EmbeddingPort = {
		embed: vi.fn(async () => [0.1, 0.2]),
		embedBatch: vi.fn(async (texts) => texts.map(() => [0.1, 0.2])),
	};
	const embeddingStore: EmbeddingStorePort = {
		setEmbedding: vi.fn(async () => undefined),
	};
	return { repo, embeddings, embeddingStore };
}

describe("person_create and person_upsert core actions (#1518)", () => {
	it("1. person_create preserves exact id, JSON schema snapshot, description, and annotations", () => {
		const { repo } = makeFakeDeps();
		const action = createPersonCreateAction(repo);
		expect(action.id).toBe("person_create");
		expect(action.description).toBe(PERSON_CREATE_DESCRIPTION);
		expect(action.description).toBe("Create one or many people rows.");
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_CREATE_JSON_SCHEMA_SNAPSHOT);
	});

	it("2. person_upsert preserves exact id, JSON schema snapshot, description, and annotations", () => {
		const { repo } = makeFakeDeps();
		const action = createPersonUpsertAction(repo);
		expect(action.id).toBe("person_upsert");
		expect(action.description).toBe(PERSON_UPSERT_DESCRIPTION);
		expect(action.description).toBe(
			"Create or update one or many people rows. If id is supplied, updates that row; otherwise creates a new row.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_UPSERT_JSON_SCHEMA_SNAPSHOT);
	});

	it("3. person_create inserts two entities rows with entity_type 'people' and user_id ctx.userId, then embeds each with title, description, properties and aliases", async () => {
		const { repo, embeddings, embeddingStore } = makeFakeDeps();
		const action = createPersonCreateAction({ people: repo, embeddings, embeddingStore });

		const res = await executeAction(
			action,
			{
				people: [
					{
						name: "Todd Martinez",
						bio: "Platform lead",
						role: "CTO",
						organization: "Acme",
						aliases: ["todd", " TM "],
					},
					{
						name: "Laura Sharp",
						bio: "Design lead",
						relationship: "Partner",
						aliases: ["laura"],
					},
				],
			},
			{ context: CTX },
		);

		expect(repo.insertPeople).toHaveBeenCalledTimes(1);
		const [insertedRows, passedUserId] = vi.mocked(repo.insertPeople).mock.calls[0];
		expect(passedUserId).toBe(USER_ID);
		expect(insertedRows).toHaveLength(2);
		expect(insertedRows[0]).toMatchObject({
			entity_type: "people",
			user_id: USER_ID,
			title: "Todd Martinez",
			description: "Platform lead",
			properties: { role: "CTO", organization: "Acme" },
			aliases: ["todd", "TM"],
		});
		expect(insertedRows[1]).toMatchObject({
			entity_type: "people",
			user_id: USER_ID,
			title: "Laura Sharp",
			description: "Design lead",
			properties: { relationship: "Partner" },
			aliases: ["laura"],
		});

		expect(embeddings.embed).toHaveBeenCalledTimes(2);
		expect(embeddings.embed).toHaveBeenNthCalledWith(
			1,
			"Todd Martinez\n\nPlatform lead\n\nCTO\n\nAcme\n\ntodd TM",
		);
		expect(embeddings.embed).toHaveBeenNthCalledWith(
			2,
			"Laura Sharp\n\nDesign lead\n\nPartner\n\nlaura",
		);
		expect(embeddingStore.setEmbedding).toHaveBeenCalledTimes(2);
		expect(formatPersonCreateMcp(res)).toContain("Created 2 people:");
	});

	it("4. person_upsert updates by id scoped to ctx.userId and inserts without id, embedding each written row once", async () => {
		const { repo, embeddings, embeddingStore } = makeFakeDeps({
			findExistingPeopleForEmails: vi.fn(
				async () =>
					new Map([[EXISTING_ID, { id: EXISTING_ID, properties: { email: "old@example.com" } }]]),
			),
		});
		const action = createPersonUpsertAction({ people: repo, embeddings, embeddingStore });

		const res = await executeAction(
			action,
			{
				people: [
					{ id: EXISTING_ID, name: "Updated Bob", email: "new@example.com" },
					{ name: "New Alice", role: "Engineer" },
				],
			},
			{ context: CTX },
		);

		expect(repo.updatePersonById).toHaveBeenCalledWith(
			EXISTING_ID,
			expect.objectContaining({
				title: "Updated Bob",
				properties: { email: "new@example.com", previous_emails: ["old@example.com"] },
			}),
			USER_ID,
		);
		expect(repo.insertPeople).toHaveBeenCalledTimes(1);
		expect(vi.mocked(repo.insertPeople).mock.calls[0][0][0]).toMatchObject({
			entity_type: "people",
			user_id: USER_ID,
			title: "New Alice",
		});
		expect(embeddings.embed).toHaveBeenCalledTimes(2);
		expect(embeddingStore.setEmbedding).toHaveBeenCalledTimes(2);
		expect(formatPersonUpsertMcp(res)).toBe(
			`Upserted 2 people: created New Alice; updated ${EXISTING_ID}`,
		);
	});

	it("5. source_url: '' is normalized and stored as null on create and upsert update", async () => {
		const { repo, embeddings, embeddingStore } = makeFakeDeps();
		const createAction = createPersonCreateAction({ people: repo, embeddings, embeddingStore });
		const upsertAction = createPersonUpsertAction({ people: repo, embeddings, embeddingStore });

		await executeAction(
			createAction,
			{ people: [{ name: "Sam", source_url: "" }] },
			{ context: CTX },
		);
		expect(vi.mocked(repo.insertPeople).mock.calls[0][0][0].source_url).toBeNull();

		await executeAction(
			upsertAction,
			{ people: [{ id: EXISTING_ID, source_url: "" }] },
			{ context: CTX },
		);
		expect(vi.mocked(repo.updatePersonById).mock.calls[0][1].source_url).toBeNull();
	});

	it("6. embedding failure is awaited and best-effort (never throws) for both person_create and person_upsert", async () => {
		const order: string[] = [];
		const failingEmbeddings: EmbeddingPort = {
			embed: vi.fn(async () => {
				order.push("embed_attempted");
				throw new Error("401 invalid api key");
			}),
			embedBatch: vi.fn(async () => {
				throw new Error("401 invalid api key");
			}),
		};
		const { repo, embeddingStore } = makeFakeDeps();
		const createAction = createPersonCreateAction({
			people: repo,
			embeddings: failingEmbeddings,
			embeddingStore,
			retryOptions: { maxAttempts: 1 },
		});
		const upsertAction = createPersonUpsertAction({
			people: repo,
			embeddings: failingEmbeddings,
			embeddingStore,
			retryOptions: { maxAttempts: 1 },
		});

		const created = await executeAction(
			createAction,
			{ people: [{ name: "Resilient Create" }] },
			{ context: CTX },
		);
		order.push("create_returned");
		expect(created.count).toBe(1);

		const upserted = await executeAction(
			upsertAction,
			{ people: [{ name: "Resilient Upsert" }] },
			{ context: CTX },
		);
		order.push("upsert_returned");
		expect(upserted).toEqual({ count: 1, created: ["Resilient Upsert"], updated: [] });
		expect(order).toEqual([
			"embed_attempted",
			"create_returned",
			"embed_attempted",
			"upsert_returned",
		]);
		expect(embeddingStore.setEmbedding).not.toHaveBeenCalled();
	});
});
