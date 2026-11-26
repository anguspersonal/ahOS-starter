#!/usr/bin/env node

// Artifact-surface write guard — every `artifacts` insert path is declared (#570).
//
// WHY THIS EXISTS (see issue #570 AC4, ADR-046 §2/§3, ADR-026):
//   `artifacts.surface` is the key BOTH read-time derivations hang off:
//   ADR-046 §3's synthesis role ladder (resolveSynthesisRole) and ADR-026's
//   trust derivation (resolveTrust). A row written with a null `surface` is
//   un-gateable — neither included nor excluded, trust falling back to a bare
//   default instead of provenance. That is exactly how the Drive discover path
//   flooded the day-window synthesis read with a decade of personal-archive
//   PDFs (#567), and #570 is the fix.
//
//   The durable half of that fix is this guard. Without it the failure recurs
//   the obvious way: a future connector copies the nearest existing insert
//   shape, ships, and nothing fails.
//
//   #584 closed five of six write paths this guard had recorded as a gap;
//   #736 closed the sixth and last (createTask.ts). Every path this guard can
//   see now stamps a non-null surface — but the guard's own limits mean that
//   is only ONE of the two preconditions for the NOT NULL constraint (#736):
//   it cannot see a writer that is not TypeScript under packages/, and an
//   external n8n workflow has written `artifacts` rows directly via
//   PostgREST. Confirming that writer retired is a human/ops step outside
//   what static analysis can prove — see the zero-gap message below.
//
// THE RULE:
//   Every `.from("artifacts").insert(…)` / `.upsert(…)` site in production
//   code must appear in the ARTIFACT_WRITE_SITES registry below, declaring
//   whether that path stamps a non-null `surface`. Paths that do are pinned by
//   `requiredPatterns`, so removing the stamp fails CI. Paths that don't are
//   recorded as known gaps with the issue tracking them — visible and counted,
//   never silent.
//
//   Adding a new artifact write path therefore forces an explicit decision.
//   That is the point: the guard cannot prove an arbitrary payload is non-null
//   (payloads are built far from the call site — discover.ts hands `insert()` a
//   pre-built array), but it CAN guarantee no such path is added or changed
//   without a human writing down what it does about `surface`.
//
// WHAT THIS SCRIPT DOES (pure static analysis — no imports, no execution):
//   walks every .ts/.tsx file under packages/ (tests excluded), finds each
//   `.from("artifacts")` immediately chained to `.insert(`/`.upsert(`, and
//   fails (exit 1) on any of:
//     - a write site in a file the registry does not declare
//     - a declared file whose site count changed (a new insert was added to it)
//     - a `stampsSurface: true` file that no longer matches its required
//       stamp pattern (the regression this guard mainly exists to catch)
//     - a registry entry with no site left in the tree (stale — keep it honest)
//
// Usage:
//   node scripts/check-artifact-surface-writes.js [--json]
//   or: npm run check:artifact-surface-writes    (from the repo root)
//
// Exit codes: 0 = every write path declared and stamps intact; 1 = violations;
// 2 = could not run (missing dir, unexpected error).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

// Directories never worth walking.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', '.next', 'coverage']);

