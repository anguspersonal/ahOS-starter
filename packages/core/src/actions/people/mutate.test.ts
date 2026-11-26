import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore, type ActionApprovalStore } from "../gate.js";
import type { ActionContext } from "../types.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	PeopleMutateRepository,
	PeopleRepository,
	PeopleWriteRepository,
	PersonRow,
	PersonWrittenRow,
} from "../../ports/people.js";
import {
	createPersonUpdateAction,
	formatPersonUpdateMcp,
	PERSON_UPDATE_DESCRIPTION,
} from "./update.js";
import {
	createPersonDeleteAction,
	formatPersonDeleteMcp,
	PERSON_DELETE_DESCRIPTION,
} from "./delete.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";
const CTX: ActionContext = { caller: "mcp", requestId: "req-people-mutate-1", userId: USER_ID };
const OPTS = { context: CTX };

const UUID_PATTERN =
	"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
const DATETIME_PATTERN =
	"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$";

const PEOPLE_QUERY_FILTER_SCHEMA = {
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
			items: { type: "string", format: "uuid", pattern: UUID_PATTERN },
		},
		team_id: {
			description: "Filter by team id.",
			type: "string",
			format: "uuid",
			pattern: UUID_PATTERN,
		},
		user_id: {
			description: "Filter by user id. Defaults to the current MCP user.",
			type: "string",
			format: "uuid",
			pattern: UUID_PATTERN,
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

const PERSON_UPDATE_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		ids: {
			description: "Update only these ids.",
			type: "array",
			items: { type: "string", format: "uuid", pattern: UUID_PATTERN },
		},
		filter: {
			...PEOPLE_QUERY_FILTER_SCHEMA,
			description: "Optional filter to select rows for bulk update.",
		},
		patch: {
			description: "Fields to change.",
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
		},
	},
	required: ["patch"],
	additionalProperties: false,
};

const PERSON_DELETE_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		ids: {
			description: "Delete only these ids.",
			type: "array",
			items: { type: "string", format: "uuid", pattern: UUID_PATTERN },
		},
		filter: {
			...PEOPLE_QUERY_FILTER_SCHEMA,
			description: "Optional filter to select rows for bulk delete.",
		},
		archive_only: {
			description: "Archive instead of deleting. Defaults to true.",
			type: "boolean",
		},
	},
	additionalProperties: false,
};

