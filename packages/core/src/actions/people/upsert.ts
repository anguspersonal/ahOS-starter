import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { PeopleRepository, PeopleWriteRepository } from "../../ports/people.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	embedWrittenPersonRow,
	extractIncomingEmail,
	mergePreviousEmailIntoProperties,
	personUpsertSchema,
	requirePeopleWriteRepo,
	resolvePeopleWriteDeps,
	toPersonEntityInsert,
	toPersonEntityUpdate,
	type PeopleWriteDeps,
	type PersonUpsertInput,
} from "./personFields.js";

export const PERSON_UPSERT_DESCRIPTION =
	"Create or update one or many people rows. If id is supplied, updates that row; otherwise creates a new row.";

export interface PersonUpsertResult {
	count: number;
	created: string[];
	updated: string[];
}

export function formatPersonUpsertMcp(result: PersonUpsertResult): string {
	return `Upserted ${result.count} people: ${result.created.length ? `created ${result.created.join(", ")}` : ""}${result.created.length && result.updated.length ? "; " : ""}${result.updated.length ? `updated ${result.updated.join(", ")}` : ""}`.trim();
}

export function createPersonUpsertAction(
	depsOrRepo: PeopleRepository | PeopleWriteRepository | PeopleWriteDeps,
	embeddings?: EmbeddingPort | null,
	embeddingStore?: EmbeddingStorePort,
): ActionDefinition<typeof personUpsertSchema, PersonUpsertResult> {
	const deps = resolvePeopleWriteDeps(depsOrRepo, embeddings, embeddingStore);
	return defineAction({
		id: "person_upsert",
		description: PERSON_UPSERT_DESCRIPTION,
		schema: personUpsertSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: PersonUpsertInput, ctx) => {
			const repo = requirePeopleWriteRepo(deps.people);
			const created: string[] = [];
			const updated: string[] = [];

			for (const person of input.people) {
				if (person.id) {
					const entityUpdate = toPersonEntityUpdate(person);
					const incomingEmail = extractIncomingEmail(person);
					if (incomingEmail !== null) {
						const existingMap = await repo.findExistingPeopleForEmails(
							[person.id],
							ctx?.userId,
							true,
						);
						const targetExisting =
							existingMap.get(person.id) ?? existingMap.values().next().value;
						entityUpdate.properties = mergePreviousEmailIntoProperties(
							(entityUpdate.properties ?? {}) as Record<string, unknown>,
							targetExisting,
							incomingEmail,
						);
					}
					const row = await repo.updatePersonById(person.id, entityUpdate, ctx?.userId);
					if (row) await embedWrittenPersonRow(deps, row);
					updated.push(person.id);
					continue;
				}

				const inserted = await repo.insertPeople(
					[toPersonEntityInsert(person, ctx?.userId)],
					ctx?.userId,
					"People upsert create failed",
				);
				const row = inserted[0];
				if (row) await embedWrittenPersonRow(deps, row);
				created.push(person.name ?? "(unnamed)");
			}

			return { count: input.people.length, created, updated };
		},
		formatMcp: formatPersonUpsertMcp,
	});
}
