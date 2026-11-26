import { parse as parseYaml } from "yaml";

// The x-upstream provenance convention (#375): a frontmatter block that records
// which external skill a local fork descends from and the exact upstream commit +
// blob it was last reconciled against. It IS the persistent mapping + fork-point
// store — no ahkms DB field, no migration. We manipulate ONLY the x-upstream block
// textually (never round-trip the whole frontmatter through YAML) so the rest of the
// file stays byte-identical and its content hash is stable.

export interface XUpstream {
	repo: string;
	path: string;
	baseCommit: string;
	baseBlob: string;
	reviewed?: string;
	localEdits?: string;
}

// CRLF-tolerant (#392). git-for-Windows installs with core.autocrlf=true, so a
// cloned upstream SKILL.md is checked out as `---\r\n…`. An LF-only pattern here
// simply doesn't match, which is worse than it sounds: stampXUpstream then takes
// its "no frontmatter" branch and PREPENDS a second, LF frontmatter block,
// demoting the real CRLF one to body. importUpstreamSkill did that on every
// import and walkFork then merged the double-frontmatter file into garbage.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * The line ending to re-emit with. Inferred from the frontmatter delimiter when
 * there is one (that's the region being rewritten), else from the first break in
 * the file. Detecting rather than normalising is deliberate: this module's
 * contract is that everything outside the x-upstream block stays byte-identical,
 * so rewriting a CRLF file's endings to LF would be its own corruption — a
 * whole-file diff, and a spurious "local edits" signal to the reconcile pass.
 */
function eolOf(skillMd: string): string {
	const firstBreak = /\r?\n/.exec(skillMd);
	return firstBreak?.[0] === "\r\n" ? "\r\n" : "\n";
}

/**
 * Split a frontmatter block into lines with no trailing \r, so downstream
 * line-scanning and YAML parsing never see the carriage return. Callers rejoin
 * with eolOf() to restore the file's own style.
 */
function splitLines(block: string): string[] {
	return block.split(/\r?\n/);
}

function dedent(lines: string[]): string {
	const indents = lines.filter((l) => l.trim() !== "").map((l) => (/^(\s*)/.exec(l)?.[1].length ?? 0));
	const min = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(min)).join("\n");
}

/** Extract the x-upstream provenance from a SKILL.md, or null if absent/malformed. */
export function parseXUpstream(skillMd: string): XUpstream | null {
	const fm = FRONTMATTER.exec(skillMd);
	if (!fm) return null;
	const lines = splitLines(fm[1]);
	const start = lines.findIndex((l) => /^x-upstream:\s*$/.test(l));
	if (start === -1) return null;

	const block: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s/.test(lines[i])) block.push(lines[i]);
		else break; // dedent to a new top-level key ends the block
	}

	let obj: Record<string, unknown>;
	try {
		obj = (parseYaml(dedent(block)) ?? {}) as Record<string, unknown>;
	} catch {
		return null;
	}
	const str = (k: string): string | undefined => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
	const repo = str("repo");
	const path = str("path");
	const baseCommit = str("base_commit");
	const baseBlob = str("base_blob");
	if (!repo || !path || !baseCommit || !baseBlob) return null;
	return { repo, path, baseCommit, baseBlob, reviewed: str("reviewed"), localEdits: str("local-edits") };
}

/** Strip the x-upstream block out of a SKILL.md (used before a 3-way merge — upstream never has it). */
export function removeXUpstream(skillMd: string): string {
	const fm = FRONTMATTER.exec(skillMd);
	if (!fm) return skillMd;
	const lines = splitLines(fm[1]);
	const start = lines.findIndex((l) => /^x-upstream:\s*$/.test(l));
	if (start === -1) return skillMd;
	let end = start + 1;
	while (end < lines.length && /^\s/.test(lines[end])) end++;
	const newFm = [...lines.slice(0, start), ...lines.slice(end)].join(eolOf(skillMd));
	// Function replacer: a string 2nd arg to String.replace interprets `$`-sequences
	// (`$&`, `$1`, `$$`, etc.) as special patterns. newFm is derived from file content,
	// so treat it as a literal replacement rather than risk silent corruption.
	return skillMd.replace(fm[1], () => newFm);
}

/** Serialise an XUpstream to the canonical block form used across the skills. */
export function serializeXUpstream(x: XUpstream): string {
	const out = ["x-upstream:", `  repo: ${x.repo}`, `  path: ${x.path}`];
	out.push(`  base_commit: ${x.baseCommit}`);
	out.push(`  base_blob: ${x.baseBlob}`);
	if (x.reviewed !== undefined) out.push(`  reviewed: ${JSON.stringify(x.reviewed)}`);
	if (x.localEdits !== undefined) out.push(`  local-edits: ${JSON.stringify(x.localEdits)}`);
	return out.join("\n");
}

/**
 * Write (or replace) the x-upstream block in a SKILL.md's frontmatter, leaving the
 * rest of the file byte-identical. If there is no frontmatter at all, one is created.
 */
export function stampXUpstream(skillMd: string, x: XUpstream): string {
	// serializeXUpstream is canonically LF; re-split so the block adopts this
	// file's line ending rather than injecting LF into a CRLF frontmatter.
	const blockLines = serializeXUpstream(x).split("\n");
	const eol = eolOf(skillMd);
	const fm = FRONTMATTER.exec(skillMd);
	if (!fm) {
		return `---${eol}${blockLines.join(eol)}${eol}---${eol}${eol}${skillMd}`;
	}

	const lines = splitLines(fm[1]);
	const start = lines.findIndex((l) => /^x-upstream:\s*$/.test(l));
	let newFm: string;
	if (start !== -1) {
		let end = start + 1;
		while (end < lines.length && /^\s/.test(lines[end])) end++;
		newFm = [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join(eol);
	} else {
		// Drop any trailing blank lines before appending, then rejoin — going via
		// `lines` keeps this CRLF-safe (a `/\n*$/` strip would leave a stray \r).
		while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
		newFm = [...lines, ...blockLines].join(eol);
	}
	// Function replacer: newFm can contain `$`-sequences (e.g. via reviewed/local-edits
	// values), which String.replace would otherwise interpret as special patterns.
	return skillMd.replace(fm[1], () => newFm);
}
