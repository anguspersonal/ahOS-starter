import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { defaultSkillsHome } from "./localSkills.js";

// Upstream clone + registry management (#375). Each registered upstream — mattpocock
// is the first, NOT hardcoded — gets a shallow, gitignored clone under
// <skills-home>/.upstream/<owner>-<repo>/, fetched on demand. A registry file lists
// them, so the whole design generalises to N upstreams with no code change.

/** Top-level subdirs treated as distribution adapters, not skill content (stripped on import). */
export const ADAPTER_DIRS = new Set(["agents"]);

export interface Upstream {
	/** <owner>-<repo>, derived from the URL. */
	name: string;
	url: string;
	/** Absolute path to the local clone. */
	dir: string;
}

export function upstreamRoot(skillsHome: string = defaultSkillsHome()): string {
	return join(skillsHome, ".upstream");
}

function registryPath(skillsHome: string): string {
	return join(upstreamRoot(skillsHome), "registry.json");
}

function git(args: string[], cwd?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Derive a stable `<owner>-<repo>` name from a git URL (https or ssh form). */
export function upstreamName(url: string): string {
	// Normalise Windows backslash separators to POSIX so the regex matches
	// filesystem paths (e.g. os.tmpdir() clones in tests) as well as remote URLs.
	const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim().replace(/\\/g, "/"));
	if (!m) throw new Error(`skill-sync: cannot derive an upstream name from '${url}'`);
	return `${m[1]}-${m[2]}`;
}

export function listUpstreams(skillsHome: string = defaultSkillsHome()): Upstream[] {
	const p = registryPath(skillsHome);
	if (!existsSync(p)) return [];
	try {
		return (JSON.parse(readFileSync(p, "utf8")) as { upstreams?: Upstream[] }).upstreams ?? [];
	} catch {
		return [];
	}
}

/** Clone the upstream shallowly if absent, else fetch and hard-reset to the new HEAD. */
export function cloneOrFetch(url: string, dir: string): void {
	if (existsSync(join(dir, ".git"))) {
		git(["fetch", "--depth", "1", "origin"], dir);
		git(["reset", "--hard", "FETCH_HEAD"], dir);
	} else {
		mkdirSync(dir, { recursive: true });
		git(["clone", "--depth", "1", url, dir]);
	}
}

/** Register (and clone/fetch) an upstream. Idempotent — re-registering just fetches. */
export function registerUpstream(url: string, skillsHome: string = defaultSkillsHome()): Upstream {
	const name = upstreamName(url);
	const dir = join(upstreamRoot(skillsHome), name);
	cloneOrFetch(url, dir);
	const upstreams = listUpstreams(skillsHome).filter((u) => u.name !== name);
	upstreams.push({ name, url, dir });
	mkdirSync(upstreamRoot(skillsHome), { recursive: true });
	writeFileSync(registryPath(skillsHome), JSON.stringify({ version: 1, upstreams }, null, 2) + "\n", "utf8");
	return { name, url, dir };
}

export function upstreamHead(dir: string): string {
	return git(["rev-parse", "HEAD"], dir);
}

/**
 * The content of `blob` from the clone's object store, or null when the clone no
 * longer has it (a later shallow fetch pruned it, or it was never fetched). With
 * `path`, the blob goes through that path's checkout filters (autocrlf and the
 * like), giving the bytes as they were in the working tree. Not trimmed: callers
 * hash the result.
 */
export function readUpstreamBlob(dir: string, blob: string, path?: string): string | null {
	if (!/^[0-9a-f]{40}$/.test(blob)) return null;
	const args = path === undefined ? ["cat-file", "blob", blob] : ["cat-file", "--filters", `--path=${path}`, blob];
	try {
		return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

export interface UpstreamSkill {
	/** Skill directory name. */
	name: string;
	/** Path relative to the clone root, e.g. `skills/engineering/implement/SKILL.md`. */
	path: string;
	/** SKILL.md contents. */
	body: string;
	/** Content files (excludes the agents/ adapter and dotfiles) — previews the tier. */
	fileCount: number;
}

function walkSkillDirs(root: string, visit: (dir: string) => void): void {
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
		const child = join(root, entry.name);
		if (existsSync(join(child, "SKILL.md"))) visit(child);
		else walkSkillDirs(child, visit); // recurse through category folders
	}
}

/** Count content files under a skill dir, excluding the agents/ adapter and dotfiles. */
export function countContentFiles(skillDir: string): number {
	let n = 0;
	const rec = (d: string, atTop: boolean) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name.startsWith(".")) continue;
			if (atTop && ADAPTER_DIRS.has(e.name)) continue;
			if (e.isDirectory()) rec(join(d, e.name), false);
			else n++;
		}
	};
	rec(skillDir, true);
	return n;
}

/** Enumerate every skill in an upstream clone (any directory holding a SKILL.md). */
export function listUpstreamSkills(dir: string): UpstreamSkill[] {
	const skills: UpstreamSkill[] = [];
	const skillsRoot = join(dir, "skills");
	walkSkillDirs(existsSync(skillsRoot) ? skillsRoot : dir, (skillDir) => {
		skills.push({
			name: basename(skillDir),
			path: relative(dir, join(skillDir, "SKILL.md")),
			body: readFileSync(join(skillDir, "SKILL.md"), "utf8"),
			fileCount: countContentFiles(skillDir),
		});
	});
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
