import { z } from "zod";
import { normalizeAliases } from "../../domain/aliases.js";
import {
	embedAndStore,
	type EntityEmbedFields,
	type RetryOptions,
} from "../../domain/embeddings.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	ExistingPersonEmailRow,
	PeopleRepository,
	PeopleWriteRepository,
	PersonEntityInsertRow,
	PersonWrittenRow,
} from "../../ports/people.js";
import { collectPreviousEmails } from "./shared.js";

export const personFields = {
	id: z.string().uuid().optional().describe("Existing person id, used by update/upsert flows."),
	name: z.string().min(1).optional().describe("Person name."),
	bio: z.string().nullable().optional().describe("Short bio / notes."),
	role: z.string().nullable().optional().describe("Role or title."),
	organization: z.string().nullable().optional().describe("Organization / company."),
	email: z.string().nullable().optional().describe("Email address."),
	phone: z.string().nullable().optional().describe("Phone number."),
	relationship: z.string().nullable().optional().describe("Relationship to the user."),
	last_contact: z
		.string()
		.datetime()
		.nullable()
		.optional()
		.describe("Last contact timestamp in ISO 8601."),
	tags: z.array(z.string()).nullable().optional().describe("Tags."),
	archived: z.boolean().optional().describe("Archived state."),
	archived_at: z
		.string()
		.datetime()
		.nullable()
		.optional()
		.describe("Archived timestamp in ISO 8601."),
	properties: z
		.record(z.string(), z.unknown())
		.nullable()
		.optional()
		.describe("Extra JSON properties to merge or replace."),
	source_url: z
		.string()
		.nullable()
		.optional()
		.describe(
			"URL of the external record that IS this person (e.g. their Notion People row), not pages that mention them. null = native to the graph (#426).",
		),
	aliases: z
		.array(z.string())
		.optional()
		.describe(
			"Other names this person answers to: nicknames, first-name-only, initials (e.g. ['todd', 'TM']). people_match reads them. Replaces the whole list on update, so read it first to append. Needs migration 110 (#1023).",
		),
	hot: z
		.boolean()
		.optional()
		.describe(
			"Put this person in the hot tier: the always-loaded decoder table shipped in every session's MCP instructions (ADR-092, capped at 100 lines). Hand-curated; keep it to the ~30 people referred to by shorthand most often. Needs migration 110 (#1023).",
		),
};

export const personObjectSchema = z.object(personFields);
export type PersonFieldValues = z.infer<typeof personObjectSchema>;

export const peopleCreateInput = {
	people: z.array(z.object(personFields)).min(1).max(100).describe("One or many people to create."),
} as const;

export const peopleUpsertInput = {
	people: z.array(z.object(personFields)).min(1).max(100).describe("One or many people to upsert."),
} as const;

export const personCreateSchema = z.object(peopleCreateInput);
export const personUpsertSchema = z.object(peopleUpsertInput);

export type PersonCreateInput = z.infer<typeof personCreateSchema>;
export type PersonUpsertInput = z.infer<typeof personUpsertSchema>;

export function normalizePersonProperties(person: PersonFieldValues): Record<string, unknown> {
	const props: Record<string, unknown> = { ...(person.properties ?? {}) };
	if (person.role !== undefined) props.role = person.role;
	if (person.organization !== undefined) props.organization = person.organization;
	if (person.email !== undefined) props.email = person.email;
	if (person.phone !== undefined) props.phone = person.phone;
	if (person.relationship !== undefined) props.relationship = person.relationship;
	if (person.last_contact !== undefined) props.last_contact = person.last_contact;
	return props;
}

/**
 * Collapse "" to null so callers clearing source_url with an empty string do not
 * trip the partial unique index `entities_user_source_url_unique` (#426).
 */
export function normalizeSourceUrl(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	return value === "" ? null : value;
}

/** Migration-110 columns carried on a write: only the ones the caller set (#1023). */
export function personAliasColumns(person: {
	aliases?: string[];
	hot?: boolean;
}): { aliases?: string[]; hot?: boolean } {
	const out: { aliases?: string[]; hot?: boolean } = {};
	if (person.aliases !== undefined) out.aliases = normalizeAliases(person.aliases);
	if (person.hot !== undefined) out.hot = person.hot;
	return out;
}

export function toPersonEntityInsert(
	person: PersonFieldValues,
	userId?: string,
): PersonEntityInsertRow {
	return {
		id: globalThis.crypto.randomUUID(),
		entity_type: "people",
		title: person.name,
		description: person.bio ?? null,
		tags: person.tags ?? [],
		archived: person.archived ?? false,
		archived_at: person.archived ? (person.archived_at ?? new Date().toISOString()) : null,
		properties: normalizePersonProperties(person),
		source_url: normalizeSourceUrl(person.source_url) ?? null,
		user_id: userId,
		team_id: null,
		...personAliasColumns(person),
	};
}

