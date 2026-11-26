import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRepoRoot } from "./repoSkills.js";

// The repo-skill registration manifest (#689) — `.claude/skill-registry.json`.
//
// WHY A COMMITTED MANIFEST
//   The issue's sharpest line is "a body registered once and then left to rot is
//   worse than a pointer, because it looks authoritative". Catching that rot in
//   CI means answering "does the registry hold these exact bytes?" — and CI has
//   no ahkms credentials (see .github/workflows/migration-drift.yml: the one
//   Supabase secret Actions holds is SUPABASE_DB_URL). So the answer has to be
//   committed. This file is the receipt: `body_sha256` is the content that was
//   handed to the registry and `registered_at` is when. scripts/check-skill-bodies.js
//   compares the receipt against the working tree with no credentials at all.
//
//   `body_sha256` hashes the ASSEMBLED body, not SKILL.md (#697). For a skill
//   with nothing travelling those are the same string, which is why every receipt
//   stamped before #697 is still valid; for a multi-file skill it also covers the
//   carried files, so editing a travelling REFERENCE.md fails the guard exactly
//   like editing SKILL.md. One served artifact, one receipt — no second digest.
//
// WHY IT ALSO DECLARES NON-REGISTERED SKILLS
//   Same reason ARTIFACT_WRITE_SITES declares its known gaps
//   (scripts/check-artifact-surface-writes.js): a complete inventory makes a new
//   skill a decision rather than a silent omission. `register: false` is a valid,
//   reviewed answer — it just has to be written down with a `why`.
//
// WRITERS
//   The LIVE push (repoPush.ts) is the only machine writer, and it only ever
//   stamps `body_sha256` + `registered_at` for a skill it actually registered.
//   Everything else is hand-edited in a PR — including re-pointing `body_sha256`
//   after editing a SKILL.md without credentials to hand, which the check script
//   prints the exact value for. Keeping one machine writer is deliberate: two
//   writers of one file drift on formatting.

/** Location is fixed: beside the skills tree, but OUTSIDE it — Claude Code scans that tree. */
export const MANIFEST_RELATIVE_PATH = ".claude/skill-registry.json";

export function manifestPath(repoRoot: string = defaultRepoRoot()): string {
	return join(repoRoot, ".claude", "skill-registry.json");
}

/**
 * One non-SKILL.md file in a skill directory, and the reviewed decision about it
 * (#697). `travels: true` means the file is part of the definition and is carried
 * inside the served body; `travels: false` means it exists but the body is
 * complete without it.
 *
 * Before #697 this was a bare path string, meaning "affirmed NOT load-bearing".
 * That shape is deliberately no longer accepted rather than quietly upgraded: a
 * reader taking both shapes would make a successful parse meaningless, and the
 * default it would have to pick — travel or not — is exactly the decision this
 * file exists to record.
 */
export interface SupportingFileDecl {
	/** Path relative to the skill directory, as SKILL.md names it. */
	path: string;
	/** Carried inside the kms-db body? */
	travels: boolean;
	/** Why this decision — required for BOTH answers, so neither is a shrug. */
	why: string;
}

export interface RepoSkillEntry {
	/** Should this skill be served from ahkms as a kms-db body? */
	register: boolean;
	/** Why this decision — required for BOTH answers, so neither is a shrug. */
	why: string;
	/** Surfaces the capability is listed for. Required when `register`. */
	surface?: string[];
	/** Every non-SKILL.md file, with its travel decision. Required when `register`. */
	supporting_files?: SupportingFileDecl[];
	/** Canonical hash of the assembled body the registry was given. Required when `register`. */
	body_sha256?: string | null;
	/** When the live push last registered this body; null = registration still owed. */
	registered_at?: string | null;
}

/** The declared paths, in path order — the inventory half of `supporting_files`. */
export function declaredPaths(entry: { supporting_files?: SupportingFileDecl[] }): string[] {
	return (entry.supporting_files ?? []).map((file) => file.path).sort();
}

/** The declared paths that are carried inside the body, in path order. */
export function travellingPaths(entry: { supporting_files?: SupportingFileDecl[] }): string[] {
	return (entry.supporting_files ?? [])
		.filter((file) => file.travels)
		.map((file) => file.path)
		.sort();
}

export interface RepoSkillManifest {
	version: 1;
	skills: Record<string, RepoSkillEntry>;
}

export class ManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestError";
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const SUPPORTING_FILE_SHAPE = '{ "path": …, "travels": true|false, "why": … }';

