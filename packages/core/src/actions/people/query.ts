import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { PeopleRepository, PersonRow } from "../../ports/people.js";
import {
	formatPersonRow,
	PEOPLE_SCAN_LIMIT,
	peopleQuerySchema,
	type PersonQueryInput,
} from "./shared.js";

export const PERSON_QUERY_DESCRIPTION =
	"Read people rows from the people view/table. Returns name, bio, role, organization, email, phone, relationship, last_contact, tags, archived state, and timestamps. Supports ids, team/user filters, query filtering, archived inclusion, and limit.";

export interface PersonQueryResult {
	count: number;
	rows: PersonRow[];
	truncated: boolean;
}

export function formatPersonQueryMcp(result: PersonQueryResult): string {
	const note = result.truncated
		? `\n⚠️ Scanned the ${PEOPLE_SCAN_LIMIT} most recently updated people only — matches may exist beyond that window.`
		: "";
	if (result.rows.length === 0) return `No people found.${note}`;
	return `People (${result.rows.length}):\n${result.rows.map(formatPersonRow).join("\n")}${note}`;
}

export function createPersonQueryAction(
	repo: PeopleRepository,
): ActionDefinition<typeof peopleQuerySchema, PersonQueryResult> {
	return defineAction({
		id: "person_query",
		description: PERSON_QUERY_DESCRIPTION,
		schema: peopleQuerySchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: PersonQueryInput, ctx) => {
			if (input.user_id !== undefined && input.user_id !== ctx?.userId) {
				throw new Error(
					`People query failed: user_id "${input.user_id}" does not match the current user.`,
				);
			}
			const { rows, truncated } = await repo.load(input, ctx?.userId);
			return {
				count: rows.length,
				rows,
				truncated,
			};
		},
		formatMcp: formatPersonQueryMcp,
	});
}