export function toPersonEntityUpdate(person: PersonFieldValues): Record<string, unknown> {
	const updates: Record<string, unknown> = {};
	if (person.name !== undefined) updates.title = person.name;
	if (person.bio !== undefined) updates.description = person.bio;
	if (person.tags !== undefined) updates.tags = person.tags ?? [];
	if (person.archived !== undefined) updates.archived = person.archived;
	if (person.archived_at !== undefined) {
		updates.archived_at = person.archived_at ?? (person.archived ? new Date().toISOString() : null);
	}
	if (
		person.role !== undefined ||
		person.organization !== undefined ||
		person.email !== undefined ||
		person.phone !== undefined ||
		person.relationship !== undefined ||
		person.last_contact !== undefined ||
		person.properties !== undefined
	) {
		updates.properties = normalizePersonProperties(person);
	}
	if (person.source_url !== undefined) updates.source_url = normalizeSourceUrl(person.source_url);
	Object.assign(updates, personAliasColumns(person));
	return updates;
}

export function extractIncomingEmail(input: {
	email?: string | null;
	properties?: Record<string, unknown> | null;
}): string | null {
	if (typeof input.email === "string" && input.email.trim().length > 0) {
		return input.email.trim();
	}
	if (
		input.email === undefined &&
		typeof input.properties?.email === "string" &&
		input.properties.email.trim().length > 0
	) {
		return input.properties.email.trim();
	}
	return null;
}

export function extractExistingEmail(row: ExistingPersonEmailRow): string | null {
	const propEmail = row.properties?.email;
	if (typeof propEmail === "string" && propEmail.trim().length > 0) {
		return propEmail.trim();
	}
	if (typeof row.email === "string" && row.email.trim().length > 0) {
		return row.email.trim();
	}
	return null;
}

export function mergePreviousEmailIntoProperties(
	nextProps: Record<string, unknown>,
	existingRow: ExistingPersonEmailRow | undefined,
	incomingEmail: string,
): Record<string, unknown> {
	const existingProps =
		existingRow?.properties &&
		typeof existingRow.properties === "object" &&
		!Array.isArray(existingRow.properties)
			? existingRow.properties
			: {};
	const merged: Record<string, unknown> = { ...existingProps, ...nextProps };
	const existingEmail = existingRow ? extractExistingEmail(existingRow) : null;
	const normIncoming = incomingEmail.trim().toLowerCase();
	if (existingEmail) {
		const normExisting = existingEmail.trim().toLowerCase();
		if (normExisting && normExisting !== normIncoming) {
			const priorList = collectPreviousEmails({
				properties: {
					previous_emails: Array.isArray(nextProps.previous_emails)
						? [...collectPreviousEmails({ properties: existingProps }), ...nextProps.previous_emails]
						: existingProps.previous_emails,
				},
			});
			if (!priorList.includes(normExisting)) priorList.push(normExisting);
			merged.previous_emails = priorList;
		}
	}
	return merged;
}

export interface PeopleWriteDeps {
	people: PeopleRepository | PeopleWriteRepository;
	embeddings?: EmbeddingPort | null | (() => EmbeddingPort | null);
	embeddingStore?: EmbeddingStorePort;
	embedEntity?: (id: string, fields: EntityEmbedFields) => Promise<unknown>;
	retryOptions?: RetryOptions;
}

export function isPeopleWriteDeps(
	value: PeopleRepository | PeopleWriteRepository | PeopleWriteDeps,
): value is PeopleWriteDeps {
	return "people" in value && typeof value.people === "object" && value.people !== null;
}

export function resolvePeopleWriteDeps(
	depsOrRepo: PeopleRepository | PeopleWriteRepository | PeopleWriteDeps,
	embeddings?: EmbeddingPort | null,
	embeddingStore?: EmbeddingStorePort,
): PeopleWriteDeps {
	return isPeopleWriteDeps(depsOrRepo)
		? depsOrRepo
		: { people: depsOrRepo, embeddings, embeddingStore };
}

export function requirePeopleWriteRepo(
	repo: PeopleRepository | PeopleWriteRepository,
): PeopleWriteRepository {
	if (!repo.insertPeople || !repo.updatePersonById || !repo.findExistingPeopleForEmails) {
		throw new Error("PeopleRepository does not implement write methods.");
	}
	return repo as PeopleWriteRepository;
}

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

export async function embedWrittenPersonRow(
	deps: PeopleWriteDeps,
	row: PersonWrittenRow,
): Promise<void> {
	const fields: EntityEmbedFields = {
		title: row.title,
		description: row.description,
		properties: row.properties,
		...(row.aliases !== undefined ? { aliases: row.aliases } : {}),
	};
	const embeddingPort =
		typeof deps.embeddings === "function" ? deps.embeddings() : deps.embeddings;
	if (!embeddingPort && deps.embedEntity) {
		try {
			await deps.embedEntity(row.id, fields);
		} catch {
			// Best-effort embedding on write, matching core embedAndStore.
		}
		return;
	}
	await embedAndStore(
		embeddingPort,
		deps.embeddingStore ?? noopEmbeddingStore,
		"entities",
		row.id,
		fields,
		{ retryOptions: deps.retryOptions },
	);
}