function makeUuid(index: number): string {
	return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function makeFakeRepo(
	overrides: Partial<PeopleRepository & PeopleWriteRepository & PeopleMutateRepository> = {},
) {
	const updateCalls: Array<{ ids: string[]; updates: Record<string, unknown>; userId?: string }> = [];
	const deleteCalls: Array<{ ids: string[]; userId?: string }> = [];
	const repo: PeopleRepository & PeopleWriteRepository & PeopleMutateRepository = {
		getById: vi.fn(async () => null),
		load: vi.fn(async () => ({ rows: [], truncated: false })),
		insertPeople: vi.fn(async () => []),
		updatePersonById: vi.fn(async () => null),
		findExistingPeopleForEmails: vi.fn(async () => new Map()),
		updatePeopleByIds: vi.fn(async (ids, updates, userId) => {
			updateCalls.push({ ids, updates, userId });
			return ids.map((id): PersonWrittenRow => ({
				id,
				title: (updates.title as string | undefined) ?? "Person",
				description: (updates.description as string | null | undefined) ?? null,
				properties: (updates.properties as Record<string, unknown> | undefined) ?? {},
				aliases: (updates.aliases as string[] | undefined) ?? [],
			}));
		}),
		deletePeopleByIds: vi.fn(async (ids, userId) => {
			deleteCalls.push({ ids, userId });
			return ids.map((id) => ({ id, title: `Deleted ${id.slice(-4)}` }));
		}),
		...overrides,
	};
	return { repo, updateCalls, deleteCalls };
}

function makeApprovalStore() {
	const parked: Array<{ actionId: string; input: unknown; caller: string; userId?: string }> = [];
	const store: ActionApprovalStore = {
		async park(req) {
			parked.push({
				actionId: req.actionId,
				input: req.input,
				caller: req.caller,
				userId: req.userId,
			});
			return { decisionId: `dec-${parked.length}` };
		},
	};
	return { store, parked };
}

afterEach(() => {
	setActionApprovalStore(undefined);
	vi.restoreAllMocks();
});

describe("person_update and person_delete core actions (#1522)", () => {
	it("1. person_update preserves exact id, JSON schema snapshot, description, and annotations", () => {
		const { repo } = makeFakeRepo();
		const action = createPersonUpdateAction(repo);

		expect(action.id).toBe("person_update");
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_UPDATE_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(PERSON_UPDATE_DESCRIPTION);
		expect(action.description).toBe("Update one or many people rows by ids or filter criteria.");
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. person_delete preserves exact id, JSON schema snapshot, description, and annotations", () => {
		const { repo } = makeFakeRepo();
		const action = createPersonDeleteAction(repo);

		expect(action.id).toBe("person_delete");
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_DELETE_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(PERSON_DELETE_DESCRIPTION);
		expect(action.description).toBe(
			"Delete or archive one or many people rows by ids or filter criteria. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it("3. rejects with exact message when neither ids nor filter resolves targets", async () => {
		const { repo } = makeFakeRepo();
		const updateAction = createPersonUpdateAction(repo);
		const deleteAction = createPersonDeleteAction(repo);

		await expect(
			executeAction(updateAction, { patch: { role: "CTO" } }, OPTS),
		).rejects.toThrow("People update failed: provide ids or a filter.");

		await expect(
			executeAction(deleteAction, {}, OPTS),
		).rejects.toThrow("People delete failed: provide ids or a filter.");
	});

	it("4. person_delete defaults to archive_only=true, updates without embedding, and formats Archived N people", async () => {
		const { repo, updateCalls, deleteCalls } = makeFakeRepo();
		const action = createPersonDeleteAction(repo);

		const res = await executeAction(action, { ids: [ID_1, ID_2] }, OPTS);

		expect(deleteCalls).toHaveLength(0);
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].ids).toEqual([ID_1, ID_2]);
		expect(updateCalls[0].updates.archived).toBe(true);
		expect(typeof updateCalls[0].updates.archived_at).toBe("string");
		expect(formatPersonDeleteMcp(res)).toBe(
			`Archived 2 people: [${ID_1}] Person, [${ID_2}] Person`,
		);
	});

	it("5. person_delete needsApproval gate: >50 hard delete parks on mcp, <=50 or archive default runs, filter >50 parks, count error parks, ui bypasses", async () => {
		const ids51 = Array.from({ length: 51 }, (_, i) => makeUuid(i + 1));
		const ids50 = Array.from({ length: 50 }, (_, i) => makeUuid(i + 1));

		const { store, parked } = makeApprovalStore();
		setActionApprovalStore(store);

		const { repo, updateCalls, deleteCalls } = makeFakeRepo();
		const action = createPersonDeleteAction(repo);

		// 51 ids, archive_only: false on mcp -> PendingApprovalError, no row changes
		await expect(
			executeAction(action, { ids: ids51, archive_only: false }, OPTS),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(deleteCalls).toHaveLength(0);
		expect(updateCalls).toHaveLength(0);
		expect(parked).toHaveLength(1);

		// 50 ids, archive_only: false on mcp -> runs
		const res50 = await executeAction(action, { ids: ids50, archive_only: false }, OPTS);
		expect(res50.count).toBe(50);
		expect(res50.archive_only).toBe(false);
		expect(deleteCalls).toHaveLength(1);

		// 51 ids with archive default -> runs
		const resArchive = await executeAction(action, { ids: ids51 }, OPTS);
		expect(resArchive.count).toBe(51);
		expect(resArchive.archive_only).toBe(true);
		expect(updateCalls).toHaveLength(1);

		// filter resolving 51 rows with archive_only: false -> parks
		const rows51: PersonRow[] = ids51.map((id) => ({
			id,
			name: "P",
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
		}));
		const { repo: filterRepo, deleteCalls: filterDeletes } = makeFakeRepo({
			load: vi.fn(async () => ({ rows: rows51, truncated: false })),
		});
		const filterAction = createPersonDeleteAction(filterRepo);
		await expect(
			executeAction(filterAction, { filter: { query: "P" }, archive_only: false }, OPTS),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(filterDeletes).toHaveLength(0);

		// count failure (load throws) -> predicate throws -> counts as true -> parks
		const { repo: failingRepo, deleteCalls: failingDeletes } = makeFakeRepo({
			load: vi.fn(async () => {
				throw new Error("count failed");
			}),
		});
		const failingAction = createPersonDeleteAction(failingRepo);
		await expect(
			executeAction(failingAction, { filter: { query: "P" }, archive_only: false }, OPTS),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(failingDeletes).toHaveLength(0);

		// caller ui is not parked
		const uiRes = await executeAction(
			action,
			{ ids: ids51, archive_only: false },
			{ context: { caller: "ui", requestId: "req-ui", userId: USER_ID } },
		);
		expect(uiRes.count).toBe(51);
		expect(deleteCalls).toHaveLength(2);
	});

	it("6. person_update merges previous_emails, embeds each updated row, and formats Updated N people", async () => {
		const { repo, updateCalls } = makeFakeRepo({
			findExistingPeopleForEmails: vi.fn(async () =>
				new Map([[ID_1, { id: ID_1, properties: { email: "old@example.com" } }]]),
			),
		});
		const embeddings: EmbeddingPort = {
			embed: vi.fn(async () => [0.1, 0.2]),
			embedBatch: vi.fn(async () => [[0.1, 0.2]]),
		};
		const setEmbeddingMock = vi.fn(async () => {});
		const embeddingStore: EmbeddingStorePort = {
			setEmbedding: setEmbeddingMock,
		};

		const action = createPersonUpdateAction({ people: repo, embeddings, embeddingStore });
		const res = await executeAction(
			action,
			{ ids: [ID_1], patch: { email: "new@example.com", role: "CTO" } },
			OPTS,
		);

		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].updates.properties).toEqual({
			email: "new@example.com",
			role: "CTO",
			previous_emails: ["old@example.com"],
		});
		expect(setEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(formatPersonUpdateMcp(res)).toBe(`Updated 1 people: [${ID_1}] Person`);
	});
});