// A supabase-js insert/upsert against the artifacts table. Deliberately narrow:
// `.insert(`/`.upsert(` must chain directly off `.from("artifacts")` (only
// whitespace between), which is how every real call site is written. Reads that
// chain `.select()`/`.update()` off the same `.from()` do not match.
const ARTIFACT_WRITE = /\.from\(\s*(["'])artifacts\1\s*\)\s*\.\s*(insert|upsert)\s*\(/g;

// Every production path that writes an artifacts row, and what it does about
// `surface`. Repo-relative POSIX paths.
//
// `stampsSurface: true`  — the path always writes a non-null surface, and
//                          `requiredPatterns` pins the line(s) that do it.
// `stampsSurface: false` — the path can still write null. A KNOWN, TRACKED gap;
//                          `issue` says where. Not an invitation to add more.
const ARTIFACT_WRITE_SITES = {
	'packages/mcp-server/src/tools/discover.ts': {
		sites: 1,
		stampsSurface: true,
		why:
			'The discover write path (#570). discoverItems() stamps ' +
			'surface = source_channel ("discovered_<connector>") on the insert and ' +
			'again on the changed-content update — a deterministic field-copy of the ' +
			"caller's own connector argument, so an envelope fact under ADR-046 §2, " +
			'not the content interpretation ADR-018 forbids at write.',
		requiredPatterns: [
			{
				label: 'surface: channel — insert payload + changed-content update payload',
				pattern: /^\s*surface: channel,$/gm,
				min: 2,
			},
		],
	},
	'packages/core/src/actions/artifacts/captureBody.ts': {
		sites: 0,
		stampsSurface: true,
		why:
			'Closed by #584 (moved to core in #1658). The three-rung chain `args.surface ?? prefs.default_surface ' +
			'?? ARTIFACT_SURFACES.api` is TOTAL, and the pinned pattern below matches the ' +
			'whole expression INCLUDING its terminal - so deleting the floor, which is ' +
			'the regression that re-opens the hole, cannot pass. The floor is a code ' +
			'constant rather than another optional preference because a configurable ' +
			'default that itself defaults to nothing is the same bug one layer down.',
		requiredPatterns: [
			{
				label: 'surface chain terminates in the ARTIFACT_SURFACES.api floor',
				pattern:
					/^\s*surface: args\.surface \?\? prefs\.default_surface \?\? ARTIFACT_SURFACES\.api,$/gm,
				min: 1,
			},
		],
	},
	'packages/core/src/actions/drive/importFile.ts': {
		sites: 0,
		stampsSurface: true,
		why:
			'Closed by #584 (moved to core in #1613). createDriveImportFileAction() ' +
			'stamps ARTIFACT_SURFACES.driveImport through ArtifactRepository.insert(row), ' +
			'kept distinct from its source_channel ("google_drive") so explicit single-file ' +
			'imports stay separately addressable from discovered_gdrive inventory pointers (#567).',
		requiredPatterns: [
			{
				label: 'surface: ARTIFACT_SURFACES.driveImport on the import insert',
				pattern: /^\s*surface: ARTIFACT_SURFACES\.driveImport,$/gm,
				min: 1,
			},
		],
	},
	'packages/mcp-server/src/tools/drive/shared.ts': {
		sites: 1,
		stampsSurface: true,
		why:
			'Closed by #584. importDriveFileArtifact() (the explicit drive_import_file ' +
			'tool) now stamps ARTIFACT_SURFACES.driveImport — a field-copy of which TOOL ' +
			'the row came through, so an envelope fact under ADR-046 §2. Kept distinct ' +
			'from its source_channel ("google_drive") on purpose: the discover path ' +
			'already owns the Drive-as-a-system space with `discovered_gdrive`, and ' +
			'one-file-by-request must stay separately addressable from a bulk account ' +
			'inventory (#567).',
		requiredPatterns: [
			{
				label: 'surface: ARTIFACT_SURFACES.driveImport on the import insert',
				pattern: /^\s*surface: ARTIFACT_SURFACES\.driveImport,$/gm,
				min: 1,
			},
		],
	},
	'packages/core/src/actions/calendar/eventCreate.ts': {
		sites: 0,
		stampsSurface: true,
		why:
			'Closed by #584 (moved to core in #1612). Act-path receipt artifact (ADR-038 §6): no EXTERNAL surface ' +
			'to copy, but "a receipt this system wrote" is itself an envelope fact and a ' +
			'nameable one, so it stamps ARTIFACT_SURFACES.actReceipt. It shares that ' +
			'value with create_task by design — ADR-046 §3 stores one role per surface ' +
			'and the policy for both is identical; the task-vs-event distinction already ' +
			'rides on content_subtype, which is what search_knowledge excludes on.',
		requiredPatterns: [
			{
				label: 'surface: ARTIFACT_SURFACES.actReceipt on the event-request receipt',
				pattern: /^\s*surface: ARTIFACT_SURFACES\.actReceipt,$/gm,
				min: 1,
			},
		],
	},
	'packages/core/src/actions/tasks/createTaskBody.ts': {
		sites: 0,
		stampsSurface: true,
		why:
			'Closed by #736, moved to core in #1662 (precondition 1 of 2 on the NOT NULL constraint — see that ' +
			'issue for the second, out-of-repo precondition). Act-path receipt artifact, ' +
			'the twin of createEvent.ts above: this file was being edited concurrently ' +
			"under #653 when #584 landed, so #584 stayed out of it rather than race that " +
			'diff, leaving it as the one declared gap. Now stamps the same ' +
			'ARTIFACT_SURFACES.actReceipt on the captureTaskRequestArtifact() insert that ' +
			"createEvent.ts's twin function carries.",
		requiredPatterns: [
			{
				label: 'surface: ARTIFACT_SURFACES.actReceipt on the task-request receipt',
				pattern: /^\s*surface: ARTIFACT_SURFACES\.actReceipt,$/gm,
				min: 1,
			},
		],
	},
	'packages/worker/src/workflows/steps/createArtifact.ts': {
		sites: 1,
		stampsSurface: true,
		why:
			'Closed by #584. Worker upload pipeline. Resolves surface from the SAME ' +
			'client-platform signal as its neighbouring source/source_channel fields, ' +
			'but through resolveUploadSurface(), which is total — an unrecognised ' +
			'platform lands on the ARTIFACT_SURFACES.api floor instead of following ' +
			'source_channel to null. Both patterns below are pinned: the call site, and ' +
			'the total default arm that makes the call site safe. Pinning only the call ' +
			'would let the function quietly gain a nullable return.',
		requiredPatterns: [
			{
				label: 'surface: resolveUploadSurface(...) on the upload insert payload',
				pattern: /^\s*surface: resolveUploadSurface\(userContext\.deviceInfo\?\.platform\),$/gm,
				min: 1,
			},
			{
				label: 'resolveUploadSurface has a total default arm',
				pattern: /default:\s*\n\s*return ARTIFACT_SURFACES\.api;/g,
				min: 1,
			},
		],
	},
	'packages/worker/src/workflows/steps/createDerived.ts': {
		sites: 1,
		stampsSurface: true,
		why:
			"Closed by #584. Derived-artifact writer (source_channel: 'derived') now " +
			'stamps ARTIFACT_SURFACES.derived — a field-copy of its own channel, the ' +
			'same envelope-rule shape as the discover path. It deliberately does NOT ' +
			"inherit the source artifact's surface, though that was available: ADR-046 " +
			'§3 stores one role per surface, so inheriting would make generated ' +
			'derivatives unaddressable AS a class, and provenance is not lost — ' +
			'processing_metadata.prov.derived_from already carries the source id.',
		requiredPatterns: [
			{
				label: 'surface: ARTIFACT_SURFACES.derived on the derived insert payload',
				pattern: /^\s*surface: ARTIFACT_SURFACES\.derived,$/gm,
				min: 1,
			},
		],
	},
	'packages/core/src/adapters/supabase/artifacts.ts': {
		sites: 1,
		stampsSurface: true,
		why:
			'Shared ArtifactRepository.insert(row) write seam (#1611). Every caller must ' +
			'supply an ArtifactInsertRow whose `surface: string` field is required and ' +
			'non-nullable at the type level in packages/core/src/ports/artifacts.ts, while ' +
			'each caller that builds an ArtifactInsertRow pins its own envelope surface expression.',
		requiredPatterns: [
			{
				file: 'packages/core/src/ports/artifacts.ts',
				label: 'ArtifactInsertRow types surface as required non-nullable string',
				pattern: /export type ArtifactInsertRow = \{[^}]*\bsurface:\s*string;/g,
				min: 1,
			},
		],
	},
};

// Normalise a path to POSIX separators for stable comparisons/reports.
function toPosix(p) {
	return p.split(path.sep).join('/');
}

// Is this repo-relative POSIX path a test file? Tests and their helpers build
// synthetic insert calls and fixtures; they are not production write paths.
function isTestPath(relPosixPath) {
	return (
		relPosixPath.includes('/__tests__/') ||
		relPosixPath.includes('/tests/') ||
		/\.(test|spec)\.tsx?$/.test(relPosixPath)
	);
}

// Recursively collect candidate .ts/.tsx files under `dir` (absolute paths).
function collectTsFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...collectTsFiles(path.join(dir, entry.name)));
		} else if (/\.tsx?$/.test(entry.name)) {
			out.push(path.join(dir, entry.name));
		}
	}
	return out;
}

