import { z } from "zod";
import { HARD_DELETE_APPROVAL_THRESHOLD } from "../../ports/entities.js";
import type { PeopleMutateRepository, PeopleRepository } from "../../ports/people.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { resolvePeopleWriteDeps, type PeopleWriteDeps } from "./personFields.js";
import { peopleQueryInput } from "./shared.js";

export const PERSON_DELETE_DESCRIPTION =
	"Delete or archive one or many people rows by ids or filter criteria. Parks for the owner's approval when archive_only is false and more than 50 rows match.";

export const peopleDeleteInput = {
	ids: z.array(z.string().uuid()).optional().describe("Delete only these ids."),
	filter: z
		.object(peopleQueryInput)
		.optional()
		.describe("Optional filter to select rows for bulk delete."),
	archive_only: z.boolean().optional().describe("Archive instead of deleting. Defaults to true."),
} as const;

export const personDeleteSchema = z.object(peopleDeleteInput);
export type PersonDeleteInput = z.infer<typeof personDeleteSchema>;

export interface PersonDeleteResult {
	archive_only: boolean;
	count: number;
	people: Array<{ id: string; title: string | null }>;
}

export function formatPersonDeleteMcp(result: PersonDeleteResult): string {
	const verb = result.archive_only ? "Archived" : "Deleted";
	return `${verb} ${result.count} people: ${result.people.map((row) => `[${row.id}] ${row.title ?? "(unnamed)"}`).join(", ")}`;
}

export function createPersonDeleteAction(
	depsOrRepo: PeopleRepository | PeopleWriteDeps,
): ActionDefinition<typeof personDeleteSchema, PersonDeleteResult> {
	const deps = resolvePeopleWriteDeps(depsOrRepo);
	const repo = deps.people as PeopleRepository & Partial<PeopleMutateRepository>;

	return defineAction({
		id: "person_delete",
		description: PERSON_DELETE_DESCRIPTION,
		schema: personDeleteSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		needsApproval: async (input, ctx) => {
			if (input.archive_only !== false) return false;
			if (input.ids?.length) {
				return new Set(input.ids).size > HARD_DELETE_APPROVAL_THRESHOLD;
			}
			if (input.filter) {
				const { rows } = await repo.load(input.filter, ctx.userId);
				return rows.length > HARD_DELETE_APPROVAL_THRESHOLD;
			}
			return false;
		},
		run: async (input: PersonDeleteInput, ctx) => {
			if (!repo.updatePeopleByIds || !repo.deletePeopleByIds || !repo.load) {
				throw new Error("PeopleRepository does not implement mutate methods.");
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
				throw new Error("People delete failed: provide ids or a filter.");
			}

			const archiveOnly = input.archive_only ?? true;
			if (!archiveOnly) {
				const deleted = await repo.deletePeopleByIds(ids, ctx?.userId);
				return {
					archive_only: false,
					count: deleted.length,
					people: deleted,
				};
			}

			const updated = await repo.updatePeopleByIds(
				ids,
				{ archived: true, archived_at: new Date().toISOString() },
				ctx?.userId,
			);
			return {
				archive_only: true,
				count: updated.length,
				people: updated.map((row) => ({ id: row.id, title: row.title })),
			};
		},
		formatMcp: formatPersonDeleteMcp,
	});
}
