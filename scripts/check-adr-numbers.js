#!/usr/bin/env node
'use strict';

// ADR number guard — extracted from `pr-guards.yml` step 2 by #919.
//
// Two ADRs must never claim the same integer. Numbers are claimed at authoring
// (ADR-039 retired mint-at-merge, because slug-then-integer traded a collision
// risk for citation instability and failed anyway), so the collision check has
// to happen before the merge rather than at it. The 024 collision went unnoticed
// for a month because the losing draft never opened a PR.
//
// Two checks, and the second is the one the bash version added late:
//   1. An ADR added by this change must not reuse an integer already taken on
//      the integration branch.
//   2. No two ADRs in the resulting tree may share an integer — which catches a
//      change that adds two ADRs with the same number, where check 1 sees
//      neither as pre-existing.
//
// Self-skips when no numbered ADRs were added, which is what the workflow's
// `paths: docs/ADRs/**` filter used to do.

const path = require('node:path');
const { git, resolveBase, changedFiles } = require('./lib/range.js');

const ADR_FILE = /^docs\/ADRs\/ADR([0-9]{3})_/;

/** Every `ADRNNN_` prefix present in a tree, as a list of integers. */
function numbersIn(ref) {
	const out = git(['ls-tree', '-r', '--name-only', ref, '--', 'docs/ADRs/'], { allowFail: true });
	if (!out) return [];
	return out
		.split('\n')
		.map((f) => (ADR_FILE.exec(f) || [])[1])
		.filter(Boolean);
}

function baseFilesFor(base, num) {
	const out = git(['ls-tree', '-r', '--name-only', base, '--', 'docs/ADRs/'], { allowFail: true });
	if (!out) return [];
	return out.split('\n').filter((f) => f.startsWith(`docs/ADRs/ADR${num}_`));
}

function main() {
	const base = resolveBase();
	// AR only: an ADR *modified* in place has not claimed a new number.
	const added = changedFiles(base, { filter: 'AR', pathspec: ['docs/ADRs/'] }).filter((f) => ADR_FILE.test(f));

	if (added.length === 0) {
		console.log('No numbered ADRs added — nothing to enforce.');
		return 0;
	}

	let fail = false;

	for (const file of added) {
		const num = ADR_FILE.exec(file)[1];
		const taken = base ? baseFilesFor(base, num) : [];
		if (taken.length > 0) {
			console.log(`${file}: ADR number ${num} is already taken on the base by: ${taken.join(', ')}`);
			console.log(`  Renumber ${path.basename(file)} to the next free integer and update the index row.`);
			fail = true;
		}
	}

	const seen = {};
	for (const n of numbersIn('HEAD')) seen[n] = (seen[n] || 0) + 1;
	const dupes = Object.keys(seen).filter((n) => seen[n] > 1).sort();
	if (dupes.length > 0) {
		console.log(`Duplicate ADR numbers in this tree: ${dupes.join(', ')}`);
		fail = true;
	}

	if (fail) return 1;
	console.log(`OK: all ${added.length} added ADR number(s) are unique against the base.`);
	return 0;
}

if (require.main === module) process.exit(main());

module.exports = { numbersIn };
