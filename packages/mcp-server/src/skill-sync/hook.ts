import { fetchAllCapabilities } from "./ahkmsSource.js";
import { isSkillCapability } from "./capabilityShape.js";
import { defaultSkillsHome, listLocalSkills } from "./localSkills.js";
import { pullSkill } from "./pull.js";
import { hasSupportingFilesDecl, pushSkill } from "./push.js";
import { statusForSkill } from "./status.js";
import { getBaseHash, readSyncState } from "./syncState.js";
import { writeSkillHomesCache } from "./skillHomes.js";

// The SessionStart auto-reconcile (#373, ADR: ahkms as source of truth for
// single-file skills). Runs the whole local↔ahkms reconcile every boot so the
// local-file-shadows-ahkms drift bug fixes itself without the user remembering to
// sync. It reuses the shared classifier (status/reconcile) and the push/pull
// primitives shipped in #371 — this module only orchestrates them.
//
// Three rules the ADR pins down and this enforces:
//   • Auto-apply the two unambiguous rows — push (local moved) and pull (ahkms
//     moved, backed up first). Auto-push is accepted.
//   • NEVER auto-apply the both-changed row: log each conflict and surface a count
//     ("N conflicts — run `/skill-sync resolve`").
//   • Fail open — if ahkms is unreachable, or any single skill errors, warn and let
//     boot proceed. It must never hang or block the session.
// Tiering (single-file, plus manifest-declared multi-file per #758) and symlink
// safety (compare-only) are inherited straight from statusForSkill / pushSkill /
// pullSkill, so they hold here too. A manifest-declared multi-file skill's
// "ahkms-moved"/"converged" rows go through pullSkill exactly like a
// single-file skill's, but pullSkill never writes its assembled body back
// (that would corrupt SKILL.md) — a genuine ahkms-side divergence surfaces as
// a "warned" event instead of a silent no-op.

export type ReconcileOutcome =
	| "pushed" // local moved → uploaded to ahkms
	| "pulled" // ahkms moved → written over local (backed up first)
	| "converged" // both moved to the same content → base advanced, no write
	| "conflict" // both moved and differ → DEFERRED, not applied
	| "warned" // an expected-but-noteworthy no-op (e.g. symlink differs)
	| "skipped"; // nothing to do (in-sync / unregistered / etc.)

export interface ReconcileEvent {
	name: string;
	outcome: ReconcileOutcome;
	reason?: string;
	/** Where the pre-overwrite copy landed, when a pull overwrote local. */
	backupPath?: string;
}

