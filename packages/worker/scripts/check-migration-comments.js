#!/usr/bin/env node

// Column-comment shrink guard — a migration can silently wipe a column comment,
// and nothing notices (#964).
//
// THE BUG THIS EXISTS TO PREVENT:
//   `COMMENT ON COLUMN` REPLACES the comment, it does not append to it. Migration
//   090 left `user_preferences.dos_hl_config` carrying the full dos vocabulary —
//   what a pillar is and that it is not task priority, `NEVER RENAME AN OPTION,
//   ONLY ADD`, the topic-versus-pillar disjointness rule, and the
//   config-is-a-subset-of-Notion rule — 2822 characters of it. Migration 097
//   renamed the column and wrote a 416-character pointer comment in its place;
//   its own header said the JSONB value's shape "is untouched", which was true,
//   but the comment carrying that shape's rules shrank by 85% the moment it ran.
//   No error, no warning — the class of bug this repo keeps producing, something
//   that reads as working while doing nothing. Migration 099 restored it (#963);
//   this is the guard so the next rename doesn't repeat it.
//
// WHAT THIS SCRIPT DOES (NO DATABASE — pure static analysis of the .sql files):
//   Replays EVERY migration file in filename (= chronological) order to track the
//   running COMMENT text for every `table.column`, exactly as the issue asks —
//   but only FLAGS a regression when the migration that caused it is NEW relative
//   to the base branch (`--base`, same flag and fallback chain as
//   `scripts/check-adr-links.js`, via `scripts/lib/range.js`). That distinction
//   matters: comment length falling as a migration evolves is completely normal
//   (early scaffolding comments get replaced by tighter ones dozens of times in
//   this repo's own history) and is not itself a bug — only a NEW migration
//   silently regressing an EXISTING comment is. Scanning the whole directory
//   unconditionally, the way `check-migration-versions.js` does for its
//   invariant, would require a permanent, ever-growing grandfather list here
//   instead of a short, finite one — every past legitimate rewrite would need an
//   entry. Diffing against the base avoids that: once a migration is merged, it
//   is baseline for every later PR and is never re-flagged.
//
//   A regression is either:
//     1. SHRINK: the new comment is under half the length of what it replaced
//        (`newLength < oldLength * SHRINK_RATIO`) — the 090 -> 097 shape.
//     2. DROPPED RULE: the new comment drops a run of 3+ consecutive ALL-CAPS
//        words the old one carried — this repo writes its load-bearing rules
//        SHOUTED inline (`NEVER RENAME AN OPTION, ONLY ADD`, `EVERY CONFIGURED
//        VALUE MUST EXIST IN NOTION`), so a rewrite that keeps the byte count
//        roughly flat but drops the rule itself is still caught. Short acronyms
//        and identifiers (`ADR-054`, `MCP`, `P0-P4`) never qualify — they carry
//        digits/hyphens, or stand alone under the 3-word minimum.
//
//   A column RENAME (`ALTER TABLE t RENAME COLUMN old TO new`) carries the
//   running comment state forward under the new name, so a rename-then-recomment
//   in one migration — exactly the 054 and 097 shape — is compared against the
//   PRE-rename text, not treated as a fresh column with no history. Renames are
//   looked for both at top level and inside dollar-quoted `DO $$ ... $$` bodies
//   (097 wraps its rename in one), since that is where every rename in this
//   repo's history actually lives.
//
// ESCAPE HATCH — a genuine cleanup is one line, not a blocked PR:
//   A migration containing the SQL comment `-- ALLOW-COMMENT-SHRINK` suppresses
//   every regression finding for that file. Scope it to one column with
//   `-- ALLOW-COMMENT-SHRINK: table.column` (repeatable) when the migration
//   touches more than one comment and only one shrink is deliberate.
//
// ORDERING ASSUMPTION, STATED RATHER THAN HIDDEN:
//   Within one file, every rename is applied to the running state BEFORE any
//   comment rewrite in that file is compared — regardless of their literal source
//   order. That matches every migration in this repo's history (rename first,
//   recomment second) and would mis-order a migration that wrote a comment
//   BEFORE a later rename in the SAME file; none currently do.
//
// KNOWN LIMITATIONS (kept, not hidden):
//   - A `COMMENT ON COLUMN` built via dynamic `EXECUTE '...'` (migration 025 does
//     this for `workflows.id` / `workflow_runs.id`) is not parsed — it is nested
//     single-quoted SQL inside a dollar-quoted DO body, and unpicking that is out
//     of scope for a guard whose job is the direct-statement case that actually
//     bit us. Missing it can only under-report (a column never tracked can never
//     register a shrink), never falsely block a PR.
//   - A TABLE rename (`ALTER TABLE ... RENAME TO ...`) is not tracked — only a
//     COLUMN rename. Same failure direction: under-reporting, not false alarms.
//   - Live database comments are out of scope by design (#964's own scoping) —
//     this reads the migration FILES only, the same property that makes
//     `check-migration-versions.js` reachable at PR time with no credentials.
//   - If no base can be resolved (see `resolveBase()` in `scripts/lib/range.js`),
//     no file counts as "new" and the guard passes trivially — under-block, never
//     over-block, the same rule every diff-based guard in this repo follows.
//
// Usage:
//   node packages/worker/scripts/check-migration-comments.js [--base <ref>] [--json]
//   or: npm run check:migration-comments        (from the repo root)
//
// Exit codes: 0 = no unexplained comment regression among new migrations;
// 1 = violations found; 2 = could not run (missing directory, unexpected error).