/** Parse `supporting_files`, or throw with the shape it should have had. */
function parseSupportingFiles(skillName: string, value: unknown): SupportingFileDecl[] {
	if (!Array.isArray(value)) {
		throw new ManifestError(`skills.${skillName}: \`supporting_files\` must be an array when register is true`);
	}
	return value.map((item, index) => {
		const where = `skills.${skillName}.supporting_files[${index}]`;
		if (typeof item === "string") {
			throw new ManifestError(`${where}: bare paths are no longer accepted — use ${SUPPORTING_FILE_SHAPE} (#697)`);
		}
		if (typeof item !== "object" || item === null) throw new ManifestError(`${where}: expected ${SUPPORTING_FILE_SHAPE}`);
		const file = item as Record<string, unknown>;
		const unknown = Object.keys(file).filter((key) => key !== "path" && key !== "travels" && key !== "why");
		if (unknown.length > 0) throw new ManifestError(`${where}: unknown key(s) ${unknown.join(", ")} (allowed: path, travels, why)`);
		if (typeof file.path !== "string" || file.path.trim() === "") throw new ManifestError(`${where}: \`path\` must be a non-empty string`);
		if (typeof file.travels !== "boolean") throw new ManifestError(`${where}: \`travels\` must be a boolean`);
		if (typeof file.why !== "string" || file.why.trim() === "") {
			throw new ManifestError(`${where}: \`why\` must explain the travel decision, either way`);
		}
		return { path: file.path, travels: file.travels, why: file.why };
	});
}

// Unknown keys are REJECTED rather than ignored. writeManifest re-serialises the
// parsed model, so a key this reader does not know about would be silently
// dropped the first time a receipt is stamped — losing hand-written intent from
// a file whose whole job is to be trustworthy. Keep this list in step with the
// one in scripts/check-skill-bodies.js.
const ENROLLED_KEYS = new Set(["register", "why", "surface", "supporting_files", "body_sha256", "registered_at"]);
const NOT_ENROLLED_KEYS = new Set(["register", "why"]);

/** Parse + validate manifest text. Throws ManifestError with a specific reason. */
export function parseManifest(text: string): RepoSkillManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ManifestError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof raw !== "object" || raw === null) throw new ManifestError("expected a JSON object");

	const obj = raw as Record<string, unknown>;
	if (obj.version !== 1) throw new ManifestError(`unsupported version ${JSON.stringify(obj.version)} (expected 1)`);
	if (typeof obj.skills !== "object" || obj.skills === null) throw new ManifestError("missing `skills` object");

	const skills: Record<string, RepoSkillEntry> = {};
	for (const [name, value] of Object.entries(obj.skills as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) throw new ManifestError(`skills.${name}: expected an object`);
		const entry = value as Record<string, unknown>;

		if (typeof entry.register !== "boolean") throw new ManifestError(`skills.${name}: \`register\` must be a boolean`);
		if (typeof entry.why !== "string" || entry.why.trim() === "") {
			throw new ManifestError(`skills.${name}: \`why\` must be a non-empty string`);
		}

		const allowed = entry.register ? ENROLLED_KEYS : NOT_ENROLLED_KEYS;
		const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
		if (unknown.length > 0) {
			throw new ManifestError(`skills.${name}: unknown key(s) ${unknown.join(", ")} (allowed: ${[...allowed].join(", ")})`);
		}

		const parsed: RepoSkillEntry = { register: entry.register, why: entry.why };

		if (entry.register) {
			if (!isStringArray(entry.surface) || entry.surface.length === 0) {
				throw new ManifestError(`skills.${name}: \`surface\` must be a non-empty string array when register is true`);
			}
			if (typeof entry.body_sha256 !== "string" || entry.body_sha256 === "") {
				throw new ManifestError(`skills.${name}: \`body_sha256\` must be a hash string when register is true`);
			}
			parsed.surface = entry.surface;
			parsed.supporting_files = parseSupportingFiles(name, entry.supporting_files);
			parsed.body_sha256 = entry.body_sha256;
			parsed.registered_at = typeof entry.registered_at === "string" ? entry.registered_at : null;
		}

		skills[name] = parsed;
	}

	return { version: 1, skills };
}

export function readManifest(path: string = manifestPath()): RepoSkillManifest {
	if (!existsSync(path)) throw new ManifestError(`no manifest at ${path}`);
	try {
		return parseManifest(readFileSync(path, "utf8"));
	} catch (error) {
		throw error instanceof ManifestError ? new ManifestError(`${path}: ${error.message}`) : error;
	}
}

/**
 * Serialise deterministically — tabs to match the repo's indentation, skills in
 * name order, exactly one trailing newline — so a receipt stamp is a one-line
 * diff rather than a reformat.
 */
export function serialiseManifest(manifest: RepoSkillManifest): string {
	const ordered: Record<string, RepoSkillEntry> = {};
	for (const name of Object.keys(manifest.skills).sort()) ordered[name] = manifest.skills[name];
	return JSON.stringify({ version: manifest.version, skills: ordered }, null, "\t") + "\n";
}

export function writeManifest(manifest: RepoSkillManifest, path: string = manifestPath()): void {
	writeFileSync(path, serialiseManifest(manifest), "utf8");
}

/** The enrolled subset, in name order. */
export function enrolledSkills(manifest: RepoSkillManifest): { name: string; entry: RepoSkillEntry }[] {
	return Object.entries(manifest.skills)
		.filter(([, entry]) => entry.register)
		.map(([name, entry]) => ({ name, entry }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
