#!/usr/bin/env node
'use strict';

/**
 * Git worktree isolation guard (Issue #1822).
 *
 * Enforces worktree isolation across concurrent agent sessions (Gemini, Claude Code,
 * Cursor, terminal):
 * - Compares `git rev-parse --git-dir` against `git rev-parse --git-common-dir` to
 *   determine whether the current working directory is the primary working tree or
 *   an isolated linked git worktree.
 * - Inspects `git worktree list --porcelain` (and optional session lock directories)
 *   to detect when linked worktrees or concurrent session locks exist.
 * - Rejects committing on a non-`dev` branch in the primary working tree when linked
 *   worktrees or concurrent session locks exist, instructing the caller to create an
 *   isolated worktree (`git worktree add .worktrees/<slug> -b <branch> origin/dev`)
 *   or set `ALLOW_PRIMARY_WORKTREE=1` for intentional single-session hotfixes.
 * - Skips automatically in CI (`process.env.CI === 'true'` or `GITHUB_ACTIONS === 'true'`).
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function runGit(args, cwd) {
	try {
		return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

/**
 * Parses `git worktree list --porcelain` output into an array of worktree descriptors.
 * @param {string} porcelainOutput
 * @returns {Array<{ path: string, head: string, branch: string | null, bare: boolean, detached: boolean, prunable: boolean }>}
 */
function parseWorktreeListPorcelain(porcelainOutput) {
	if (!porcelainOutput || !porcelainOutput.trim()) {
		return [];
	}
	const blocks = porcelainOutput.trim().split(/\n\s*\n/);
	const worktrees = [];
	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		const entry = {
			path: '',
			head: '',
			branch: null,
			bare: false,
			detached: false,
			prunable: false,
		};
		for (const line of lines) {
			if (line.startsWith('worktree ')) {
				entry.path = line.slice('worktree '.length).trim();
			} else if (line.startsWith('HEAD ')) {
				entry.head = line.slice('HEAD '.length).trim();
			} else if (line.startsWith('branch ')) {
				entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
			} else if (line === 'bare') {
				entry.bare = true;
			} else if (line === 'detached') {
				entry.detached = true;
			} else if (line.startsWith('prunable')) {
				entry.prunable = true;
			}
		}
		if (entry.path) {
			worktrees.push(entry);
		}
	}
	return worktrees;
}

/**
 * Pure evaluator for worktree isolation.
 *
 * @param {object} state
 * @param {string} state.gitDir - Result of `git rev-parse --git-dir`
 * @param {string} state.gitCommonDir - Result of `git rev-parse --git-common-dir`
 * @param {string} state.branch - Current symbolic branch name (or '' if detached)
 * @param {string} state.worktreePorcelain - Output of `git worktree list --porcelain`
 * @param {boolean} [state.hasSessionLocks=false] - Whether active concurrent session locks exist
 * @param {NodeJS.ProcessEnv} [state.env=process.env] - Environment variables
 * @param {string} [state.cwd=''] - Working directory for path resolution
 * @returns {{ ok: boolean, reason: string, message?: string }}
 */
function evaluateWorktreeIsolation({
	gitDir,
	gitCommonDir,
	branch,
	worktreePorcelain,
	hasSessionLocks = false,
	env = process.env,
	cwd = '',
}) {
	if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') {
		return { ok: true, reason: 'ci-skip' };
	}
	if (env.ALLOW_PRIMARY_WORKTREE === '1' || env.GUARDS_SKIP === '1') {
		return { ok: true, reason: 'env-bypass' };
	}
	if (!gitDir || !gitCommonDir) {
		return { ok: true, reason: 'not-a-git-repo' };
	}

	const resolvedGitDir = cwd ? path.resolve(cwd, gitDir) : path.normalize(gitDir);
	const resolvedCommonDir = cwd ? path.resolve(cwd, gitCommonDir) : path.normalize(gitCommonDir);
	const isLinkedWorktree = resolvedGitDir !== resolvedCommonDir;

	if (isLinkedWorktree) {
		return { ok: true, reason: 'linked-worktree' };
	}

	// Detached HEAD or `dev` / `main` in primary working tree is not a feature-branch violation here
	// (direct commits on `dev`/`main` are already governed by checkProtectedBranch in guards.js).
	if (!branch || branch === 'dev' || branch === 'main') {
		return { ok: true, reason: 'primary-on-default-or-detached' };
	}

	const worktrees = parseWorktreeListPorcelain(worktreePorcelain);
	const activeLinkedWorktrees = worktrees.slice(1).filter((wt) => !wt.prunable);

	if (activeLinkedWorktrees.length === 0 && !hasSessionLocks) {
		return { ok: true, reason: 'single-worktree-no-locks' };
	}

	const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'feature';
	const linkedSummary =
		activeLinkedWorktrees.length > 0
			? `${activeLinkedWorktrees.length} linked worktree(s) active`
			: 'concurrent session lock(s) active';

	const message =
		`worktree-isolation: committing on branch '${branch}' inside the primary working tree is blocked (${linkedSummary}).\n` +
		`  Concurrent agent sessions share the primary checkout if they do not use isolated worktrees.\n` +
		`  Keep the primary checkout on 'dev' and create an isolated worktree for your branch:\n` +
		`    git checkout dev\n` +
		`    git worktree add .worktrees/${slug} -b ${branch} origin/dev\n` +
		`  For an intentional single-session hotfix in the primary checkout, set:\n` +
		`    ALLOW_PRIMARY_WORKTREE=1`;

	return {
		ok: false,
		reason: 'primary-worktree-with-concurrent-sessions',
		message,
	};
}

function detectSessionLocks(cwd) {
	try {
		const lockDir = path.join(cwd, 'sessions', 'locks');
		if (!fs.existsSync(lockDir)) return false;
		const entries = fs.readdirSync(lockDir).filter((f) => !f.startsWith('.'));
		return entries.length > 0;
	} catch {
		return false;
	}
}

function checkWorktreeIsolation({ cwd = process.env.GUARDS_REPO_ROOT || REPO_ROOT, env = process.env } = {}) {
	const gitDir = runGit(['rev-parse', '--git-dir'], cwd);
	const gitCommonDir = runGit(['rev-parse', '--git-common-dir'], cwd);
	const branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
	const worktreePorcelain = runGit(['worktree', 'list', '--porcelain'], cwd);
	const hasSessionLocks = detectSessionLocks(cwd);

	return evaluateWorktreeIsolation({
		gitDir,
		gitCommonDir,
		branch,
		worktreePorcelain,
		hasSessionLocks,
		env,
		cwd,
	});
}

function main() {
	const result = checkWorktreeIsolation();
	if (!result.ok) {
		console.error(result.message);
		return 1;
	}
	return 0;
}

if (require.main === module) {
	process.exit(main());
}

module.exports = {
	parseWorktreeListPorcelain,
	evaluateWorktreeIsolation,
	checkWorktreeIsolation,
};
