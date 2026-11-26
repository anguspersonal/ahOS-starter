import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "../../domain/aliases.js";
import { matchesPersonQuery, PEOPLE_SCAN_LIMIT } from "../../actions/people/shared.js";
import type {
	ExistingPersonEmailRow,
	PeopleLoadResult,
	PeopleMutateRepository,
	PeopleQueryFilter,
	PeopleRepository,
	PeopleSelfRepository,
	PeopleWriteRepository,
	PersonEntityInsertRow,
	PersonRow,
	PersonWrittenRow,
	SelfEntityInsert,
	SelfEntityRow,
	SelfIdentity,
	SelfPreferencesState,
} from "../../ports/people.js";

export type PeopleSupabaseClient = Pick<SupabaseClient, "from">;

export interface SupabasePeopleRepositoryOptions {
	client: PeopleSupabaseClient;
	ownerId?: string | (() => string | undefined);
}

export const PERSON_BASE_COLUMNS =
	"id, name, bio, role, organization, email, phone, relationship, last_contact, tags, archived, archived_at, properties, source_url, user_id, team_id, created_at, updated_at";
/** Projected by the people view from migration 110 on (#1023). */
export const PERSON_COLUMNS = `${PERSON_BASE_COLUMNS}, aliases, hot`;

export const SELF_PREFS_MIGRATION_HINT =
	"If this mentions a missing column (self_entity_id / identity), apply migration 053 (supabase/migrations/20260627120000_053_add_self_entity_to_user_preferences.sql).";

/**
 * Run a read with the migration-110 columns, and once more without them if the
 * view does not have them yet (#1023).
 */
export async function withPersonAliasColumns<
	T extends { error: { code?: string; message?: string } | null },
>(run: (columns: string) => PromiseLike<T>): Promise<T> {
	const first = await run(PERSON_COLUMNS);
	if (
		!isMissingColumnError(first.error, "aliases") &&
		!isMissingColumnError(first.error, "hot")
	) {
		return first;
	}
	return run(PERSON_BASE_COLUMNS);
}

