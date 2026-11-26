/**
 * @ahkms/core/ports - CapabilityRepository port (ADR-101, Issue #1540).
 *
 * Persistence interface over `entities` rows with `entity_type = 'capability'`
 * so `capability_get`, `capability_register` (#1593) and `capability_resolve`
 * (#1596) can execute in core without touching Supabase or `env` directly.
 */

export interface CapabilityEntityRow {
	id: string;
	title: string | null;
	description: string | null;
	properties: Record<string, unknown> | null;
	tags?: string[] | null;
	archived: boolean | null;
	created_at: string | null;
	updated_at: string | null;
}

export interface CapabilityListOptions {
	includeArchived?: boolean;
}

export interface CapabilityInsertInput {
	id?: string;
	title: string;
	description?: string | null;
	properties: Record<string, unknown>;
	tags?: string[];
	domain_override?: string;
}

export interface CapabilityUpdatePatch {
	title: string;
	description?: string | null;
	properties: Record<string, unknown>;
	tags: string[];
	domain_override?: string;
}

export interface CapabilityRepository {
	list(options?: CapabilityListOptions): Promise<CapabilityEntityRow[]>;
	findByName(name: string): Promise<CapabilityEntityRow | null>;
	insert(row: CapabilityInsertInput): Promise<{ id: string }>;
	update(id: string, patch: CapabilityUpdatePatch): Promise<void>;
}
