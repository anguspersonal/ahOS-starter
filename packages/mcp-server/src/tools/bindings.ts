import {
	type BindingRow,
	resolveNames as coreResolveNames,
} from "@ahkms/core";
import {
	createSupabaseBindingRepository,
	type BindingsSupabaseClient,
} from "@ahkms/core/adapters";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";

export type { BindingRow };

const bindingRepo = createSupabaseBindingRepository({
	client: supabase as unknown as BindingsSupabaseClient,
	ownerId: getCurrentUserId,
});

export async function resolveBindingValue(row: BindingRow): Promise<string | null> {
	return bindingRepo.resolveBindingValue(row);
}

export async function resolveNames(
	names: string[],
	domainId: string | null,
): Promise<{ resolved: Record<string, string>; missing: string[] }> {
	return coreResolveNames(bindingRepo, names, domainId);
}
