import { join, resolve, sep } from "node:path";
import { canonicalize, hashBody } from "./hash.js";

// Assemble the ONE string a `kms-db` capability serves for a repo skill (#697).
//
// THE PROBLEM
//   `properties.body` is a single string, and the contract the ahkms MCP server
//   states in its own instructions is that "a returned `body` IS the definition —
//   follow it as if it were a local skill". A skill whose SKILL.md says
//   ``Read `references/REFERENCE.md`.`` therefore CANNOT be served as SKILL.md
//   alone: the surface gets an authoritative-looking body whose first instruction
//   points at a file it has no way to open. That is #689's failure one level down
//   — which is why dos-infra and dos-personal were held back at `register: false`.
//
// THE FIX
//   Carry the supporting files INSIDE the body. The alternative — registering each
//   reference as its own capability and rewriting the step to fetch it — costs a
//   round trip the surface may not be able to make, and rewrites every skill that
//   wants to travel. This repo has 2 such skills; ~/dev/dotclaude has 15 more
//   waiting on the same mechanism (#566). Carrying the files means a multi-file
//   skill travels with NO edit to its SKILL.md.
//
// WHY THIS DOES NOT BREAK THE RECEIPT MODEL
//   #697 worried that inlining "breaks the hash-receipt model". It does not,
//   because the receipt follows the body: `body_sha256` records the hash of what
//   the registry was handed, and the bundle is a PURE, deterministic function of
//   files already in the repo. scripts/check-skill-bodies.js recomputes it with no
//   credentials, exactly as before — and a changed REFERENCE.md now fails the
//   guard identically to a changed SKILL.md, through the same field and the same
//   `body-drift` violation. No second digest is needed, and none is added: one
//   served artifact, one receipt.
//
// SINGLE-FILE SKILLS ARE UNTOUCHED
//   With nothing to carry, assembly is the IDENTITY function — the body is
//   SKILL.md verbatim, byte for byte, as it was before this module existed. Every
//   receipt already committed stays valid. The asymmetry is deliberate: the
//   multi-file branch canonicalises what it concatenates so a Windows checkout and
//   a Linux checkout assemble the same bytes, and the single-file branch does not
//   canonicalise because doing so would change bodies that are already registered.
//
// PURE. No fs, no env, no network — the fs half lives in repoSkills.ts.

/**
 * Ceiling on an assembled body, in UTF-8 bytes.
 *
 * The registry column is JSONB and would take far more; the real consumer is a
 * model's context window. `dos-hl` is ~70 KB today and works, so this is ~3.5x
 * the largest body in flight — enough headroom for a genuinely large ritual,
 * small enough to catch a fixture or a vendored dump landing in a skill folder.
 *
 * Over the budget the answer is a REFUSAL, never a truncation. A body cut in half
 * is precisely the authoritative-but-wrong definition #689 is about, and it would
 * be invisible: the surface has no way to know it received nine steps of eleven.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** A supporting file to carry inside the body, already read off disk. */
export interface CarriedFile {
	/** Path relative to the skill directory, exactly as the SKILL.md names it. */
	path: string;
	content: string;
}

export type SkillBodyResult =
	| { ok: true; body: string; hash: string; bytes: number; carried: string[] }
	| { ok: false; reason: string };

/**
 * Why this file cannot be carried in a text body, or null when it can.
 *
 * A NUL byte is the cheap, robust tell for "not text". A binary carried into a
 * body would be mojibake the surface would try to follow, so it is refused by
 * name rather than mangled.
 */
export function uncarriableReason(path: string, content: Buffer): string | null {
	if (content.includes(0)) return `\`${path}\` is not text (contains a NUL byte) — a kms-db body carries text only`;
	return null;
}

export type PathContainmentResult =
	| { ok: true; fullPath: string }
	| { ok: false; reason: string };

/**
 * Check whether a declared travelling file stays inside the skill directory (#1188, #1193).
 *
 * Prevents directory traversal attacks where a manifest references
 * files escaping the skill directory (e.g., `../../.ssh/id_rsa`).
 *
 * Pure path calculation: no fs operations.
 */
export function assertWithinSkillDir(skillDir: string, relPath: string): PathContainmentResult {
	const skillRoot = resolve(skillDir);
	const fullPath = resolve(join(skillDir, relPath));
	if (fullPath !== skillRoot && !fullPath.startsWith(skillRoot + sep)) {
		return {
			ok: false,
			reason: `declared travelling file '${relPath}' escapes the skill's own directory — refusing to read it`,
		};
	}
	return { ok: true, fullPath };
}

/**
 * The shortest backtick fence that cannot be closed early by the content — the
 * CommonMark rule. Deterministic, so both implementations of the bundler agree.
 */
