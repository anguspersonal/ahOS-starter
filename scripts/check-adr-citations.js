#!/usr/bin/env node

// Apex-doc citation guard — an apex doc must not cite a superseded ADR (#849).
//
// WHY THIS EXISTS (see #841, #849, ADR-056):
//   On 2026-08-23 an audit found `docs/vision.md` a month behind the decision
//   record. The load-bearing instance: the vision's whole Projections section
//   is built on ADR-023's three sibling synthesis consumers, and ADR-051
//   superseded ADR-023 on 2026-08-07. Nothing said so. The document kept
//   asserting a shape the decision record had abandoned sixteen days earlier,
//   and it took a hand audit to notice.
//
//   That class of drift is mechanically detectable and needs no judgement from
//   anyone. The superseding ADR already announces itself in its predecessor's
//   Status line, because the ADR README's same-PR supersession stamp requires
//   it. So the fact is sitting in the repo, in a fixed place, unread.
//
// THE RULE:
//   If an apex doc cites ADR-NNN, and ADR-NNN's Status line says it is
//   superseded, the citation must ACKNOWLEDGE that: the superseding ADR's id
//   must appear within ACK_WINDOW lines of the citation. Update the claim, or
//   name the successor next to it ("ADR-023, superseded by ADR-051"). Either is
//   fine. Silence is not.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT:
//   It proves the author saw the supersession. It does NOT prove the prose is
//   correct — someone can append "(superseded by ADR-051)" and leave a wrong
//   paragraph standing. That limit is deliberate and is why ADR-056 pairs this
//   with three other mechanisms rather than treating it as the whole answer. A
//   guard that claimed more than it checks would be the same failure in a new
//   place.
//
// WHY ACKNOWLEDGEMENT RATHER THAN A HIDDEN MARKER:
//   The alternative was a machine-readable allow-comment in the prose. ADR-040
//   rejected exactly that trade for the State Doc — machine identifiers do not
//   belong in a document a human reads. Naming the successor in the sentence is
//   checkable AND improves the document: a reader hitting that citation now
//   learns what the checker learned.
//
// MODE:
//   ADR_CITATION_GUARD_MODE=warn (default) reports and exits 0.
//   ADR_CITATION_GUARD_MODE=fail reports and exits 1.
//   It ships in `warn` because four citations are stale the day it lands (#842,
//   #844 own the fixes). Flipping the default is the one-line change that
//   belongs in the PR which clears them. A grandfather allowlist was rejected:
//   a list of known-stale citations is a second store of what this derives, and
//   it would outlive its entries.

const fs = require('fs');
const path = require('path');

// Paths stay REPO-RELATIVE, because that is what a `::warning file=` annotation
// must carry for GitHub to attach it to the right line. They are resolved
// against the repo root — derived from this file's own location, never from the
// caller's cwd — so the guard reports identically from a workspace package, a
// hook, or the Actions runner.
const REPO_ROOT = path.resolve(__dirname, '..');
const APEX_DOCS = ['docs/vision.md', 'docs/architecture/architecture.md'];
const ADR_DIR = 'docs/ADRs';

// A citation within this many lines of its successor's id counts as
// acknowledged. Six is about one paragraph of this repo's prose — wide enough
// that a natural sentence satisfies it, narrow enough that an unrelated mention
// elsewhere in the section does not.
const ACK_WINDOW = 6;

// Both citation forms in use: `ADR-051` in prose, `ADR051_Title.md` in a link
// target. Normalised to the hyphenated form so one ADR is one id.
const CITATION_RE = /ADR-?(\d{3})/g;
const STATUS_RE = /^-?\s*\*\*Status:\*\*/i;

function normaliseId(digits) {
	return `ADR-${digits}`;
}

/**
 * Read an ADR's Status line into a supersession verdict.
 *
 * `null` status (no Status line at all) is treated as not-superseded rather
 * than as an error: a malformed ADR is a different guard's problem, and failing
 * here would block PRs on something this check has no opinion about.
 *
 * ONLY A SUPERSESSION THAT NAMES A SUCCESSOR COUNTS. ADR-039 §1 lets an ADR be
 * amended in place, and several are: ADR-052 §5's heading and ADR-054 §8's
 * conclusion are both "superseded IN PLACE", by themselves, naming no other
 * ADR. There is nothing for a citing document to acknowledge in that case, and
 * a rule the prose cannot satisfy is a broken guard, not a strict one. Self
 * references are dropped for the same reason.
 */
function parseStatus(statusLine, ownId = null) {
	if (!statusLine) return { superseded: null, supersededBy: [] };

	const superseded = /superseded\s+in\s+part/i.test(statusLine)
		? 'partial'
		: /superseded/i.test(statusLine)
			? 'full'
			: null;

	if (!superseded) return { superseded: null, supersededBy: [] };

	// The successor appears twice on a stamped Status line — once as link text
	// (`[ADR-051]`) and once inside the path (`./ADR051_...md`). Same id.
	const supersededBy = [...new Set(
		[...statusLine.matchAll(CITATION_RE)].map((m) => normaliseId(m[1])),
	)].filter((id) => id !== ownId);

	if (supersededBy.length === 0) return { superseded: null, supersededBy: [] };

	return { superseded, supersededBy };
}

