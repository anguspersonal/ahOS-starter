'use strict';

/**
 * Local guard runner — the guards, without GitHub Actions (#862, ADR-065, ADR-071).
 *
 * WHY THIS EXISTS:
 *   Every guard in this repo runs in one place: `pr-guards.yml`. Actions quota is
 *   metered and runs out, and when it does the guards do not degrade, they simply
 *   stop, silently, with a green-looking repo. That is not hypothetical. On the day
 *   this was written, `check-migration-versions.js` had been failing on `dev` since
 *   25 August (sequence 097 claimed by two merged files) and nothing had said so,
 *   and two ADRs sat on `dev` reading `Proposed` for the same reason.
 *
 *   So the guards get a second execution path that costs nothing and needs no
 *   network: git hooks, wired up by `npm install` (see `prepare` in package.json).
 *   CI remains the backstop that cannot be skipped; this is the one that actually
 *   runs most weeks.
 *
 * THE RULE THAT MAKES IT SURVIVABLE:
 *   A hook that blocks your commit over somebody else's merged mistake gets
 *   `--no-verify` the second time it fires, and then it protects nothing. So this
 *   runner blocks only on guards whose INPUTS YOUR CHANGE TOUCHED, and reports the
 *   rest without blocking — the same rule the ADR link guard already states in
 *   `pr-guards.yml`: "pre-existing breakage elsewhere is not this PR's problem".
 *
 *   Pre-existing breakage is still printed, every push. Visible and not in your way
 *   beats blocking and disabled.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   It does not run the unit tests, typecheck, or lint. Those are `turbo` tasks over
 *   a monorepo and belong to a deliberate `npm test`, not to every commit.
 *
 *   It does not duplicate the guards written as inline bash inside `pr-guards.yml`
 *   (the ADR link, ADR number, docs index and authorship guards). Those have no
 *   script file to call, and re-implementing them here would create two behaviours
 *   under one name. #919 tracks extracting them so both paths share one
 *   implementation. Until then this runner covers the script-backed guards only,
 *   which is a real gap, stated rather than hidden.
 *
 * REPORT-ONLY GUARDS:
 *   A guard marked `report: true` runs and prints but never sets the exit code. That
 *   is for checks whose subject is not the change in front of you — the apex-doc
 *   watermark measures whether anyone has reviewed a document lately, and failing
 *   your push over that is the "punishes whoever happens to push next" case its own
 *   header refuses. Shipping it as blocking was a mistake in the first cut of this
 *   file, and it took about an hour to bite: a one-line ADR stamp was refused because
 *   the gap had reached the threshold on a document the commit did not touch.
 *
 * CLI:
 *   node scripts/guards.js --staged        guards for staged files      (pre-commit)
 *   node scripts/guards.js --push          the above + a full sweep     (pre-push)
 *   node scripts/guards.js --all           every guard, all blocking    (by hand)
 *   node scripts/guards.js --list          the manifest, and nothing else
 *
 * ENV:
 *   ALLOW_DEV_COMMIT=1 bypass the protected-branch check (dev, main) in --staged mode (#1761)
 *   GUARDS_SKIP=1   skip entirely, for a deliberate WIP commit. `git commit
 *                   --no-verify` does the same thing; this exists so a script can
 *                   opt out without also disabling every other hook.
 *   AHOS_GUARDS_SKIP_SUBCHECKS=1 test seam: run branch/manifest/mode dispatch without
 *                   spawning child guard processes (#1761).
 */

const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// `GUARDS_REPO_ROOT` is a test seam: guards.test.js needs a throwaway
// repository to verify branch checks and range computation (#1047, #1761).
const TARGET_DIR =
	process.env.GUARDS_REPO_ROOT ||
	(fs.existsSync(path.join(process.cwd(), '.git')) ? process.cwd() : REPO_ROOT);

/**
 * `paths` are prefix-or-suffix tests against repo-relative paths, not globs: a
 * trailing `/` means "anything under here", a leading `.` means "any file with this
 * extension", anything else is an exact path. No dependency, and the manifest stays
 * readable, which matters more here than expressiveness.
 */
