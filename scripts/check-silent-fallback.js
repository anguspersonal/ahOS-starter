#!/usr/bin/env node
'use strict';

/**
 * Silent fallback guard (ADR-101 / ADR-102 §3).
 *
 * Prevents silent error swallowing via empty catch blocks (catch {} / catch (_) {})
 * and in-memory mock fallbacks on production paths (inMemory[A-Z]\w* outside __tests__).
 *
 * ADR-102 §3: "No silent fallback: an empty catch {} or an in-memory fallback on a
 * production path must fail a guard." Errors must be surfaced, logged, or propagated,
 * never silently swallowed with fake success.
 *
 * Grandfathered existing offenders from before ADR-102 are listed in GRANDFATHERED_PATHS with TODO(#1321).
 *
 * Usage:
 *   node scripts/check-silent-fallback.js            # PR diff vs merge-base
 *   node scripts/check-silent-fallback.js --staged   # staged changes (pre-commit)
 *   node scripts/check-silent-fallback.js --all      # full scan across all files
 *   node scripts/check-silent-fallback.js --base <ref>
 *   node scripts/check-silent-fallback.js --files <file1,file2>
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { GIT_MAX_BUFFER, rangeGit, resolveBase } = require('./lib/range.js');

const REPO_ROOT = path.resolve(__dirname, '..');

const GRANDFATHERED_PATHS = [
	// TODO(#1321): Engine in-memory lock tracking
	'packages/core/src/engine/main.ts',
	// TODO(#1321): Legacy web action in-memory entity store (removed in #1325)
	'packages/web/src/lib/entityActions.ts',
	// TODO(#1321): Web Gemini helper in-memory storage
	'packages/web/src/lib/gemini.ts',
	// TODO(#1321): Legacy web action in-memory relationship store (removed in #1325)
	'packages/web/src/lib/relationshipActions.ts',
	// TODO(#1321): Inline font/analytics script error handling in index.html
	'packages/web/index.html',
	// TODO(#1321): Worker webhook optional feedback module loader fallback
	'packages/worker/routes/webhooks.js',
];

const EMPTY_CATCH_REGEX = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;
const IN_MEMORY_REGEX = /\binMemory[A-Z]\w*/;

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html']);

function isTestFile(filePath) {
	const normal = filePath.replace(/\\/g, '/');
	return (
		normal.includes('/__tests__/') ||
		normal.includes('__tests__/') ||
		normal.endsWith('.test.ts') ||
		normal.endsWith('.test.tsx') ||
		normal.endsWith('.test.js') ||
		normal.endsWith('.test.mjs') ||
		normal.endsWith('.spec.ts') ||
		normal.endsWith('.spec.js') ||
		normal.includes('/fixtures/') ||
		normal.includes('fixtures/')
	);
}

function runGit(args) {
	try {
		return execFileSync('git', args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			maxBuffer: GIT_MAX_BUFFER,
		}).trim();
	} catch {
		return '';
	}
}

function checkLines(filePath, lines) {
	const normal = filePath.replace(/\\/g, '/');

	if (GRANDFATHERED_PATHS.includes(normal)) {
		return [];
	}

	if (
		normal === 'scripts/check-silent-fallback.js' ||
		normal === 'scripts/check-silent-fallback.test.js'
	) {
		return [];
	}

	const isTest = isTestFile(normal);
	const violations = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (EMPTY_CATCH_REGEX.test(line)) {
			violations.push(
				`${normal}:${i + 1}: empty catch block silently swallows error (ADR-101 / ADR-102 §3).`
			);
		}

		if (!isTest && IN_MEMORY_REGEX.test(line)) {
			const match = line.match(IN_MEMORY_REGEX);
			violations.push(
				`${normal}:${i + 1}: in-memory fallback identifier '${match[0]}' outside __tests__ (ADR-101 / ADR-102 §3).`
			);
		}
	}

	return violations;
}

