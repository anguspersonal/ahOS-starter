import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SkillKindConflictError, upsertSkillCapability } from "./ahkmsSource.js";
import { type CheckoutState, describeCheckoutState, describeCheckoutStateLine } from "./checkoutState.js";
import { hashBody } from "./hash.js";
import { defaultSkillsHome } from "./localSkills.js";
import { CROSS_SURFACE } from "./push.js";
import {
	type RepoSkillEntry,
	declaredPaths,
	enrolledSkills,
	manifestPath,
	readManifest,
	travellingPaths,
	writeManifest,
} from "./repoManifest.js";
import { type RepoSkill, defaultRepoRoot, listRepoSkills, repoSkillsDir, resolveSkillBody } from "./repoSkills.js";
import type { SkillBodyResult } from "./skillBody.js";
import { detectTier } from "./tier.js";

// Register repo-resident skills into ahkms as kms-db bodies (#689).
//
// One direction only: git -> ahkms. The repo file is authoritative and the ahkms
// row is a mirror, so there is no pull and no merge base here (see the header of
// repoSkills.ts). The upsert itself is the SAME function the home-tree push uses
// (ahkmsSource.upsertSkillCapability), so both sources write an identically
// shaped row and inherit the same "never clobber an agent/command" guard.
//
// FIVE REFUSALS, all of them deliberate. The first is about the CHECKOUT and
// stops the whole run; the other four are per skill:
//   0. stale-checkout — this tree is behind the branch it tracks, so its bodies
//      are not the bodies anyone else has (#724). Every other check here
//      compares two things that move together, so a stale file agreeing with a
//      stale receipt reads as perfect health; this is the only one that can see
//      it. Overridable with `allowBehind`, because pushing from a deliberately
//      older tree is occasionally what you want and a refusal you cannot
//      override becomes a reason to stop using the tool.
//
//   1. supporting-files-changed — the skill grew or lost a non-SKILL.md file
//      since each file's travel decision was reviewed. Checked FIRST because it
//      is what proves every declared travelling path exists: no body can be
//      assembled, let alone hashed, until the file set is the reviewed one.
//   2. body-unbuildable — a declared travelling file is unreadable or is not
//      text, or the assembled body is over MAX_BODY_BYTES (skillBody.ts). The
//      skill is named and skipped; nothing is ever truncated to make it fit.
//   3. manifest-drift  — the manifest's body_sha256 does not match the body
//      assembled from disk. The manifest is the REVIEWED contract; pushing bytes
//      that no PR approved is the same class of surprise #689 is about, just in
//      the other direction. Re-review, then re-point the hash.
//   4. home-copy-conflict — a copy of the same name in the Claude Code skills
//      home holds DIFFERENT bytes, OR holds the SAME bytes, is single-file, and
//      carries a different declared surface. `skill-sync push --all` owns that
//      tree and would overwrite this row on its next run, and this push would
//      flip it back: two writers, one capability row, forever.
//
//      The body test is content, not paths. Several home entries are symlinks
//      into this repo's skills tree, so they are the same file and pushing
//      either lands the same BODY — and a path test gets even that wrong when
//      this command runs from a git worktree, where the symlink resolves to the
//      main checkout rather than to the tree being pushed. Equal bytes, no body
//      conflict.
//
//      Equal bytes is NOT idempotent for `surface` either — but only for a
//      SINGLE-FILE home copy, and used to be treated as idempotent regardless
//      of tier (#707). `upsertSkillCapability()` replaces the whole
//      `properties` object, and the two writers disagree on what goes in it:
//      the home push (push.ts) always writes CROSS_SURFACE, while this repo
//      push writes whatever the manifest declares — which is narrower for most
//      enrolled skills. But `pushSkill()`/`pushAllSingleFile()` (push.ts) skip
//      any home copy whose tier is not `single` without ever calling
//      `upsertSkillCapability` — a multi-file home copy (e.g. `create-task`,
//      symlinked and multi-file today) is local-authoritative and the home
//      writer never touches its surface, so there is nothing for it to flip
//      back. The surface check below is gated on the home copy's own tier
//      (reusing the same `detectTier` push.ts's writers key off) for exactly
//      that reason; the byte check above still applies unconditionally.

export type RepoPushOutcome = "created" | "updated" | "skipped" | "would-push" | "refused" | "warned";

export interface RepoPushResult {
	name: string;
	outcome: RepoPushOutcome;
	reason?: string;
}

export interface RepoPushOptions {
	repoRoot?: string;
	/** Claude Code skills home, for the independent-copy guard. */
	skillsHome?: string;
	/** Report what would happen; touch neither ahkms nor the manifest. */
	dryRun?: boolean;
	/** Injected clock, so the receipt stamp is pinnable in tests. */
	now?: () => Date;
	/** Push even though the checkout is behind its upstream (#724). */
	allowBehind?: boolean;
	/** Skip the currency fetch. The comparison then uses the last fetch's result. */
	noFetch?: boolean;
	/** Injected for tests, so no test performs a real fetch. */
	checkoutState?: (repoRoot: string) => CheckoutState;
}

