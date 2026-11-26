export const TARGET_KINDS = ["integration_config", "entity", "literal"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export type DomainRow = { id: string; title: string | null };

export type BindingRow = {
	id: string;
	domain_entity_id: string | null;
	name: string;
	target_kind: TargetKind;
	target_ref: Record<string, unknown>;
};

export type CreateBindingRowInput = {
	domain_entity_id: string | null;
	name: string;
	target_kind: TargetKind;
	target_ref: Record<string, unknown>;
};

export type UpdateBindingRowPatch = {
	target_kind: TargetKind;
	target_ref: Record<string, unknown>;
};

export interface BindingRepository {
	listDomains(): Promise<DomainRow[]>;
	listBindings(filter?: { name?: string; domainId?: string }): Promise<BindingRow[]>;
	findBinding(name: string, domainId: string | null): Promise<BindingRow | null>;
	resolveBindingValue(row: BindingRow): Promise<string | null>;
	findExactBinding?(name: string, domainId: string | null): Promise<BindingRow | null>;
	createBinding?(input: CreateBindingRowInput): Promise<void>;
	updateBinding?(id: string, patch: UpdateBindingRowPatch): Promise<void>;
	deleteBinding?(id: string): Promise<void>;
}
