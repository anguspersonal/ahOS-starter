import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	BindingRepository,
	BindingRow,
	CreateBindingRowInput,
	DomainRow,
	UpdateBindingRowPatch,
} from "../../ports/bindings.js";
import { entityRef, integrationConfigRef, literalRef } from "../../actions/bindings/shared.js";

export type BindingsSupabaseClient = Pick<SupabaseClient, "from">;

export interface SupabaseBindingRepositoryOptions {
	client: BindingsSupabaseClient;
	ownerId: string | (() => string);
}

function toScalar(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value === "" ? null : value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

export function createSupabaseBindingRepository(
	options: SupabaseBindingRepositoryOptions,
): BindingRepository {
	const resolveOwnerId = () =>
		typeof options.ownerId === "function" ? options.ownerId() : options.ownerId;

	return {
		async listDomains(): Promise<DomainRow[]> {
			const { data, error } = await options.client
				.from("entities")
				.select("id, title")
				.eq("user_id", resolveOwnerId())
				.eq("entity_type", "domain")
				.eq("archived", false);
			if (error) throw new Error(`domain lookup failed: ${error.message}`);
			return (data as DomainRow[] | null) ?? [];
		},

		async listBindings(filter?: { name?: string; domainId?: string }): Promise<BindingRow[]> {
			let query = options.client
				.from("bindings")
				.select("id, domain_entity_id, name, target_kind, target_ref")
				.eq("user_id", resolveOwnerId())
				.order("name", { ascending: true });
			if (filter?.name) query = query.eq("name", filter.name);
			if (filter?.domainId) query = query.eq("domain_entity_id", filter.domainId);

			const { data, error } = await query;
			if (error) throw new Error(`binding_list failed: ${error.message}`);
			return (data as BindingRow[] | null) ?? [];
		},

		async findBinding(name: string, domainId: string | null): Promise<BindingRow | null> {
			const { data, error } = await options.client
				.from("bindings")
				.select("id, domain_entity_id, name, target_kind, target_ref")
				.eq("user_id", resolveOwnerId())
				.eq("name", name);
			if (error) throw new Error(`binding lookup failed: ${error.message}`);
			const rows = (data as BindingRow[] | null) ?? [];
			if (domainId) {
				const scoped = rows.find((r) => r.domain_entity_id === domainId);
				if (scoped) return scoped;
			}
			return rows.find((r) => r.domain_entity_id === null) ?? null;
		},

		async resolveBindingValue(row: BindingRow): Promise<string | null> {
			if (row.target_kind === "integration_config") {
				const ref = integrationConfigRef.safeParse(row.target_ref);
				if (!ref.success) return null;
				const { data, error } = await options.client
					.from("user_integrations")
					.select("config") // config ONLY — never credential_ref/status/etc.
					.eq("user_id", resolveOwnerId())
					.eq("provider", ref.data.provider)
					.maybeSingle();
				if (error) throw new Error(`integration_config resolution failed: ${error.message}`);
				const config = (data?.config as Record<string, unknown> | undefined) ?? {};
				return toScalar(config[ref.data.json_path]);
			}

			if (row.target_kind === "entity") {
				const ref = entityRef.safeParse(row.target_ref);
				if (!ref.success) return null;
				const { data, error } = await options.client
					.from("entities")
					.select("title, description, properties")
					.eq("user_id", resolveOwnerId())
					.eq("id", ref.data.entity_id)
					.maybeSingle();
				if (error) throw new Error(`entity resolution failed: ${error.message}`);
				if (!data) return null;
				if (ref.data.property === "title") return toScalar(data.title);
				if (ref.data.property === "description") return toScalar(data.description);
				const props = (data.properties as Record<string, unknown> | null) ?? {};
				return toScalar(props[ref.data.property]);
			}

			const ref = literalRef.safeParse(row.target_ref);
			return ref.success ? toScalar(ref.data.value) : null;
		},

		async findExactBinding(name: string, domainId: string | null): Promise<BindingRow | null> {
			const query = options.client
				.from("bindings")
				.select("id, domain_entity_id, name, target_kind, target_ref")
				.eq("user_id", resolveOwnerId())
				.eq("name", name);
			const { data, error } = await (domainId === null
				? query.is("domain_entity_id", null)
				: query.eq("domain_entity_id", domainId));
			if (error) throw new Error(`binding lookup failed: ${error.message}`);
			const rows = (data as BindingRow[] | null) ?? [];
			return rows[0] ?? null;
		},

		async createBinding(input: CreateBindingRowInput): Promise<void> {
			const { error } = await options.client.from("bindings").insert([
				{
					user_id: resolveOwnerId(),
					domain_entity_id: input.domain_entity_id,
					name: input.name,
					target_kind: input.target_kind,
					target_ref: input.target_ref,
				},
			]);
			if (error) throw new Error(`binding_create failed: ${error.message}`);
		},

		async updateBinding(id: string, patch: UpdateBindingRowPatch): Promise<void> {
			const { error } = await options.client
				.from("bindings")
				.update({ target_kind: patch.target_kind, target_ref: patch.target_ref })
				.eq("id", id)
				.eq("user_id", resolveOwnerId());
			if (error) throw new Error(`binding_update failed: ${error.message}`);
		},

		async deleteBinding(id: string): Promise<void> {
			const { error } = await options.client
				.from("bindings")
				.delete()
				.eq("id", id)
				.eq("user_id", resolveOwnerId());
			if (error) throw new Error(`binding_delete failed: ${error.message}`);
		},
	};
}