/**
 * Does the Claude Code skills home hold a copy of this skill that the two
 * writers would fight over? Two ways in:
 *
 *   - DIFFERENT bytes — the home push (push.ts) and this repo push would each
 *     keep re-asserting their own body.
 *   - SAME bytes, DIFFERENT surface, home copy is SINGLE-FILE — symlinked
 *     entries are literally the same file, so the body never conflicts, but
 *     the home push always writes CROSS_SURFACE while this repo push writes
 *     `repoSurface` (whatever the manifest declares). `upsertSkillCapability()`
 *     replaces the whole `properties` object, so the two would flip `surface`
 *     back and forth with nothing reporting it (#707) — but only when the home
 *     writer would actually touch that row. `pushSkill()`/`pushAllSingleFile()`
 *     (push.ts) skip any home copy whose tier is not `single` without ever
 *     calling `upsertSkillCapability`, so a same-bytes MULTI-FILE home copy
 *     (e.g. `create-task`, symlinked today) is not a surface conflict: the
 *     home writer never writes surface for it regardless of what the manifest
 *     declares.
 *
 * Reads through the symlink deliberately; the compare-only rule in
 * localSkills.ts is about never WRITING through one. Returns the refusal
 * reason, or `null` when there is no conflict.
 */
export function hasConflictingHomeCopy(
	name: string,
	skillsHome: string,
	repoBodyHash: string,
	repoSurface: readonly string[] = [],
): string | null {
	const homeDir = join(skillsHome, name);
	const homeSkillMd = join(homeDir, "SKILL.md");
	if (!existsSync(homeSkillMd)) return null;

	// The home writer (push.ts) only ever pushes single-file home copies
	// (pushSkill/pushAllSingleFile tier gate). A multi-file home copy (e.g.
	// `close` with supporting files, or `create-task`) is never written to
	// ahkms by the home push, so there is no two-writer conflict.
	if (detectTier(homeDir).tier !== "single") return null;

	let homeBody: string;
	try {
		homeBody = readFileSync(homeSkillMd, "utf8");
	} catch {
		return null; // dangling symlink or unreadable — nothing to conflict with
	}

	if (hashBody(homeBody) !== repoBodyHash) {
		return "a DIFFERENT copy of this skill exists in the Claude Code skills home — `skill-sync push --all` owns that name and the two sources would overwrite each other";
	}

	const homeSurface = [...CROSS_SURFACE].sort();
	const declaredSurface = [...repoSurface].sort();
	const surfaceMatches = homeSurface.length === declaredSurface.length && homeSurface.every((surface, index) => surface === declaredSurface[index]);
	if (!surfaceMatches) {
		return `the Claude Code skills home holds the same bytes, but the writers disagree on surface — home push (\`skill-sync push --all\`) owns that name and writes surface=[${CROSS_SURFACE.join(", ")}], while the manifest declares surface=[${repoSurface.join(", ") || "none"}]`;
	}

	return null;
}

/**
 * Everything that can refuse a push before it touches the network. PURE — the
 * body has already been resolved off disk by the caller, and is `undefined`
 * exactly when there was no skill to resolve one for.
 */
export function checkPushPreconditions(
	skill: RepoSkill | undefined,
	entry: Pick<RepoSkillEntry, "body_sha256" | "supporting_files">,
	resolved: SkillBodyResult | undefined,
	homeConflictReason: string | null,
): string | null {
	if (!skill) return "no such skill in .claude/skills/";

	const declared = declaredPaths(entry).join("|");
	const actual = [...skill.supportingFiles].sort().join("|");
	if (declared !== actual) {
		return `supporting files changed since their travel decisions were reviewed (declared: ${declared || "none"}; found: ${actual || "none"}) — re-affirm each in the manifest`;
	}

	if (!resolved) return "body was not resolved";
	if (!resolved.ok) return `body cannot be assembled — ${resolved.reason}`;

	if (entry.body_sha256 !== resolved.hash) {
		const carried = resolved.carried.length > 0 ? ` (SKILL.md + ${resolved.carried.join(", ")})` : "";
		return `manifest body_sha256 (${(entry.body_sha256 ?? "unset").slice(0, 12)}…) does not match the assembled body${carried} (${resolved.hash.slice(0, 12)}…) — re-review, then update the manifest`;
	}
	if (homeConflictReason) return homeConflictReason;
	return null;
}

/**
 * Register every enrolled repo skill (or one by name). Sequential: a handful of
 * upserts, and a partial failure should stop rather than half-register a set.
 */
