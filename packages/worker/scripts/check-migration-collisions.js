#!/usr/bin/env node

// Cross-branch migration collision guard — the union `check-migration-versions.js`
// cannot see (#1049).
//
// WHY THIS EXISTS:
//   `check-migration-versions.js` scans one checked-out tree: base's migrations
//   plus this PR's. It catches two files colliding WITHIN that tree, but three
//   PRs authored in the same minute — #1041, #1039, #1042, all
//   `20260912120000_*` — each pass it in isolation, because on any one branch
//   the prefix IS unique. The collision exists only in the UNION of every open
//   PR, which no single PR's checkout ever contains. `db push` would have died
//   with `duplicate key value violates unique constraint
//   "schema_migrations_pkey"` the moment the second of the three merged; three
//   separate human QA reviews caught it by hand instead (#1049).
//
// WHAT THIS SCRIPT DOES:
//   1. Works out which migration files THIS branch adds, relative to its merge
//      base (same `--base` flag and fallback chain as `check-migration-comments.js`,
//      via `scripts/lib/range.js`) — no network for this half.
//   2. If that set is empty, or no GitHub token is available, it prints why and
//      exits 0. A branch with no new migration has nothing to collide on; a
//      guard with no way to see sibling PRs must under-block, never over-block
//      (`range.js`'s rule, applied here to a capability rather than a range).
//   3. Otherwise it lists every OPEN pull request targeting `--target-base`
//      (default `dev`) and, for each one (skipping this PR itself), reads which
//      migration files IT adds.
//   4. Any two ADDED files — one from this branch, one from another open PR —
//      that share a 14-digit version or a `_NNN_` sequence is a violation,
//      reported with BOTH PR numbers so either side can fix it.
//
// WHY "ADDED OR RENAMED" FILES ONLY, NEVER A DIRECTORY SCAN:
//   `check-migration-versions.js` grandfathers six pre-existing `_NNN_`
//   collisions already on `dev` because they are real, harmless, and permanent.
//   This guard never needs that list: it only ever compares files with GitHub's
//   `added` or `renamed` status in an OPEN PR's diff, so a legacy pair already
//   merged to `dev` never appears as "added"/"renamed" in anything and can never
//   be flagged here. The two guards' grandfathering needs are structurally
//   different, not independently reinvented.
//
//   RENAMED is included, not just ADDED, because this guard's own suggested
//   remedy — "give ITS file a new, later timestamp" — is applied in practice via
//   `git mv old_ts_*.sql new_ts_*.sql`, which GitHub reports as `status:
//   "renamed"`, not `"added"`. An added-only filter would make that exact
//   remedy invisible to the next run: rename a migration into a colliding
//   timestamp and the guard would silently stop seeing it, on both the local
//   and the foreign side. Treating the new filename as the candidate (matching
//   its post-rename version/sequence) closes that gap.
//
// WHY THIS NEEDS NO DATABASE CREDENTIAL:
//   Same posture as `check-migration-versions.js` — filename comparison only,
//   this time across the GitHub REST API instead of the checked-out tree.
//   `${{ secrets.GITHUB_TOKEN }}` (repo-scoped, already granted `pull-requests:
//   read` by `pr-guards.yml`) is enough; no PAT, no `SUPABASE_DB_URL`.
//
// Usage:
//   GITHUB_TOKEN=... node packages/worker/scripts/check-migration-collisions.js \
//     [--base <ref>] [--target-base dev] [--repo owner/name] [--pr <number>] [--json]
//   or: npm run check:migration-collisions      (from the repo root)
//
// Exit codes: 0 = no cross-PR collision (or the check could not apply and said
// so); 1 = a collision was found; 2 = could not run (network/API failure).

'use strict';

const { resolveBase, changedFiles } = require('../../../scripts/lib/range.js');

