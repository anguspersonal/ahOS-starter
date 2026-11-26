import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import YAML from "yaml";
import { SkillKindConflictError, upsertSkillCapability } from "./ahkmsSource.js";
import { parseFrontmatter } from "./frontmatter.js";
import { hashBody } from "./hash.js";
import { defaultSkillsHome, listLocalSkills, type LocalSkill } from "./localSkills.js";
import { assembleSkillBody, assertWithinSkillDir, type CarriedFile, uncarriableReason } from "./skillBody.js";
import { setBase } from "./syncState.js";
import { detectTier } from "./tier.js";

// Push local skills up to ahkms as the authoritative kms-db body
// (ADR: ahkms as source of truth for single-file skills and user-level multi-file skills).
// Single-file skills push their SKILL.md verbatim. Multi-file skills assemble their body
// using supporting files declared in skill-sync.json or frontmatter (Issue #758), sharing
// the same assembler repo skills use. After a successful upsert we stamp the sync-state base.
// Multi-file skills without supporting files declared are local-authoritative and skipped.

/** Surface metadata for pushed single-file skills (kms-db bodies serve everywhere by default). */
export const CROSS_SURFACE = ["claude-code", "cowork", "chat"] as const;

export interface PushResult {
	name: string;
	outcome: "created" | "updated" | "skipped";
	reason?: string;
}

export interface SupportingFileDecl {
	path: string;
	travels?: boolean;
	why?: string;
}

export interface SkillSyncManifest {
	surface?: string[];
	supporting_files?: (SupportingFileDecl | string)[];
}

function extractFrontmatter(text: string): string | null {
	const norm = text.replace(/\r\n?/g, "\n");
	if (!norm.startsWith("---\n")) return null;
	const end = norm.indexOf("\n---", 3);
	if (end === -1) return null;
	return norm.slice(4, end);
}

export function readSkillManifest(skill: LocalSkill): SkillSyncManifest | null {
	const candidateDirs = [skill.realDir, skill.dir];
	for (const dir of candidateDirs) {
		const jsonPath = join(dir, "skill-sync.json");
		if (existsSync(jsonPath)) {
			try {
				const content = readFileSync(jsonPath, "utf8");
				const parsed = JSON.parse(content) as SkillSyncManifest;
				if (parsed && typeof parsed === "object" && Array.isArray(parsed.supporting_files)) {
					return parsed;
				}
			} catch {
				// invalid JSON, ignore and try frontmatter
			}
		}
	}

	if (skill.skillMd) {
		const block = extractFrontmatter(skill.skillMd);
		if (block) {
			try {
				const parsed = YAML.parse(block) as Record<string, unknown>;
				if (parsed && typeof parsed === "object" && Array.isArray(parsed.supporting_files)) {
					return {
						surface: Array.isArray(parsed.surface) ? (parsed.surface as string[]) : undefined,
						supporting_files: parsed.supporting_files as (SupportingFileDecl | string)[],
					};
				}
			} catch {
				// invalid YAML, return null
			}
		}
	}

	return null;
}

export function hasSupportingFilesDecl(skill: LocalSkill): boolean {
	return readSkillManifest(skill) !== null;
}

export type MultiFileBodyResult =
	| { ok: true; body: string; surface: readonly string[] }
	| { ok: false; reason: string };

/**
 * Assemble a multi-file skill's kms-db body from its declared supporting files
 * (Issue #758). Shared by `pushSkill` (which pushes the result) and
 * `statusForSkill`/the reconcile hook (which only need the body to hash and
 * compare — see #<High finding, round 1 QA>). Never throws: every failure —
 * no manifest, a malformed declaration, a missing/unreadable/binary file, a
 * path escaping the skill's own directory, or an assembly refusal — comes
 * back as `{ ok: false, reason }` so one bad skill can never abort a batch.
 */
