#!/usr/bin/env node
'use strict';

// Install completeness check.
//
// WHY THIS EXISTS
//   A remote session's container is provisioned by someone else's `npm install`,
//   and that install can partially fail without anything downstream saying so.
//   Observed 2026-08-28: `@sentry/profiling-node` (a native module), `n3` and
//   `@types/n3` were all absent from `node_modules` while being correctly
//   declared and present in `package-lock.json`. `npm run typecheck` failed with
//   three TS2307/TS7016 "cannot find module" errors that looked like code
//   defects and were not.
//
//   The cost was not the errors. It was that four PRs were opened that day with
//   the typecheck box unverifiable, and nobody knew, because a missing package
//   and a broken import produce the same message.
//
// WHAT IT CHECKS
//   Every `dependencies` and `devDependencies` entry declared by the root
//   manifest and by each workspace resolves to a real directory, using Node's
//   own lookup order: the workspace's own `node_modules` first, then the root's.
//
//   `optionalDependencies` are reported separately and never fail the run: a
//   package declared optional is allowed to be absent, which is the whole point
//   of the field.
//
// WHAT IT DOES NOT CHECK
//   Version satisfaction, integrity, or that the installed copy matches the
//   lockfile. `npm ci` does that and is the right tool for it. This answers one
//   question only, the one that was silently false: is anything simply missing?
//
// Usage:
//   node scripts/check-install-complete.js           # exit 1 if anything is missing
//   node scripts/check-install-complete.js --quiet   # print only on failure

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

/** Root manifest plus every `packages/*` manifest that exists. */
function manifests() {
	const out = [];
	const rootPkg = path.join(REPO_ROOT, 'package.json');
	if (fs.existsSync(rootPkg)) out.push({ dir: REPO_ROOT, label: '(root)', pkg: readJson(rootPkg) });

	const pkgsDir = path.join(REPO_ROOT, 'packages');
	if (!fs.existsSync(pkgsDir)) return out;
	for (const entry of fs.readdirSync(pkgsDir).sort()) {
		const file = path.join(pkgsDir, entry, 'package.json');
		if (!fs.existsSync(file)) continue;
		const pkg = readJson(file);
		out.push({ dir: path.join(pkgsDir, entry), label: pkg.name || `packages/${entry}`, pkg });
	}
	return out;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Node's resolution order, reduced to the part that matters here: a workspace
 * can hold its own copy, otherwise the hoisted root copy serves it.
 */
function isInstalled(name, fromDir) {
	const candidates = [path.join(fromDir, 'node_modules', name), path.join(REPO_ROOT, 'node_modules', name)];
	return candidates.some((p) => fs.existsSync(p));
}

function main() {
	const missing = [];
	const missingOptional = [];
	let checked = 0;

	for (const { dir, label, pkg } of manifests()) {
		const required = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		const optional = pkg.optionalDependencies || {};

		for (const name of Object.keys(required)) {
			// A workspace depending on a sibling workspace is satisfied by the
			// symlink npm writes, which `existsSync` follows. Nothing special needed.
			checked++;
			if (!isInstalled(name, dir)) missing.push({ label, name, want: required[name] });
		}
		for (const name of Object.keys(optional)) {
			checked++;
			if (!isInstalled(name, dir)) missingOptional.push({ label, name, want: optional[name] });
		}
	}

	if (missingOptional.length > 0 && !QUIET) {
		console.log(`note: ${missingOptional.length} optional dependency(ies) absent, which is allowed:`);
		for (const m of missingOptional) console.log(`  ${m.label}  ${m.name}@${m.want}`);
	}

	if (missing.length === 0) {
		if (!QUIET) console.log(`install looks complete — ${checked} declared dependency(ies) resolve.`);
		return 0;
	}

	console.log(`INCOMPLETE INSTALL — ${missing.length} of ${checked} declared dependency(ies) are missing:`);
	for (const m of missing) console.log(`  ${m.label}  ${m.name}@${m.want}`);
	console.log('');
	console.log('These are declared and locked but absent from node_modules, so anything');
	console.log('importing them fails as if the code were wrong. Repair with:');
	console.log('');
	console.log('  npm install --no-audit --no-fund');
	console.log('');
	console.log('If a native module keeps failing to build, `npm ci` from a clean tree is');
	console.log('the next step; do not treat the resulting TS2307 errors as code defects.');
	return 1;
}

if (require.main === module) process.exit(main());

module.exports = { isInstalled, manifests };