// Find artifacts insert/upsert sites in one file's text.
// Returns [{ line, column, text }].
function findWriteSites(source) {
	const hits = [];
	ARTIFACT_WRITE.lastIndex = 0;
	let m;
	while ((m = ARTIFACT_WRITE.exec(source)) !== null) {
		const before = source.slice(0, m.index);
		const line = before.split('\n').length;
		const column = m.index - before.lastIndexOf('\n');
		hits.push({ line, column, text: m[0].replace(/\s+/g, ' ') });
	}
	return hits;
}

// Count non-overlapping matches of a global pattern in a source string.
function countMatches(source, pattern) {
	pattern.lastIndex = 0;
	let n = 0;
	while (pattern.exec(source) !== null) n++;
	pattern.lastIndex = 0;
	return n;
}

// Return all pin definitions for a registry entry (`requiredPatterns` and/or `pins`).
function getEntryPins(declared) {
	return [...(declared.requiredPatterns ?? []), ...(declared.pins ?? [])];
}

// Analyse a list of { relPath (POSIX), source } entries — the pure core, used
// directly by the unit tests with synthetic fixtures.
function analyzeFiles(files) {
	const violations = [];
	const seen = new Map(); // relPath -> site count actually found
	const sourceByPath = new Map(); // relPath -> source text
	let filesScanned = 0;

	for (const file of files) {
		const rel = toPosix(file.relPath);
		if (isTestPath(rel)) continue;
		filesScanned++;
		sourceByPath.set(rel, file.source);
	}

	for (const [rel, source] of sourceByPath.entries()) {
		const sites = findWriteSites(source);
		const declared = ARTIFACT_WRITE_SITES[rel];

		if (sites.length === 0) {
			if (!declared || declared.sites !== 0) continue;
			seen.set(rel, 0);
		} else {
			seen.set(rel, sites.length);
			if (!declared) {
				violations.push({
					kind: 'undeclared-write-path',
					file: rel,
					line: sites[0].line,
					detail: `${sites.length} artifacts insert/upsert site(s) in a file the registry does not declare`,
				});
				continue;
			}

			if (declared.sites !== sites.length) {
				violations.push({
					kind: 'site-count-changed',
					file: rel,
					line: sites[0].line,
					detail: `registry declares ${declared.sites} artifacts write site(s), found ${sites.length}`,
				});
			}
		}

		for (const req of getEntryPins(declared)) {
			const targetPath = req.file ? toPosix(req.file) : rel;
			const targetSource = sourceByPath.get(targetPath) ?? '';
			const min = req.min ?? 1;
			const found = countMatches(targetSource, req.pattern);
			if (found < min) {
				violations.push({
					kind: 'missing-surface-stamp',
					file: rel,
					line: sites[0]?.line ?? 0,
					detail: `expected at least ${min} occurrence(s) of "${req.label}"${
						req.file ? ` in ${targetPath}` : ''
					}, found ${found}`,
				});
			}
		}
	}

	for (const [rel, declared] of Object.entries(ARTIFACT_WRITE_SITES)) {
		if (!seen.has(rel)) {
			violations.push({
				kind: 'stale-registry-entry',
				file: rel,
				line: 0,
				detail: 'registry declares this file but it has no artifacts insert/upsert site',
			});
		}
		// `stampsSurface: true` with nothing pinning the stamp is a claim the guard
		// never checks — the failure mode this whole script exists to prevent,
		// relocated into its own registry. An entry either pins the stamp or is
		// recorded as a gap; there is no third state.
		if (declared.stampsSurface && getEntryPins(declared).length === 0) {
			violations.push({
				kind: 'unpinned-surface-claim',
				file: rel,
				line: 0,
				detail: 'registry claims stampsSurface: true but declares no requiredPatterns to pin it',
			});
		}
	}

	return { violations, filesScanned, sitesFound: [...seen.values()].reduce((a, b) => a + b, 0) };
}

