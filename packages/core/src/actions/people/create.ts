import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	PeopleRepository,
	PeopleWriteRepository,
	PersonWrittenRow,
} from "../../ports/people.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	embedWrittenPersonRow,
	personCreateSchema,
	requirePeopleWriteRepo,
	resolvePeopleWriteDeps,
	toPersonEntityInsert,
	type PeopleWriteDeps,
	type PersonCreateInput,
} from "./personFields.js";

export const PERSON_CREATE_DESCRIPTION = "Create one or many people rows.";

export interface PersonCreateResult {
	count: number;
	people: PersonWrittenRow[];
}

export function formatPersonCreateMcp(result: PersonCreateResult): string {
	return `Created ${result.count} people: ${result.people.map((row) => `[${row.id}] ${row.title}`).join(", ")}`;
}

export function createPersonCreateAction(
	depsOrRepo: PeopleRepository | PeopleWriteRepository | PeopleWriteDeps,
	embeddings?: EmbeddingPort | null,
	embeddingStore?: EmbeddingStorePort,
): ActionDefinition<typeof personCreateSchema, PersonCreateResult> {
	const deps = resolvePeopleWriteDeps(depsOrRepo, embeddings, embeddingStore);
	return defineAction({
		id: "person_create",
		description: PERSON_CREATE_DESCRIPTION,
		schema: personCreateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input: PersonCreateInput, ctx) => {
			const repo = requirePeopleWriteRepo(deps.people);
			const rows = input.people.map((p) => toPersonEntityInsert(p, ctx?.userId));
			const inserted = await repo.insertPeople(rows, ctx?.userId);
			await Promise.all(inserted.map((row) => embedWrittenPersonRow(deps, row)));
			return { count: inserted.length, people: inserted };
		},
		formatMcp: formatPersonCreateMcp,
	});
}