function fenceFor(content: string): string {
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Every construct that, left open, runs to the END of the document rather than
 * ending at a blank or non-indented line — so anything after it is swallowed.
 *
 * Per CommonMark that is the fenced code block plus HTML blocks of types 1-5.
 * An indented code block, a list, a table, a blockquote and HTML block types 6-7
 * all end at a blank line or a non-indented line, and the appendix begins with
 * both, so none of them can hide it. Each entry pairs the line that OPENS the
 * construct with the line that would close it.
 */
const RUNS_TO_END_OF_DOCUMENT: { name: string; open: RegExp; close: RegExp }[] = [
	{
		name: "HTML block (`<script>`/`<pre>`/`<style>`/`<textarea>`)",
		open: /^ {0,3}<(script|pre|style|textarea)(\s|>|$)/i,
		close: /<\/(script|pre|style|textarea)>/i,
	},
	{ name: "HTML comment (`<!--`)", open: /^ {0,3}<!--/, close: /-->/ },
	{ name: "CDATA section (`<![CDATA[`)", open: /^ {0,3}<!\[CDATA\[/, close: /\]\]>/ },
	{ name: "processing instruction (`<?`)", open: /^ {0,3}<\?/, close: /\?>/ },
	{ name: "HTML declaration (`<!DOCTYPE`)", open: /^ {0,3}<![A-Za-z]/, close: />/ },
];

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * What SKILL.md ends INSIDE, named for a human, or null when it ends at top level.
 *
 * SKILL.md is the one part of an assembled body that is not fence-wrapped. Every
 * carried file is protected — `fenceFor` grows a fence the content cannot close —
 * but nothing wraps SKILL.md itself, so a construct left open at its end swallows
 * the entire appendix: the preamble, the manifest of carried paths and every
 * `` ## `path` `` heading stop being instructions and become quoted text inside
 * the skill's own unterminated block.
 *
 * That is exactly the silent corruption a prematurely-closed fence would be, seen
 * from the other side, and it gets the same answer: refuse by name. Detecting it
 * matters most for the skills still to migrate (#566) — a SKILL.md authored
 * elsewhere with one stray fence would otherwise assemble, hash and pass the
 * guard while serving an appendix no surface can act on.
 */
export function unterminatedOpener(text: string): string | null {
	const lines = canonicalize(text).split("\n");
	let open: { name: string; close: RegExp } | null = null;

	for (const line of lines) {
		if (open) {
			if (open.close.test(line)) open = null;
			continue;
		}

		const fence = FENCE_OPEN.exec(line);
		// A BACKTICK fence's info string may not itself contain a backtick, so
		// ``` `x` ``` at line start is an inline code span, not an opener. Tilde
		// fences have no such restriction.
		if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
			const marker = fence[1];
			open = {
				name: `code fence (\`${marker}\`)`,
				close: new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`),
			};
			continue;
		}

		for (const construct of RUNS_TO_END_OF_DOCUMENT) {
			if (!construct.open.test(line)) continue;
			// An opener may also satisfy its own end condition on the same line.
			if (!construct.close.test(line.replace(construct.open, ""))) open = construct;
			break;
		}
	}

	return open?.name ?? null;
}

/**
 * A short pointer inserted right after SKILL.md's frontmatter closes, so a
 * surface that executes step 1 as it reads it (rather than holding the whole
 * body in context first) learns the appendix exists BEFORE it hits the first
 * instruction that needs it (#727).
 *
 * It cannot go before SKILL.md: SKILL.md opens with the YAML frontmatter, and
 * prepending would move that off position 0, breaking "the body is SKILL.md
 * verbatim" — the format decision #697 depends on. So it goes immediately
 * after the closing `---` instead: deterministic, and the frontmatter stays
 * valid and stays first. If SKILL.md has no parseable frontmatter (no opening
 * `---` line, or it never closes), nothing is inserted — there is no safe
 * position to put it, and the full explanation still ships in the appendix.
 */
export function injectBundlePointer(canonicalSkillMd: string): string {
	const lines = canonicalSkillMd.split("\n");
	if (lines[0] !== "---") return canonicalSkillMd;

	let closeIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			closeIndex = i;
			break;
		}
	}
	if (closeIndex === -1) return canonicalSkillMd;

	const pointer = [
		"",
		'> **This file travels with its supporting files carried below.** Where a step above names\n' +
			"> a path, read the matching heading in the \"Bundled supporting files\" appendix at the\n" +
			"> end of this document instead of opening it on disk.",
		"",
	];

	return [...lines.slice(0, closeIndex + 1), ...pointer, ...lines.slice(closeIndex + 1)].join("\n");
}

/**
 * The instructions that make the bundle followable. This is the whole contract
 * with the reading surface, so it says what to do, not what happened.
 *
 * `carriedPaths` is complete for what this body carries — `travels: true`.
 * `siblingPaths` is every OTHER file the manifest reviewed and declared
 * `travels: false`: it exists in the skill's directory but was not needed for
 * the ritual. Naming it here is what keeps the completeness claim honest on a
 * mixed skill (#728) — a reader who cannot find a path in the carried list can
 * check whether it is a reviewed, deliberately-not-carried sibling before
 * concluding the body is incomplete.
 */
function preambleBlocks(carriedPaths: string[], siblingPaths: string[]): string[] {
	const blocks = [
		"---\n",
		"# Bundled supporting files\n",
		"This skill is defined by more than one file. You are reading a body assembled for a\n" +
			"surface with no access to the repository the skill lives in, so the files it depends\n" +
			"on are carried inline below, verbatim.\n",
		"**Where the instructions above tell you to read a path — for example\n" +
			"`references/REFERENCE.md` — read the section with that exact heading below instead.**\n" +
			"Paths are relative to the skill's own directory. Do not try to open them on disk.\n",
		"This list is complete for what is CARRIED in this body — not for the skill's whole\n" +
			"directory. If the instructions name another path relative to this skill's own directory\n" +
			"that is NOT listed below, check whether it appears in the \"present but not carried\" list\n" +
			"below before assuming it is missing: a path there exists in the skill's directory and was\n" +
			"reviewed as not needed for these instructions, so treat it as out of scope rather than\n" +
			"stopping. A path in neither list is genuinely absent — stop and say so rather than\n" +
			"improvising its contents. Paths elsewhere in the repository are not carried either way —\n" +
			"read them if you have the repository, and say plainly that you cannot if you do not.\n",
		`Carried in this body (${carriedPaths.length}):\n` + carriedPaths.map((path) => `- \`${path}\`\n`).join(""),
	];
	if (siblingPaths.length > 0) {
		blocks.push(
			`Present in the skill's directory but not carried in this body (${siblingPaths.length}):\n` +
				siblingPaths.map((path) => `- \`${path}\`\n`).join(""),
		);
	}
	return blocks;
}

function sectionBlock(file: CarriedFile): string {
	const content = canonicalize(file.content);
	const fence = fenceFor(content);
	return `## \`${file.path}\`\n` + "\n" + `${fence}\n` + content + `${fence}\n`;
}

/**
 * Assemble the body for a skill. With nothing to carry this is the identity
 * function on SKILL.md; otherwise it is SKILL.md — with a short pointer to the
 * appendix inserted right after its frontmatter (#727) — followed by a
 * labelled section per carried file, in path order.
 *
 * `siblings` are OTHER files the manifest declared `travels: false`: present in
 * the skill's directory, reviewed, but not part of this body. They are named in
 * the preamble rather than silently omitted (#728) — pass `[]` when there are
 * none, or the caller does not track the distinction.
 *
 * Construction is a list of blocks joined by a blank line, each block ending in
 * exactly one newline. That shape exists so the CommonJS mirror in
 * scripts/check-skill-bodies.js can be read side by side with this and checked
 * for agreement by eye as well as by test.
 */
export function assembleSkillBody(skillMd: string, carried: CarriedFile[], siblings: string[] = []): SkillBodyResult {
	const files = [...carried].sort((a, b) => a.path.localeCompare(b.path));
	const siblingPaths = [...siblings].sort();

	// Checked only on the carrying branch, and deliberately: with no appendix
	// there is nothing for an unterminated construct to swallow, and the identity
	// guarantee for single-file skills must hold whatever their markdown does.
	if (files.length > 0) {
		const swallower = unterminatedOpener(skillMd);
		if (swallower) {
			const carrying = files.map((file) => `\`${file.path}\``).join(", ");
			return {
				ok: false,
				reason:
					`SKILL.md ends inside an unterminated ${swallower}, which would swallow the appendix carrying ${carrying} — ` +
					"close it, so the carried sections read as instructions rather than as quoted text",
			};
		}
	}

	const body =
		files.length === 0
			? skillMd
			: [
					injectBundlePointer(canonicalize(skillMd)),
					...preambleBlocks(
						files.map((file) => file.path),
						siblingPaths,
					),
					...files.map(sectionBlock),
				].join("\n");

	// Measured on the CANONICAL form, not the raw string. This repo is developed
	// on Windows with autocrlf, so a fresh checkout's SKILL.md carries CRLF while
	// CI's carries LF — measuring raw would let the offline guard and the live
	// push disagree about a body near the limit, on line count alone.
	const bytes = Buffer.byteLength(canonicalize(body), "utf8");
	if (bytes > MAX_BODY_BYTES) {
		const breakdown = [
			`SKILL.md ${Buffer.byteLength(canonicalize(skillMd), "utf8")}`,
			...files.map((file) => `${file.path} ${Buffer.byteLength(canonicalize(file.content), "utf8")}`),
		].join(", ");
		return {
			ok: false,
			reason: `assembled body is ${bytes} bytes, over the ${MAX_BODY_BYTES}-byte budget (${breakdown}) — split the skill or stop carrying a file; a body is never truncated to fit`,
		};
	}

	return { ok: true, body, hash: hashBody(body), bytes, carried: files.map((file) => file.path) };
}