function buildResult(files) {
	const { violations, filesScanned, sitesFound } = analyzeFiles(files);
	return {
		ok: violations.length === 0,
		filesScanned,
		sitesFound,
		declaredPaths: Object.keys(ARTIFACT_WRITE_SITES).length,
		knownGaps: Object.entries(ARTIFACT_WRITE_SITES)
			.filter(([, d]) => !d.stampsSurface)
			.map(([file, d]) => ({ file, issue: d.issue })),
		violations,
	};
}

function formatReport(result) {
	const lines = [];
	lines.push('Artifact-surface write guard (artifacts.surface, #570)');
	lines.push(
		`Scanned ${result.filesScanned} production TypeScript file(s) under packages/; ` +
			`found ${result.sitesFound} artifacts insert/upsert site(s) across ${result.declaredPaths} declared path(s).`
	);
	if (result.ok) {
		lines.push(
			`OK: every artifacts write path is declared, and every declared stamp is intact.`
		);
		// The gap count is the countdown to the DB constraint. `artifacts.surface`
		// can only take a NOT NULL once every writer stamps one, because the
		// migration is pushed by hand LONG after the code deploys — a single
		// remaining writer means the first write after the push fails in prod
		// (#584). Print the number so it is a number someone can watch reach zero,
		// not a paragraph in a script nobody opens.
		if (result.knownGaps.length > 0) {
			lines.push(
				`${result.knownGaps.length} write path(s) can still produce a NULL surface — ` +
					`declared and tracked, not silent:`
			);
			for (const g of result.knownGaps) lines.push(`  - ${g.file} (#${g.issue})`);
			lines.push(
				`A null surface is not a wrong classification, it is an unaddressable one: ` +
					`ADR-046 §3 keys the role ladder on this column, so no map entry can reach ` +
					`the row. While any gap remains, artifacts.surface cannot take a NOT NULL ` +
					`constraint — see each entry's \`why\` in ARTIFACT_WRITE_SITES.`
			);
		} else {
			// Reaching zero clears the precondition this guard CAN see, and only
			// that one. The constraint has two, and the second is out of this
			// script's reach by construction: an external n8n workflow has written
			// `artifacts` rows straight through PostgREST (14 of them, newest
			// 2025-11-18), and no static scan of TypeScript under packages/ can
			// observe a writer that is not in this repo. Saying "eligible" on the
			// strength of the half we can measure is how the landmine gets armed.
			lines.push(
				`No write path IN THIS REPO can produce a NULL surface — the ` +
					`in-repo precondition for a NOT NULL constraint is met (#736).`
			);
			lines.push(
				`STILL UNVERIFIED, and not checkable from here: the external n8n ` +
					`workflow that wrote artifacts rows directly via PostgREST. Confirm ` +
					`it is retired before adding the constraint, then backfill per ` +
					`migration 091.`
			);
		}
		return lines;
	}
	lines.push('');
	lines.push(`FAIL: ${result.violations.length} problem(s).`);
	lines.push('');
	lines.push('artifacts.surface is the key ADR-046 §3 role resolution and ADR-026 trust');
	lines.push('derivation both hang off. A row written without it is un-gateable (#570).');
	lines.push('');
	for (const v of result.violations) {
		lines.push(`  * [${v.kind}] ${v.file}${v.line ? `:${v.line}` : ''}`);
		lines.push(`      ${v.detail}`);
	}
	lines.push('');
	lines.push('Fix, depending on the kind:');
	lines.push('  undeclared-write-path / site-count-changed —');
	lines.push('    stamp a non-null surface on the new write (see discoverItems() in');
	lines.push('    packages/mcp-server/src/tools/discover.ts for the envelope-rule shape),');
	lines.push('    then declare the file in ARTIFACT_WRITE_SITES in this script.');
	lines.push('  missing-surface-stamp —');
	lines.push('    a path that used to stamp surface no longer does. Restore it, or if the');
	lines.push('    stamp legitimately moved, update the registry pattern to match.');
	lines.push('  stale-registry-entry —');
	lines.push('    the write site is gone; drop the entry from ARTIFACT_WRITE_SITES.');
	lines.push('  unpinned-surface-claim —');
	lines.push('    the entry says stampsSurface: true but pins nothing. Add a');
	lines.push('    requiredPatterns entry matching the stamp, or record it as a gap.');
	return lines;
}

function readPackageFiles(dir) {
	return collectTsFiles(dir).map((abs) => ({
		relPath: toPosix(path.relative(REPO_ROOT, abs)),
		source: fs.readFileSync(abs, 'utf-8'),
	}));
}

function main() {
	const asJson = process.argv.slice(2).includes('--json');
	let files;
	try {
		files = readPackageFiles(PACKAGES_DIR);
	} catch (err) {
		console.error(`Could not read packages dir ${PACKAGES_DIR}: ${err.message}`);
		process.exit(2);
	}
	let result;
	try {
		result = buildResult(files);
	} catch (err) {
		console.error(`Could not analyse files: ${err.message}`);
		process.exit(2);
	}
	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatReport(result).join('\n'));
	}
	process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
	main();
}

module.exports = {
	isTestPath,
	findWriteSites,
	analyzeFiles,
	buildResult,
	formatReport,
	readPackageFiles,
	ARTIFACT_WRITE_SITES,
	PACKAGES_DIR,
};