function checkDiff(diffText) {
	const violations = [];
	if (!diffText) return violations;

	const hunks = diffText.split(/^diff --git /m);

	for (const hunk of hunks) {
		if (!hunk.trim()) continue;

		const fileMatch = hunk.match(/^a\/(.*?)\s+b\/(.*?)$/m);
		if (!fileMatch) continue;

		const filePath = fileMatch[2];
		const normal = filePath.replace(/\\/g, '/');

		if (GRANDFATHERED_PATHS.includes(normal)) continue;
		// Only code can hold a silent fallback; prose that describes the rule
		// (ADRs, guides) must not trip it (#1356).
		if (!CODE_EXTENSIONS.has(path.extname(normal))) continue;
		if (
			normal === 'scripts/check-silent-fallback.js' ||
			normal === 'scripts/check-silent-fallback.test.js'
		) {
			continue;
		}

		const isTest = isTestFile(normal);
		const lines = hunk.split('\n');

		for (const line of lines) {
			// Check added or modified lines only
			if (!line.startsWith('+') || line.startsWith('+++')) continue;
			const codeLine = line.slice(1);

			if (EMPTY_CATCH_REGEX.test(codeLine)) {
				violations.push(
					`${normal}: added empty catch block '${codeLine.trim()}' (ADR-101 / ADR-102 §3).`
				);
			}

			if (!isTest && IN_MEMORY_REGEX.test(codeLine)) {
				const match = codeLine.match(IN_MEMORY_REGEX);
				violations.push(
					`${normal}: added in-memory fallback identifier '${match[0]}' outside __tests__ (ADR-101 / ADR-102 §3).`
				);
			}
		}
	}

	return violations;
}

function findRepoCodeFiles(dir) {
	const results = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === 'node_modules' ||
				entry.name === 'dist' ||
				entry.name === '.git' ||
				entry.name === '.turbo' ||
				entry.name === 'coverage'
			) {
				continue;
			}
			results.push(...findRepoCodeFiles(fullPath));
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			if (CODE_EXTENSIONS.has(ext)) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

function main(argv = process.argv.slice(2)) {
	const violations = [];

	const filesIdx = argv.indexOf('--files');
	if (filesIdx !== -1 && argv[filesIdx + 1]) {
		const files = argv[filesIdx + 1]
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		for (const file of files) {
			const relPath = path.isAbsolute(file) ? path.relative(REPO_ROOT, file) : file;
			const absPath = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
			if (!fs.existsSync(absPath)) continue;
			const content = fs.readFileSync(absPath, 'utf8');
			violations.push(...checkLines(relPath, content.split('\n')));
		}
	} else if (argv.includes('--all')) {
		const packagesDir = path.join(REPO_ROOT, 'packages');
		const filesToScan = fs.existsSync(packagesDir) ? findRepoCodeFiles(packagesDir) : [];

		for (const file of filesToScan) {
			const relPath = path.relative(REPO_ROOT, file);
			const content = fs.readFileSync(file, 'utf8');
			violations.push(...checkLines(relPath, content.split('\n')));
		}
	} else if (argv.includes('--staged')) {
		const diff = runGit(['diff', '--cached', '-U0', '--diff-filter=ACMR']);
		violations.push(...checkDiff(diff));
	} else {
		const base = resolveBase(argv);
		if (!base) {
			const diff = runGit(['diff', '--cached', '-U0', '--diff-filter=ACMR']);
			violations.push(...checkDiff(diff));
		} else {
			const diff = rangeGit(['diff', '-U0', '--diff-filter=ACMR', `${base}..HEAD`], `${base}..HEAD`);
			violations.push(...checkDiff(diff));
		}
	}

	if (violations.length > 0) {
		console.error('silent-fallback: violations found:');
		for (const v of violations) {
			console.error(`  ${v}`);
		}
		return 1;
	}

	return 0;
}

if (require.main === module) {
	process.exit(main());
}

module.exports = {
	checkLines,
	checkDiff,
	isTestFile,
	main,
	GRANDFATHERED_PATHS,
	EMPTY_CATCH_REGEX,
	IN_MEMORY_REGEX,
};
