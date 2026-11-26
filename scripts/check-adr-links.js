#!/usr/bin/env node
'use strict';

// ADR link guard — extracted from `pr-guards.yml` step 1 by #919.
//
// A link to an ADR must resolve. Issue #126 sat blocked for a month because it
// cited an ADR path that had never landed on `dev`: the reference looked
// authoritative and pointed at nothing.
//
// Scope limit (ADR-039): repo files only. A citation inside a GitHub issue body
// is beyond any checker's reach, which is why an ADR is authoritative to cite
// only once it is Accepted on `dev`.
//
// WHY IT IS A SCRIPT NOW
//   It was inline bash, so `scripts/guards.js` had no way to run it and the
//   local execution path ADR-071 built simply did not cover it. Re-implementing
//   it in the runner would have produced two behaviours under one name, which
//   #919 argues is worse than the gap. One implementation, two callers.
//
// SCOPE, PRESERVED FROM THE BASH
//   Only files the change touched — pre-existing breakage elsewhere is not this
//   change's problem, and failing on it would block unrelated work (ADR-071 §2).
//   Test files are excluded: a unit test for a markdown guard has to embed
//   synthetic markdown, and a link-shaped fixture naming an ADR that was never
//   meant to exist is a test input, not a citation. Without this the apex
//   citation guard's own tests (#849) fail this guard on their fixtures.
//
//   Markdown LINK TARGETS only — `](…/ADRNNN_Title.md)`. A bare backticked
//   mention is not a link: `docs/ADRs/README.md` legitimately names two drafts
//   deleted in #151 while explaining their removal, and prose about a removed
//   file must not fail the build.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, resolveBase, changedFiles } = require('./lib/range.js');

const RELEVANT = /\.(md|ts|js|yml|yaml)$/;
const TEST_FILE = /(^|\/)__tests__\/|\.test\.[cm]?[tj]s$/;
const LINK_TARGET = /\]\([^)]*?(ADR[0-9]{3}_[A-Za-z0-9_]+\.md)/g;

function analyse(files) {
	const violations = [];
	for (const file of files) {
		const abs = path.join(REPO_ROOT, file);
		if (!fs.existsSync(abs)) continue;
		const refs = new Set();
		const text = fs.readFileSync(abs, 'utf8');
		let m;
		LINK_TARGET.lastIndex = 0;
		while ((m = LINK_TARGET.exec(text)) !== null) refs.add(m[1]);
		for (const ref of [...refs].sort()) {
			if (!fs.existsSync(path.join(REPO_ROOT, 'docs', 'ADRs', ref))) violations.push({ file, ref });
		}
	}
	return violations;
}

function main() {
	const base = resolveBase();
	const files = changedFiles(base).filter((f) => RELEVANT.test(f) && !TEST_FILE.test(f));

	if (files.length === 0) {
		console.log('No relevant files changed — nothing to enforce.');
		return 0;
	}

	const violations = analyse(files);
	if (violations.length === 0) {
		console.log(`OK: every ADR reference in the ${files.length} changed file(s) resolves.`);
		return 0;
	}

	for (const v of violations) {
		console.log(`${v.file}: references docs/ADRs/${v.ref}, which does not exist in this tree`);
	}
	console.log('');
	console.log('Fix the link, or land the ADR it points at first — an unmerged ADR is not');
	console.log('authoritative to cite (ADR-039).');
	return 1;
}

if (require.main === module) process.exit(main());

module.exports = { analyse };