const GUARDS = [
	{
		id: 'adr-index-status',
		cmd: ['node', '.github/scripts/check-adr-index-status.js'],
		paths: ['docs/ADRs/'],
		why: 'an ADR index row disagreeing with the file it links to',
	},
	{
		id: 'apex-watermark',
		cmd: ['node', '.github/scripts/check-apex-watermark.js'],
		paths: ['docs/ADRs/', 'docs/vision.md', 'docs/architecture/architecture.md'],
		why: 'apex docs drifting from the decision record, and ADRs that never got stamped',
		// Never blocks. `check-apex-watermark.js` says why in its own header: "blocking
		// an unrelated PR on a document nobody has read punishes whoever happens to push
		// next", which is exactly why it is a scheduled job and not a PR gate. Listing it
		// as blocking here contradicted the check it runs, and it bit immediately: a
		// one-line ADR stamp was refused because a doc somebody else had not reviewed put
		// the gap on the threshold.
		report: true,
	},
	{
		id: 'adr-links',
		cmd: ['node', 'scripts/check-adr-links.js'],
		paths: ['.md', '.ts', '.js', '.yml', '.yaml'],
		staged: true,
		why: 'a link to an ADR file that does not exist',
	},
	{
		id: 'adr-numbers',
		cmd: ['node', 'scripts/check-adr-numbers.js'],
		paths: ['docs/ADRs/'],
		staged: true,
		why: 'two ADRs claiming the same integer',
	},
	{
		id: 'docs-index',
		cmd: ['node', 'scripts/check-docs-index.js'],
		paths: ['docs/'],
		staged: true,
		why: 'a doc added, removed or renamed without a docs index update',
	},
	{
		id: 'commit-authorship',
		cmd: ['node', 'scripts/check-commit-authorship.js'],
		// Not path-scoped: whether a commit is authored by a human has nothing to do
		// with which files it touched. `always` runs it on every push regardless.
		paths: [],
		always: true,
		why: 'a commit authored as the assistant rather than by a human',
	},
	{
		id: 'markdown-links',
		cmd: ['node', 'scripts/check-markdown-links.js'],
		paths: ['.md'],
		why: 'a relative markdown link that does not resolve',
	},
	{
		id: 'adr-citations',
		cmd: ['node', 'scripts/check-adr-citations.js'],
		paths: ['docs/'],
		why: 'an apex doc citing a superseded ADR without naming its successor',
		// The check defaults to warn and exits 0 however many stale citations it finds;
		// only fail makes it block. pr-guards.yml sets this and this runner did not, so
		// the guard had teeth in CI and none locally -- which, since ADR-071 established
		// that Actions are a thing that does not run, meant no teeth anywhere. ADR-056
		// shipped it in warn because nine citations were stale that day; #842 and #844
		// cleared them and the flip was made in CI but never here.
		env: { ADR_CITATION_GUARD_MODE: 'fail' },
	},
	{
		id: 'skill-bodies',
		cmd: ['node', 'scripts/check-skill-bodies.js'],
		paths: ['.claude/skills/'],
		why: 'a repo skill drifting from its registered body',
	},
	{
		id: 'turbo-inputs',
		cmd: ['node', 'scripts/check-turbo-inputs.js'],
		// Whole-repo scan, not staged-scoped (like migration-versions): a new
		// test's escape and the turbo.json declaration for it can land in
		// different files, or the declaration can simply be forgotten, so this
		// has to see the committed tree as a whole, not just the diff.
		paths: ['.test.ts', '.test.tsx', '.test.js', 'turbo.json', 'vitest.config.ts', 'jest.config.js'],
		why: 'a test reading outside its package with no turbo.json inputs declaration (#729)',
	},
	{
		id: 'type-duplicates',
		cmd: ['node', 'scripts/check-type-duplicates.js'],
		paths: ['.ts', '.tsx'],
		why: 'the same type declared in two packages',
	},
	{
		id: 'user-id-reads',
		cmd: ['node', 'scripts/check-user-id-reads.js'],
		paths: ['.ts', '.tsx'],
		why: 'a query reading rows without scoping them to a user',
	},
	{
		id: 'artifact-surface-writes',
		cmd: ['node', 'scripts/check-artifact-surface-writes.js'],
		paths: ['.ts', '.tsx'],
		why: 'an artifact write bypassing the surface vocabulary',
	},
	{
		id: 'undeclared-deps',
		cmd: ['node', 'scripts/check-undeclared-deps.js'],
		paths: ['package.json', '.ts', '.tsx'],
		why: 'importing a package nothing declares a dependency on',
	},
	{
		id: 'standalone-lockfiles',
		cmd: ['node', 'scripts/check-standalone-lockfiles.js'],
		paths: ['package.json', 'package-lock.json'],
		why: 'a standalone lockfile drifting from the workspace it mirrors',
	},
	{
		id: 'migration-versions',
		cmd: ['node', 'packages/worker/scripts/check-migration-versions.js'],
		paths: ['supabase/migrations/'],
		why: 'two migrations minted on the same sequence number',
	},
	{
		id: 'migration-signatures',
		cmd: ['node', 'packages/worker/scripts/check-migration-signatures.js'],
		paths: ['supabase/migrations/'],
		why: 'an already-applied migration edited in place',
	},
	{
		id: 'migration-comments',
		cmd: ['node', 'packages/worker/scripts/check-migration-comments.js'],
		paths: ['supabase/migrations/'],
		staged: true,
		why: 'a new migration silently shrinking an existing column comment (#964)',
	},
	{
		id: 'build-artifacts',
		cmd: ['node', 'scripts/check-build-artifacts.js'],
		paths: [],
		always: true,
		staged: true,
		why: 'unapproved build allowance files or placeholder content in diff',
	},
	{
		id: 'architecture-drift',
		cmd: ['node', 'scripts/check-architecture-drift.js'],
		paths: [
			'docs/architecture/architecture.md',
			'.railway/',
			'railway.json',
			'railway.toml',
			'Dockerfile',
			'supabase/config.toml',
			'supabase/functions/',
			'package.json',
			'packages/web/src/components/visual-meaning/',
		],
		staged: true,
		why: 'physical architecture or topology drifting from architecture.md, missing ADR linkage, or lagging Visual Meaning views',
	},
	{
		id: 'core-isomorphic',
		cmd: ['node', 'scripts/check-core-isomorphic.js'],
		paths: ['packages/core/'],
		why: '@ahkms/core importing Node built-ins or non-isomorphic dependencies (#1319)',
	},
	{
		id: 'core-import-direction',
		cmd: ['node', 'scripts/check-core-import-direction.js'],
		paths: ['packages/core/', 'packages/web/', 'packages/mobile/'],
		why: '@ahkms/core internal import hierarchy violation (contracts -> actions -> engine, never backwards; adapters in composition roots only; ADR-101 #1321)',
	},
	{
		id: 'no-new-cadence',
		cmd: ['node', 'scripts/check-no-new-cadence.js'],
		paths: ['packages/mcp-server/src/schedule/', 'packages/worker/src/schedule/'],
		staged: true,
		why: 'cadence or background loop added to mcp-server or worker instead of core/engine (ADR-101 / ADR-102 §3)',
	},
	{
		id: 'llm-client-location',
		cmd: ['node', 'scripts/check-llm-client-location.js'],
		paths: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
		why: 'direct LLM SDK imports or endpoints outside packages/core/src/adapters (ADR-101 / ADR-102 §3)',
	},
	{
		id: 'silent-fallback',
		cmd: ['node', 'scripts/check-silent-fallback.js'],
		paths: ['.ts', '.tsx', '.js', '.jsx', '.html'],
		staged: true,
		why: 'empty catch block or in-memory fallback on a production path (ADR-102 §3)',
	},
	{
		id: 'client-writes',
		cmd: ['node', 'scripts/check-client-writes.js'],
		paths: ['packages/web/', 'packages/mobile/', 'supabase/migrations/'],
		why: 'direct Supabase write call in web/mobile or migration granting writes back to anon/authenticated (#1450, ADR-100)',
	},
	{
		id: 'workflow-tests',
		cmd: ['npm', 'run', '--silent', 'test:workflows'],
		paths: ['.github/scripts/'],
		why: 'the guard scripts themselves regressing',
	},
	{
		id: 'circular-deps',
		cmd: ['node', 'scripts/check-circular-deps.js'],
		paths: ['packages/mcp-server/src/', 'packages/core/src/'],
		why: 'circular dependencies in compiled ES modules causing runtime TDZ crashes (#1723)',
	},
	{
		id: 'esm-smoke',
		cmd: ['node', 'scripts/check-esm-smoke.js'],
		paths: ['packages/mcp-server/src/'],
		why: 'runtime ReferenceError or unhandled module evaluation failure during service boot (#1723)',
	},
	{
		id: 'worktree-isolation',
		cmd: ['node', 'scripts/check-worktree-isolation.js'],
		paths: [],
		always: true,
		stagedSafe: true,
		ciRunsIt: false,
		why: 'feature-branch commit in the primary checkout while concurrent worktrees or session locks exist (#1822)',
	},
];

