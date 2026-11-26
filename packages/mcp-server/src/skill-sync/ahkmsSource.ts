import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { capabilityKinds, isSkillCapability, normalizeDeclaredSurface } from "./capabilityShape.js";

// ahkms read side for skill-sync (ADR: ahkms as source of truth for single-file
// skills). The SessionStart hook is a plain shell command and cannot call MCP
// tools, so the shared reconcile core reads capabilities the same way the MCP
// tools do — directly against the `entities` substrate with the service-role
// client (see tools/capabilities.ts). Importing this module pulls in env/supabase,
// so the PURE core modules deliberately never import it.

const ENTITY_TYPE = "capability";

// The local skills tree this module compares against is always the Claude Code
// skills home (`~/.claude/skills`, see localSkills.ts). A capability registered
// for a different surface only (e.g. 'cowork') has nothing to compare — it isn't
// backed by a file in that tree — so it must be excluded here, not just at the
// point of use, or a status/push/pull pass would compare against a row that was
// never meant to represent this surface. Mirrors the `surface` enum in
// tools/capabilities.ts (kept local to avoid coupling this creds-free-adjacent
// module to the MCP tool layer).
const SKILL_SYNC_SURFACE = "claude-code";

export interface AhkmsCapability {
	name: string;
	/** Display label: the kinds joined with "+" (e.g. "skill+agent"), or "?" when absent. */
	kind: string;
	/** Every kind the row carries. Migration 114 (#344) made `properties.kind` an array so a skill+agent twin is one row. */
	kinds?: string[];
	storageLocation: string;
	/** Pointer to the canonical home for the non-kms-db storage locations. */
	storageUrl: string | null;
	/** Surfaces the capability is listed for. */
	surface: string[];
	/** Authoritative body when storage_location='kms-db'; otherwise a snapshot or null. */
	body: string | null;
	bodySyncedAt: string | null;
}

type EntityRow = {
	title: string | null;
	properties: Record<string, unknown> | null;
	archived: boolean | null;
};

function toCapability(row: EntityRow): AhkmsCapability {
	const p = row.properties ?? {};
	const kinds = capabilityKinds(p);
	return {
		name: row.title ?? "",
		kind: kinds.length > 0 ? kinds.join("+") : "?",
		kinds,
		storageLocation: typeof p.storage_location === "string" ? p.storage_location : "?",
		storageUrl: typeof p.storage_url === "string" ? p.storage_url : null,
		surface: Array.isArray(p.surface) ? (p.surface as string[]) : [],
		body: typeof p.body === "string" ? p.body : null,
		bodySyncedAt: typeof p.body_synced_at === "string" ? p.body_synced_at : null,
	};
}

/**
 * Every non-archived capability of ANY kind and ANY surface, in registry order.
 * The UNFILTERED read — the single round-trip both views below are built from.
 *
 * Only callers that genuinely have nothing to do with the local file tree should
 * use this directly: today that is the body audit (audit.ts), which must see a
 * cowork-only row precisely because a cowork-only row with no body is the bug it
 * is looking for. Every reconcile path takes a filtered view instead.
 */
export async function fetchCapabilityRows(): Promise<AhkmsCapability[]> {
	const { data, error } = await supabase
		.from("entities")
		.select("title, properties, archived")
		.eq("user_id", getCurrentUserId())
		.eq("entity_type", ENTITY_TYPE);
	if (error) throw new Error(`skill-sync: capability fetch failed: ${error.message}`);

	return ((data as EntityRow[] | null) ?? []).filter((row) => !row.archived).map(toCapability);
}

/**
 * Fetch every non-archived capability of ANY kind registered for the claude-code
 * surface, indexed by lower-cased name. Reads once so a status pass over many
 * local skills is a single round-trip. Capability names are unique per user
 * across kinds, so a name maps to at most one row — letting `status` tell a
 * genuinely unregistered skill-dir apart from one whose name is registered as an
 * agent/command (see #381). Surface-scoped to claude-code because that is the
 * only local tree we compare against (see the SKILL_SYNC_SURFACE note above);
 * kind filtering lives in fetchSkillCapabilities so the reconcile paths never
 * treat an agent/command as a skill.
 */
export async function fetchAllCapabilities(): Promise<Map<string, AhkmsCapability>> {
	const map = new Map<string, AhkmsCapability>();
	for (const cap of await fetchCapabilityRows()) {
		if (!cap.surface.includes(SKILL_SYNC_SURFACE)) continue;
		if (cap.name) map.set(cap.name.toLowerCase(), cap);
	}
	return map;
}

/**
 * Capabilities of ANY kind and ANY surface, indexed by lower-cased name.
 *
 * The repo source (repoPush/repoStatus) needs this rather than the claude-code
 * view above: a repo skill is registered to whatever surfaces its manifest entry
 * declares, and after this PR that legitimately includes cowork/chat. Looking it
 * up through the claude-code filter would report a correctly-registered
 * cross-surface skill as unregistered. The SKILL_SYNC_SURFACE guard still binds
 * where it was written to bind — the home-tree reconcile, which really does
 * compare against a claude-code file tree.
 */
export async function fetchCapabilitiesByName(): Promise<Map<string, AhkmsCapability>> {
	const map = new Map<string, AhkmsCapability>();
	for (const cap of await fetchCapabilityRows()) {
		if (cap.name) map.set(cap.name.toLowerCase(), cap);
	}
	return map;
}

