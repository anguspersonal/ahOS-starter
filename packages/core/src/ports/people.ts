/**
 * Port for reading people rows over the `people` view and resolving the owner's
 * self entity (ADR-024, ADR-101 §1, #1508, #1512).
 * Pure types only. No external SDKs, database, or environment dependencies.
 */

export interface PersonRow {
	id: string;
	name: string | null;
	bio: string | null;
	role: string | null;
	organization: string | null;
	email: string | null;
	phone: string | null;
	relationship: string | null;
	last_contact: string | null;
	tags: string[] | null;
	archived: boolean | null;
	archived_at: string | null;
	properties: Record<string, unknown> | null;
	source_url: string | null;
	user_id: string | null;
	team_id: string | null;
	created_at: string | null;
	updated_at: string | null;
	/** Absent before migration 110 is pushed (#1023). */
	aliases?: string[] | null;
	hot?: boolean | null;
}

export interface PeopleQueryFilter {
	query?: string;
	ids?: string[];
	team_id?: string;
	user_id?: string;
	include_archived?: boolean;
	limit?: number;
}

export interface PeopleLoadResult {
	rows: PersonRow[];
	truncated: boolean;
}

export type SelfIdentity = { emails?: string[]; display_name?: string };
export type SelfPreferencesState = { self_entity_id: string | null; identity: SelfIdentity; exists: boolean };
export type SelfEntityRow = { id: string; title: string | null; properties: Record<string, unknown> | null };
export type SelfEntityInsert = { id: string; title: string; properties: Record<string, unknown> };

export interface PeopleSelfRepository {
	readSelfPreferences(userId?: string): Promise<SelfPreferencesState>;
	writeSelfPreferences(rowExists: boolean, selfEntityId: string, identity: SelfIdentity, userId?: string): Promise<void>;
	findSelfEntityById(id: string, userId?: string): Promise<SelfEntityRow | null>;
	findSelfEntityByFlag(userId?: string): Promise<SelfEntityRow | null>;
	findSelfEntityByEmail(emails: string[], userId?: string): Promise<SelfEntityRow | null>;
	findSelfEntityByName(name: string, userId?: string): Promise<SelfEntityRow | null>;
	createSelfEntity(entity: SelfEntityInsert, userId?: string): Promise<SelfEntityRow>;
	markSelfEntity(entity: SelfEntityRow, userId?: string): Promise<void>;
}

export interface PersonEntityInsertRow {
	id: string;
	entity_type: "people";
	title?: string;
	description: string | null;
	tags: string[];
	archived: boolean;
	archived_at: string | null;
	properties: Record<string, unknown>;
	source_url: string | null;
	user_id?: string;
	team_id: null;
	aliases?: string[];
	hot?: boolean;
}

export interface PersonWrittenRow {
	id: string;
	title: string | null;
	description: string | null;
	properties: Record<string, unknown> | null;
	aliases?: string[] | null;
}

export interface ExistingPersonEmailRow {
	id?: string;
	email?: unknown;
	properties?: Record<string, unknown> | null;
}

export interface PeopleWriteRepository {
	insertPeople(
		rows: PersonEntityInsertRow[],
		userId?: string,
		errorPrefix?: string,
	): Promise<PersonWrittenRow[]>;
	updatePersonById(
		id: string,
		updates: Record<string, unknown>,
		userId?: string,
	): Promise<PersonWrittenRow | null>;
	findExistingPeopleForEmails(
		ids: string[],
		userId?: string,
		useEqForSingle?: boolean,
	): Promise<Map<string, ExistingPersonEmailRow>>;
}

export interface PeopleMutateRepository {
	updatePeopleByIds(
		ids: string[],
		updates: Record<string, unknown>,
		userId?: string,
	): Promise<PersonWrittenRow[]>;
	deletePeopleByIds(
		ids: string[],
		userId?: string,
	): Promise<Array<{ id: string; title: string | null }>>;
}

export interface PeopleRepository
	extends Partial<PeopleSelfRepository>,
		Partial<PeopleWriteRepository>,
		Partial<PeopleMutateRepository> {
	getById(id: string, userId?: string): Promise<PersonRow | null>;
	load(filter: PeopleQueryFilter, userId?: string): Promise<PeopleLoadResult>;
}