const MIGRATIONS_DIR_REL = 'supabase/migrations';
const MIGRATION_FILENAME = /^(\d{14})_(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const SQL_UNDER_MIGRATIONS = new RegExp(`^${MIGRATIONS_DIR_REL}/`);

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 20; // matches scripts/check-issue-labels.js's cap — loud, not silent, if exceeded.

/**
 * Parse one migration path (as git or the GitHub API gives it, forward-slashed
 * and rooted at the repo). Returns `{ filename, version, sequence }` for a
 * well-formed `supabase/migrations/<ts>_<NNN>_<slug>.sql` path, else `null`.
 *
 * Deliberately narrower than `check-migration-versions.js`'s
 * `parseMigrationFilename`: a malformed name (no version, no sequence) has
 * nothing for THIS guard to compare, and reporting that malformation is
 * `check-migration-versions.js`'s job, not a second copy of it here.
 */
function parseMigrationPath(filepath) {
	if (!SQL_UNDER_MIGRATIONS.test(filepath)) return null;
	const filename = filepath.slice(MIGRATIONS_DIR_REL.length + 1);
	const match = MIGRATION_FILENAME.exec(filename);
	if (match === null) return null;
	return { filename, version: match[1], sequence: match[2] };
}

/**
 * This branch's newly ADDED migration files, relative to `base`. Pure given a
 * `changedFilesFn` seam so tests never touch git.
 */
function localAddedMigrations(base, changedFilesFn = changedFiles) {
	// 'AR' = added or renamed — see "WHY ADDED OR RENAMED FILES ONLY" above.
	const added = changedFilesFn(base, { filter: 'AR', pathspec: [MIGRATIONS_DIR_REL] });
	return added.map(parseMigrationPath).filter((entry) => entry !== null);
}

/**
 * Every collision between `localFiles` (this branch) and `foreignFiles` (one
 * added-migration list per other open PR, each entry carrying its `prNumber`).
 * Pure — no I/O, so this is what the unit tests drive directly.
 *
 * A pair sharing BOTH the version and the sequence produces two violations
 * (nothing hides the sequence collision because the version already failed);
 * that mirrors `check-migration-versions.js` reporting duplicate-version and
 * duplicate-sequence as separate violation kinds.
 */
function findCollisions(localFiles, foreignFiles) {
	const violations = [];
	for (const local of localFiles) {
		for (const foreign of foreignFiles) {
			if (local.version === foreign.version) {
				violations.push({
					kind: 'version',
					key: local.version,
					localFile: local.filename,
					foreignFile: foreign.filename,
					foreignPr: foreign.prNumber,
				});
			}
			if (local.sequence === foreign.sequence) {
				violations.push({
					kind: 'sequence',
					key: local.sequence,
					localFile: local.filename,
					foreignFile: foreign.filename,
					foreignPr: foreign.prNumber,
				});
			}
		}
	}
	return violations;
}

/** One human-readable block per violation. Pure. */
function describeViolation(violation, { selfPr }) {
	const self = selfPr ? `this PR (#${selfPr})` : 'this branch';
	if (violation.kind === 'version') {
		return [
			`COLLISION: version ${violation.key} is claimed by two OPEN pull requests:`,
			`    ${self}: ${MIGRATIONS_DIR_REL}/${violation.localFile}`,
			`    PR #${violation.foreignPr}: ${MIGRATIONS_DIR_REL}/${violation.foreignFile}`,
			'  Both stamp the same supabase_migrations.version. Neither PR could see this',
			'  alone — the collision exists only in the union of open PRs. Whichever PR',
			'  merges second, give ITS file a new, later timestamp before merging.',
		];
	}
	return [
		`COLLISION: sequence ${violation.key} is claimed by two OPEN pull requests:`,
		`    ${self}: ${MIGRATIONS_DIR_REL}/${violation.localFile}`,
		`    PR #${violation.foreignPr}: ${MIGRATIONS_DIR_REL}/${violation.foreignFile}`,
		'  Both branches minted "the next" migration off the same tip. Renumber',
		'  whichever PR merges second to the next free sequence.',
	];
}

function formatReport(violations, { selfPr, checked }) {
	const lines = ['Cross-PR migration collision guard'];
	if (violations.length === 0) {
		lines.push(
			`  OK: this branch's new migration(s) collide with none of ${checked} other open PR(s) targeting dev.`
		);
	} else {
		for (const violation of violations) {
			for (const line of describeViolation(violation, { selfPr })) lines.push(`  ${line}`);
		}
		lines.push('');
		lines.push(
			'Fix before merging — see supabase/README.md "Migration authoring gotchas" and docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md.'
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// GitHub REST API (the only I/O below this line)
// ---------------------------------------------------------------------------

async function githubJson(url, token) {
	const res = await fetch(url, {
		headers: {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			Authorization: `Bearer ${token}`,
		},
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} ${res.statusText} on ${url}`);
	}
	return res.json();
}

/** Every OPEN pull request targeting `targetBase`, paginated. */
async function fetchOpenPullRequests({ repo, token, targetBase, fetchJson = githubJson }) {
	const pulls = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = `${GITHUB_API}/repos/${repo}/pulls?state=open&base=${targetBase}&per_page=${PER_PAGE}&page=${page}`;
		const batch = await fetchJson(url, token);
		pulls.push(...batch);
		if (batch.length < PER_PAGE) return pulls;
	}
	throw new Error(`More than ${MAX_PAGES} pages of open PRs against ${targetBase}; raise the cap deliberately.`);
}

/** Migration files a given PR ADDS (GitHub `status: "added"`), paginated. */
async function fetchAddedMigrations({ repo, token, prNumber, fetchJson = githubJson }) {
	const files = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files?per_page=${PER_PAGE}&page=${page}`;
		const batch = await fetchJson(url, token);
		files.push(...batch);
		if (batch.length < PER_PAGE) break;
		if (page === MAX_PAGES) {
			throw new Error(`More than ${MAX_PAGES} pages of files on PR #${prNumber}; raise the cap deliberately.`);
		}
	}
	// 'added' or 'renamed' — see "WHY ADDED OR RENAMED FILES ONLY" above. A
	// renamed file's `.filename` is GitHub's post-rename path, which is exactly
	// the candidate this guard needs to compare.
	return files
		.filter((file) => file.status === 'added' || file.status === 'renamed')
		.map((file) => parseMigrationPath(file.filename))
		.filter((entry) => entry !== null)
		.map((entry) => ({ ...entry, prNumber }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(argv, flag) {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

/**
 * This branch's own PR, filtered out of the sibling-PR list. Pure: no network,
 * no `main()` — a bug here makes the guard collide with itself on every
 * migration PR, so it gets its own tests rather than living only inside the
 * untestable body of `main()`.
 */
function excludeSelf(pulls, selfPr) {
	return pulls.filter((pr) => String(pr.number) !== String(selfPr));
}

/**
 * `main()`'s entire decision tree, minus the I/O side effects (`console.*`,
 * `process.exit`). Returns `{ exitCode, lines, isError }` so every branch —
 * the base-resolution failure, the no-local-migrations skip, the no-token
 * skip, the two API-failure paths, and the happy path — is a plain async call
 * with injectable fakes, exercised directly by the unit tests instead of only
 * by hand.
 *
 * `main()` below is the only caller that touches `process.env`/`process.exit`;
 * everything it can inject (the token, the repo, the network functions) is a
 * parameter here instead.
 */
async function runCheck({
	argv,
	repo,
	targetBase,
	selfPr,
	token,
	resolveBaseFn = resolveBase,
	localAddedMigrationsFn = localAddedMigrations,
	fetchOpenPullRequestsFn = fetchOpenPullRequests,
	fetchAddedMigrationsFn = fetchAddedMigrations,
	isGithubActions = false,
}) {
	const asJson = argv.includes('--json');

	let base;
	try {
		base = resolveBaseFn(argv);
	} catch (err) {
		return { exitCode: 1, lines: [`check-migration-collisions: ${err.message}`], isError: true };
	}

	let localFiles;
	try {
		localFiles = base ? localAddedMigrationsFn(base) : [];
	} catch (err) {
		return { exitCode: 2, lines: [`check-migration-collisions failed to run: ${err.message}`], isError: true };
	}

	if (localFiles.length === 0) {
		return {
			exitCode: 0,
			lines: [
				'Cross-PR migration collision guard',
				'  SKIP: this branch adds no supabase/migrations/*.sql file; nothing to collide on.',
			],
		};
	}

	if (!token) {
		return {
			exitCode: 0,
			lines: [
				'Cross-PR migration collision guard',
				`  SKIP: no GITHUB_TOKEN / GH_TOKEN set, so open PRs cannot be listed. This branch adds ${localFiles.length} migration file(s) that were NOT checked against sibling PRs — under-block, never a false pass reported as a full check.`,
			],
		};
	}

	let pulls;
	try {
		pulls = await fetchOpenPullRequestsFn({ repo, token, targetBase });
	} catch (err) {
		return {
			exitCode: 2,
			lines: [`check-migration-collisions: could not list open PRs — ${err.message}`],
			isError: true,
		};
	}

	const others = excludeSelf(pulls, selfPr);

	let foreignFiles;
	try {
		const perPr = await Promise.all(
			others.map((pr) => fetchAddedMigrationsFn({ repo, token, prNumber: pr.number }))
		);
		foreignFiles = perPr.flat();
	} catch (err) {
		return {
			exitCode: 2,
			lines: [`check-migration-collisions: could not read PR files — ${err.message}`],
			isError: true,
		};
	}

	const violations = findCollisions(localFiles, foreignFiles);
	const report = formatReport(violations, { selfPr, checked: others.length });

	const lines = [
		asJson
			? JSON.stringify({ ok: violations.length === 0, checked: others.length, violations }, null, 2)
			: report.join('\n'),
	];

	if (violations.length > 0 && isGithubActions) {
		for (const violation of violations) {
			lines.push(
				`::error file=${MIGRATIONS_DIR_REL}/${violation.localFile}::collides with PR #${violation.foreignPr}'s ${MIGRATIONS_DIR_REL}/${violation.foreignFile} on ${violation.kind} ${violation.key}`
			);
		}
	}

	return { exitCode: violations.length === 0 ? 0 : 1, lines };
}

async function main() {
	const argv = process.argv.slice(2);
	const result = await runCheck({
		argv,
		repo: argValue(argv, '--repo') || process.env.GITHUB_REPOSITORY || 'anguspersonal/ahOS',
		targetBase: argValue(argv, '--target-base') || 'dev',
		selfPr: argValue(argv, '--pr') || process.env.PR_NUMBER || process.env.GH_PR_NUMBER || null,
		token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
		isGithubActions: process.env.GITHUB_ACTIONS === 'true',
	});

	for (const line of result.lines) {
		if (result.isError) console.error(line);
		else console.log(line);
	}

	process.exit(result.exitCode);
}

if (require.main === module) {
	main();
}

module.exports = {
	parseMigrationPath,
	localAddedMigrations,
	findCollisions,
	describeViolation,
	formatReport,
	excludeSelf,
	runCheck,
	fetchOpenPullRequests,
	fetchAddedMigrations,
	MIGRATIONS_DIR_REL,
};
