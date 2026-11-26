import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";
import { hashBody } from "./hash.js";
import { type CarriedFile, type SkillBodyResult, assembleSkillBody, assertWithinSkillDir, uncarriableReason } from "./skillBody.js";
import { detectTier } from "./tier.js";

// The REPO skills tree as a first-class skill-sync source (#689).
//
// Why this is a second source rather than a second skills home:
//   localSkills.ts enumerates the Claude Code skills home (`~/.claude/skills`),
//   a mutable working copy that can move on EITHER side — hence the merge base,
//   the 3-way classify() and the pull path. This repo's `.claude/skills/` tree is
//   different in kind: git is the base, the file is authoritative, and the ahkms
//   row is a downstream mirror. There is no "pull" here (that is `git checkout`)
//   and no "conflict" (that is a merge conflict), so running the repo tree through
//   the bidirectional reconcile would model it wrongly. Everything BELOW that
//   difference is shared: the same canonical hash (hash.ts), the same frontmatter
//   reader, the same upsert (ahkmsSource.ts) and the same CLI binary.
//
// Second difference: tier. A home-tree skill's tier is INFERRED from its file
// count, because nobody declared it. A repo skill's supporting files are declared
// in the manifest instead (repoManifest.ts), so whether each one is part of the
// definition is a reviewed statement rather than a guess — and a skill that grows
// a new supporting file fails the guard until someone re-affirms it.
//
// PURE apart from reading the given directory: no env, no network. The live
// paths (repoPush/repoStatus) import ahkmsSource; this module must not.

export interface RepoSkill {
	name: string;
	/** Absolute path to the skill directory. */
	dir: string;
	/** SKILL.md contents, verbatim. */
	skillMd: string;
	/** Frontmatter `description`, or null when absent. */
	description: string | null;
	/**
	 * Canonical content hash of SKILL.md ALONE (hash.ts — identical to the
	 * home-tree hash). This is NOT the receipt: a multi-file skill's body also
	 * carries its declared travelling files, and `body_sha256` records that
	 * assembled body (see skillBody.ts). What this hash is for is comparing two
	 * copies of the same SKILL.md — the home-tree conflict guard in repoPush.ts.
	 */
	skillMdHash: string;
	/** Every non-SKILL.md regular file in the tree, repo-skill-relative and sorted. */
	supportingFiles: string[];
}

/** Repo root, overridable with SKILL_SYNC_REPO_ROOT (used by tests). */
export function defaultRepoRoot(): string {
	const override = process.env.SKILL_SYNC_REPO_ROOT;
	if (override) return override;
	// <root>/packages/mcp-server/{src,dist}/skill-sync -> <root>
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** The repo's own skills tree. */
export function repoSkillsDir(repoRoot: string = defaultRepoRoot()): string {
	return join(repoRoot, ".claude", "skills");
}

/**
 * Enumerate `<repo>/.claude/skills/<name>/SKILL.md`. Directories without a
 * SKILL.md are not skills and are skipped; symlinks are not followed, because
 * the repo tree is checked-out git content and a symlink in it would point
 * outside the reviewed source.
 */
export function listRepoSkills(skillsDir: string = repoSkillsDir()): RepoSkill[] {
	if (!existsSync(skillsDir)) return [];

	const skills: RepoSkill[] = [];
	for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

		const dir = join(skillsDir, entry.name);
		const skillMdPath = join(dir, "SKILL.md");
		if (!existsSync(skillMdPath)) continue;

		const skillMd = readFileSync(skillMdPath, "utf8");
		skills.push({
			name: entry.name,
			dir,
			skillMd,
			description: parseFrontmatter(skillMd).description ?? null,
			skillMdHash: hashBody(skillMd),
			supportingFiles: detectTier(dir).files.filter((file) => file !== "SKILL.md"),
		});
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the body this skill actually serves: SKILL.md plus every declared
 * travelling file, read off disk and assembled (#697).
 *
 * The fs half of skillBody.ts, kept here because this module already owns the
 * tree. Every way this can fail returns a REASON rather than a shorter body —
 * a missing, unreadable or non-text file must stop the skill travelling, not
 * quietly shrink what travels.
 */
export function resolveSkillBody(skill: RepoSkill, travelling: string[]): SkillBodyResult {
	const carried: CarriedFile[] = [];
	for (const path of [...travelling].sort()) {
		const contained = assertWithinSkillDir(skill.dir, path);
		if (!contained.ok) return { ok: false, reason: contained.reason };
		const absolute = contained.fullPath;
		let raw: Buffer;
		try {
			raw = readFileSync(absolute);
		} catch (error) {
			return { ok: false, reason: `\`${path}\` is declared as travelling but could not be read: ${(error as Error).message}` };
		}
		const uncarriable = uncarriableReason(path, raw);
		if (uncarriable) return { ok: false, reason: uncarriable };
		carried.push({ path, content: raw.toString("utf8") });
	}
	// Every other on-disk supporting file was reviewed and declared NOT to
	// travel — named in the preamble as present-but-not-carried (#728), not
	// silently omitted.
	const siblings = skill.supportingFiles.filter((path) => !travelling.includes(path));
	return assembleSkillBody(skill.skillMd, carried, siblings);
}
