import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type {
	PeopleRepository,
	PeopleSelfRepository,
	SelfEntityRow,
	SelfIdentity,
} from "../../ports/people.js";

export const personSelfInput = {
	display_name: z
		.string()
		.min(1)
		.optional()
		.describe("Owner's display name; seeds identity + names a newly-created self entity."),
	emails: z
		.array(z.string())
		.optional()
		.describe("Owner's email addresses, used to match references to the owner (dedupe-by-email)."),
};

export const personSelfSchema = z.object(personSelfInput);
export type PersonSelfInput = z.infer<typeof personSelfSchema>;

export const PERSON_SELF_DESCRIPTION =
	"Resolve (or create) the owner's 'self' entity \u2014 the single people entity that represents the user in the graph (ADR-024). Returns its id, which is the endpoint for owner-relationships (e.g. self -[engaged_to]-> someone). Optionally seed the owner's display name + emails on first call so references to the owner can be deduped. Idempotent; caches the pointer in user_preferences.";

export type SelfResolutionHow =
	| "cached pointer"
	| "properties.is_self"
	| "identity email"
	| "display name"
	| "created";

export interface PersonSelfResult {
	id: string;
	title: string;
	created: boolean;
	how: SelfResolutionHow;
	identity: SelfIdentity;
}

export function formatPersonSelfMcp(result: PersonSelfResult): string {
	return `Self entity ${result.id} ("${result.title || "Me"}") \u2014 ${result.created ? "created" : `resolved via ${result.how}`}. Use this id as the endpoint for owner-relationships (e.g. self -[engaged_to]-> \u2026).`;
}

function requireSelfRepo(repo: PeopleRepository | PeopleSelfRepository): PeopleSelfRepository {
	if (!repo.readSelfPreferences || !repo.writeSelfPreferences || !repo.createSelfEntity) {
		throw new Error("PeopleRepository does not implement self-resolution methods.");
	}
	return repo as PeopleSelfRepository;
}

export function createPersonSelfAction(
	repo: PeopleRepository | PeopleSelfRepository,
): ActionDefinition<typeof personSelfSchema, PersonSelfResult> {
	return defineAction({
		id: "person_self",
		description: PERSON_SELF_DESCRIPTION,
		schema: personSelfSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: PersonSelfInput, ctx) => {
			const selfRepo = requireSelfRepo(repo);
			const userId = ctx?.userId;
			const prefs = await selfRepo.readSelfPreferences(userId);

			const identity: SelfIdentity = { ...prefs.identity };
			if (input.display_name) identity.display_name = input.display_name;
			if (input.emails) {
				identity.emails = Array.from(
					new Set([
						...(identity.emails ?? []).map((e) => e.toLowerCase()),
						...input.emails.map((e) => e.toLowerCase()),
					]),
				);
			}

			let found: SelfEntityRow | null = null;
			let how: SelfResolutionHow = "created";
			if (prefs.self_entity_id) {
				found = await selfRepo.findSelfEntityById(prefs.self_entity_id, userId);
				if (found) how = "cached pointer";
			}
			if (!found) {
				found = await selfRepo.findSelfEntityByFlag(userId);
				if (found) how = "properties.is_self";
			}
			if (!found && identity.emails?.length) {
				found = await selfRepo.findSelfEntityByEmail(identity.emails, userId);
				if (found) how = "identity email";
			}
			if (!found && identity.display_name) {
				found = await selfRepo.findSelfEntityByName(identity.display_name, userId);
				if (found) how = "display name";
			}

			let created = false;
			if (!found) {
				const id = globalThis.crypto.randomUUID();
				const title = identity.display_name ?? "Me";
				const properties: Record<string, unknown> = { is_self: true };
				if (identity.emails?.length) {
					properties.emails = identity.emails;
					properties.email = identity.emails[0];
				}
				found = await selfRepo.createSelfEntity({ id, title, properties }, userId);
				created = true;
			} else {
				await selfRepo.markSelfEntity(found, userId);
			}

			await selfRepo.writeSelfPreferences(prefs.exists, found.id, identity, userId);
			return { id: found.id, title: found.title ?? "Me", created, how, identity };
		},
		formatMcp: formatPersonSelfMcp,
	});
}
