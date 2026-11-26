import { DOMAINS, type EntityDomain } from "./domains.js";
import { DEFAULT_DOS_CONFIG, domainConfig, type DosConfig } from "./dosConfig.js";
import type {
	EntityDomainRow,
	EntityRepository,
	ResolvedBy,
} from "../ports/entities.js";

// ADR-084 / ADR-107: an entity's `domain` across the Knowledge Graph is
// derived at read time, in a fixed order every caller must apply identically:
//
//   1. `entities.domain_override`, if set — return verbatim, terminal ('work' | 'angus' | 'cross-domain').
//   2. If `properties.is_self` is true, resolve immediately to 'cross-domain' (ADR-107) —
//      the owner by definition spans and bridges both spheres.
//   3. Walk the entity's primary `belongs_to` edge (ADR-049) to its parent and
//      recurse this same order on the parent. Secondary `associated_with` edges
//      are never followed — they carry no roll-up semantics.
//   4. Match the entity's own title/description/tags/properties text against
//      each domain's `domain_signals` list (`user_preferences.dos_config`,
//      `by_domain.<domain>.domain_signals`, ADR-054 §5) — the identical
//      matching rule `dos` Step 1 already applies to atoms
//      (`.claude/skills/dos/SKILL.md`: "work if the atom references any of
//      the work routing signals; otherwise angus"), read as a case-
//      insensitive substring test and applied per-domain here so a graph
//      entity and the atom that produced it resolve against the same evidence.
//   5. Neither reaches: report unresolved (R3 — surface, don't guess). This
//      module does NOT write the memoised judgement back to `domain_override`;
//      that write happens through the ordinary `entities_update` /
//      `entities_upsert` path (see tools/entities.ts), keeping "derive" and
//      "assert the residue" as two separate, explicit actions.
//
// This module is the ONE place that order is implemented. `matchesDomainSignals`
// is exported so nothing else grows a second matcher (ADR-084's own warning:
// "every caller agrees" depends on the order — and the matching rule — being
// followed identically everywhere).

export type DomainResolution = {
	domain: EntityDomain | null;
	resolved_by: ResolvedBy;
	path: string[];
	matched_signal?: string;
	reason?: string;
};

export type EntityDomainResolution = DomainResolution;

export type { EntityDomainRow, ResolvedBy };

export type EntityDomainReader = Pick<
	EntityRepository,
	"getDomainRow" | "fetchPrimaryParentId"
>;

export type DomainResolutionContext = {
	dosConfig?: DosConfig;
	primaryParents?: Map<string, string | null>;
	loadDosConfig?: () => Promise<DosConfig>;
};

const MAX_DEPTH = 50;

export async function fetchPrimaryParentsBatch(
	repo: Pick<EntityRepository, "fetchPrimaryParentsBatch">,
	ids: string[],
): Promise<Map<string, string>> {
	return repo.fetchPrimaryParentsBatch(ids);
}

function entityText(entity: EntityDomainRow): string {
	return [
		entity.title,
		entity.description,
		(entity.tags ?? []).join(" "),
		JSON.stringify(entity.properties ?? {}),
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join(" ")
		.toLowerCase();
}

export function matchesDomainSignals(text: string, signals: string[]): boolean {
	const haystack = text.toLowerCase();
	return signals.some((signal) => signal.trim().length > 0 && haystack.includes(signal.toLowerCase()));
}

async function matchOwnSignals(
	entity: EntityDomainRow,
	context?: DomainResolutionContext,
): Promise<EntityDomain | null> {
	const config =
		context?.dosConfig ??
		(context?.loadDosConfig ? await context.loadDosConfig() : DEFAULT_DOS_CONFIG);
	const text = entityText(entity);
	if (!text) return null;
	for (const domain of DOMAINS) {
		const block = domainConfig(config, domain);
		if (!block) continue;
		if (matchesDomainSignals(text, block.domain_signals)) return domain;
	}
	return null;
}

async function resolveNode(
	repo: EntityDomainReader,
	entityId: string,
	visited: Set<string>,
	depth: number,
	context?: DomainResolutionContext,
): Promise<DomainResolution> {
	if (depth > MAX_DEPTH) {
		return { domain: null, resolved_by: "unresolved", path: [entityId, "depth-limit-reached"] };
	}
	if (visited.has(entityId)) {
		return { domain: null, resolved_by: "unresolved", path: [entityId, "cycle-detected"] };
	}
	visited.add(entityId);

	const entity = await repo.getDomainRow(entityId);
	if (!entity) {
		return { domain: null, resolved_by: "unresolved", path: [entityId, "not-found"] };
	}

	// Step 1: domain_override, terminal ('work' | 'angus' | 'cross-domain').
	if (entity.domain_override) {
		return { domain: entity.domain_override as EntityDomain, resolved_by: "override", path: [entityId] };
	}

	// Step 2 (ADR-107): self entity resolves immediately to 'cross-domain'.
	if (entity.properties?.is_self === true || entity.properties?.is_self === "true") {
		return { domain: "cross-domain", resolved_by: "is_self", path: [entityId] };
	}

	// Step 3: walk the primary belongs_to edge and recurse the same order.
	const parentId =
		depth === 0 && context?.primaryParents
			? (context.primaryParents.get(entityId) ?? null)
			: await repo.fetchPrimaryParentId(entityId);
	if (parentId) {
		const parentResolution = await resolveNode(repo, parentId, visited, depth + 1, context);
		if (parentResolution.domain !== null) {
			return {
				domain: parentResolution.domain,
				resolved_by: "parent",
				path: [entityId, ...(parentResolution.path ?? [])],
			};
		}
	}

	// Step 4: domain_signals against this entity's own text.
	const bySignals = await matchOwnSignals(entity, context);
	if (bySignals) {
		return { domain: bySignals, resolved_by: "signals", path: [entityId] };
	}

	// Step 5: unresolved — surfaced, not guessed (R3).
	return { domain: null, resolved_by: "unresolved", path: [entityId] };
}

export async function resolveEntityDomain(
	repo: EntityDomainReader,
	entityId: string,
	context?: DomainResolutionContext,
): Promise<DomainResolution> {
	return resolveNode(repo, entityId, new Set<string>(), 0, context);
}

export async function resolveEntityDomainSafely(
	repo: EntityDomainReader,
	entityId: string,
	context?: DomainResolutionContext,
): Promise<DomainResolution> {
	try {
		return await resolveEntityDomain(repo, entityId, context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { domain: null, resolved_by: "unresolved", path: [entityId, `resolution-error: ${message}`] };
	}
}
