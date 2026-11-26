#!/usr/bin/env node
'use strict';

/**
 * Build-artifacts & placeholder guard (Fleet Layer 3).
 *
 * Deterministically rejects transient build allowance files (.pnpm.builds.yaml,
 * rogue pnpm-workspace.yaml, temporary lockfiles), compiler scratch (.tsbuildinfo),
 * and unconfigured placeholder strings (such as "set this to true or false",
 * "TODO: placeholder", "YOUR_API_KEY_HERE") from PR diffs and staged commits at
 * $0 LLM spend.
 *
 * Usage:
 *   node scripts/check-build-artifacts.js            # PR diff vs merge-base
 *   node scripts/check-build-artifacts.js --staged   # staged changes (pre-commit)
 *   node scripts/check-build-artifacts.js --base <ref>
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { GIT_MAX_BUFFER, rangeGit, resolveBase } = require('./lib/range.js');

const REPO_ROOT = path.resolve(__dirname, '..');

const BLOCKED_FILE_PATTERNS = [
	{ pattern: /(?:^|\/)\.pnpm(?:\.builds\.yaml|\/|$)/, reason: 'transient pnpm build allowance file' },
	{ pattern: /(?:^|\/)pnpm-workspace\.yaml(?:\.tmp.*)?$/, reason: 'unapproved pnpm-workspace.yaml in npm-workspace monorepo' },
	{ pattern: /(?:^|\/)[^/]+\.pnpm-lock\.yaml\.tmp/, reason: 'temporary pnpm lockfile artifact' },
	{ pattern: /(?:^|\/)\.pytest_cache(?:\/|$)/, reason: 'pytest cache scratch directory' },
	{ pattern: /(?:^|\/)[^/]+\.tsbuildinfo$/, reason: 'TypeScript incremental build cache' },
	{ pattern: /(?:^|\/)\.coverage$/, reason: 'coverage output scratch file' },
	{ pattern: /(?:^|\/)\.DS_Store$/, reason: 'macOS metadata file' },
	{ pattern: /(?:^|\/)Thumbs\.db$/, reason: 'Windows thumbnail cache' },
	{ pattern: /(?:^|\/)package-lock\.json\.tmp/, reason: 'temporary package-lock artifact' },
];

const PLACEHOLDER_PATTERN = /^\+\s*(?:.*set this to true or false|.*TODO:\s*placeholder|.*YOUR_API_KEY_HERE|.*<YOUR_[A-Z0-9_]+>|.*YOUR_[A-Z0-9_]+_HERE)/i;

function isTestPath(filePath) {
	const normal = filePath.replace(/\\/g, '/');
	return (
		normal.includes('__tests__/') ||
		normal.includes('/__tests__/') ||
		normal.includes('/fixtures/') ||
		normal.startsWith('scripts/check-') ||
		normal.includes('/scripts/check-') ||
		normal.endsWith('.test.ts') ||
		normal.endsWith('.test.tsx') ||
		normal.endsWith('.test.js') ||
		normal.endsWith('.spec.ts') ||
		normal.endsWith('.spec.js')
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

function getChangedFilesAndDiff(stagedOnly) {
	if (stagedOnly) {
		const filesOut = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
		const diffOut = runGit(['diff', '--cached', '-U0', '--diff-filter=ACMR']);
		const files = filesOut ? filesOut.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
		return { files, diff: diffOut };
	}

	const base = resolveBase();
	if (!base) {
		// Fallback to staged files if base could not be resolved
		return getChangedFilesAndDiff(true);
	}

	const filesOut = rangeGit(['diff', '--name-only', '--diff-filter=ACMR', `${base}..HEAD`], `${base}..HEAD`);
	const diffOut = rangeGit(['diff', '-U0', '--diff-filter=ACMR', `${base}..HEAD`], `${base}..HEAD`);
	const files = filesOut ? filesOut.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
	return { files, diff: diffOut };
}

function checkArtifactsAndPlaceholders(files, diff) {
	const violations = [];

	// 1. Check file names against blocked patterns
	for (const file of files) {
		if (file.includes('fixtures/')) continue;

		for (const { pattern, reason } of BLOCKED_FILE_PATTERNS) {
			if (pattern.test(file)) {
				violations.push(`${file}: ${reason}`);
				break;
			}
		}
	}

	// 2. Check added lines in diff for unconfigured placeholder strings
	if (diff) {
		let currentFile = '';
		let fileFlagged = false;

		for (const line of diff.split('\n')) {
			if (line.startsWith('diff --git ')) {
				const parts = line.split(' ');
				currentFile = (parts[parts.length - 1] || '').replace(/^b\//, '').replace(/\\/g, '/');
				fileFlagged = false;
				continue;
			}

			if (line.startsWith('+') && !line.startsWith('+++')) {
				if (fileFlagged || !currentFile || isTestPath(currentFile)) {
					continue;
				}

				if (PLACEHOLDER_PATTERN.test(line)) {
					violations.push(`${currentFile}: contains unconfigured placeholder text`);
					fileFlagged = true;
				}
			}
		}
	}

	return violations;
}

function main() {
	const staged = process.argv.includes('--staged');
	const { files, diff } = getChangedFilesAndDiff(staged);

	const violations = checkArtifactsAndPlaceholders(files, diff);

	if (violations.length > 0) {
		console.error('\nFAIL: Unapproved build artifacts or placeholder text detected:');
		for (const v of violations) {
			console.error(`  - ${v}`);
		}
		console.error('\nPlease remove extraneous artifacts or clean placeholder strings before committing.\n');
		process.exit(1);
	}

	console.log(`OK: no unapproved build artifacts or placeholder text found (${files.length} file(s) checked).`);
	process.exit(0);
}

if (require.main === module) {
	main();
}

module.exports = {
	checkArtifactsAndPlaceholders,
	BLOCKED_FILE_PATTERNS,
	PLACEHOLDER_PATTERN,
};