export interface ReconcileAllResult {
	/** false when ahkms could not be read at all (fail-open — boot still proceeds). */
	reachedAhkms: boolean;
	/** Populated when reachedAhkms is false. */
	warning?: string;
	events: ReconcileEvent[];
	/** Count of both-changed rows that were logged but deliberately NOT applied. */
	conflicts: number;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Auto-reconcile every single-file skill against ahkms. Fetches capabilities ONCE
 * (a single round-trip for the whole tree), then dispatches each skill by its
 * classified reconcile state. Never throws: an unreachable ahkms returns a
 * fail-open result, and a per-skill failure is recorded as a `warned` event so the
 * remaining skills still reconcile.
 */
export async function reconcileAll(skillsHome: string = defaultSkillsHome()): Promise<ReconcileAllResult> {
	let caps: Awaited<ReturnType<typeof fetchAllCapabilities>>;
	try {
		caps = await fetchAllCapabilities();
		// Skill-only view for the homes cache (#811): the check-skill-home.js hook
		// only ever resolves skill names, so an agent/command sharing a name must
		// never shadow the skill's real home here (see fetchSkillCapabilities above).
		writeSkillHomesCache(Array.from(caps.values()).filter((cap) => isSkillCapability(cap)));
	} catch (err) {
		// ahkms unreachable — the whole point of fail-open. Warn and let boot proceed.
		return {
			reachedAhkms: false,
			warning: `ahkms unreachable — skills not reconciled (${errMessage(err)})`,
			events: [],
			conflicts: 0,
		};
	}

	// Reconcilable = pushed to kms-db by push.ts: single-file skills, plus
	// multi-file skills that declare a supporting_files manifest (#758). A
	// multi-file skill with no manifest stays local-authoritative and outside
	// this loop entirely, unchanged.
	const reconcilable = listLocalSkills(skillsHome).filter((s) => s.tier === "single" || hasSupportingFilesDecl(s));
	const state = readSyncState(skillsHome);
	const events: ReconcileEvent[] = [];
	let conflicts = 0;

	for (const skill of reconcilable) {
		const cap = caps.get(skill.name.toLowerCase());
		const { status } = statusForSkill(skill, cap, getBaseHash(state, skill.name));
		try {
			switch (status) {
				case "local-moved": {
					const r = await pushSkill(skill, skillsHome);
					events.push({
						name: skill.name,
						outcome: r.outcome === "skipped" ? "skipped" : "pushed",
						reason: r.reason,
					});
					break;
				}
				case "ahkms-moved": {
					const r = pullSkill(skill, skillsHome, cap?.body ?? null);
					events.push({
						name: skill.name,
						outcome: r.outcome === "pulled" ? "pulled" : r.outcome === "warned" ? "warned" : "skipped",
						reason: r.reason,
						backupPath: r.backupPath,
					});
					break;
				}
				case "converged": {
					// Both sides moved to the SAME content: no write needed, just advance the
					// base so the next boot reads in-sync. pullSkill stamps the base when the
					// hashes already match.
					const r = pullSkill(skill, skillsHome, cap?.body ?? null);
					events.push({ name: skill.name, outcome: "converged", reason: r.reason });
					break;
				}
				case "conflict": {
					// Both changed and they differ. NEVER auto-applied — defer to resolve.
					conflicts++;
					events.push({
						name: skill.name,
						outcome: "conflict",
						reason: "both changed — deferred to `/skill-sync resolve`",
					});
					break;
				}
				// in-sync / no-base / ahkms-missing / local-only / other-kind / multi-file:
				// nothing safe to auto-apply — leave for status/init/resolve.
				default:
					break;
			}
		} catch (err) {
			// Fail open per skill: one failed upsert/write must not abort the boot reconcile.
			events.push({ name: skill.name, outcome: "warned", reason: errMessage(err) });
		}
	}

	return { reachedAhkms: true, events, conflicts };
}

/** One-line-per-category summary for the hook's stdout (added to session context). */
export function formatReconcile(result: ReconcileAllResult): string {
	if (!result.reachedAhkms) {
		return `skill-sync: ${result.warning ?? "ahkms unreachable"} — continuing.`;
	}

	const names = (outcome: ReconcileOutcome) =>
		result.events
			.filter((e) => e.outcome === outcome)
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));

	const lines: string[] = [];
	const pushed = names("pushed");
	const pulled = names("pulled");
	const converged = names("converged");
	const warned = result.events.filter((e) => e.outcome === "warned").sort((a, b) => a.name.localeCompare(b.name));

	if (pushed.length) lines.push(`pushed ${pushed.length} local→ahkms: ${pushed.join(", ")}`);
	if (pulled.length) lines.push(`pulled ${pulled.length} ahkms→local (backed up): ${pulled.join(", ")}`);
	if (converged.length) lines.push(`converged ${converged.length}: ${converged.join(", ")}`);
	if (warned.length) lines.push(`warned ${warned.length}: ${warned.map((e) => `${e.name} (${e.reason})`).join(", ")}`);
	if (result.conflicts > 0) {
		lines.push(`${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} — run \`/skill-sync resolve\``);
	}

	if (lines.length === 0) return "skill-sync: skills in sync.";
	return "skill-sync:\n" + lines.map((l) => `  ${l}`).join("\n");
}