// --- manifest integrity ----------------------------------------------------

/**
 * The manifest is a hand-edited array of object literals, and a merge that drops
 * a `},{` between two entries fuses them into one. JavaScript accepts that
 * silently — later keys win — so a guard can disappear with no syntax error and
 * no missing file. That happened on 2026-08-28: the `commit-authorship` entry
 * was absorbed into `markdown-links`, taking the guard out of the runner while
 * `node --check` passed and `--list` still printed both ids.
 *
 * So the runner checks its own manifest before running anything. This costs a
 * microsecond and catches the one failure mode a guard runner cannot afford: a
 * guard that is silently not there.
 */
function validateManifest(guards = GUARDS) {
	const problems = [];
	const seen = new Set();
	guards.forEach((g, i) => {
		const where = g.id ? `'${g.id}'` : `entry ${i}`;
		if (!g.id) problems.push(`${where}: no id`);
		else if (seen.has(g.id)) problems.push(`${where}: duplicate id`);
		else seen.add(g.id);
		if (!Array.isArray(g.cmd) || g.cmd.length === 0) problems.push(`${where}: no cmd`);
		if (!Array.isArray(g.paths)) problems.push(`${where}: paths must be an array`);
		if (!g.always && (!g.paths || g.paths.length === 0)) {
			problems.push(`${where}: no paths and not \`always\`, so it can never be selected`);
		}
		if (!g.why) problems.push(`${where}: no why`);
	});
	// The check above catches duplicate ids, missing fields and unreachable
	// entries. It does NOT catch the fusion itself: two entries merged into one
	// object have a single surviving id, so nothing about the resulting array
	// looks wrong. Counting `id:` keys in the source and comparing to the array
	// length does catch it, and needs no second list to maintain.
	try {
		const src = fs.readFileSync(__filename, 'utf8');
		const block = /const GUARDS = \[[\s\S]*?\n\];/.exec(src);
		if (block) {
			const declared = (block[0].match(/^\t\tid: '/gm) || []).length;
			if (declared !== guards.length) {
				problems.push(
					`${declared} \`id:\` key(s) in the source but ${guards.length} entr(y|ies) in the array — ` +
						'two entries are fused into one object, and the earlier one has been silently dropped',
				);
			}
		}
	} catch (err) {
		// This check reads our own source, so a failure here means the check is not
		// running. Silence would make a dead detector look like a clean manifest —
		// which is exactly what happened while it was written before `fs` was in
		// scope. Say so instead.
		problems.push(`manifest fusion check could not run: ${err.message}`);
	}

	return problems;
}

// --- matching --------------------------------------------------------------

function matches(file, patterns) {
	return patterns.some((p) => {
		if (p.endsWith('/')) return file.startsWith(p);
		if (p.startsWith('.') && !p.includes('/')) return file.endsWith(p);
		return file === p || file.endsWith(`/${p}`);
	});
}

function selectGuards(files) {
	// An `always` guard asks a question that is not about which files changed —
	// commit authorship is the case — so path matching cannot select it and would
	// silently drop it. It still obeys `--staged` versus `--push`; it just never
	// self-skips on scope.
	return GUARDS.filter((g) => g.always || files.some((f) => matches(f, g.paths)));
}

// --- git -------------------------------------------------------------------

function git(args, { allowFail = false, cwd = TARGET_DIR } = {}) {
	try {
		return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
	} catch (err) {
		if (allowFail) return '';
		throw err;
	}
}

function stagedFiles() {
	const out = git(['diff', '--cached', '--diff-filter=ACMR', '--name-only']);
	return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * What this push adds on top of the integration branch. Falls back to the staged
 * set, then to nothing: a runner that cannot work out the range must under-block,
 * never over-block, or we are back to the `--no-verify` habit.
 */
function pushedFiles() {
	const base = ['origin/dev', 'origin/main'].find((r) => git(['rev-parse', '--verify', '--quiet', r], { allowFail: true }));
	if (!base) return stagedFiles();
	const mergeBase = git(['merge-base', 'HEAD', base], { allowFail: true });
	if (!mergeBase) return stagedFiles();
	const out = git(['diff', '--diff-filter=ACMR', '--name-only', `${mergeBase}..HEAD`], { allowFail: true });
	return out ? out.split('\n').filter(Boolean) : [];
}

function onDev() {
	return git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) === 'dev';
}

// --- protected branches -----------------------------------------------------

const PROTECTED_BRANCHES = new Set(['dev', 'main']);

function getSymbolicBranch(cwd = TARGET_DIR) {
	return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true, cwd });
}

