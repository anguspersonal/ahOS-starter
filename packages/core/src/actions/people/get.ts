import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { PeopleRepository, PersonRow } from "../../ports/people.js";
import {
	formatPersonRow,
	peopleGetSchema,
	type PersonGetInput,
} from "./shared.js";

export const PERSON_GET_DESCRIPTION = "Read a single people row by id.";

export interface PersonGetResult {
	found: boolean;
	person: PersonRow | null;
}

export function formatPersonGetMcp(result: PersonGetResult): string {
	if (!result.found || !result.person) return "No person found.";
	return formatPersonRow(result.person);
}

export function createPersonGetAction(
	repo: PeopleRepository,
): ActionDefinition<typeof peopleGetSchema, PersonGetResult> {
	return defineAction({
		id: "person_get",
		description: PERSON_GET_DESCRIPTION,
		schema: peopleGetSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: PersonGetInput, ctx) => {
			const person = await repo.getById(input.id, ctx?.userId);
			return {
				found: Boolean(person),
				person: person ?? null,
			};
		},
		formatMcp: formatPersonGetMcp,
	});
}
