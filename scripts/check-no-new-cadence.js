#!/usr/bin/env node
'use strict';

/**
 * No new cadence guard (ADR-101 / ADR-102 §3).
 *
 * Prevents scheduling or long-running cadence jobs from landing in
 * packages/mcp-server or packages/worker.
 *
 * ADR-101 and ADR-102 reserve recurring engine loops and background cadences
 * exclusively for packages/core/src/engine/. Long-running jobs and LLM-batch
 * processes must be hosted in the core engine runner on worker, never added to
 * packages/mcp-server/src/schedule/ or packages/worker/src/schedule/.
 *
 * Usage:
 *   node scripts/check-no-new-cadence.js            # PR diff vs merge-base
 *   node scripts/check-no-new-cadence.js --staged   # staged additions (pre-commit)
 *   node scripts/check-no-new-cadence.js --base <ref>
 *   node scripts/check-no-new-cadence.js --files <file1,file2> # direct check
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { rangeGit, resolveBase } = require('./lib/range.js');

const REPO_ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_SCHEDULE_PREFIXES = [
	'packages/mcp-server/src/schedule/',
	'packages/worker/src/schedule/',
];

function runGit(args) {
	try {
		return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

function getAddedFiles(argv = process.argv.slice(2)) {
	const filesIdx = argv.indexOf('--files');
	if (filesIdx !== -1 && argv[filesIdx + 1]) {
		return argv[filesIdx + 1]
			.split(',')
			.map((s) => s.trim().replace(/\\/g, '/'))
			.filter(Boolean);
	}

	if (argv.includes('--staged')) {
		const out = runGit(['diff', '--cached', '--name-only', '--diff-filter=A']);
		return out ? out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
	}

	const base = resolveBase(argv);
	if (!base) {
		const out = runGit(['diff', '--cached', '--name-only', '--diff-filter=A']);
		return out ? out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
	}

	const out = rangeGit(['diff', '--name-only', '--diff-filter=A', `${base}..HEAD`], `${base}..HEAD`);
	return out ? out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
}

function checkNoNewCadence(addedFiles) {
	const violations = [];
	for (const file of addedFiles) {
		const normalized = file.replace(/\\/g, '/');
		for (const prefix of FORBIDDEN_SCHEDULE_PREFIXES) {
			if (normalized.startsWith(prefix)) {
				violations.push(
					`error: added file "${normalized}" under legacy schedule directory. Recurring cadence and background loops belong in packages/core/src/engine/ (ADR-101 / ADR-102 §3).`
				);
				break;
			}
		}
	}
	return violations;
}

function main(argv = process.argv.slice(2)) {
	const addedFiles = getAddedFiles(argv);
	const violations = checkNoNewCadence(addedFiles);

	if (violations.length > 0) {
		console.error('no-new-cadence: violations found:');
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
	checkNoNewCadence,
	getAddedFiles,
	main,
	FORBIDDEN_SCHEDULE_PREFIXES,
};
