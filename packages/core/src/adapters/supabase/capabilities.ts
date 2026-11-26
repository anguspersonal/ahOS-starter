/**
 * @ahkms/core/adapters - Supabase adapter for CapabilityRepository (ADR-101, Issue #1540).
 *
 * Reads and writes `entities` rows with `entity_type = 'capability'` scoped to
 * the injected `ownerId()`. Never reads `env` directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	CapabilityEntityRow,
	CapabilityInsertInput,
	CapabilityListOptions,
	CapabilityRepository,
	CapabilityUpdatePatch,
} from "../../ports/capabilities.js";

export type CapabilitySupabaseClient = Pick<SupabaseClient, "from">;

export interface CreateSupabaseCapabilityRepositoryOptions {
	client: CapabilitySupabaseClient;
	ownerId: () => string;
}

const ENTITY_TYPE = "capability";
const SELECT_COLUMNS =
	"id, title, description, properties, tags, archived, created_at, updated_at";

export function createSupabaseCapabilityRepository({
	client,
	ownerId,
}: CreateSupabaseCapabilityRepositoryOptions): CapabilityRepository {
	return {
		async list(options: CapabilityListOptions = {}): Promise<CapabilityEntityRow[]> {
			const { data, error } = await client
				.from("entities")
				.select(SELECT_COLUMNS)
				.eq("user_id", ownerId())
				.eq("entity_type", ENTITY_TYPE)
				.order("updated_at", { ascending: false, nullsFirst: false });

			if (error) {
				throw new Error(`capability_get failed: ${error.message}`);
			}

			const rows = (data as CapabilityEntityRow[] | null) ?? [];
			return options.includeArchived ? rows : rows.filter((row) => !row.archived);
		},

		async findByName(name: string): Promise<CapabilityEntityRow | null> {
			const { data, error } = await client
				.from("entities")
				.select(SELECT_COLUMNS)
				.eq("user_id", ownerId())
				.eq("entity_type", ENTITY_TYPE);

			if (error) {
				throw new Error(`capability_register lookup failed: ${error.message}`);
			}

			const needle = name.toLowerCase();
			return (
				(data as CapabilityEntityRow[] | null)?.find(
					(row) => (row.title ?? "").toLowerCase() === needle,
				) ?? null
			);
		},

		async insert(row: CapabilityInsertInput): Promise<{ id: string }> {
			const id = row.id ?? globalThis.crypto.randomUUID();
			const insertPayload: Record<string, unknown> = {
				id,
				entity_type: ENTITY_TYPE,
				title: row.title,
				description: row.description ?? null,
				properties: row.properties,
				tags: row.tags ?? [],
				archived: false,
				archived_at: null,
				user_id: ownerId(),
				team_id: null,
				...(row.domain_override ? { domain_override: row.domain_override } : {}),
			};

			const { error } = await client.from("entities").insert([insertPayload]);
			if (error) {
				throw new Error(`capability_register create failed: ${error.message}`);
			}
			return { id };
		},

		async update(id: string, patch: CapabilityUpdatePatch): Promise<void> {
			const updatePayload: Record<string, unknown> = {
				title: patch.title,
				description: patch.description ?? null,
				properties: patch.properties,
				tags: patch.tags,
				...(patch.domain_override ? { domain_override: patch.domain_override } : {}),
			};

			const { error } = await client
				.from("entities")
				.update(updatePayload)
				.eq("id", id)
				.eq("user_id", ownerId());

			if (error) {
				throw new Error(`capability_register update failed: ${error.message}`);
			}
		},
	};
}
