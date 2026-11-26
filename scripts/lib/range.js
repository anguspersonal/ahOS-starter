'use strict';

// Shared commit-range resolution for the guards extracted from `pr-guards.yml`
// (#919, ADR-071).
//
// Each of those guards asks the same question — *what did this change add on top
// of the integration branch?* — and the answer differs by caller. CI knows the
// merge base and passes it. A git hook has to work it out. Getting that logic
// four times, slightly differently, is the "two behaviours under one name"
// failure #919 exists to avoid, so it lives here once.
//
// The fallback order matters and is deliberate: a runner that cannot resolve a
// range must **under-block, never over-block**, or we are back to the
// `--no-verify` habit ADR-071 §6 warns about.
//
// ---------------------------------------------------------------------------
// #1047: that rule holds for hooks, and held for CI too, which was the bug.
//
// ADR-071 §6 argues for under-blocking because "the failure mode of an
// unskippable local hook is a developer who stops committing". That reasoning is
// about a laptop. The same ADR says "CI remains the copy nobody can skip", and
// CI was silently skipping: a guard that resolves no range reports success, so
// the run went green having checked nothing — strictly worse than having no
// guard, because the signal says "verified". See ADR-071 Erratum 2.
//
// So there are two questions here, not one, and they have different answers:
//
//   1. "Nobody gave me a base, and I cannot work one out."
//      Policy. Lenient by default (hooks), fatal under GUARDS_STRICT=1 (CI).
//
//   2. "Somebody gave me a base and it is unusable."
//      Never policy, always fatal, everywhere. The caller named what it wanted;
//      quietly substituting a guess is the defect. `guards.js` never passes
//      `--base`, so this costs a laptop nothing.
//
// Conflating those two is what let three separate holes through, all live in CI
// until this commit:
//
//   a. `pr-guards.yml` wrote `BASE_SHA=$(git merge-base …)` with `set -euo
//      pipefail` on. `echo` exits 0 with an empty substitution, so a failed
//      merge-base wrote an empty BASE_SHA and passed the step.
//   b. `--base ''` then fell through to the guess path, because `argv[i + 1]`
//      is falsy. On a PR targeting `main` — a release PR — the guess is
//      `origin/dev`: the wrong range, with no signal that it was substituted.
//   c. `git rev-parse --verify` accepts any well-formed 40-hex string without
//      checking the object exists. A bogus sha "verified", the diff then failed,
//      and `allowFail` turned that fatal into `[]` — into "no changes".

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// `GUARDS_REPO_ROOT` is a test seam and nothing else: `range.test.js` needs a
// throwaway repository with no `origin/*` to exercise the no-base path, which
// cannot be staged inside this one. Guards in CI and hooks never set it.
const REPO_ROOT = process.env.GUARDS_REPO_ROOT || path.resolve(__dirname, '..', '..');
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Raised when a range cannot be computed and reporting success would be a lie.
 * Callers do not catch this: the handler below turns it into a clean non-zero
 * exit, so every guard inherits the behaviour without opting in. That is the
 * point — a guard added next year gets it for free.
 */
class GuardRangeError extends Error {
	constructor(message) {
		super(message);
		this.name = 'GuardRangeError';
	}
}

// Registered once, here, rather than in each of the five callers. Someone
// reading a red PR check wants the reason, not a stack trace.
process.on('uncaughtException', (err) => {
	if (err instanceof GuardRangeError) {
		console.error(`guard: cannot determine what this change touched — ${err.message}`);
	} else {
		console.error(err);
	}
	process.exit(1);
});

/**
 * CI sets `GUARDS_STRICT=1`; hooks do not. This is the whole hook/CI split, and
 * it governs only question 1 above — an explicitly-passed base that cannot be
 * used is fatal either way.
 */
function isStrict() {
	return process.env.GUARDS_STRICT === '1';
}

function git(args, { allowFail = false } = {}) {
	try {
		return execFileSync('git', args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			maxBuffer: GIT_MAX_BUFFER,
		}).trim();
	} catch (err) {
		if (allowFail) return '';
		throw err;
	}
}

/** True if `ref` names a commit that actually exists. `^{commit}` is the load-bearing part. */
function commitFor(ref) {
	return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
}

/** `--base <ref>` if given, else the merge base with the integration branch, else null. */
function resolveBase(argv = process.argv.slice(2)) {
	const i = argv.indexOf('--base');
	if (i !== -1) {
		const given = argv[i + 1];
		if (!given) {
			throw new GuardRangeError(
				'`--base` was passed with no value. Something meant to name a base and computed an empty string instead; refusing to guess one.',
			);
		}
		const sha = commitFor(given);
		if (!sha) {
			throw new GuardRangeError(
				`\`--base ${given}\` does not name a commit in this repository. Fetch it first (\`git fetch --no-tags origin <ref>\`) or pass a base that exists; refusing to guess one.`,
			);
		}
		return sha;
	}

	const ref = ['origin/dev', 'origin/main'].find((r) => commitFor(r));
	const base = ref ? git(['merge-base', 'HEAD', ref], { allowFail: true }) : '';
	if (base) return base;

	// Nobody asked for a base and none can be worked out. ADR-071 §6's case.
	if (isStrict()) {
		throw new GuardRangeError(
			'no merge base with `origin/dev` or `origin/main`, so there is no range to check. `GUARDS_STRICT=1`, so this fails rather than passing silently.',
		);
	}
	return null;
}

/**
 * Run a git command that reads a range, without the empty-on-failure behaviour.
 * A base that resolved but will not read is a *broken* range, not an empty one,
 * and `''` here reads downstream as "clean PR" / "no offending commits".
 *
 * Both readers go through this. The empty-on-failure pattern existed in two
 * places — `changedFiles` here and the authorship guard's `git log` — so fixing
 * only the one #1047 happened to name would have left the other one lying.
 */
function rangeGit(args, range) {
	try {
		return git(args);
	} catch {
		throw new GuardRangeError(
			`could not read \`${range}\`. The base resolved but the range did not; refusing to report an empty result.`,
		);
	}
}

/**
 * Files this range adds, copies, modifies or renames into place.
 * `filter` is the git `--diff-filter` string; `pathspec` limits it to a subtree.
 */
function changedFiles(base, { filter = 'ACMR', pathspec = [], argv = process.argv.slice(2) } = {}) {
	if (argv.includes('--staged')) {
		const args = ['diff', '--cached', `--diff-filter=${filter}`, '--name-only'];
		if (pathspec.length) args.push('--', ...pathspec);
		const out = git(args);
		return out ? out.split('\n').filter(Boolean) : [];
	}
	if (!base) return [];
	const args = ['diff', `--diff-filter=${filter}`, '--name-only', `${base}..HEAD`];
	if (pathspec.length) args.push('--', ...pathspec);
	const out = rangeGit(args, `${base}..HEAD`);
	return out ? out.split('\n').filter(Boolean) : [];
}

module.exports = {
	REPO_ROOT,
	GIT_MAX_BUFFER,
	git,
	rangeGit,
	resolveBase,
	changedFiles,
	isStrict,
	GuardRangeError,
};
