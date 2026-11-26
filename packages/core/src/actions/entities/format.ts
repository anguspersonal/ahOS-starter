import type {
	EntityRow,
	DomainResolution,
	EntityCreateResult,
	EntityGetResult,
	EntityQueryResult,
	EntityUpdateResult,
	EntityDeleteResult,
	EntityBulkDeleteResult,
	EntityUpsertResult,
	EntitiesCrudResult,
} from "../domain/entities.js";

export const SCAN_LIMIT = 2000;

/** Trim, drop blanks, dedupe case-insensitively; the first spelling seen wins. */
export function normalizeAliases(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

/** Every alias a row carries: the column first, then the legacy jsonb array. */
export function collectAliases(row: {
	aliases?: readonly string[] | null;
	properties?: Record<string, unknown> | null;
}): string[] {
	const legacy = row.properties?.aliases;
	return normalizeAliases([...(row.aliases ?? []), ...(Array.isArray(legacy) ? legacy : [])]);
}

/**
 * ADR-084: render the entity's resolved domain (the derived `domain` value plus
 * `resolved_by`, naming which step of the resolver order answered) alongside
 * the row it describes. `null` domain reads as "unresolved" per R3: surfaced,
 * never guessed.
 */
export function formatDomain(resolution: DomainResolution): string {
	return `domain: ${resolution.domain ?? "unresolved"} | domain_resolution: ${resolution.resolved_by}`;
}

export function formatRow(entity: EntityRow, domain?: DomainResolution | null): string {
	const aliases = collectAliases(entity);
	const parts = [
		entity.entity_type,
		entity.title ?? "(untitled)",
		aliases.length ? `aka: ${aliases.join(", ")}` : null,
		entity.local_name ? `local_name: ${entity.local_name}${entity.namespace ? ` (${entity.namespace})` : ""}` : null,
		entity.description ? `desc: ${entity.description}` : null,
		entity.tags?.length ? `tags: ${entity.tags.join(", ")}` : null,
		// Only shown when set; absence reads as "native to the graph" (#426).
		entity.source_url ? `source: ${entity.source_url}` : null,
		domain ? formatDomain(domain) : null,
		entity.hot ? "hot" : null,
		entity.archived ? "archived" : null,
	].filter(Boolean);
	return `• [${entity.id}] ${parts.join(" | ")}`;
}

/**
 * The row's whole `properties` object, as one JSON line under its row.
 * `entity_update` replaces `properties` wholesale, so a caller that means to
 * change one key has to read every other key first and write the merged whole.
 * Without this line no read tool showed the object, and a "merge" over nothing
 * silently wiped the keys it could not see (#1234, #1236).
 */
export function formatProperties(entity: EntityRow): string {
	return `  properties: ${JSON.stringify(entity.properties ?? {})}`;
}

export function formatEntitiesCreateMcp(result: EntityCreateResult): string {
	return `Created ${result.count} entities: ${result.entities.map((row) => `[${row.id}] ${row.title} (${row.entity_type})`).join(", ")}`;
}

export function formatEntitiesGetMcp(result: EntityGetResult): string {
	if (!result.found || !result.entity) return "No entity found.";
	return `${formatRow(result.entity, result.domain)}\n${formatProperties(result.entity)}`;
}

export function formatEntitiesQueryMcp(result: EntityQueryResult, includeProperties = false): string {
	const note = result.truncated ? `\n⚠️ Scanned the ${SCAN_LIMIT} most recently updated entities only: matches may exist beyond that window.` : "";
	if (result.count === 0) return `No entities found.${note}`;
	const lines = result.rows.map((row, i) =>
		includeProperties ? `${formatRow(row, result.domains?.[i])}\n${formatProperties(row)}` : formatRow(row, result.domains?.[i]),
	);
	return `Entities (${result.count}):\n${lines.join("\n")}${note}`;
}

export function formatEntitiesUpdateMcp(result: EntityUpdateResult): string {
	return `Updated ${result.count} entities: ${result.updated.map((row) => `[${row.id}] ${row.title ?? "(untitled)"}`).join(", ")}`;
}

export function formatEntitiesDeleteMcp(result: EntityDeleteResult | EntityBulkDeleteResult): string {
	if (result.dryRun) {
		const sampleText = result.sample?.length
			? ` Preview sample: ${result.sample.map((s) => `[${s.id}] ${s.title ?? "(untitled)"}`).join(", ")}`
			: "";
		return `[Dry Run] Would ${result.archiveOnly ? "archive" : "delete"} ${result.count} entities.${sampleText}`;
	}
	const verb = result.archiveOnly ? "Archived" : "Deleted";
	return `${verb} ${result.count} entities: ${result.deleted.map((row) => `[${row.id}] ${row.title ?? "(untitled)"}`).join(", ")}`;
}

export function formatEntitiesUpsertMcp(result: EntityUpsertResult): string {
	return `Upserted ${result.count} entities: ${result.created.length ? `created ${result.created.join(", ")}` : ""}${result.created.length && result.updated.length ? "; " : ""}${result.updated.length ? `updated ${result.updated.join(", ")}` : ""}`.trim();
}

export function formatEntitiesCrudMcp(result: EntitiesCrudResult, includeProperties = false): string {
	switch (result.operation) {
		case "create":
			return formatEntitiesCreateMcp(result);
		case "get":
			return formatEntitiesGetMcp(result);
		case "query":
			return formatEntitiesQueryMcp(result, includeProperties);
		case "update":
			return formatEntitiesUpdateMcp(result);
		case "delete":
		case "bulk_delete":
			return formatEntitiesDeleteMcp(result);
		case "upsert":
			return formatEntitiesUpsertMcp(result);
	}
}