function checkProtectedBranch({ cwd = TARGET_DIR, env = process.env } = {}) {
	if (env.ALLOW_DEV_COMMIT === '1' || env.GUARDS_SKIP === '1') {
		return null;
	}
	const branch = getSymbolicBranch(cwd);
	if (PROTECTED_BRANCHES.has(branch)) {
		return (
			`guards: direct commits to '${branch}' are blocked.\n` +
			`        Feature work must branch off dev (git checkout -b <type>/<name>).\n` +
			`        Bypass with ALLOW_DEV_COMMIT=1 or --no-verify.`
		);
	}
	return null;
}

// --- running ---------------------------------------------------------------

function buildGuardCommand(guard, { strictStamps = false, mode = 'staged' } = {}) {
	// The stamp check is only a violation once the ADR is merged, so it is asked for
	// on `dev` and nowhere else. On the branch that ADDS an ADR, `Proposed` is right.
	const cmd = [...guard.cmd];
	if (guard.id === 'apex-watermark' && strictStamps) {
		cmd.push('--strict-stamps');
	}
	if (mode === 'staged' && guard.staged) {
		cmd.push('--staged');
	}
	return cmd;
}

function runGuard(guard, { strictStamps = false, mode = 'staged' } = {}) {
	if (process.env.AHOS_GUARDS_SKIP_SUBCHECKS === '1') {
		return { ok: true, output: '' };
	}
	const cmd = buildGuardCommand(guard, { strictStamps, mode });

	const env = guard.env ? { ...process.env, ...guard.env } : { ...process.env };
	delete env.GUARDS_REPO_ROOT;
	const res = spawnSync(cmd[0], cmd.slice(1), {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env,
		shell: process.platform === 'win32',
	});
	return {
		ok: res.status === 0,
		output: `${res.stdout || ''}${res.stderr || ''}`.trimEnd(),
	};
}

