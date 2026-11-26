#!/usr/bin/env node
'use strict';

/**
 * Architecture Drift & ADR Linkage Guard (Issue #1302, ADR-039 §2, ADR-043).
 *
 * Enforces three critical invariants across ahOS to keep physical architecture,
 * canonical documentation, and frontend visual representations in lockstep:
 *
 * 1. Architecture Staleness (ADR-039 §2):
 *    If a PR modifies physical architecture surface files (e.g., package roots in
 *    packages/*, root services in railway.json/Dockerfile, Supabase Edge Functions),
 *    docs/architecture/architecture.md must be updated in the same PR.
 *    Escape hatch: '-- ALLOW-ARCH-DRIFT: <reason>' or '-- NO-ARCH-UPDATE'.
 *
 * 2. ADR Linkage Enforcement (ADR-043):
 *    If docs/architecture/architecture.md is modified, the PR must add or update an
 *    ADR in docs/ADRs/ or cite an accepted ADR (e.g. ADR-100) in the diff/commit message.
 *    Escape hatch: '-- NO-ADR-REQUIRED: <reason>'.
 *
 * 3. Visual Meaning Synchronization:
 *    If docs/architecture/architecture.md alters Mermaid architectural diagrams or
 *    topologies, the visualizer views in packages/web/src/components/visual-meaning/
 *    must be updated in the same PR so the web application never lags behind the SSOT.
 *    Escape hatch: '-- NO-VISUAL-UPDATE: <reason>'.
 *
 * Usage:
 *   node scripts/check-architecture-drift.js            # PR diff vs merge-base
 *   node scripts/check-architecture-drift.js --staged   # staged changes (pre-commit)
 *   node scripts/check-architecture-drift.js --base <ref>
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { GIT_MAX_BUFFER, rangeGit, resolveBase } = require('./lib/range.js');

const REPO_ROOT = path.resolve(__dirname, '..');

const STRUCTURAL_FILE_PATTERNS = [
	{ pattern: /^\.railway\/railway\.(?:ts|py|go)$/, reason: 'Railway IaC platform topology' },
	{ pattern: /^railway\.(?:json|toml)$/, reason: 'root Railway platform topology' },
	{ pattern: /(?:^|\/)Dockerfile(?:\.[a-zA-Z0-9_-]+)?$/, reason: 'container deployment definition' },
	{ pattern: /^docker-compose(?:\.[a-zA-Z0-9_-]+)?\.ya?ml$/, reason: 'local compose topology' },
	{ pattern: /^supabase\/config\.toml$/, reason: 'Supabase platform configuration' },
	{ pattern: /^supabase\/functions\/[^/]+\/index\.ts$/, reason: 'Supabase Edge Function endpoint' },
];

const ARCHITECTURE_DOC_PATH = 'docs/architecture/architecture.md';
const VISUAL_MEANING_DIR_PREFIX = 'packages/web/src/components/visual-meaning/';
const ADR_DIR_PREFIX = 'docs/ADRs/';

const ESCAPE_ALLOW_ARCH_DRIFT = /--\s*(?:ALLOW-ARCH-DRIFT|NO-ARCH-UPDATE)/i;
const ESCAPE_NO_ADR_REQUIRED = /--\s*NO-ADR-REQUIRED/i;
const ESCAPE_NO_VISUAL_UPDATE = /--\s*NO-VISUAL-UPDATE/i;

const ADR_CITATION_PATTERN = /(?:ADR[-_ ]?\d{3}|\[ADR[-_ ]?\d{3}\])/i;
const MERMAID_BLOCK_PATTERN = /```mermaid[\s\S]*?```/g;

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
		const filesOut = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']);
		const diffOut = runGit(['diff', '--cached', '-U0', '--diff-filter=ACMRD']);
		const files = filesOut ? filesOut.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
		return { files, diff: diffOut, commitMsg: '' };
	}

	const base = resolveBase();
	if (!base) {
		return getChangedFilesAndDiff(true);
	}

	const filesOut = rangeGit(['diff', '--name-only', '--diff-filter=ACMRD', `${base}..HEAD`], `${base}..HEAD`);
	const diffOut = rangeGit(['diff', '-U0', '--diff-filter=ACMRD', `${base}..HEAD`], `${base}..HEAD`);
	const commitMsgOut = runGit(['log', '--format=%B', `${base}..HEAD`]);
	const files = filesOut ? filesOut.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
	return { files, diff: diffOut, commitMsg: commitMsgOut };
}

function getFileDiffChunk(diff, filePath) {
	if (!diff) return '';
	const chunks = diff.split(/^diff --git /m);
	for (const chunk of chunks) {
		if (!chunk) continue;
		const firstLine = chunk.split('\n', 1)[0];
		if (firstLine.includes(`a/${filePath} `) || firstLine.endsWith(`b/${filePath}`)) {
			return chunk;
		}
	}
	return '';
}

function isRootWorkspacesModified(chunk) {
	if (!chunk) return false;
	const lines = chunk.split('\n');
	let inWorkspacesArray = false;
	for (const line of lines) {
		if (/^@@\s/.test(line)) {
			inWorkspacesArray = /"workspaces"\s*:/.test(line);
			continue;
		}
		if (/^(?:diff --git|index |--- |\+\+\+ )/.test(line)) {
			inWorkspacesArray = false;
			continue;
		}
		const isChangedLine = /^[+-](?![+-]{2})/.test(line);
		const isContextLine = line.startsWith(' ');
		if (!isChangedLine && !isContextLine) continue;

		if (/^[ +-]\s*"workspaces"\s*:/.test(line)) {
			if (isChangedLine) return true;
			inWorkspacesArray = /\[/.test(line) && !/\]/.test(line);
			continue;
		}

		if (inWorkspacesArray) {
			if (/^[ +-]\s*\]/.test(line)) {
				inWorkspacesArray = false;
				if (isChangedLine) return true;
				continue;
			}
			if (isChangedLine) return true;
		}

		if (isChangedLine && /^[+-]\s*"[^"]+"\s*,?\s*$/.test(line)) {
			return true;
		}
	}
	return false;
}

function isPackageManifestTopologyChange(chunk) {
	if (!chunk) return false;
	if (/^(?:new|deleted) file mode /m.test(chunk)) return true;
	if (/^rename (?:from|to) /m.test(chunk)) return true;
	if (/^--- \/dev\/null$/m.test(chunk) || /^\+\+\+ \/dev\/null$/m.test(chunk)) return true;
	const changedLines = chunk
		.split('\n')
		.filter((line) => /^[+-](?![+-]{2})/.test(line));
	return changedLines.some((line) => /^[+-]\s*"name"\s*:/.test(line));
}

function isPackageStructuralChange(files, diff = '') {
	for (const file of files) {
		if (file === 'package.json') {
			const chunk = getFileDiffChunk(diff, file);
			if (isRootWorkspacesModified(chunk)) {
				return true;
			}
		}
		const match = file.match(/^packages\/([^/]+)\/package\.json$/);
		if (match) {
			const chunk = getFileDiffChunk(diff, file);
			if (isPackageManifestTopologyChange(chunk)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Pure check function evaluating changed files, diff, and commit messages against
 * architectural drift invariants.
 */
