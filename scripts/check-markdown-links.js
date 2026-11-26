#!/usr/bin/env node
'use strict';

// Relative markdown link guard.
//
// WHY THIS EXISTS
//   On 2026-08-28 a whole-repo sweep found **69 broken relative `.md` links**, none
//   of them recent. Three shapes, and the mix is the interesting part:
//
//     1. Files that moved and left their references behind (`./Worker.md` from
//        `docs/guides/`, which has lived at `docs/design/systems/Worker.md` for
//        months).
//     2. Filenames that were never right — `Step01_Create_Artifact.md` for
//        `Step01_CreateArtifact.md`, `Step03_Organize_Entities.md` for
//        `Step03_Organise.md`. The second is a British-spelling trap that will
//        recur.
//     3. Documents that were never written at all. `docs/WorkflowSteps/` carried
//        "Related Documentation" blocks pointing at a dozen per-function docs
//        (`executeWorkflow.md`, `executeAnalyzeStep.md`) that have never existed.
//
//   None of it broke a build, so none of it was ever noticed. That is the same
//   silent-omission class the apex-citation guard exists for (ADR-056), one level
//   down: a dead link costs a reader a click and teaches them the docs cannot be
//   trusted, which is more expensive than the click.
//
// WHY IT BLOCKS RATHER THAN REPORTS
//   Unlike the watermark, this needs no judgement and has no threshold: a relative
//   link either resolves or it does not. The tree is clean as of the PR that adds
//   this, so it cannot fire on somebody else's mess — the ADR-071 §2 condition for
//   a guard being allowed to block.
//
// WHAT IT CHECKS
//   Every `[text](./path.md)` or `[text](../path.md)` in a tracked `.md` file
//   resolves to a real file. Anchors (`#section`) are stripped before resolving
//   and not otherwise validated.
//
// WHAT IT DOES NOT CHECK
//   Absolute URLs, bare paths without a leading `./` or `../`, links to non-`.md`
//   files, and whether an anchor exists in the target. Each of those has a
//   materially higher false-positive rate, and a guard that cries wolf is one that
//   gets `--no-verify`'d.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const LINK = /\[([^\]]*)\]\((\.{1,2}\/[A-Za-z0-9_.\/-]+?\.md)(#[^)]*)?\)/g;

function trackedMarkdown() {
	const out = execFileSync('git', ['ls-files', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' });
	return out.trim().split('\n').filter(Boolean);
}

function findBroken(files = trackedMarkdown()) {
	const broken = [];
	for (const file of files) {
		const abs = path.join(REPO_ROOT, file);
		if (!fs.existsSync(abs)) continue;
		const lines = fs.readFileSync(abs, 'utf8').split('\n');
		lines.forEach((line, i) => {
			LINK.lastIndex = 0;
			let m;
			while ((m = LINK.exec(line)) !== null) {
				const target = path.resolve(path.dirname(abs), m[2]);
				if (!fs.existsSync(target)) broken.push({ file, line: i + 1, text: m[1], link: m[2] });
			}
		});
	}
	return broken;
}

function main() {
	const files = trackedMarkdown();
	const broken = findBroken(files);

	if (broken.length === 0) {
		console.log(`OK: every relative markdown link resolves (${files.length} file(s) checked).`);
		return 0;
	}

	console.log(`${broken.length} broken relative markdown link(s):`);
	for (const b of broken) console.log(`  ${b.file}:${b.line}  [${b.text}](${b.link})`);
	console.log('');
	console.log('Point it at the real file, or drop the link. If the target was never');
	console.log('written, say what it would have described and cite the code instead —');
	console.log('a link to a document that does not exist is not a promise, it is a dead end.');
	return 1;
}

if (require.main === module) process.exit(main());

module.exports = { findBroken, trackedMarkdown };
