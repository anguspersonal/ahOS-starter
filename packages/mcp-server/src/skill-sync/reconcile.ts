// The 3-way merge-base classifier (ADR: ahkms as source of truth for single-file
// skills). Given three content hashes — the local SKILL.md, the ahkms body, and
// the last-synced base recorded per-machine in .sync-state.json — decide what the
// reconcile should do. This module is PURE (no fs, no network, no env) so it is
// cheap to exhaustively unit-test and safe to import anywhere.

export type ReconcileState =
	| "in-sync" // local == ahkms == base (or base-less but already equal)
	| "local-moved" // only local changed since base  -> push local to ahkms
	| "ahkms-moved" // only ahkms changed since base   -> pull ahkms to local
	| "converged" // both changed but to the same content -> in sync, advance base
	| "conflict" // both changed, and they differ    -> defer to `resolve`
	| "no-base" // never synced and local != ahkms   -> needs init/resolve
	| "ahkms-missing"; // no body on the ahkms side to compare against

export interface Hashes {
	/** Hash of the canonicalised local SKILL.md. */
	local: string;
	/** Hash of the canonicalised ahkms body, or null if ahkms has no body. */
	ahkms: string | null;
	/** Hash stored at last successful sync, or null if never synced. */
	base: string | null;
}

export function classify({ local, ahkms, base }: Hashes): ReconcileState {
	if (ahkms === null) return "ahkms-missing";

	if (base === null) {
		// No merge base yet. If the two sides already match we can treat it as in
		// sync (init will stamp the base); otherwise a human/init must decide.
		return local === ahkms ? "in-sync" : "no-base";
	}

	const localMoved = local !== base;
	const ahkmsMoved = ahkms !== base;

	if (!localMoved && !ahkmsMoved) return "in-sync";
	if (localMoved && !ahkmsMoved) return "local-moved";
	if (!localMoved && ahkmsMoved) return "ahkms-moved";

	// Both moved since the base.
	return local === ahkms ? "converged" : "conflict";
}

/** States the SessionStart hook may auto-apply without human input. */
export function isAutoApplicable(state: ReconcileState): boolean {
	return state === "local-moved" || state === "ahkms-moved" || state === "converged";
}
