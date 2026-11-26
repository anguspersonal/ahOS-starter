import { z } from "zod";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	PeopleMutateRepository,
	PeopleRepository,
	PeopleWriteRepository,
	PersonWrittenRow,
} from "../../ports/people.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	embedWrittenPersonRow,
	extractIncomingEmail,
	mergePreviousEmailIntoProperties,
	normalizeSourceUrl,
	personAliasColumns,
	personFields,
	resolvePeopleWriteDeps,
	type PeopleWriteDeps,
} from "./personFields.js";
import { peopleQueryInput } from "./shared.js";

export const PERSON_UPDATE_DESCRIPTION = "Update one or many people rows by ids or filter criteria.";

export const peopleUpdateInput = {
	ids: z.array(z.string().uuid()).optional().describe("Update only these ids."),
	filter: z
		.object(peopleQueryInput)
		.optional()
		.describe("Optional filter to select rows for bulk update."),
	patch: z
		.object(personFields)
		.partial()
		.refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.")
		.describe("Fields to change."),
} as const;

export const personUpdateSchema = z.object(peopleUpdateInput);
export type PersonUpdateInput = z.infer<typeof personUpdateSchema>;

export interface PersonUpdateResult {
	count: number;
	people: PersonWrittenRow[];
}

export function formatPersonUpdateMcp(result: PersonUpdateResult): string {
	return `Updated ${result.count} people: ${result.people.map((row) => `[${row.id}] ${row.title ?? "(unnamed)"}`).join(", ")}`;
}

export function createPersonUpdateAction(
	depsOrRepo: PeopleRepository | PeopleWriteDeps,
	embeddings?: EmbeddingPort | null,
	embeddingStore?: EmbeddingStorePort,
): ActionDefinition<typeof personUpdateSchema, PersonUpdateResult> {
	const deps = resolvePeopleWriteDeps(depsOrRepo, embeddings, embeddingStore);
	return defineAction({
		id: "person_update",
		description: PERSON_UPDATE_DESCRIPTION,
		schema: personUpdateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: PersonUpdateInput, ctx) => {
			const repo = deps.people as PeopleRepository &
				Partial<PeopleWriteRepository> &
				Partial<PeopleMutateRepository>;
			if (!repo.updatePeopleByIds || !repo.load) {
				throw new Error("PeopleRepository does not implement updatePeopleByIds/load.");
			}

			let ids: string[];
			if (input.ids?.length) {
				ids = input.ids;
			} else if (input.filter) {
				const { rows } = await repo.load(input.filter, ctx?.userId);
				ids = rows.map((row) => row.id);
			} else {
				ids = [];
			}

			if (ids.length === 0) {
				throw new Error("People update failed: provide ids or a filter.");
			}

			const patch = input.patch;
			const updates: Record<string, unknown> = {};
			if (patch.archived !== undefined) {
				updates.archived = patch.archived;
				updates.archived_at = patch.archived ? (patch.archived_at ?? new Date().toISOString()) : null;
			}
			if (patch.name !== undefined) updates.title = patch.name;
			if (patch.bio !== undefined) updates.description = patch.bio;
			if (patch.tags !== undefined) updates.tags = patch.tags ?? [];
			if (
				patch.properties !== undefined ||
				patch.role !== undefined ||
				patch.organization !== undefined ||
				patch.email !== undefined ||
				patch.phone !== undefined ||
				patch.relationship !== undefined ||
				patch.last_contact !== undefined
			) {
				updates.properties = {
					...(patch.properties ?? {}),
					...(patch.role !== undefined ? { role: patch.role } : {}),
					...(patch.organization !== undefined ? { organization: patch.organization } : {}),
					...(patch.email !== undefined ? { email: patch.email } : {}),
					...(patch.phone !== undefined ? { phone: patch.phone } : {}),
					...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
					...(patch.last_contact !== undefined ? { last_contact: patch.last_contact } : {}),
				};
			}
			if (patch.source_url !== undefined) updates.source_url = normalizeSourceUrl(patch.source_url);
			Object.assign(updates, personAliasColumns(patch));

			const incomingEmail = extractIncomingEmail(patch);
			if (incomingEmail !== null) {
				if (!repo.findExistingPeopleForEmails) {
					throw new Error("PeopleRepository does not implement findExistingPeopleForEmails.");
				}
				const existingMap = await repo.findExistingPeopleForEmails(ids, ctx?.userId, false);
				if (ids.length > 1 && existingMap.size > 1) {
					const updatedRows: PersonWrittenRow[] = [];
					for (const id of ids) {
						const rowUpdates = {
							...updates,
							properties: mergePreviousEmailIntoProperties(
								(updates.properties ?? {}) as Record<string, unknown>,
								existingMap.get(id),
								incomingEmail,
							),
						};
						const rows = await repo.updatePeopleByIds([id], rowUpdates, ctx?.userId);
						updatedRows.push(...rows);
					}
					await Promise.all(updatedRows.map((row) => embedWrittenPersonRow(deps, row)));
					return { count: updatedRows.length, people: updatedRows };
				}
				const targetExisting = existingMap.get(ids[0]) ?? existingMap.values().next().value;
				updates.properties = mergePreviousEmailIntoProperties(
					(updates.properties ?? {}) as Record<string, unknown>,
					targetExisting,
					incomingEmail,
				);
			}

			const updated = await repo.updatePeopleByIds(ids, updates, ctx?.userId);
			await Promise.all(updated.map((row) => embedWrittenPersonRow(deps, row)));
			return { count: updated.length, people: updated };
		},
		formatMcp: formatPersonUpdateMcp,
	});
}
