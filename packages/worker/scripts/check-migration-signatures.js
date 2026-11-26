#!/usr/bin/env node

// Migration function-signature lint — the #069 overload trap, caught in CI.
//
// THE BUG THIS EXISTS TO PREVENT (see #206 / #273):
//   Postgres keys a function by its full INPUT-argument-type signature. Using
//   `CREATE OR REPLACE FUNCTION name(...)` with a CHANGED argument list does NOT
//   replace the function — it creates a SECOND overload alongside the old one. If
//   the new params are all defaultable, an old-arity call now matches BOTH
//   candidates and fails at runtime with:
//       ERROR 42725: function name(...) is not unique
//   Migration 069 did exactly this to `fts_search_artifacts` /
//   `hybrid_search_artifacts` (added `include_archived` via CREATE OR REPLACE) and
//   broke prod keyword+hybrid search until migration 071 dropped the stale
//   overloads. mcp-server unit tests mock Supabase, so nothing in CI exercised
//   Postgres overload resolution — the bug was invisible until prod.
//
// THE RULE (documented in AGENTS.md + supabase/README.md "Migration authoring
// gotchas"): to change a function's signature you must DROP the old signature(s)
// explicitly, then CREATE. Functions are versioned by DROP+CREATE, so every
// function name resolves to exactly ONE live overload.
//
// WHAT THIS SCRIPT DOES (NO DATABASE — pure static analysis of the .sql files):
// replays every CREATE/DROP FUNCTION statement in supabase/migrations/ in version
// order, tracking the set of live signatures per function name. A `CREATE OR
// REPLACE` with a new argument list adds an overload; a matching `DROP FUNCTION
// name(oldtypes)` removes it. If, after replaying the whole history, any function
// name still has MORE THAN ONE live overload, that is the trap — a signature was
// changed without dropping the prior one — and the check fails (exit 1).
//
// The historical 069+071 pair nets out clean (069 adds the overload, 071 drops the
// stale one → one live signature), so committed history passes; a NEW migration
// that repeats 069's mistake without a fix leaves two live overloads and fails.
//
// PARSER HARDENING (#402): the scan is string-literal aware — text inside a
// single-quoted or dollar-quoted (`$$...$$`) literal (a DEFAULT value, or dynamic
// SQL inside a function body) is blanked before the CREATE/DROP scan runs, so it
// can never be mistaken for real DDL — and DROP FUNCTION accepts a comma-separated
// multi-name list (`DROP FUNCTION f1(...), f2(...);`), a valid single-statement fix
// for an overload in more than one function at once.
//
// Usage:
//   node packages/worker/scripts/check-migration-signatures.js [--json]
//   or: npm run check:migration-signatures            (from the repo root)
//   or: npm run check:migration-signatures -w @ahkms/worker
//
// Exit codes: 0 = every function has a single live overload; 1 = an accidental
// overload was found; 2 = could not run (missing dir, unexpected error).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

// ---------------------------------------------------------------------------
// SQL text handling
// ---------------------------------------------------------------------------

// Match a dollar-quote opening tag (`$$` or `$tag$`) at the START of `s`, or return
// null. A tag is `$`, an optional identifier, `$` — exactly Postgres's own rule.
const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