function checkArchitectureDrift(files, diff = '', commitMsg = '') {
	const violations = [];
	const combinedContext = `${diff}\n${commitMsg}`;

	const normalizedFiles = files.map((f) => f.replace(/\\/g, '/'));
	const hasArchDocChange = normalizedFiles.includes(ARCHITECTURE_DOC_PATH);
	const hasAdrChange = normalizedFiles.some((f) => f.startsWith(ADR_DIR_PREFIX) && f.endsWith('.md'));
	const hasVisualMeaningChange = normalizedFiles.some((f) => f.startsWith(VISUAL_MEANING_DIR_PREFIX));

	// 1. Identify structural physical changes
	const structuralChanges = [];
	for (const file of normalizedFiles) {
		for (const { pattern, reason } of STRUCTURAL_FILE_PATTERNS) {
			if (pattern.test(file)) {
				structuralChanges.push(`${file} (${reason})`);
				break;
			}
		}
	}

	if (isPackageStructuralChange(normalizedFiles, diff)) {
		structuralChanges.push('packages/* package manifest or workspace topology');
	}

	// Invariant 1: Structural changes must update architecture.md (ADR-039 §2)
	if (structuralChanges.length > 0 && !hasArchDocChange) {
		if (!ESCAPE_ALLOW_ARCH_DRIFT.test(combinedContext)) {
			violations.push(
				`Structural architecture files changed without updating ${ARCHITECTURE_DOC_PATH} (ADR-039 §2):\n` +
				`  Changed: ${structuralChanges.join(', ')}\n` +
				`  Fix: Update ${ARCHITECTURE_DOC_PATH} in the same PR, or include '-- ALLOW-ARCH-DRIFT: <reason>' if non-structural.`
			);
		}
	}

	// Invariants 2 & 3: Changes to architecture.md
	if (hasArchDocChange) {
		// Invariant 2: ADR Linkage (ADR-043)
		const hasAdrCitation = ADR_CITATION_PATTERN.test(combinedContext);
		if (!hasAdrChange && !hasAdrCitation) {
			if (!ESCAPE_NO_ADR_REQUIRED.test(combinedContext)) {
				violations.push(
					`Changes to ${ARCHITECTURE_DOC_PATH} require an associated ADR or accepted ADR citation (ADR-043):\n` +
					`  Fix: Add/update an ADR in docs/ADRs/, cite an accepted ADR (e.g. ADR-100), or include '-- NO-ADR-REQUIRED: <reason>'.`
				);
			}
		}

		// Invariant 3: Visual Meaning Synchronization
		// Check if architecture.md diff touches Mermaid diagrams or component topologies
		// Filter to added/removed lines only so `@@ ... @@ ### Runtime Services` hunk headers do not false-positive (#1798).
		const archDiffChunk = diff
			.split('diff --git ')
			.find((chunk) => chunk.includes(`b/${ARCHITECTURE_DOC_PATH}`));
		const archChangedLines = archDiffChunk
			? archDiffChunk
					.split('\n')
					.filter((line) => /^[+-](?![+-]{2})/.test(line))
					.join('\n')
			: '';

		const hasMermaidOrTopologyDiff = Boolean(
			archChangedLines && (
				archChangedLines.includes('```mermaid') ||
				archChangedLines.includes('flowchart') ||
				archChangedLines.includes('graph TD') ||
				archChangedLines.includes('graph TB') ||
				archChangedLines.includes('### Component Boundaries') ||
				archChangedLines.includes('### Runtime Services')
			)
		);

		if (hasMermaidOrTopologyDiff && !hasVisualMeaningChange) {
			if (!ESCAPE_NO_VISUAL_UPDATE.test(combinedContext)) {
				violations.push(
					`Mermaid diagrams or component topologies in ${ARCHITECTURE_DOC_PATH} were modified without updating Visual Meaning views:\n` +
					`  Fix: Update view definitions in ${VISUAL_MEANING_DIR_PREFIX} to align with SSOT, or include '-- NO-VISUAL-UPDATE: <reason>'.`
				);
			}
		}
	}

	return violations;
}

function main() {
	const staged = process.argv.includes('--staged');
	const { files, diff, commitMsg } = getChangedFilesAndDiff(staged);

	const violations = checkArchitectureDrift(files, diff, commitMsg);

	if (violations.length > 0) {
		console.error('\nFAIL: Architectural drift or ADR linkage violation detected:');
		for (const v of violations) {
			console.error(`\n- ${v}`);
		}
		console.error('\nArchitecture SSOT guard failed. Please resolve the alignment issues above.\n');
		process.exit(1);
	}

	console.log('OK: Architecture SSOT, ADR linkage, and Visual Meaning synchronization verified.');
}

if (require.main === module) {
	main();
}

module.exports = {
	checkArchitectureDrift,
	STRUCTURAL_FILE_PATTERNS,
	ARCHITECTURE_DOC_PATH,
	VISUAL_MEANING_DIR_PREFIX,
};