/**
 * Fetch only skill-kind capabilities, indexed by lower-cased name. The reconcile
 * paths (init/pull) compare bodies and must never treat an agent/command as a
 * skill, so they take this filtered view. Matches the case-insensitive naming the
 * MCP tools enforce.
 */
export async function fetchSkillCapabilities(): Promise<Map<string, AhkmsCapability>> {
	const map = new Map<string, AhkmsCapability>();
	for (const [key, cap] of await fetchAllCapabilities()) {
		if (isSkillCapability(cap)) map.set(key, cap);
	}
	return map;
}

export interface UpsertSkillInput {
	name: string;
	description: string | null;
	/** Authoritative kms-db body — the local SKILL.md verbatim. */
	body: string;
	surface: string[];
	/** Canonical repo path when pushed via `skill-sync repo push` (e.g. `.claude/skills/dos/SKILL.md`). */
	repoMirror?: string;
}

/**
 * Thrown when a push would overwrite an existing capability that is NOT a skill
 * (e.g. an agent or command sharing the name). Capability names are unique per
 * user across kinds, so blindly upserting a skill would silently convert the
 * other kind — this guard forces the caller to skip instead.
 */
export class SkillKindConflictError extends Error {
	constructor(
		readonly capabilityName: string,
		readonly existingKind: string,
	) {
		super(`'${capabilityName}' is already registered as '${existingKind}', not a skill — refusing to overwrite`);
		this.name = "SkillKindConflictError";
	}
}

/**
 * Create or full-replace a single-file skill capability as kms-db (ahkms
 * source-of-truth). Mirrors registerCapabilityHandler's find-by-name → update /
 * insert, so the case-insensitive uniqueness and entities shape stay identical.
 * Returns whether a row was created or updated.
 */
export async function upsertSkillCapability(input: UpsertSkillInput): Promise<"created" | "updated"> {
	const { data, error } = await supabase
		.from("entities")
		.select("id, title, properties")
		.eq("user_id", getCurrentUserId())
		.eq("entity_type", ENTITY_TYPE);
	if (error) throw new Error(`skill-sync: capability lookup failed: ${error.message}`);

	const needle = input.name.toLowerCase();
	type LookupRow = { id: string; title: string | null; properties: Record<string, unknown> | null };
	const existing = ((data as LookupRow[] | null) ?? []).find((row) => (row.title ?? "").toLowerCase() === needle);

	if (existing) {
		// Never cross-convert: refuse to overwrite an agent/command of the same name.
		// A missing/malformed `kind` (e.g. legacy data predating this field) is treated
		// as conservatively as an explicit non-skill kind — "unknown ⇒ conflict", not
		// "unknown ⇒ safe to overwrite" — even though every row created through the
		// normal registration path always has `kind` set (it's a required enum there).
		// A skill+agent twin (kind ["skill","agent"], #344) is still a skill: updating its
		// body is exactly what the twin model wants, so only a row with no "skill" kind
		// at all is refused.
		const existingKinds = capabilityKinds(existing.properties);
		if (!existingKinds.includes("skill")) {
			throw new SkillKindConflictError(input.name, existingKinds.join("+") || "unknown");
		}
	}

	// Keep what this push does not own. `kind` keeps any twin kinds, and `scope` and
	// any extra `clients` were set by the registry (migration 114 or capability_register),
	// not by the repo manifest, so a body push must not erase them.
	const prior = existing?.properties ?? {};
	const priorKinds = existing ? capabilityKinds(prior) : [];
	const { surface, clients: declaredClients } = normalizeDeclaredSurface(input.surface);
	const priorClients = Array.isArray(prior.clients) ? (prior.clients as unknown[]).filter((c): c is string => typeof c === "string") : [];
	const clients = [...new Set([...priorClients, ...declaredClients])].sort();

	const properties: Record<string, unknown> = {
		kind: priorKinds.length > 0 ? priorKinds : ["skill"],
		surface,
		storage_location: "kms-db",
		storage_url: null,
		body: input.body,
		body_synced_at: new Date().toISOString(),
	};
	if (clients.length > 0) properties.clients = clients;
	if (typeof prior.scope === "string") properties.scope = prior.scope;
	if (typeof input.repoMirror === "string" && input.repoMirror.trim() !== "") {
		properties.repo_mirror = input.repoMirror;
	} else if (typeof prior.repo_mirror === "string" && prior.repo_mirror.trim() !== "") {
		properties.repo_mirror = prior.repo_mirror;
	}

	if (existing) {
		const { error: updateError } = await supabase
			.from("entities")
			.update({ title: input.name, description: input.description, properties })
			.eq("id", existing.id)
			.eq("user_id", getCurrentUserId());
		if (updateError) throw new Error(`skill-sync: capability update failed (${input.name}): ${updateError.message}`);
		return "updated";
	}

	const { error: insertError } = await supabase.from("entities").insert([
		{
			id: randomUUID(),
			entity_type: ENTITY_TYPE,
			title: input.name,
			description: input.description,
			properties,
			tags: [],
			archived: false,
			archived_at: null,
			user_id: getCurrentUserId(),
			team_id: null,
		},
	]);
	if (insertError) throw new Error(`skill-sync: capability create failed (${input.name}): ${insertError.message}`);
	return "created";
}