export function resolveMultiFileBody(skill: LocalSkill, surface: readonly string[] = CROSS_SURFACE): MultiFileBodyResult {
	const manifest = readSkillManifest(skill);
	if (!manifest || !manifest.supporting_files) {
		return { ok: false, reason: "multi-file (local-authoritative, no supporting_files declared)" };
	}

	const targetSurface: readonly string[] = manifest.surface ?? surface;

	const decls: SupportingFileDecl[] = [];
	for (const item of manifest.supporting_files) {
		if (typeof item === "string") {
			decls.push({ path: item, travels: true });
			continue;
		}
		if (!item || typeof item !== "object" || typeof item.path !== "string" || item.path.length === 0) {
			return {
				ok: false,
				reason: `supporting_files entry ${JSON.stringify(item)} is missing a valid 'path' — skipping this skill, not the batch`,
			};
		}
		decls.push({ path: item.path, travels: item.travels !== false, why: item.why });
	}

	const travellingPaths = decls.filter((d) => d.travels).map((d) => d.path);
	const onDisk = detectTier(skill.realDir).files.filter((f) => f !== "SKILL.md" && f !== "skill-sync.json");

	// A declared path must stay inside the skill's own directory — otherwise a
	// hand-authored (or copied-around) manifest could read, and push to hosted
	// kms-db, a file like `../../.ssh/id_rsa` (round 1 QA finding).
	const carried: CarriedFile[] = [];
	for (const relPath of [...travellingPaths].sort()) {
		const contained = assertWithinSkillDir(skill.realDir, relPath);
		if (!contained.ok) {
			return { ok: false, reason: contained.reason };
		}
		const fullPath = contained.fullPath;
		if (!existsSync(fullPath)) {
			return { ok: false, reason: `declared travelling file '${relPath}' does not exist on disk` };
		}
		let raw: Buffer;
		try {
			raw = readFileSync(fullPath);
		} catch (error) {
			return { ok: false, reason: `\`${relPath}\` could not be read: ${(error as Error).message}` };
		}
		const uncarriable = uncarriableReason(relPath, raw);
		if (uncarriable) {
			return { ok: false, reason: uncarriable };
		}
		carried.push({ path: relPath, content: raw.toString("utf8") });
	}

	const siblings = onDisk.filter((f) => !travellingPaths.includes(f));
	const assembled = assembleSkillBody(skill.skillMd ?? "", carried, siblings);
	if (!assembled.ok) {
		return { ok: false, reason: assembled.reason };
	}
	return { ok: true, body: assembled.body, surface: targetSurface };
}

export async function pushSkill(
	skill: LocalSkill,
	skillsHome: string,
	surface: readonly string[] = CROSS_SURFACE,
): Promise<PushResult> {
	if (skill.skillMd === null) {
		return { name: skill.name, outcome: "skipped", reason: "no SKILL.md" };
	}

	let body: string;
	let targetSurface: readonly string[] = surface;

	if (skill.tier === "single") {
		body = skill.skillMd;
	} else {
		const resolved = resolveMultiFileBody(skill, surface);
		if (!resolved.ok) {
			return { name: skill.name, outcome: "skipped", reason: resolved.reason };
		}
		body = resolved.body;
		targetSurface = resolved.surface;
	}

	const description = parseFrontmatter(skill.skillMd).description ?? null;
	let outcome: "created" | "updated";
	try {
		outcome = await upsertSkillCapability({
			name: skill.name,
			description,
			body,
			surface: [...targetSurface],
		});
	} catch (error) {
		// A name already held by an agent/command must not be clobbered into a skill.
		if (error instanceof SkillKindConflictError) {
			return { name: skill.name, outcome: "skipped", reason: `already registered as ${error.existingKind} — not overwriting` };
		}
		throw error;
	}

	setBase(skillsHome, skill.name, hashBody(body), new Date().toISOString(), body);
	return { name: skill.name, outcome };
}

/** Push all eligible skills (single-file or multi-file with declared supporting files). Sequential — one upsert at a time is plenty. */
export async function pushAllSingleFile(skillsHome: string = defaultSkillsHome()): Promise<PushResult[]> {
	const candidates = listLocalSkills(skillsHome).filter((skill) => skill.tier === "single" || hasSupportingFilesDecl(skill));
	const results: PushResult[] = [];
	for (const skill of candidates) {
		results.push(await pushSkill(skill, skillsHome));
	}
	return results;
}

export const pushAll = pushAllSingleFile;

/** Push one skill by name. Returns a skipped result if the name is unknown. */
export async function pushByName(name: string, skillsHome: string = defaultSkillsHome()): Promise<PushResult> {
	const skill = listLocalSkills(skillsHome).find((s) => s.name === name);
	if (!skill) return { name, outcome: "skipped", reason: "no such local skill" };
	return pushSkill(skill, skillsHome);
}
