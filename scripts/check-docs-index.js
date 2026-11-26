#!/usr/bin/env node
'use strict';

// Docs index guard — extracted from `pr-guards.yml` step 3 by #919.
//
// The docs indexes (`docs/README.md` and the `docs/**/README.md` sub-indexes)
// must never silently drift. A change that adds, removes, or renames a doc under
// `docs/` must update an index in the same change. See ADR-014.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//   It proves an index file was touched, not that the touch was the right one.
//   Someone can fix a typo in `docs/README.md` while adding an unlisted doc and
//   satisfy this. That limit is deliberate and is the same shape the apex
//   citation guard states about itself: checking that a human looked is cheap
//   and mechanical, checking that they looked correctly is neither.
//
// The `ADR` in the diff filter is git's rename status, not this repo's ADRs:
// Added, Deleted, Renamed. A doc merely *modified* has not changed the index's
// contents, so it is out of scope.

const { resolveBase, changedFiles } = require('./lib/range.js');

const IS_INDEX = /(^|\/)README\.md$/;

function main() {
	const base = resolveBase();
	const touched = changedFiles(base, { filter: 'ADR', pathspec: ['docs/'] });
	const docs = touched.filter((f) => !IS_INDEX.test(f));

	if (docs.length === 0) {
		console.log('No docs added/removed/renamed — nothing to enforce.');
		return 0;
	}

	// Any modification to an index counts, not only add/remove/rename, so the
	// filter here is deliberately wider than the one above.
	const indexes = changedFiles(base, { filter: 'ACMR', pathspec: ['docs/'] }).filter((f) => IS_INDEX.test(f));

	if (indexes.length > 0) {
		console.log('OK: a docs index was updated:');
		for (const f of indexes) console.log(`  ${f}`);
		return 0;
	}

	console.log('These docs were added/removed/renamed but no docs index was updated:');
	for (const f of docs) console.log(`  ${f}`);
	console.log('');
	console.log('Update docs/README.md, or the relevant docs/**/README.md sub-index');
	console.log('(e.g. docs/ADRs/README.md).');
	return 1;
}

if (require.main === module) process.exit(main());