export function createSupabasePeopleRepository(
	options: SupabasePeopleRepositoryOptions,
): PeopleRepository & PeopleSelfRepository & PeopleWriteRepository & PeopleMutateRepository {
	const resolveOwnerId = (override?: string) =>
		override ??
		(typeof options.ownerId === "function" ? options.ownerId() : options.ownerId);
	const requireOwnerId = (override?: string): string => {
		const id = resolveOwnerId(override);
		if (!id) throw new Error("People self resolution requires an owner user_id.");
		return id;
	};

	return {
		async getById(id: string, userId?: string): Promise<PersonRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await withPersonAliasColumns((columns) => {
				let q = options.client.from("people").select(columns).eq("id", id);
				if (activeUserId) q = q.eq("user_id", activeUserId);
				return q.maybeSingle();
			});
			if (error) throw new Error(`People get failed: ${error.message}`);
			return (data as unknown as PersonRow | null) ?? null;
		},

		async load(filter: PeopleQueryFilter, userId?: string): Promise<PeopleLoadResult> {
			const activeUserId = resolveOwnerId(userId);
			if (
				filter.user_id !== undefined &&
				activeUserId !== undefined &&
				filter.user_id !== activeUserId
			) {
				throw new Error(
					`People query failed: user_id "${filter.user_id}" does not match the current user.`,
				);
			}
			const effectiveUserId = activeUserId ?? filter.user_id;
			const limit = filter.limit ?? 20;

			const { data, error } = await withPersonAliasColumns((columns) => {
				let q = options.client
					.from("people")
					.select(columns)
					.order("updated_at", { ascending: false, nullsFirst: false });

				if (effectiveUserId) {
					q = q.eq("user_id", effectiveUserId);
				}
				if (filter.team_id) {
					q = q.eq("team_id", filter.team_id);
				}
				if (filter.ids?.length) {
					q = q.in("id", filter.ids);
				}
				if (!filter.include_archived) {
					q = q.eq("archived", false);
				}

				// Without a query the database limit is the answer; with one it is a scan window.
				return q.limit(filter.query ? PEOPLE_SCAN_LIMIT : limit);
			});
			if (error) throw new Error(`People query failed: ${error.message}`);

			const scanned = (data ?? []) as unknown as PersonRow[];
			if (!filter.query) {
				return {
					rows: scanned,
					truncated: limit >= PEOPLE_SCAN_LIMIT && scanned.length >= PEOPLE_SCAN_LIMIT,
				};
			}

			const needle = filter.query.toLowerCase();
			const matched = scanned.filter((person) => matchesPersonQuery(person, needle));
			return {
				rows: matched.slice(0, limit),
				truncated: scanned.length >= PEOPLE_SCAN_LIMIT,
			};
		},

		async readSelfPreferences(userId?: string): Promise<SelfPreferencesState> {
			const { data, error } = await options.client
				.from("user_preferences")
				.select("self_entity_id, identity")
				.eq("user_id", requireOwnerId(userId))
				.maybeSingle();
			if (error) throw new Error(`Read user_preferences failed: ${error.message}. ${SELF_PREFS_MIGRATION_HINT}`);
			return {
				self_entity_id: (data?.self_entity_id as string | null) ?? null,
				identity: ((data?.identity as SelfIdentity | null) ?? {}) as SelfIdentity,
				exists: Boolean(data),
			};
		},

		async writeSelfPreferences(rowExists, selfEntityId, identity, userId): Promise<void> {
			const uid = requireOwnerId(userId);
			if (rowExists) {
				const { error } = await options.client
					.from("user_preferences")
					.update({ self_entity_id: selfEntityId, identity, updated_at: new Date().toISOString() })
					.eq("user_id", uid);
				if (error) throw new Error(`Update user_preferences failed: ${error.message}. ${SELF_PREFS_MIGRATION_HINT}`);
				return;
			}
			const { error } = await options.client
				.from("user_preferences")
				.insert({ user_id: uid, self_entity_id: selfEntityId, identity });
			if (error) throw new Error(`Insert user_preferences failed: ${error.message}. ${SELF_PREFS_MIGRATION_HINT}`);
		},

		async findSelfEntityById(id, userId): Promise<SelfEntityRow | null> {
			const { data, error } = await options.client
				.from("entities")
				.select("id, title, properties")
				.eq("user_id", requireOwnerId(userId))
				.eq("id", id)
				.eq("archived", false)
				.maybeSingle();
			if (error) throw new Error(`Lookup self entity failed: ${error.message}`);
			return (data as SelfEntityRow | null) ?? null;
		},

		async findSelfEntityByFlag(userId): Promise<SelfEntityRow | null> {
			const { data, error } = await options.client
				.from("entities")
				.select("id, title, properties")
				.eq("user_id", requireOwnerId(userId))
				.eq("entity_type", "people")
				.eq("archived", false)
				.contains("properties", { is_self: true })
				.limit(1)
				.maybeSingle();
			if (error) throw new Error(`is_self lookup failed: ${error.message}`);
			return (data as SelfEntityRow | null) ?? null;
		},

		async findSelfEntityByEmail(emails, userId): Promise<SelfEntityRow | null> {
			const lowered = emails.map((e) => e.toLowerCase()).filter(Boolean);
			if (lowered.length === 0) return null;
			const { data, error } = await options.client
				.from("people")
				.select("id, name, email, properties")
				.eq("user_id", requireOwnerId(userId))
				.in("email", lowered)
				.limit(1)
				.maybeSingle();
			if (error) throw new Error(`Email match failed: ${error.message}`);
			if (!data) return null;
			return {
				id: data.id as string,
				title: (data.name as string | null) ?? null,
				properties: (data.properties as Record<string, unknown> | null) ?? null,
			};
		},

		async findSelfEntityByName(name, userId): Promise<SelfEntityRow | null> {
			const { data, error } = await options.client
				.from("entities")
				.select("id, title, properties")
				.eq("user_id", requireOwnerId(userId))
				.eq("entity_type", "people")
				.eq("archived", false)
				.ilike("title", name)
				.limit(1)
				.maybeSingle();
			if (error) throw new Error(`Name match failed: ${error.message}`);
			return (data as SelfEntityRow | null) ?? null;
		},

		async createSelfEntity(entity: SelfEntityInsert, userId): Promise<SelfEntityRow> {
			const { error } = await options.client.from("entities").insert({
				id: entity.id,
				user_id: requireOwnerId(userId),
				entity_type: "people",
				title: entity.title,
				description: "The owner of this knowledge store (self).",
				properties: entity.properties,
				tags: [],
			});
			if (error) throw new Error(`Create self entity failed: ${error.message}`);
			return { id: entity.id, title: entity.title, properties: entity.properties };
		},

		async markSelfEntity(entity: SelfEntityRow, userId): Promise<void> {
			const { error } = await options.client
				.from("entities")
				.update({ properties: { ...(entity.properties ?? {}), is_self: true }, updated_at: new Date().toISOString() })
				.eq("id", entity.id)
				.eq("user_id", requireOwnerId(userId));
			if (error) throw new Error(`Flagging is_self failed: ${error.message}`);
		},

		async insertPeople(
			rows: PersonEntityInsertRow[],
			userId?: string,
			errorPrefix = "People create failed",
		): Promise<PersonWrittenRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const payload = rows.map((row) =>
				row.user_id === undefined && activeUserId !== undefined
					? { ...row, user_id: activeUserId }
					: row,
			);
			const { data, error } = await options.client
				.from("entities")
				.insert(payload)
				.select("id, title, description, properties, aliases");
			if (error) throw new Error(`${errorPrefix}: ${error.message}`);
			return (data ?? []) as PersonWrittenRow[];
		},

		async updatePersonById(
			id: string,
			updates: Record<string, unknown>,
			userId?: string,
		): Promise<PersonWrittenRow | null> {
			const activeUserId = resolveOwnerId(userId);
			let q = options.client
				.from("entities")
				.update({
					...updates,
					entity_type: "people",
					...(activeUserId !== undefined ? { user_id: activeUserId } : {}),
				})
				.eq("entity_type", "people");
			if (activeUserId !== undefined) q = q.eq("user_id", activeUserId);
			const { data, error } = await q
				.eq("id", id)
				.select("id, title, description, properties, aliases");
			if (error) throw new Error(`People upsert failed for ${id}: ${error.message}`);
			return ((data as PersonWrittenRow[] | null)?.[0]) ?? null;
		},

		async findExistingPeopleForEmails(
			ids: string[],
			userId?: string,
			useEqForSingle = false,
		): Promise<Map<string, ExistingPersonEmailRow>> {
			const map = new Map<string, ExistingPersonEmailRow>();
			if (ids.length === 0) return map;
			const sel: any = options.client.from("entities").select("id, properties");
			if (!sel || typeof sel.eq !== "function") return map;
			const activeUserId = resolveOwnerId(userId);
			let q: any = sel.eq("entity_type", "people");
			if (activeUserId !== undefined) q = q.eq("user_id", activeUserId);
			if (useEqForSingle && ids.length === 1) q = q.eq("id", ids[0]);
			else if (typeof q.in === "function") q = q.in("id", ids);
			else if (ids.length === 1) q = q.eq("id", ids[0]);
			const result: any =
				q && typeof q.limit === "function"
					? await q.limit(ids.length)
					: q && typeof q.maybeSingle === "function" && ids.length === 1
						? await q.maybeSingle()
						: await q;
			if (result?.error) {
				throw new Error(`People existing email check failed: ${result.error.message}`);
			}
			const raw = result?.data;
			for (const row of Array.isArray(raw) ? raw : raw ? [raw] : []) {
				if (row && typeof row.id === "string") map.set(row.id, row);
			}
			return map;
		},

		async updatePeopleByIds(
			ids: string[],
			updates: Record<string, unknown>,
			userId?: string,
		): Promise<PersonWrittenRow[]> {
			if (ids.length === 0) return [];
			const activeUserId = resolveOwnerId(userId);
			let q = options.client
				.from("entities")
				.update(updates)
				.eq("entity_type", "people");
			if (activeUserId !== undefined) q = q.eq("user_id", activeUserId);
			const { data, error } = await q
				.in("id", ids)
				.select("id, title, description, properties, aliases");
			if (error) throw new Error(`People update failed: ${error.message}`);
			return (data ?? []) as PersonWrittenRow[];
		},

		async deletePeopleByIds(
			ids: string[],
			userId?: string,
		): Promise<Array<{ id: string; title: string | null }>> {
			if (ids.length === 0) return [];
			const activeUserId = resolveOwnerId(userId);
			let q = options.client
				.from("entities")
				.delete()
				.eq("entity_type", "people");
			if (activeUserId !== undefined) q = q.eq("user_id", activeUserId);
			const { data, error } = await q.in("id", ids).select("id, title");
			if (error) throw new Error(`People delete failed: ${error.message}`);
			return (data ?? []) as Array<{ id: string; title: string | null }>;
		},
	};
}