const fs = require('fs');
const path = require('path');
const { resolveBase, changedFiles } = require('../../../scripts/lib/range.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATIONS_DIR_REL = 'supabase/migrations';

// A new comment shorter than half its predecessor is the 090->097 shape (2822 ->
// 416, ~15%). Half is generous on purpose — plenty of legitimate trims land
// between 50% and 100% and should never need the escape hatch.
const SHRINK_RATIO = 0.5;

// A "capitals phrase" needs at least this many consecutive shout-words to count.
// The repo's actual load-bearing rules (`NEVER RENAME AN OPTION, ONLY ADD`,
// `EVERY CONFIGURED VALUE MUST EXIST IN NOTION`) all run 4+ words; 3 leaves
// margin on both sides without catching a stray two-word acronym pair.
const MIN_SHOUT_WORDS = 3;

// ---------------------------------------------------------------------------
// SQL text handling
// ---------------------------------------------------------------------------

// Match a dollar-quote opening tag (`$$` or `$tag$`) at the START of `s`.
const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Walk the SQL once, character by character. Returns:
 *   - `clean`: the source with `--` / `/* *‍/` comments blanked to a single
 *     newline (position-preserving is not attempted — only source ORDER
 *     matters here) and every string literal (single- or dollar-quoted)
 *     replaced by a `\0<index>\0` placeholder.
 *   - `strings`: the literal value of each placeholder, in the order found —
 *     `{ value, kind: 'single' | 'dollar', tag }`.
 *
 * Same shape as `check-migration-signatures.js`'s `stripSqlComments`, except
 * that script BLANKS literals (it only needs to stop them looking like DDL) and
 * this one EXTRACTS them (a COMMENT's payload IS the literal).
 */
function tokenize(sql) {
	let clean = '';
	const strings = [];
	let i = 0;
	const n = sql.length;

	while (i < n) {
		const ch = sql[i];

		if (ch === "'") {
			let j = i + 1;
			let value = '';
			while (j < n) {
				if (sql[j] === "'" && sql[j + 1] === "'") {
					value += "'";
					j += 2;
					continue;
				}
				if (sql[j] === "'") {
					j += 1;
					break;
				}
				value += sql[j];
				j += 1;
			}
			strings.push({ value, kind: 'single', tag: null });
			clean += `\0${strings.length - 1}\0`;
			i = j;
			continue;
		}

		if (ch === '$') {
			const m = DOLLAR_TAG_RE.exec(sql.slice(i));
			if (m) {
				const openTag = m[0];
				const tag = m[1] || '';
				const start = i + openTag.length;
				const closeIdx = sql.indexOf(openTag, start);
				const end = closeIdx === -1 ? n : closeIdx;
				strings.push({ value: sql.slice(start, end), kind: 'dollar', tag });
				clean += `\0${strings.length - 1}\0`;
				i = closeIdx === -1 ? n : closeIdx + openTag.length;
				continue;
			}
		}

		if (ch === '-' && sql[i + 1] === '-') {
			// Skip to (not past) the newline — the default branch below copies it on
			// the next iteration, so a manual `clean += '\n'` here would double it.
			let j = sql.indexOf('\n', i);
			if (j === -1) j = n;
			i = j;
			continue;
		}

		if (ch === '/' && sql[i + 1] === '*') {
			let j = sql.indexOf('*/', i + 2);
			j = j === -1 ? n : j + 2;
			i = j;
			continue;
		}

		clean += ch;
		i += 1;
	}

	return { clean, strings };
}

/** Split a possibly-quoted, possibly-dotted identifier into lowercased parts. */
function splitIdentParts(raw) {
	const parts = [];
	const s = raw;
	const n = s.length;
	let i = 0;
	while (i < n) {
		while (i < n && /\s/.test(s[i])) i++;
		if (i >= n) break;
		if (s[i] === '"') {
			let j = i + 1;
			let val = '';
			while (j < n && s[j] !== '"') {
				val += s[j];
				j += 1;
			}
			parts.push(val.toLowerCase());
			i = j + 1;
		} else {
			let j = i;
			while (j < n && s[j] !== '.' && !/\s/.test(s[j])) j++;
			parts.push(s.slice(i, j).toLowerCase());
			i = j;
		}
		while (i < n && /\s/.test(s[i])) i++;
		if (s[i] === '.') i += 1;
	}
	return parts;
}

const IDENT_SIMPLE = '(?:"[^"]+"|[A-Za-z_][\\w$]*)';
const IDENT_TABLE = `${IDENT_SIMPLE}(?:\\s*\\.\\s*${IDENT_SIMPLE})?`;
const IDENT_COLUMN_REF = `${IDENT_SIMPLE}(?:\\s*\\.\\s*${IDENT_SIMPLE}){1,2}`;

const COMMENT_RE = new RegExp(
	`comment\\s+on\\s+column\\s+(${IDENT_COLUMN_REF})\\s+is\\s+(?:\\0(\\d+)\\0|null)\\s*;`,
	'gi'
);

const RENAME_RE = new RegExp(
	`alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?(${IDENT_TABLE})\\s+rename\\s+column\\s+(${IDENT_SIMPLE})\\s+to\\s+(${IDENT_SIMPLE})\\s*;`,
	'gi'
);

/** `table.column`, schema prefix (if any) dropped, from a `COMMENT ON COLUMN` target. */
function columnKeyFromRef(raw) {
	const parts = splitIdentParts(raw);
	return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

/** Every `ALTER TABLE ... RENAME COLUMN old TO new` in `text`, appended to `into`. */
function collectRenames(text, into) {
	RENAME_RE.lastIndex = 0;
	let m;
	while ((m = RENAME_RE.exec(text)) !== null) {
		const tableParts = splitIdentParts(m[1]);
		into.push({
			table: tableParts[tableParts.length - 1],
			from: splitIdentParts(m[2])[0],
			to: splitIdentParts(m[3])[0],
		});
	}
}

/** Every `COMMENT ON COLUMN ... IS ...` in `clean`, in source order, resolved via `strings`. */
function collectComments(clean, strings) {
	const events = [];
	COMMENT_RE.lastIndex = 0;
	let m;
	while ((m = COMMENT_RE.exec(clean)) !== null) {
		const idx = m[2];
		const text = idx === undefined ? '' : (strings[Number(idx)] ?? { value: '' }).value;
		events.push({ key: columnKeyFromRef(m[1]), text });
	}
	return events;
}

/**
 * Same char-walk as `tokenize()` (same dollar-tag detection, same `''`
 * escaping), but for a different purpose: DROP every single- and
 * dollar-quoted span entirely (no placeholder, nothing kept) while leaving
 * `--` and `/* *‍/` comments — and everything else — untouched in place.
 *
 * Why this exists rather than reusing `clean`: `clean` blanks comments too
 * (it has to, so they cannot be mistaken for DDL), which is exactly the text
 * a real `-- ALLOW-COMMENT-SHRINK` marker lives in. But scanning the RAW
 * source for the marker (the previous approach) means the marker text can
 * match inside a column comment's own STRING content — a comment that
 * happens to mention `-- ALLOW-COMMENT-SHRINK` (quoting this very
 * convention, say) would silently suppress a real regression on that
 * column, with nothing forcing that text to be an actual SQL comment. This
 * walk keeps comments, the only place a marker can legitimately live, and
 * removes literals, the one place it must never be read from.
 *
 * A dollar-quoted `DO $$ ... $$` block is dropped as one opaque span, same
 * as a string — a marker is never written inside executable PL/pgSQL in
 * this repo's migrations, only as a standalone top-level line comment, so
 * this cannot hide a real one; it only prevents an embedded apostrophe
 * inside a dollar-quoted comment payload (`$comment$an objective's
 * identity$comment$`) from being misread as a naive single-quote and
 * desynchronising the rest of the scan.
 */
function blankLiterals(sql) {
	let out = '';
	let i = 0;
	const n = sql.length;

	while (i < n) {
		const ch = sql[i];

		if (ch === "'") {
			let j = i + 1;
			while (j < n) {
				if (sql[j] === "'" && sql[j + 1] === "'") {
					j += 2;
					continue;
				}
				if (sql[j] === "'") {
					j += 1;
					break;
				}
				j += 1;
			}
			i = j;
			continue;
		}

		if (ch === '$') {
			const m = DOLLAR_TAG_RE.exec(sql.slice(i));
			if (m) {
				const openTag = m[0];
				const closeIdx = sql.indexOf(openTag, i + openTag.length);
				i = closeIdx === -1 ? n : closeIdx + openTag.length;
				continue;
			}
		}

		if (ch === '-' && sql[i + 1] === '-') {
			let j = sql.indexOf('\n', i);
			if (j === -1) j = n;
			out += sql.slice(i, j);
			i = j;
			continue;
		}

		if (ch === '/' && sql[i + 1] === '*') {
			let j = sql.indexOf('*/', i + 2);
			j = j === -1 ? n : j + 2;
			out += sql.slice(i, j);
			i = j;
			continue;
		}

		out += ch;
		i += 1;
	}

	return out;
}

// `-- ALLOW-COMMENT-SHRINK` (blanket) or `-- ALLOW-COMMENT-SHRINK: table.column`
// (scoped, repeatable, schema prefix optional). Read via `blankLiterals()`, not
// the raw source — a marker is a real SQL comment, never text inside a string.
const MARKER_RE = /--\s*ALLOW-COMMENT-SHRINK(?:\s*:\s*([A-Za-z0-9_.]+))?/gi;

/**
 * Normalize a scoped marker's `table.column` (or schema-qualified
 * `schema.table.column`, which is what a developer will naturally type since
 * it is how the target already appears in the `COMMENT ON COLUMN` statement
 * right above the marker) down to the same schema-free `table.column` shape
 * `columnKeyFromRef()` produces — otherwise the two never compare equal and a
 * correctly-written scoped marker silently fails to suppress anything.
 */
function normalizeMarkerScope(raw) {
	const parts = raw
		.split('.')
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean);
	if (parts.length < 2) return parts.join('.');
	return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

function extractMarkers(rawSql) {
	const markers = new Set();
	const text = blankLiterals(rawSql);
	MARKER_RE.lastIndex = 0;
	let m;
	while ((m = MARKER_RE.exec(text)) !== null) {
		markers.add(m[1] ? normalizeMarkerScope(m[1]) : '*');
	}
	return markers;
}

// ---------------------------------------------------------------------------
// Capitals-phrase detection
// ---------------------------------------------------------------------------

// Strip only genuine sentence punctuation from a word's edges — never a hyphen
// or a digit, which is what keeps `ADR-054`, `P0-P4` and `#715` from being
// mistaken for shout-words (they fail the letters-only test below intact).
const EDGE_PUNCT_RE = /^[.,:;()"]+|[.,:;()"]+$/g;

/** A word counts as "shouted" if, punctuation stripped, it is 2+ pure uppercase letters. */
function shoutWord(rawWord) {
	const stripped = rawWord.replace(EDGE_PUNCT_RE, '');
	if (stripped.length < 2) return null;
	return /^[A-Z']+$/.test(stripped) ? stripped : null;
}

function normalizeWhitespace(text) {
	return text.replace(/\s+/g, ' ').trim();
}

/** Runs of `minWords`+ consecutive shout-words in `text`, each joined back into one phrase. */
function extractCapsPhrases(text, minWords = MIN_SHOUT_WORDS) {
	const words = normalizeWhitespace(text).split(' ').filter(Boolean);
	const phrases = [];
	let run = [];
	const flush = () => {
		if (run.length >= minWords) phrases.push(run.join(' '));
		run = [];
	};
	for (const word of words) {
		const shout = shoutWord(word);
		if (shout) run.push(shout);
		else flush();
	}
	flush();
	return phrases;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Pure core: replay every file's renames then comment rewrites, in filename
 * order, to build the running comment text per column, and report a regression
 * only when the migration that caused it is in `newFiles`.
 *
 * @param {object} inputs
 * @param {{name: string, sql: string}[]} inputs.files - ALL migrations, sorted by caller
 * @param {Set<string>} [inputs.newFiles] - filenames to actually flag (default: none — nothing is new, nothing can violate)
 */
function buildResult({ files, newFiles = new Set() }) {
	const state = new Map(); // key -> { text, file }
	const violations = [];
	let statementCount = 0;
	let renameCount = 0;
	let newFileCount = 0;

	for (const { name: filename, sql } of files) {
		const isNew = newFiles.has(filename);
		if (isNew) newFileCount += 1;

		const { clean, strings } = tokenize(sql);
		const markers = extractMarkers(sql);

		// 1. Renames, applied to the running state before this file's comments are
		//    compared (see the header's ORDERING ASSUMPTION). Looked for both at
		//    top level and inside every string this file opened — a rename inside a
		//    dollar-quoted `DO $$ ... $$` body (097's shape) lives in `strings`, not
		//    `clean`, since the tokenizer treats the whole body as one literal.
		const renames = [];
		collectRenames(clean, renames);
		for (const s of strings) collectRenames(s.value, renames);
		renameCount += renames.length;
		for (const r of renames) {
			const oldKey = `${r.table}.${r.from}`;
			const newKey = `${r.table}.${r.to}`;
			if (oldKey === newKey || !state.has(oldKey)) continue;
			const prev = state.get(oldKey);
			state.delete(oldKey);
			state.set(newKey, prev);
		}

		// 2. Comment rewrites, in source order. State updates unconditionally (even
		//    for an old, already-merged file) — later NEW files must still see the
		//    real baseline. Only a NEW file's own rewrite is ever compared.
		for (const event of collectComments(clean, strings)) {
			statementCount += 1;
			const prev = state.get(event.key);
			if (isNew && prev && prev.text.length > 0) {
				const suppressed = markers.has('*') || markers.has(event.key);
				if (!suppressed) {
					const oldLen = prev.text.length;
					const newLen = event.text.length;
					if (newLen < oldLen * SHRINK_RATIO) {
						violations.push({
							kind: 'comment-shrink',
							key: event.key,
							file: filename,
							previousFile: prev.file,
							previousLength: oldLen,
							newLength: newLen,
						});
					}
					const survivingText = normalizeWhitespace(event.text);
					for (const phrase of extractCapsPhrases(prev.text)) {
						if (!survivingText.includes(phrase)) {
							violations.push({
								kind: 'comment-dropped-rule',
								key: event.key,
								file: filename,
								previousFile: prev.file,
								phrase,
							});
						}
					}
				}
			}
			state.set(event.key, { text: event.text, file: filename });
		}
	}

	return {
		ok: violations.length === 0,
		counts: { files: files.length, newFiles: newFileCount, commentStatements: statementCount, renames: renameCount },
		violations,
	};
}

/** One human-readable block per violation. Pure. */
function describeViolation(violation) {
	switch (violation.kind) {
		case 'comment-shrink':
			return [
				`SHRINK: ${MIGRATIONS_DIR_REL}/${violation.file} cuts the comment on ` +
					`\`${violation.key}\` from ${violation.previousLength} to ${violation.newLength} characters` +
					` (set by ${violation.previousFile}).`,
				'  `COMMENT ON COLUMN` REPLACES, it does not append — this is the shape that took',
				'  `dos_hl_config` from 2822 to 416 characters in migration 097 (#964) with no error.',
				'  If the cut is deliberate, add `-- ALLOW-COMMENT-SHRINK` (or, scoped, ' +
					`\`-- ALLOW-COMMENT-SHRINK: ${violation.key}\`) to this migration.`,
			];
		case 'comment-dropped-rule':
			return [
				`DROPPED RULE: ${MIGRATIONS_DIR_REL}/${violation.file} rewrites the comment on ` +
					`\`${violation.key}\` (set by ${violation.previousFile}) without carrying forward:`,
				`    "${violation.phrase}"`,
				'  This repo writes load-bearing rules SHOUTED inline, and a rewrite that drops one',
				'  silently retires it. If that is intended, add `-- ALLOW-COMMENT-SHRINK` (or, scoped,',
				`  \`-- ALLOW-COMMENT-SHRINK: ${violation.key}\`) to this migration.`,
			];
		default:
			return [`UNKNOWN VIOLATION: ${JSON.stringify(violation)}`];
	}
}

/** Human-readable report lines for a buildResult() result. Pure. */
function formatReport(result) {
	const lines = [`Column-comment shrink guard — ${MIGRATIONS_DIR_REL}/`];
	lines.push(
		`  Scanned ${result.counts.files} file(s) (${result.counts.newFiles} new): ` +
			`${result.counts.commentStatements} COMMENT ON COLUMN statement(s), ${result.counts.renames} column rename(s).`
	);

	if (result.ok) {
		lines.push('  OK: no unexplained column-comment regression among the new migration(s).');
	} else {
		for (const violation of result.violations) {
			for (const line of describeViolation(violation)) lines.push(`  ${line}`);
		}
	}

	lines.push('');
	lines.push(
		result.ok
			? 'No new migration lost more than half a column comment or a shouted rule.'
			: 'Fix before merging — restore the dropped text (see migration 099 for the pattern) or, if ' +
					'the cut is deliberate, mark it with `-- ALLOW-COMMENT-SHRINK`.'
	);
	return lines;
}

function readMigrationFiles(dir = MIGRATIONS_DIR) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
		.map((entry) => entry.name)
		.sort()
		.map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf-8') }));
}

/** `::error file=…::` so a failure lands on the PR's Files-changed tab. */
function annotate(violation) {
	const [headline] = describeViolation(violation);
	console.log(`::error file=${MIGRATIONS_DIR_REL}/${violation.file}::${headline}`);
}

function main() {
	const argv = process.argv.slice(2);
	const asJson = argv.includes('--json');

	let files;
	try {
		files = readMigrationFiles();
	} catch (err) {
		console.error(`Could not read ${MIGRATIONS_DIR_REL}/: ${err.message}`);
		process.exit(2);
	}

	let result;
	try {
		const base = resolveBase(argv);
		const changed = changedFiles(base, { pathspec: [MIGRATIONS_DIR_REL] });
		const newFiles = new Set(
			changed.map((f) => path.basename(f)).filter((name) => name.endsWith('.sql'))
		);
		result = buildResult({ files, newFiles });
	} catch (err) {
		console.error(`check-migration-comments failed to run: ${err.message}`);
		process.exit(2);
	}

	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatReport(result).join('\n'));
	}

	if (!result.ok && process.env.GITHUB_ACTIONS === 'true') {
		for (const violation of result.violations) annotate(violation);
	}

	process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
	main();
}

module.exports = {
	tokenize,
	splitIdentParts,
	columnKeyFromRef,
	collectRenames,
	collectComments,
	blankLiterals,
	normalizeMarkerScope,
	extractMarkers,
	extractCapsPhrases,
	normalizeWhitespace,
	buildResult,
	describeViolation,
	formatReport,
	annotate,
	readMigrationFiles,
	MIGRATIONS_DIR,
	MIGRATIONS_DIR_REL,
	SHRINK_RATIO,
	MIN_SHOUT_WORDS,
};