export async function pushRepoSkills(only?: string, options: RepoPushOptions = {}): Promise<RepoPushResult[]> {
	const repoRoot = options.repoRoot ?? defaultRepoRoot();
	const skillsHome = options.skillsHome ?? defaultSkillsHome();
	const repoSkillsRoot = repoSkillsDir(repoRoot);
	const now = options.now ?? (() => new Date());

	const results: RepoPushResult[] = [];

	// Currency gate (#724), before anything is read or written. A dry run is
	// exempt: it touches neither ahkms nor the manifest, so there is nothing for
	// a stale tree to corrupt, and blocking it would deny the operator the very
	// preview that shows what a stale push WOULD do.
	if (!options.dryRun) {
		const state = (options.checkoutState ?? ((root: string) => describeCheckoutState(root, { noFetch: options.noFetch })))(repoRoot);
		if (state.currency === "behind" && !options.allowBehind) {
			return [
				{
					name: only ?? "(all enrolled)",
					outcome: "refused",
					reason: `${describeCheckoutStateLine(state)} Pushing now would register bodies nobody has reviewed as current — this is exactly the #724 failure, where a stale tree and a stale receipt agree and every other check reports health. Pull, then re-run; or pass --allow-behind if the older tree is deliberate.`,
				},
			];
		}
		if (state.currency === "unknown") {
			// A warning, never a refusal: see checkoutState.ts's header. Its own
			// outcome rather than `skipped`, because a no-upstream or non-git
			// checkout is a legitimate way to work and must not turn every push
			// into a non-zero exit — but it still rides on the results so the CLI
			// prints it beside what was pushed rather than scrolling past first.
			results.push({ name: "(checkout)", outcome: "warned", reason: describeCheckoutStateLine(state) });
		}
	}

	const manifestFile = manifestPath(repoRoot);
	const manifest = readManifest(manifestFile);
	const skills = new Map(listRepoSkills(repoSkillsRoot).map((skill) => [skill.name, skill]));

	let targets = enrolledSkills(manifest);
	if (only) {
		const declared = manifest.skills[only];
		if (!declared) return [{ name: only, outcome: "skipped", reason: `not declared in ${manifestFile}` }];
		if (!declared.register) return [{ name: only, outcome: "skipped", reason: `declared register: false — ${declared.why}` }];
		targets = [{ name: only, entry: declared }];
	}

	let mutated = false;

	// The receipt write is in a `finally` so a mid-run failure still records the
	// registrations that DID land. Losing them would leave the manifest claiming
	// a debt that was already paid, and the next run would re-push bytes ahkms
	// already holds.
	try {
		for (const { name, entry } of targets) {
			const skill = skills.get(name);
			const resolved = skill ? resolveSkillBody(skill, travellingPaths(entry)) : undefined;
			const conflictReason = hasConflictingHomeCopy(name, skillsHome, skill?.skillMdHash ?? "", entry.surface ?? []);
			const refusal = checkPushPreconditions(skill, entry, resolved, conflictReason);
			if (refusal || !skill || !resolved?.ok) {
				results.push({ name, outcome: "skipped", reason: refusal ?? "no such skill in .claude/skills/" });
				continue;
			}

			if (options.dryRun) {
				const carried = resolved.carried.length > 0 ? `, carrying ${resolved.carried.join(", ")}` : "";
				results.push({
					name,
					outcome: "would-push",
					reason: `${resolved.bytes} bytes -> kms-db, surface=${(entry.surface ?? []).join("+")}${carried}`,
				});
				continue;
			}

			try {
				const outcome = await upsertSkillCapability({
					name,
					description: skill.description,
					body: resolved.body,
					surface: entry.surface ?? [],
					repoMirror: `.claude/skills/${name}/SKILL.md`,
				});
				manifest.skills[name] = { ...entry, body_sha256: resolved.hash, registered_at: now().toISOString() };
				mutated = true;
				results.push({ name, outcome });
			} catch (error) {
				// A name already held by an agent/command must not be clobbered into a skill.
				if (error instanceof SkillKindConflictError) {
					results.push({ name, outcome: "skipped", reason: `already registered as ${error.existingKind} — not overwriting` });
					continue;
				}
				throw error;
			}
		}
	} finally {
		if (mutated) writeManifest(manifest, manifestFile);
	}

	return results;
}

export function formatRepoPush(results: RepoPushResult[], manifestFile: string): string {
	const lines: string[] = [];
	for (const outcome of ["refused", "warned", "created", "updated", "would-push", "skipped"] as const) {
		const bucket = results.filter((result) => result.outcome === outcome);
		if (bucket.length === 0) continue;
		lines.push(`${outcome} (${bucket.length}):`);
		for (const result of bucket.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`  • ${result.name}${result.reason ? `  — ${result.reason}` : ""}`);
		}
	}
	const stamped = results.some((result) => result.outcome === "created" || result.outcome === "updated");
	// The checkout line is a note about the tree, not a skill — counting it would
	// overstate what was processed by one on every run that emits it.
	lines.push(`${results.filter((result) => result.outcome !== "warned").length} repo skill(s) processed.`);
	if (stamped) lines.push(`Receipts stamped in ${manifestFile} — commit it so the drift guard stays honest.`);
	return lines.join("\n");
}

/** Convenience for the CLI: the manifest path the results refer to. */
export function repoManifestFile(options: RepoPushOptions = {}): string {
	return manifestPath(options.repoRoot ?? defaultRepoRoot());
}