function report(label, results) {
	const failed = results.filter((r) => !r.ok);
	if (!failed.length) {
		console.log(`  ${label}: ${results.length} passed`);
		return;
	}
	for (const r of failed) {
		console.log('');
		console.log(`  ${label} · ${r.guard.id} — ${r.guard.why}`);
		console.log(
			r.output.split('\n').map((l) => `      ${l}`).join('\n') || '      (no output)',
		);
	}
}

function main() {
	const manifestProblems = validateManifest();
	if (manifestProblems.length > 0) {
		console.log('guards: the manifest is malformed, so some guards would not run:');
		for (const p of manifestProblems) console.log(`  ${p}`);
		console.log('');
		console.log('Most likely a merge fused two entries by dropping the `},{` between them.');
		return 1;
	}

	if (process.env.GUARDS_SKIP === '1') {
		console.log('guards: skipped (GUARDS_SKIP=1)');
		return 0;
	}

	if (process.argv.includes('--list')) {
		for (const g of GUARDS) console.log(`${g.id.padEnd(24)} ${g.always ? '(always)' : g.paths.join(' ')}`);
		return 0;
	}

	const mode = process.argv.includes('--all') ? 'all'
		: process.argv.includes('--push') ? 'push'
		: 'staged';

	if (mode === 'staged') {
		const branchViolation = checkProtectedBranch();
		if (branchViolation) {
			console.error(branchViolation);
			return 1;
		}
	}

	const strictStamps = onDev();
	const started = Date.now();

	const touched = mode === 'all' ? null : (mode === 'push' ? pushedFiles() : stagedFiles());
	const selected = mode === 'all' ? GUARDS : selectGuards(touched);
	// A report-only guard still RUNS and still prints; it just never decides the exit
	// code. `--all` is the exception: run by hand to see everything, it reports on all
	// of them without failing on the advisory ones either.
	const blocking = selected.filter((g) => !g.report);
	const advisory = selected.filter((g) => g.report);

	if (!selected.length && mode !== 'push') {
		console.log('guards: nothing this change touches. 0 run.');
		return 0;
	}

	console.log(`guards (${mode})${mode === 'all' ? '' : ` · ${touched.length} file(s) changed`}`);

	const blockingResults = blocking.map((guard) => ({ guard, ...runGuard(guard, { strictStamps, mode }) }));
	if (blockingResults.length) report('BLOCKING', blockingResults);

	const advisoryResults = advisory.map((guard) => ({ guard, ...runGuard(guard, { strictStamps, mode }) }));
	if (advisoryResults.some((r) => !r.ok)) report('ADVISORY', advisoryResults.filter((r) => !r.ok));

	// The sweep is the point of `--push`: pre-existing breakage stays visible every
	// time, without ever being the reason your push failed.
	let sweepResults = [];
	if (mode === 'push') {
		const rest = GUARDS.filter((g) => !selected.includes(g));
		sweepResults = rest.map((guard) => ({ guard, ...runGuard(guard, { strictStamps, mode }) }));
		const brokenElsewhere = sweepResults.filter((r) => !r.ok);
		if (brokenElsewhere.length) {
			console.log('');
			console.log(`  NOT YOURS (${brokenElsewhere.length} failing, not blocking this push):`);
			for (const r of brokenElsewhere) console.log(`      ${r.guard.id} — ${r.guard.why}`);
			console.log('      Run `npm run guards:all` to see them in full.');
		}
	}

	const failed = blockingResults.filter((r) => !r.ok);
	const secs = ((Date.now() - started) / 1000).toFixed(1);

	console.log('');
	if (failed.length) {
		console.log(`guards: ${failed.length} of ${blockingResults.length} failed in ${secs}s.`);
		console.log('        Fix, or `--no-verify` if you know why this one does not apply.');
		return 1;
	}
	console.log(
		`guards: ok (${blockingResults.length + advisoryResults.length + sweepResults.length} run, ${secs}s).`,
	);
	return 0;
}

if (require.main === module) {
	process.exit(main());
}

module.exports = {
	GUARDS,
	PROTECTED_BRANCHES,
	matches,
	selectGuards,
	validateManifest,
	buildGuardCommand,
	getSymbolicBranch,
	checkProtectedBranch,
};
