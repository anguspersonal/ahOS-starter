import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { reconcileDomain } from "../../domain/domains.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { BindingRepository } from "../../ports/bindings.js";
import type { CapabilityEntityRow, CapabilityRepository } from "../../ports/capabilities.js";
import { resolveNames, resolveScopeToDomainId } from "../bindings/shared.js";
import {
	normalizeCapabilityLookup,
	wrapServedCapabilityBody,
	type CapabilityActionPorts,
} from "./shared.js";

// Bake-at-serve resolution (ADR-019 §4 / #62, migrated in #1596). Takes a
// capability name + a scope, loads the capability body from the registry
// (entity_type='capability'), and substitutes every `{{name}}` reference with
// the value its binding resolves to under that scope.
//
// Missing bindings FAIL LOUD with the full manifest in one pass — never a
// silent-empty substitution.

// {{ name }} where name is a dotted namespace. Whitespace inside the braces is
// tolerated; the captured name is trimmed.
const REF_PATTERN = /\{\{\s*([A-Za-z0-9]+(?:\.[A-Za-z0-9_]+)+)\s*\}\}/g;

export const resolveCapabilityInput = {
	name: z
		.string()
		.min(1)
		.describe("Capability name to resolve (exact, case-insensitive) — e.g. 'capture'."),
	// Required in fact, optional at the zod layer (#1062): either argument satisfies
	// it, and requireCapabilityDomain below refuses when neither is given. Unlike a
	// binding, a resolve has no domain-agnostic answer — the whole point is that the
	// same body resolves differently per domain — so there is nothing to default to.
	domain: optionalDomainInput,
	scope: z.string().min(1).optional().describe("Deprecated, use `domain`."),
} as const;

export const resolveCapabilitySchema = z.object(resolveCapabilityInput);
export type CapabilityResolveInput = z.infer<typeof resolveCapabilitySchema>;

export type CapabilityResolveOutput = {
	id: string;
	text: string;
};

export interface CapabilityResolvePorts {
	capabilities: CapabilityRepository | Pick<CapabilityActionPorts, "repo">;
	bindings: BindingRepository;
}

/** The domain to resolve bindings under, from either argument. */
export function requireCapabilityDomain(args: { domain?: string; scope?: string }): string {
	const domain = reconcileDomain(args.domain, args.scope, "scope");
	if (!domain) {
		throw new Error(
			"`domain` is required to resolve a capability — 'work' or 'angus'. The same body resolves to different bindings per domain, so there is no default that is right.",
		);
	}
	return domain;
}

/** Distinct `{{name}}` references in order of first appearance. */
export function extractRefs(body: string): string[] {
	const seen = new Set<string>();
	for (const m of body.matchAll(REF_PATTERN)) {
		seen.add(m[1].trim());
	}
	return Array.from(seen);
}

function resolveCapabilityRepo(
	capabilities: CapabilityRepository | Pick<CapabilityActionPorts, "repo">,
): CapabilityRepository {
	return "repo" in capabilities && capabilities.repo
		? capabilities.repo
		: (capabilities as CapabilityRepository);
}

/** Load a capability's stored body by exact (case-insensitive) name, after stripping `ahos/` or `ahkms/` prefix and resolving ritual aliases (ADR-112). */
async function findCapabilityBody(
	repo: CapabilityRepository,
	name: string,
): Promise<{ id: string; body: string; storage_location: string; storage_url: string | null } | null> {
	const rows = (await repo.list({ includeArchived: false })).filter((r) => !r.archived);
	const { candidates } = normalizeCapabilityLookup(name);
	let row: CapabilityEntityRow | undefined;
	for (const candidate of candidates) {
		row = rows.find((r) => (r.title ?? "").toLowerCase() === candidate);
		if (row) break;
	}
	if (!row && rows.length === 0) {
		for (const candidate of candidates) {
			const byName = await repo.findByName(candidate);
			if (byName && !byName.archived) {
				row = byName;
				break;
			}
		}
	}
	if (!row) return null;
	const p = row.properties ?? {};
	const body = typeof p.body === "string" ? p.body : "";
	const storage_location = typeof p.storage_location === "string" ? p.storage_location : "kms-db";
	const storage_url = typeof p.storage_url === "string" ? p.storage_url : null;
	return { id: row.id, body, storage_location, storage_url };
}

export function createCapabilityResolveAction(
	ports: CapabilityResolvePorts,
): ActionDefinition<typeof resolveCapabilitySchema, CapabilityResolveOutput> {
	return defineAction({
		id: "capability_resolve",
		description:
			"Bake-at-serve resolution: load a capability's body and substitute every {{name}} reference with the value its binding resolves to UNDER THE GIVEN SCOPE. scope is a human string ('personal' | 'work') — the same body resolves differently per scope. Bindings resolve to identifiers/paths only, NEVER secrets. Missing bindings fail loud with a required-bindings manifest (error='missing_bindings'), never a silent-empty substitution.",
		schema: resolveCapabilitySchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (args) => {
			const capabilityRepo = resolveCapabilityRepo(ports.capabilities);
			const bindingRepo = ports.bindings;

			const domain = requireCapabilityDomain(args);
			const domainId = await resolveScopeToDomainId(bindingRepo, domain);

			const cap = await findCapabilityBody(capabilityRepo, args.name);
			if (!cap) {
				throw new Error(
					`capability_not_found: no capability named '${args.name}'. Register it first (capability_register).`,
				);
			}
			if (cap.body.trim() === "") {
				throw new Error(
					`capability_has_no_body: '${args.name}' is indexed but stores no body to resolve (storage_location is external). Fetch it from its canonical home instead.`,
				);
			}

			const refs = extractRefs(cap.body);
			if (refs.length === 0) {
				return {
					id: cap.id,
					text: wrapServedCapabilityBody(cap.body, cap.storage_location, cap.storage_url),
				};
			}

			const { resolved, missing } = await resolveNames(bindingRepo, refs, domainId);

			if (missing.length > 0) {
				const manifest = { error: "missing_bindings", capability: args.name, scope: domain, missing };
				throw new Error(JSON.stringify(manifest));
			}

			const baked = cap.body.replace(REF_PATTERN, (_match, rawName: string) => resolved[rawName.trim()]);
			return {
				id: cap.id,
				text: wrapServedCapabilityBody(baked, cap.storage_location, cap.storage_url),
			};
		},
		formatMcp: (output) => output.text,
	});
}