// #850's watermark line names ADRs, but it does not CITE them: it records how far
// through the corpus the document was last read, and its evidence. That claim stays
// true after the named ADR is superseded — the review still happened, and still
// covered that far. Asking it to acknowledge a successor would be asking a historical
// marker to keep changing, which is the opposite of what a watermark is for.
const WATERMARK_RE = /^\*\*Reviewed-against:\*\*/;

/** Every ADR cited in `text`, with the 1-indexed line it sits on. */
function findCitations(text) {
	const out = [];
	text.split('\n').forEach((line, i) => {
		if (WATERMARK_RE.test(line)) return;
		for (const m of line.matchAll(CITATION_RE)) {
			out.push({ id: normaliseId(m[1]), line: i + 1 });
		}
	});
	return out;
}

/** Is any successor id within ACK_WINDOW lines of this citation? */
function isAcknowledged(lines, line, supersededBy, window = ACK_WINDOW) {
	const from = Math.max(0, line - 1 - window);
	const to = Math.min(lines.length, line + window);
	const scope = lines.slice(from, to).join('\n');
	return supersededBy.some((id) => scope.includes(id) || scope.includes(id.replace('-', '')));
}

/**
 * Pure core. `docs` is {path: text}; `statuses` is {ADR-NNN: statusLine|null}.
 * Returns one violation per unacknowledged citation.
 */
function analyze(docs, statuses, window = ACK_WINDOW) {
	const violations = [];

	for (const [docPath, text] of Object.entries(docs)) {
		const lines = text.split('\n');

		for (const citation of findCitations(text)) {
			// An ADR with no entry in `statuses` does not exist in this tree. The
			// ADR link guard already owns broken link targets; a bare prose mention
			// of a missing ADR is out of scope here.
			if (!(citation.id in statuses)) continue;

			const { superseded, supersededBy } = parseStatus(statuses[citation.id], citation.id);
			if (!superseded) continue;
			if (isAcknowledged(lines, citation.line, supersededBy, window)) continue;

			violations.push({
				doc: docPath,
				line: citation.line,
				cited: citation.id,
				severity: superseded,
				supersededBy,
			});
		}
	}

	return violations;
}

function formatReport(violations, mode) {
	if (violations.length === 0) {
		return ['OK: no apex doc cites a superseded ADR without naming its successor.'];
	}

	const level = mode === 'fail' ? 'error' : 'warning';
	const out = violations.map((v) => {
		const how = v.severity === 'partial' ? 'superseded in part by' : 'superseded by';
		return `::${level} file=${v.doc},line=${v.line}::cites ${v.cited}, which is ${how} ${v.supersededBy.join(', ')} — update the claim, or name the successor within ${ACK_WINDOW} lines`;
	});

	out.push('');
	out.push(
		`${violations.length} stale citation(s). Fix the claim the citation supports, or acknowledge the supersession in the prose (ADR-056, #849).`,
	);
	if (mode !== 'fail') {
		out.push('Reporting only: ADR_CITATION_GUARD_MODE is not `fail`.');
	}
	return out;
}

/** Read every ADR's Status line: {ADR-NNN: statusLine|null}. */
function readAdrStatuses(dir = ADR_DIR) {
	const statuses = {};
	const abs = path.resolve(REPO_ROOT, dir);
	for (const file of fs.readdirSync(abs)) {
		const m = /^ADR(\d{3})_/.exec(file);
		if (!m) continue;

		const lines = fs.readFileSync(path.join(abs, file), 'utf8').split('\n');
		statuses[normaliseId(m[1])] = lines.find((l) => STATUS_RE.test(l)) ?? null;
	}
	return statuses;
}

function readDocs(paths = APEX_DOCS) {
	const docs = {};
	for (const p of paths) {
		const abs = path.resolve(REPO_ROOT, p);
		if (fs.existsSync(abs)) docs[p] = fs.readFileSync(abs, 'utf8');
	}
	return docs;
}

function main() {
	const mode = process.env.ADR_CITATION_GUARD_MODE || 'warn';
	const violations = analyze(readDocs(), readAdrStatuses());

	for (const line of formatReport(violations, mode)) console.log(line);

	process.exit(violations.length > 0 && mode === 'fail' ? 1 : 0);
}

if (require.main === module) {
	main();
}

module.exports = {
	analyze,
	findCitations,
	formatReport,
	isAcknowledged,
	parseStatus,
	readAdrStatuses,
	readDocs,
	ACK_WINDOW,
	APEX_DOCS,
};