// Blank out `-- line` / `/* block */` comments AND the interior of every string
// literal — single-quoted (`'...'`, with `''` as an escaped quote) and dollar-quoted
// (`$$...$$` / `$tag$...$tag$`) — preserving newlines and overall length so that line
// structure (and any real statement on a later line) survives. This is what makes the
// DDL-keyword and paren-balance scans below string-literal AWARE (#402): text hidden
// inside a literal — a `DROP FUNCTION ...` embedded in a DEFAULT string, in dynamic
// SQL (`EXECUTE '...'`) inside a body, or a stray unbalanced `(` in a string default —
// can no longer be mistaken for real DDL structure.
//
// Function BODIES are themselves almost always one big dollar-quoted string
// (`AS $$ ... $$`), so this blanks them too. That is a no-op for correctness: every
// CREATE/DROP signature this script parses sits BEFORE the body's `AS $$`, and nothing
// downstream reads body content.
function stripSqlComments(sql) {
	let out = '';
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i];

		if (ch === "'") {
			out += ' ';
			i++;
			while (i < n) {
				if (sql[i] === "'" && sql[i + 1] === "'") {
					out += '  ';
					i += 2;
					continue;
				}
				const c = sql[i];
				out += c === '\n' ? '\n' : ' ';
				i++;
				if (c === "'") break;
			}
			continue;
		}

		const tagMatch = ch === '$' ? DOLLAR_TAG_RE.exec(sql.slice(i)) : null;
		if (tagMatch) {
			const tag = tagMatch[0];
			const closeIdx = sql.indexOf(tag, i + tag.length);
			const end = closeIdx === -1 ? n : closeIdx + tag.length;
			for (let j = i; j < end; j++) out += sql[j] === '\n' ? '\n' : ' ';
			i = end;
			continue;
		}

		const two = sql.slice(i, i + 2);
		if (two === '--') {
			while (i < n && sql[i] !== '\n') {
				out += ' ';
				i++;
			}
		} else if (two === '/*') {
			while (i < n && sql.slice(i, i + 2) !== '*/') {
				out += sql[i] === '\n' ? '\n' : ' ';
				i++;
			}
			// consume the closing */
			if (i < n) {
				out += '  ';
				i += 2;
			}
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

// Reduce a qualified/quoted function name to a bare, lowercased identifier:
// `public."Foo"` -> `foo`. Overload identity ignores the schema, and this repo
// mixes `public.update_updated_at_column` with the bare `update_updated_at_column`.
function bareName(rawName) {
	const noQuotes = rawName.replace(/"/g, '');
	const lastDot = noQuotes.lastIndexOf('.');
	const bare = lastDot >= 0 ? noQuotes.slice(lastDot + 1) : noQuotes;
	return bare.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Type canonicalisation
// ---------------------------------------------------------------------------

// Postgres treats many type spellings as the same underlying type for the purpose
// of function-overload identity. A CREATE arg written `match_limit int` and the
// DROP that removes it `... integer)` must compare equal, or the DROP would fail to
// clear the live signature and we'd report a phantom overload.
const TYPE_ALIASES = new Map([
	['int', 'integer'],
	['int4', 'integer'],
	['integer', 'integer'],
	['int2', 'smallint'],
	['smallint', 'smallint'],
	['int8', 'bigint'],
	['bigint', 'bigint'],
	['float', 'double precision'],
	['float8', 'double precision'],
	['double precision', 'double precision'],
	['float4', 'real'],
	['real', 'real'],
	['bool', 'boolean'],
	['boolean', 'boolean'],
	['decimal', 'numeric'],
	['numeric', 'numeric'],
	['varchar', 'character varying'],
	['character varying', 'character varying'],
	['char', 'character'],
	['character', 'character'],
	['timestamptz', 'timestamptz'],
	['timestamp with time zone', 'timestamptz'],
	['timestamp', 'timestamp'],
	['timestamp without time zone', 'timestamp'],
]);

// Canonicalise a single type token: lowercase, collapse whitespace, drop the type
// modifier (`vector(1536)` -> `vector`, `numeric(10,2)` -> `numeric`) which is not
// part of the signature, preserve array `[]`, then map known aliases.
function canonicalizeType(rawType) {
	if (!rawType) return '';
	let t = rawType.trim().toLowerCase().replace(/\s+/g, ' ');
	// Remember array-ness, then strip modifiers, then re-attach.
	const arraySuffix = (t.match(/(\[\s*\])+\s*$/) || [''])[0].replace(/\s+/g, '');
	t = t.replace(/(\[\s*\])+\s*$/, '').trim();
	// Strip a trailing type modifier: `vector(1536)`, `numeric(10, 2)`.
	t = t.replace(/\(\s*[\d\s,]*\)\s*$/, '').trim();
	const mapped = TYPE_ALIASES.get(t) || t;
	return mapped + arraySuffix;
}

// Split an argument list on TOP-LEVEL commas only (commas inside `()` or `[]`,
// e.g. a `numeric(10,2)` modifier or an `array[a,b]` default, do not split).
function splitTopLevelArgs(inner) {
	const parts = [];
	let depth = 0;
	let cur = '';
	for (const ch of inner) {
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	if (cur.trim() !== '') parts.push(cur);
	return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// Parse a CREATE arg list (named args: `name type [default expr]`) into an ordered
// list of canonical INPUT types. OUT/TABLE columns are not part of the arg list we
// extract (we only take the parenthesis group immediately after the name).
function parseCreateSignature(inner) {
	return splitTopLevelArgs(inner).map((arg) => {
		let a = arg.trim();
		// Drop a leading argmode keyword. (VARIADIC changes the call signature, so
		// keep it as a marker; IN is the default; OUT/INOUT don't appear in this
		// corpus's arg lists.)
		let variadic = '';
		const modeMatch = a.match(/^(variadic|inout|out|in)\s+/i);
		if (modeMatch) {
			if (modeMatch[1].toLowerCase() === 'variadic') variadic = 'variadic ';
			a = a.slice(modeMatch[0].length);
		}
		// Strip a DEFAULT clause (`default 10`, `= 10`) -- not part of the signature.
		// The boundary after `default` is \b, not \s+: once stripSqlComments has
		// blanked a string-literal default (#402), its value is whitespace that the
		// surrounding .trim() has already removed, leaving the bare keyword at
		// end-of-string. `\s+default\s+` cannot match that, so the type normalised
		// to `text default` and stopped comparing equal to the same function
		// declared with a non-string default. \b still refuses to fire on an
		// identifier that merely starts with the word (`default_value`).
		a = a.replace(/\s+default\b.*$/is, '').replace(/\s*=\s*.*$/s, '').trim();
		// `name type` — the first whitespace-delimited token is the arg name; the
		// remainder is the (possibly multi-word) type. If there is no remainder the
		// arg was written unnamed (just a type), so treat the whole token as the type.
		const spaceIdx = a.search(/\s/);
		const typePart = spaceIdx === -1 ? a : a.slice(spaceIdx + 1);
		return variadic + canonicalizeType(typePart);
	});
}

// Parse a DROP arg list (type-only: `DROP FUNCTION name(text, uuid, integer)`) into
// an ordered list of canonical types.
function parseDropSignature(inner) {
	return splitTopLevelArgs(inner).map((arg) => {
		let a = arg.trim();
		let variadic = '';
		const modeMatch = a.match(/^(variadic|inout|out|in)\s+/i);
		if (modeMatch) {
			if (modeMatch[1].toLowerCase() === 'variadic') variadic = 'variadic ';
			a = a.slice(modeMatch[0].length);
		}
		return variadic + canonicalizeType(a);
	});
}

function signatureString(types) {
	return `(${types.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Statement extraction
// ---------------------------------------------------------------------------

// From `openIdx` (the index of a `(`), return the substring INSIDE the balanced
// parenthesis group, and the index just past its closing `)`.
function extractBalancedParens(sql, openIdx) {
	let depth = 0;
	for (let i = openIdx; i < sql.length; i++) {
		const ch = sql[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return { inner: sql.slice(openIdx + 1, i), end: i + 1 };
		}
	}
	return null;
}

// The bare/qualified/quoted function-name shape, shared by the statement-anchored
// regex below and the per-name scan used to walk a multi-name DROP list.
const NAME_PATTERN = '"?[\\w.$]+"?(?:\\."?[\\w.$]+"?)?';

// Extract every CREATE/DROP FUNCTION operation from one migration file's SQL, in
// source order. Comments and string-literal interiors are stripped first (see
// `stripSqlComments`). Each op: { op, name, hasArgs, signature, index }.
function extractFunctionOps(rawSql) {
	const sql = stripSqlComments(rawSql);
	const ops = [];
	const re = new RegExp(
		`\\b(create|drop)\\s+(?:or\\s+replace\\s+)?function\\s+(?:if\\s+exists\\s+)?(${NAME_PATTERN})`,
		'gi',
	);
	const nameOnlyRe = new RegExp(`^${NAME_PATTERN}`);

	let m;
	while ((m = re.exec(sql)) !== null) {
		const op = m[1].toLowerCase();

		// Parse one `name[(args)]` spec at `nameEnd` (the index just past `specName`),
		// push its op, and return the index just past the spec (past the closing `)`
		// if there was an arg list, otherwise past the bare name).
		const consumeSpec = (specName, specIndex, nameEnd) => {
			let k = nameEnd;
			while (k < sql.length && /\s/.test(sql[k])) k++;
			if (sql[k] === '(') {
				const group = extractBalancedParens(sql, k);
				// Fail loudly rather than silently skipping. A paren group that can't be
				// balanced would otherwise drop this CREATE/DROP op from tracking and
				// could hide a signature-changing overload — the exact bug this lint
				// exists to catch. String-literal interiors are already blanked above,
				// so a REAL unbalanced group here means genuinely malformed DDL.
				if (!group) {
					throw new Error(
						`unbalanced parentheses after ${op.toUpperCase()} FUNCTION ${specName} — ` +
							`cannot parse its argument list; refusing to silently skip it`,
					);
				}
				const types = op === 'create' ? parseCreateSignature(group.inner) : parseDropSignature(group.inner);
				ops.push({ op, name: specName, hasArgs: true, signature: signatureString(types), index: specIndex });
				return group.end;
			}
			// `DROP FUNCTION name` with no arg list => remove every live overload.
			// (A no-paren CREATE is not valid DDL; ignore it defensively.)
			if (op === 'drop') {
				ops.push({ op, name: specName, hasArgs: false, signature: null, index: specIndex });
			}
			return k;
		};

		let cursor = consumeSpec(m[2], m.index, m.index + m[0].length);

		// Multi-name DROP FUNCTION f1(...), f2(...), ...; — valid Postgres, and the
		// natural way to fix an accidental overload in more than one function at once
		// (the N-function generalisation of the 069+071 pattern). CREATE FUNCTION
		// never defines more than one function per statement, so this only applies
		// to DROP; `IF EXISTS` (already consumed above) covers the whole list, not
		// each name.
		if (op === 'drop') {
			for (;;) {
				let k = cursor;
				while (k < sql.length && /\s/.test(sql[k])) k++;
				if (sql[k] !== ',') break;
				k++;
				while (k < sql.length && /\s/.test(sql[k])) k++;
				const nameMatch = nameOnlyRe.exec(sql.slice(k));
				if (!nameMatch) break;
				cursor = consumeSpec(nameMatch[0], k, k + nameMatch[0].length);
			}
		}
	}
	ops.sort((a, b) => a.index - b.index);
	return ops;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

// Replay all files (each { name, sql }) in version order and compute, per function
// name, the set of live signatures. Returns { live, violations, createCount,
// dropCount }.
function analyzeMigrations(files) {
	const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	// name -> Map<signature, { file }>
	const live = new Map();
	let createCount = 0;
	let dropCount = 0;

	for (const file of sorted) {
		const ops = extractFunctionOps(file.sql);
		for (const op of ops) {
			const name = bareName(op.name);
			if (!live.has(name)) live.set(name, new Map());
			const sigs = live.get(name);
			if (op.op === 'drop') {
				dropCount++;
				if (op.hasArgs) sigs.delete(op.signature);
				else sigs.clear();
			} else {
				createCount++;
				// CREATE OR REPLACE of an identical signature is a no-op on the set;
				// a new signature adds a second overload (the trap).
				sigs.set(op.signature, { file: file.name });
			}
		}
	}

	const violations = [];
	for (const [name, sigs] of [...live.entries()].sort()) {
		if (sigs.size > 1) {
			violations.push({
				name,
				overloads: [...sigs.entries()]
					.map(([signature, meta]) => ({ signature, file: meta.file }))
					.sort((a, b) => (a.signature < b.signature ? -1 : 1)),
			});
		}
	}

	return { live, violations, createCount, dropCount };
}

function buildResult(files) {
	const { violations, createCount, dropCount, live } = analyzeMigrations(files);
	return {
		ok: violations.length === 0,
		filesScanned: files.length,
		functionsSeen: live.size,
		createCount,
		dropCount,
		violations,
	};
}

function formatReport(result) {
	const lines = [];
	lines.push('Migration function-signature lint');
	lines.push(
		`Scanned ${result.filesScanned} migration file(s): ${result.createCount} CREATE / ${result.dropCount} DROP FUNCTION statement(s), ${result.functionsSeen} distinct function name(s).`
	);
	if (result.ok) {
		lines.push('OK: every function name resolves to a single live overload.');
		return lines;
	}
	lines.push('');
	lines.push(`FAIL: ${result.violations.length} function(s) left with more than one live overload.`);
	lines.push('');
	lines.push('This is the migration-069 trap: a CREATE OR REPLACE FUNCTION changed a');
	lines.push("function's argument list without dropping the prior signature, so Postgres");
	lines.push('kept BOTH overloads. An old-arity call then fails at runtime with');
	lines.push('"ERROR 42725: function ... is not unique".');
	lines.push('');
	for (const v of result.violations) {
		lines.push(`  * ${v.name} has ${v.overloads.length} live overloads:`);
		for (const o of v.overloads) {
			lines.push(`      - ${v.name}${o.signature}   (created in ${o.file})`);
		}
	}
	lines.push('');
	lines.push('Fix: in the migration that changed the signature, DROP the old one first:');
	lines.push('    DROP FUNCTION IF EXISTS <name>(<old arg types>);');
	lines.push('    CREATE OR REPLACE FUNCTION <name>(<new args>) ...');
	lines.push('See AGENTS.md and supabase/README.md "Migration authoring gotchas".');
	return lines;
}

function readMigrationFiles(dir) {
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf-8') }));
}

function main() {
	const asJson = process.argv.slice(2).includes('--json');
	let files;
	try {
		files = readMigrationFiles(MIGRATIONS_DIR);
	} catch (err) {
		console.error(`Could not read migrations dir ${MIGRATIONS_DIR}: ${err.message}`);
		process.exit(2);
	}
	let result;
	try {
		result = buildResult(files);
	} catch (err) {
		console.error(`Could not analyse migrations: ${err.message}`);
		process.exit(2);
	}
	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatReport(result).join('\n'));
	}
	process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
	main();
}

module.exports = {
	stripSqlComments,
	bareName,
	canonicalizeType,
	splitTopLevelArgs,
	parseCreateSignature,
	parseDropSignature,
	signatureString,
	extractFunctionOps,
	analyzeMigrations,
	buildResult,
	formatReport,
	MIGRATIONS_DIR,
};
