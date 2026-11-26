// Pure helpers for the capability row shape migration 114 (#344) introduced:
// `properties.kind` is an array (skill+agent twins are one row), and the old
// client names in `surface` moved to a separate `clients` array. Kept free of
// supabase so the pure reconcile modules, and tests that mock ahkmsSource, can
// import them.

/**
 * The kinds a capability row carries. Migration 114 (#344) stores `properties.kind`
 * as an array; a legacy row, or one written before this module learned that, still
 * holds a plain string. Both read the same way.
 */
export function capabilityKinds(properties: Record<string, unknown> | null | undefined): string[] {
	const raw = properties?.kind;
	if (Array.isArray(raw)) return raw.filter((k): k is string => typeof k === "string" && k !== "");
	if (typeof raw === "string" && raw !== "") return [raw];
	return [];
}

/** True when the capability carries the skill kind, alone or as part of a twin. */
export function isSkillCapability(cap: { kind: string; kinds?: string[] }): boolean {
	return (cap.kinds ?? cap.kind.split("+")).includes("skill");
}

// Client identifiers the pre-114 manifest wrote into `surface`. Migration 114 moved
// them: 'cowork' became the runtime surface 'claude-synced', and both 'chat' and
// 'cowork' are recorded in the informational `clients` array.
const CLIENT_SURFACES = new Set(["chat", "cowork"]);

/**
 * Map a manifest's declared surface list onto migration 114's split: runtime
 * `surface` (claude-code | claude-synced | api) plus informational `clients`.
 * Mirrors the migration's own rewrite exactly, so a push lands the same shape the
 * migration produced rather than re-introducing the retired values.
 */
export function normalizeDeclaredSurface(declared: readonly string[]): { surface: string[]; clients: string[] } {
	const surface = new Set<string>();
	const clients = new Set<string>();
	for (const s of declared) {
		if (CLIENT_SURFACES.has(s)) clients.add(s);
		if (s === "chat") continue;
		surface.add(s === "cowork" ? "claude-synced" : s);
	}
	if (surface.size === 0) surface.add("claude-synced");
	return { surface: [...surface].sort(), clients: [...clients].sort() };
}
