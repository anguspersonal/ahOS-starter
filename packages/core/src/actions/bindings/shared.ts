import { z } from "zod";
import {
	DOMAINS,
	DOMAIN_LEGACY_SCOPE,
	LEGACY_DOMAIN_VALUE,
	reconcileDomain,
} from "../../domain/domains.js";
import type { BindingRepository, TargetKind } from "../../ports/bindings.js";

// name convention: dotted namespace, e.g. notion.inbox_db, drive.folder_id.
// App-layer only (Zod), not a DB constraint — a naming convention, not a
// structural discriminator.
export const NAME_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9_]+)+$/i;
export const bindingName = z
	.string()
	.regex(NAME_PATTERN, "name must be a dotted namespace, e.g. 'notion.inbox_db'");

export const integrationConfigRef = z.object({
	provider: z.string().min(1),
	json_path: z.string().min(1),
});
export const entityRef = z.object({
	entity_id: z.string().min(1),
	property: z.string().min(1),
});
export const literalRef = z.object({
	value: z.union([z.string(), z.number(), z.boolean()]),
});

export function validateTargetRef(kind: TargetKind, ref: Record<string, unknown>): void {
	const schema =
		kind === "integration_config" ? integrationConfigRef : kind === "entity" ? entityRef : literalRef;
	const parsed = schema.safeParse(ref);
	if (!parsed.success) {
		throw new Error(
			`target_ref does not match target_kind='${kind}': ${parsed.error.issues.map((i) => i.message).join("; ")}`,
		);
	}
}

export function bindingDomain(args: { domain?: string; scope?: string }): string | undefined {
	return reconcileDomain(args.domain, args.scope, "scope");
}

/**
 * Resolve a human scope string ("personal" / "work") to a domain entity id.
 * Callers never handle raw UUIDs. Throws (listing the available domains) on an
 * unknown scope so a typo fails loud rather than silently resolving nothing.
 */
export async function resolveScopeToDomainId(
	repo: BindingRepository,
	scope: string,
): Promise<string> {
	const needle = scope.trim().toLowerCase();
	const aliases = new Set<string>([needle]);
	const asDomain = DOMAINS.find((d) => d === needle);
	if (asDomain) aliases.add(DOMAIN_LEGACY_SCOPE[asDomain].toLowerCase());
	for (const [legacy, domain] of Object.entries(LEGACY_DOMAIN_VALUE)) {
		if (legacy === needle) aliases.add(domain.toLowerCase());
	}
	const domains = await repo.listDomains();
	const match = domains.find((d) => aliases.has((d.title ?? "").toLowerCase()));
	if (!match) {
		const available = domains.map((d) => d.title).filter(Boolean).join(", ") || "(none seeded)";
		throw new Error(`Unknown domain '${scope}'. Available domains: ${available}.`);
	}
	return match.id;
}

/**
 * Resolve a set of `{{name}}` references under one scope in a single pass.
 * Returns the resolved map and every name that could NOT be resolved (no binding
 * OR a dangling pointer) so the caller can fail loud with the full manifest at
 * once, never one-at-a-time.
 */
export async function resolveNames(
	repo: BindingRepository,
	names: string[],
	domainId: string | null,
): Promise<{ resolved: Record<string, string>; missing: string[] }> {
	const results = await Promise.all(
		names.map(async (name) => {
			const binding = await repo.findBinding(name, domainId);
			if (!binding) return { name, value: null as string | null };
			const value = await repo.resolveBindingValue(binding);
			return { name, value };
		}),
	);

	const resolved: Record<string, string> = {};
	const missing: string[] = [];
	for (const { name, value } of results) {
		if (value === null) {
			missing.push(name);
		} else {
			resolved[name] = value;
		}
	}
	return { resolved, missing };
}
