#!/usr/bin/env node

// Owner-identity seam guard — direct `env.userId` reads, caught in CI (#503).
//
// WHY THIS EXISTS (see ADR-045 / issue #503):
//   ahOS is single-user today but must not seal off multi-tenancy. Every direct
//   `env.userId` read is a hard-coded "the one owner" assumption. There were 116
//   of them when #503 was filed; each one raises the cost of the eventual
//   single-user -> per-request identity swap. #503 converted them all to the
//   single accessor `getCurrentUserId()` (packages/mcp-server/src/identity.ts).
//   This guard is the durable half: without it the seam erodes one convenient
//   direct read at a time, and the count silently grows back.
//
// THE RULE (documented on the accessor itself):
//   Production code never reads `env.userId` directly. It calls
//   `getCurrentUserId()` from the package's identity module. When per-request
//   identity arrives, only the accessor changes.
//
// WHAT THIS SCRIPT DOES (pure static analysis — no imports, no execution):
//   walks every .ts/.tsx file under packages/ and fails (exit 1) if the text
//   `env.userId` — or the raw-literal bypass `process.env.KMS_USER_ID` /
//   `process.env["KMS_USER_ID"]`, which reads the same value without ever
//   touching the typed env object — appears anywhere OUTSIDE the allowlist:
//     - the accessor's own definition file (packages/mcp-server/src/identity.ts)
//     - scripts/http-smoke.ts — the one legitimate raw read: it FORWARDS the
//       var (with a placeholder default) into a spawned child process's env,
//       it never scopes data by it; calling getCurrentUserId() there would
//       throw when KMS_USER_ID is unset and break the script's documented
//       "no real Supabase needed" contract.
//     - test files (__tests__/ directories, *.test.ts, *.spec.ts) — tests may
//       stub or assert on the raw env value.
//   This extends the issue's acceptance grep:
//     grep -rn "env\.userId" packages/ --include=*.ts | grep -v __tests__
//
// Usage:
//   node scripts/check-user-id-reads.js [--json]
//   or: npm run check:user-id-reads          (from the repo root)
//
// Exit codes: 0 = no direct reads outside the allowlist; 1 = violations found;
// 2 = could not run (missing dir, unexpected error).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

// Files allowed to touch the owner id directly. Stored as POSIX-style relative
// paths (comparisons normalise separators).
//   identity.ts   — the accessor definition (the seam itself).
//   http-smoke.ts — child-env forwarding with a placeholder default, not a
//                   data-scoping read (see the header comment above).
//   engine/main.ts — the engine process's composition root (ADR-101, #1306): the
//                   one place it resolves the owner id, handed to cadences as an
//                   explicit `resolveUserIds` port. The engine does not import
//                   mcp-server, so it cannot call getCurrentUserId().
const ALLOWED_FILES = new Set([
	'packages/mcp-server/src/identity.ts',
	'packages/mcp-server/scripts/http-smoke.ts',
	'packages/core/src/engine/main.ts',
]);

// Directories never worth walking.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', '.next', 'coverage']);

// Both the typed read and the raw-literal bypass of it.
const PATTERN = /env\.userId|process\.env(?:\.KMS_USER_ID\b|\[["']KMS_USER_ID["']\])/g;

// Normalise a path to POSIX separators for stable comparisons/reports.
function toPosix(p) {
	return p.split(path.sep).join('/');
}

// Is this repo-relative POSIX path a test file (allowed to touch env.userId)?
function isTestPath(relPosixPath) {
	return (
		relPosixPath.includes('/__tests__/') ||
		/\.(test|spec)\.tsx?$/.test(relPosixPath)
	);
}

// Recursively collect candidate .ts/.tsx files under `dir` (absolute paths).
function collectTsFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...collectTsFiles(path.join(dir, entry.name)));
		} else if (/\.tsx?$/.test(entry.name)) {
			out.push(path.join(dir, entry.name));
		}
	}
	return out;
}

// Scan one file's text; return violations as { line, column, text } entries.
// Every occurrence counts — including comments. A comment that says
// "read env.userId here" is exactly the breadcrumb that erodes the seam, and a
// text-level rule keeps this check byte-for-byte consistent with the
// acceptance grep in #503.
function scanSource(source) {
	const hits = [];
	const lines = source.split('\n');
	for (let i = 0; i < lines.length; i++) {
		let m;
		PATTERN.lastIndex = 0;
		while ((m = PATTERN.exec(lines[i])) !== null) {
			hits.push({ line: i + 1, column: m.index + 1, text: lines[i].trim() });
		}
	}
	return hits;
}

// Analyse a list of { relPath (POSIX), source } entries — the pure core, used
// directly by the unit tests with synthetic fixtures.
function analyzeFiles(files) {
	const violations = [];
	let scanned = 0;
	let skippedAllowed = 0;
	for (const file of files) {
		const rel = toPosix(file.relPath);
		if (ALLOWED_FILES.has(rel) || isTestPath(rel)) {
			skippedAllowed++;
			continue;
		}
		scanned++;
		for (const hit of scanSource(file.source)) {
			violations.push({ file: rel, ...hit });
		}
	}
	return { violations, scanned, skippedAllowed };
}

function buildResult(files) {
	const { violations, scanned, skippedAllowed } = analyzeFiles(files);
	return {
		ok: violations.length === 0,
		filesScanned: scanned,
		filesAllowlisted: skippedAllowed,
		violations,
	};
}

function formatReport(result) {
	const lines = [];
	lines.push('Owner-identity seam guard (env.userId reads)');
	lines.push(
		`Scanned ${result.filesScanned} TypeScript file(s) under packages/ (${result.filesAllowlisted} allowlisted: accessor + tests).`
	);
	if (result.ok) {
		lines.push('OK: no direct env.userId / process.env.KMS_USER_ID reads outside the allowlist.');
		return lines;
	}
	lines.push('');
	lines.push(`FAIL: ${result.violations.length} direct owner-id read(s) outside the allowlist.`);
	lines.push('');
	lines.push('Owner identity has a single read point: getCurrentUserId() in');
	lines.push('packages/mcp-server/src/identity.ts (ADR-045, #503). Direct env.userId');
	lines.push('reads — and raw process.env.KMS_USER_ID reads, which bypass the typed');
	lines.push('env object entirely — re-scatter the "one owner" assumption and raise');
	lines.push('the cost of the eventual per-request identity swap.');
	lines.push('');
	for (const v of result.violations) {
		lines.push(`  * ${v.file}:${v.line}:${v.column}   ${v.text}`);
	}
	lines.push('');
	lines.push('Fix: import { getCurrentUserId } from the package identity module and call');
	lines.push('getCurrentUserId() instead of reading env.userId.');
	return lines;
}

function readPackageFiles(dir) {
	return collectTsFiles(dir).map((abs) => ({
		relPath: toPosix(path.relative(REPO_ROOT, abs)),
		source: fs.readFileSync(abs, 'utf-8'),
	}));
}

function main() {
	const asJson = process.argv.slice(2).includes('--json');
	let files;
	try {
		files = readPackageFiles(PACKAGES_DIR);
	} catch (err) {
		console.error(`Could not read packages dir ${PACKAGES_DIR}: ${err.message}`);
		process.exit(2);
	}
	let result;
	try {
		result = buildResult(files);
	} catch (err) {
		console.error(`Could not analyse files: ${err.message}`);
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
	toPosix,
	isTestPath,
	scanSource,
	analyzeFiles,
	buildResult,
	formatReport,
	readPackageFiles,
	ALLOWED_FILES,
	PACKAGES_DIR,
};
