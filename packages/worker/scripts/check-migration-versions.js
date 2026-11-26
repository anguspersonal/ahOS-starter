#!/usr/bin/env node

// Migration filename guard — duplicate versions caught before merge, no DB (#585).
//
// WHY THIS EXISTS (third occurrence — see #585):
//   Two migration files can carry the same version and nothing catches it before
//   merge. The second `supabase db push` then dies with
//   `duplicate key value violates unique constraint "schema_migrations_pkey"`.
//   It has happened three times: the July-2026 074 collision, its 075
//   reincarnation, and 2026-08-07, when PR #582 (`20260807120000_084_…`) and
//   PR #583 (`20260807120000_083_…`) were authored in parallel by two agents.
//   Neither branch could see the collision — each contained only its own file —
//   and a human reading across both PRs caught it. That is a machine's job.
//
//   `check-migration-drift.js` has detected the same-timestamp case since 074
//   (Check C), but it is unreachable at PR time: `main()` exits 2 on a missing
//   SUPABASE_DB_URL before ever reaching it, and its workflow deliberately does
//   not run on `pull_request` (Check A false-positives on every migration PR).
//   So the detector existed and never once ran on a PR. This script is the
//   credential-free half, split out so it can run where it is needed.
//
// WHAT IS THE IDENTITY — the timestamp or the sequence number?
//   `supabase/migrations/` names files `<YYYYMMDDHHMMSS>_<NNN>_<slug>.sql`, and
//   the answer is that BOTH are identities, of different things:
//
//     - The 14-digit TIMESTAMP is the machine identity. It is verbatim the
//       `supabase_migrations.schema_migrations.version` primary key. Two files
//       sharing it is a hard breakage: `db push` applies one, commits its
//       version row, and the sibling fails on the unique constraint.
//
//     - The 3-digit SEQUENCE is the human identity. It never reaches the
//       database, but it is how this repo's docs, issues, ADRs and runbooks
//       name a migration ("migration 069 broke prod search", `supabase/README.md`).
//       Two files answering to "084" makes every such reference ambiguous —
//       the repo already carries five such ambiguities (049, 052, 053, 054,
//       055), each one a past instance of this same race.
//
//   The sequence is also the EARLIER signal. Two branches that both mint `_091_`
//   were both reading the same latest-on-dev (090); they raced. Whether their
//   timestamps happened to collide as well is luck. Guarding only the timestamp
//   would catch the collision that breaks `db push` and miss the race that
//   produces it — so this guard fails on either, with different remedies.
//
//   That answers #585's open question ("should the repo stop encoding the
//   sequence in two places?"): the sequence stays, and this guard is what keeps
//   it honest. Enforcing that sequence ORDER agrees with timestamp order is a
//   strictly larger rule that today's history violates repeatedly — tracked
//   separately, not folded in here.
//
// WHY A WHOLE-DIRECTORY SCAN AND NOT A DIFF AGAINST THE BASE BRANCH:
//   On `pull_request`, actions/checkout resolves `refs/pull/N/merge` — the PR's
//   head already merged into the base tip. So the tree this scans IS the merge
//   result: base's migrations and the PR's, together. That is precisely the view
//   neither #582 nor #583 had of itself, and it needs no git plumbing, so the
//   same command behaves identically on a laptop.
//
//   pr-guards.yml fires on PRs into `dev` AND into `main`, which gives two
//   layers: a feature PR is checked against dev, and the dev -> main release PR
//   re-checks the whole set immediately before the release that runs `db push`.
//   A collision that slipped past two simultaneously-green feature PRs (this
//   repo has no "require branches up to date" protection) is still caught on the
//   release PR, one step before it could break anything.
//
// GRANDFATHERING IS EXPLICIT AND COUNTED, NEVER SILENT:
//   Thirteen committed files predate this rule — three from before the `<NNN>`
//   convention existed, and ten in five already-duplicated sequences. They are
//   named individually below. A collision is forgiven only when EVERY file in it
//   is grandfathered, so a new file joining a legacy sequence still fails. The
//   exemptions are reported on success, and an exemption naming a file that is
//   no longer there fails the check rather than quietly covering nothing.
//
//   Applied migrations are never renamed (see the runbook) — grandfathering is
//   the only honest option, and fix-forward is the whole posture.
//
// Usage:
//   node packages/worker/scripts/check-migration-versions.js [--json]
//   or: npm run check:migration-versions      (from the repo root)
//
// Exit codes: 0 = every version and sequence is unique; 1 = violations found;
// 2 = could not run (missing directory, unexpected error).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATIONS_DIR_REL = 'supabase/migrations';

// The naming convention: <YYYYMMDDHHMMSS>_<NNN>_<lower_snake_slug>.sql
const MIGRATION_FILENAME = /^(\d{14})_(\d{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const VERSION_PREFIX = /^(\d{14})_/;
const SEQUENCE_AFTER_VERSION = /^\d{14}_(\d{3})_/;
// Case-insensitive on purpose: a stray `.SQL` should be reported as malformed,
// not waved through as "not a migration".
const SQL_FILE = /\.sql$/i;

// Files committed before the `<NNN>` convention existed — Supabase generated the
// two `remote_schema` snapshots, and 20260610203913 was the un-numbered twin of
// migration 049. Exempt from the naming rule ONLY: they still hold a version and
// still take part in version uniqueness.
const PRE_CONVENTION_FILES = new Set([
	'20251226182232_remote_schema.sql',
	'20251226190357_remote_schema.sql',
	'20260610203913_entity_relationships_graph_edges.sql',
]);

// Sequence numbers already duplicated on dev when this guard landed — five
// pairs, every one a past instance of the race #585 is about. They are applied
// in prod and must not be renamed. Listed as whole pairs so that a NEW file
// joining any of these sequences still fails.
//
// 097 is the sixth pair, and the first one this guard actually caught — except
// that it caught it in a repository where nothing was running it. Both files
// merged on 2026-08-25, the guard went red on `dev` the same day, and nobody saw
// it for two days because `pr-guards.yml` is its only caller and Actions were
// quota-starved (#867). ADR-071 gave the guards a local execution path, running
// them found this, and #918 is the record.
//
// Grandfathered rather than renamed, for the reason this file's own header gives:
// applied migrations are never renamed. Both are in `schema_migrations` on prod
// (`20260825120000` and `20260825180000`), and 098 has since landed on top. The
// timestamps never collided, so `db push` was never at risk — the damage is
// confined to the human identity, which is exactly what grandfathering records.
// Renumbering the later file to 099 would also put its sequence AFTER 098 while
// its timestamp sits BEFORE it, trading an ambiguity for an ordering violation.
const GRANDFATHERED_SEQUENCE_COLLISIONS = new Set([
	'20260610120000_049_entity_relationships_graph_edges.sql',
	'20260615120000_049_seed_user_integrations_notion.sql',
	'20260619123000_052_add_drive_ingest_routing_columns.sql',
	'20260619130000_052_add_user_id_to_relationship_tables.sql',
	'20260621120000_053_rename_notion_to_notion_work.sql',
	'20260627120000_053_add_self_entity_to_user_preferences.sql',
	'20260621140000_054_rename_dos_eod_config_to_dos_hl_config.sql',
	'20260627130000_054_add_event_entity_type.sql',
	'20260621150000_055_extend_dos_hl_config.sql',
	'20260627140000_055_add_artifact_provenance.sql',
	// 097 — see the note above (#918).
	'20260825120000_097_rename_dos_hl_config_to_dos_config.sql',
	'20260825180000_097_entities_people_hybrid_search_rpcs.sql',
]);

// Cutoff timestamp for sequence monotonicity enforcement (#731).
// Sorting migrations by timestamp must yield non-decreasing sequence numbers
// for all files whose timestamp is after this cutoff. Older history is
// grandfathered because historical out-of-order migrations exist (e.g. 20250115's
// 032 before 20251226's 010-031, and 20260627's 053-055 after 20260621's 058).
// The newest out-of-order file in history is 20260627140000_055_add_artifact_provenance.sql.
const MONOTONICITY_CUTOFF = '20260627140000';

/** True when 14 digits denote a real UTC instant (rejects month 13, 31 February). */
function isCalendarTimestamp(version) {
	const [year, month, day, hour, minute, second] = [
		version.slice(0, 4),
		version.slice(4, 6),
		version.slice(6, 8),
		version.slice(8, 10),
		version.slice(10, 12),
		version.slice(12, 14),
	].map(Number);
	if (hour > 23 || minute > 59 || second > 59) return false;
	const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

/** Why a `.sql` filename failed the convention, phrased as the fix. */
function describeMalformed(filename) {
	if (!VERSION_PREFIX.test(filename)) {
		return 'does not start with a 14-digit YYYYMMDDHHMMSS version';
	}
	if (!SEQUENCE_AFTER_VERSION.test(filename)) {
		return 'has no 3-digit sequence number between the version and the slug';
	}
	return 'slug must be lower_snake_case (a-z, 0-9, single underscores)';
}

/**
 * Classify one directory entry. Pure.
 *
 * @param {string} filename
 * @returns {{kind: 'ignored', filename: string}
 *          |{kind: 'malformed', filename: string, version: string|null, reason: string}
 *          |{kind: 'migration', filename: string, version: string, sequence: string, slug: string}}
 *
 * `malformed` still carries a `version` when the name opens with 14 digits, so
 * a pre-convention file cannot smuggle a duplicate version past the check.
 */
function parseMigrationFilename(filename) {
	if (!SQL_FILE.test(filename)) return { kind: 'ignored', filename };

	const prefix = VERSION_PREFIX.exec(filename);
	const version = prefix === null ? null : prefix[1];
	const malformed = (reason) => ({ kind: 'malformed', filename, version, reason });

	const match = MIGRATION_FILENAME.exec(filename);
	if (match === null) return malformed(describeMalformed(filename));
	if (!isCalendarTimestamp(match[1])) {
		return malformed(`version ${match[1]} is not a real UTC timestamp`);
	}
	return { kind: 'migration', filename, version: match[1], sequence: match[2], slug: match[3] };
}

/** Filenames sharing a key, keyed groups of 2+. Entries with a null key are skipped. */
function duplicateGroups(entries, keyOf) {
	const byKey = new Map();
	for (const entry of entries) {
		const key = keyOf(entry);
		if (key === null) continue;
		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key).push(entry.filename);
	}
	return [...byKey.entries()]
		.filter(([, files]) => files.length > 1)
		.map(([key, files]) => ({ key, files: [...files].sort() }))
		.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Pure core: the whole ruling, from a directory listing. No I/O — the unit tests
 * drive this with synthetic filenames.
 *
 * @param {object} inputs
 * @param {string[]} inputs.filenames - file listing of supabase/migrations/
 * @param {Set<string>} [inputs.preConventionFiles] - exempt from the naming rule
 * @param {Set<string>} [inputs.grandfatheredSequences] - exempt from sequence uniqueness
 * @param {string} [inputs.monotonicityCutoff] - timestamp cutoff for sequence monotonicity (#731)
 */
function buildResult({
	filenames,
	preConventionFiles = PRE_CONVENTION_FILES,
	grandfatheredSequences = GRANDFATHERED_SEQUENCE_COLLISIONS,
	monotonicityCutoff = MONOTONICITY_CUTOFF,
}) {
	const parsed = filenames.map(parseMigrationFilename);
	const versioned = parsed.filter((entry) => entry.kind !== 'ignored');
	const migrations = parsed.filter((entry) => entry.kind === 'migration');

	// No exemption: a duplicate version is never survivable, and none exists today.
	const duplicateVersions = duplicateGroups(versioned, (entry) => entry.version).map((group) => ({
		kind: 'duplicate-version',
		version: group.key,
		files: group.files,
	}));

	const sequenceGroups = duplicateGroups(migrations, (entry) => entry.sequence);
	const isGrandfathered = (group) => group.files.every((file) => grandfatheredSequences.has(file));
	const duplicateSequences = sequenceGroups.filter((group) => !isGrandfathered(group)).map((group) => ({
		kind: 'duplicate-sequence',
		sequence: group.key,
		files: group.files,
	}));

	// Monotonicity check (#731):
	// Sorting migrations by timestamp must yield non-decreasing sequence numbers
	// for any file whose timestamp is after monotonicityCutoff.
	// Older migrations are grandfathered explicitly by cutoff timestamp.
	const sortedMigrations = [...migrations].sort((a, b) => {
		const cmp = a.version.localeCompare(b.version);
		if (cmp !== 0) return cmp;
		return a.sequence.localeCompare(b.sequence);
	});

	let maxSequence = -1;
	let maxSequenceEntry = null;
	const nonMonotonic = [];

	for (const entry of sortedMigrations) {
		const seq = parseInt(entry.sequence, 10);
		if (entry.version > monotonicityCutoff) {
			if (seq < maxSequence && maxSequenceEntry !== null) {
				nonMonotonic.push({
					kind: 'non-monotonic-sequence',
					filename: entry.filename,
					version: entry.version,
					sequence: entry.sequence,
					priorFilename: maxSequenceEntry.filename,
					priorVersion: maxSequenceEntry.version,
					priorSequence: maxSequenceEntry.sequence,
				});
			}
		}
		if (seq > maxSequence) {
			maxSequence = seq;
			maxSequenceEntry = entry;
		}
	}

	const malformed = parsed
		.filter((entry) => entry.kind === 'malformed' && !preConventionFiles.has(entry.filename))
		.map((entry) => ({ kind: 'malformed-filename', filename: entry.filename, reason: entry.reason }));

	// An exemption for a file that is gone forgives nothing and hides the next
	// collision on that name. Deleting the entry is the fix.
	const present = new Set(filenames);
	const staleExemptions = [...preConventionFiles, ...grandfatheredSequences]
		.filter((file) => !present.has(file))
		.sort()
		.map((filename) => ({ kind: 'stale-exemption', filename }));

	const violations = [
		...duplicateVersions,
		...duplicateSequences,
		...nonMonotonic,
		...malformed,
		...staleExemptions,
	];

	return {
		ok: violations.length === 0,
		counts: {
			entries: filenames.length,
			migrations: migrations.length,
			ignored: parsed.length - versioned.length,
		},
		grandfathered: {
			preConvention: parsed
				.filter((entry) => entry.kind === 'malformed' && preConventionFiles.has(entry.filename))
				.map((entry) => entry.filename)
				.sort(),
			sequences: sequenceGroups.filter(isGrandfathered).map((group) => group.key),
		},
		violations,
	};
}

/** One human-readable block per violation. Pure. */
function describeViolation(violation) {
	switch (violation.kind) {
		case 'duplicate-version':
			return [
				`COLLISION: version ${violation.version} is claimed by ${violation.files.length} files:`,
				...violation.files.map((file) => `    ${MIGRATIONS_DIR_REL}/${file}`),
				'  Both stamp the same supabase_migrations.version, so the second',
				'  `supabase db push` dies with `duplicate key value violates unique',
				'  constraint "schema_migrations_pkey"`. Give the UNMERGED file a new',
				'  timestamp — never rename a migration already applied to prod.',
			];
		case 'duplicate-sequence':
			return [
				`COLLISION: sequence ${violation.sequence} is claimed by ${violation.files.length} files:`,
				...violation.files.map((file) => `    ${MIGRATIONS_DIR_REL}/${file}`),
				'  Two branches both minted "the next" migration off the same tip, so',
				'  every reference to this number is now ambiguous. Renumber the',
				'  UNMERGED file to the next free sequence (and re-stamp its timestamp',
				'  if that collides too).',
			];
		case 'non-monotonic-sequence':
			return [
				`NON-MONOTONIC: ${MIGRATIONS_DIR_REL}/${violation.filename}`,
				`  Sequence ${violation.sequence} is lower than prior sequence ${violation.priorSequence} from ${violation.priorFilename}.`,
				'  Sorting migrations by timestamp must yield non-decreasing sequence numbers (#731).',
				'  Renumber the UNMERGED file to a sequence greater than or equal to the prior sequence.',
			];
		case 'malformed-filename':
			return [
				`MALFORMED: ${MIGRATIONS_DIR_REL}/${violation.filename}`,
				`  ${violation.reason}.`,
				'  Rename it to <YYYYMMDDHHMMSS>_<NNN>_<lower_snake_slug>.sql — an',
				'  unparseable name has no comparable version, so no guard can protect it.',
			];
		case 'stale-exemption':
			return [
				`STALE EXEMPTION: ${violation.filename} is grandfathered but no longer exists.`,
				'  Delete its entry from PRE_CONVENTION_FILES /',
				'  GRANDFATHERED_SEQUENCE_COLLISIONS in this script.',
			];
		default:
			return [`UNKNOWN VIOLATION: ${JSON.stringify(violation)}`];
	}
}

/** Human-readable report lines for a buildResult() result. Pure. */
function formatReport(result) {
	const lines = [`Migration version guard — ${MIGRATIONS_DIR_REL}/`];

	if (result.ok) {
		lines.push(
			`  OK: ${result.counts.migrations} migration file(s); every version and sequence is unique.`
		);
	} else {
		for (const violation of result.violations) {
			for (const line of describeViolation(violation)) lines.push(`  ${line}`);
		}
	}

	const { preConvention, sequences } = result.grandfathered;
	if (preConvention.length > 0) {
		lines.push(
			`  Grandfathered: ${preConvention.length} pre-convention file(s) exempt from the naming rule (${preConvention.join(', ')}).`
		);
	}
	if (sequences.length > 0) {
		lines.push(
			`  Grandfathered: ${sequences.length} pre-existing sequence collision(s) — ${sequences.join(', ')}.`
		);
	}
	if (result.counts.ignored > 0) {
		const noun = result.counts.ignored === 1 ? 'entry' : 'entries';
		lines.push(`  Ignored ${result.counts.ignored} non-.sql ${noun}.`);
	}

	lines.push('');
	lines.push(
		result.ok
			? 'No duplicate migration versions.'
			: 'Fix before merging — see supabase/README.md "Migration authoring gotchas" and ' +
					'docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md.'
	);
	return lines;
}

/** The only I/O: the migrations directory listing. Sub-directories are not migrations. */
function readMigrationFilenames(dir = MIGRATIONS_DIR) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
}

/**
 * `::error file=…::` so a failure lands on the PR's Files-changed tab, not just
 * the log. A stale exemption names a file that is gone, so it gets an unanchored
 * `::error::` — anchoring to a path GitHub cannot resolve would swallow it.
 */
function annotate(violation) {
	const [headline] = describeViolation(violation);
	if (violation.kind === 'stale-exemption') {
		console.log(`::error::${headline}`);
		return;
	}
	const files = violation.files ?? [violation.filename];
	for (const file of files) {
		console.log(`::error file=${MIGRATIONS_DIR_REL}/${file}::${headline}`);
	}
}

function main() {
	const asJson = process.argv.slice(2).includes('--json');

	let filenames;
	try {
		filenames = readMigrationFilenames();
	} catch (err) {
		console.error(`Could not read ${MIGRATIONS_DIR_REL}/: ${err.message}`);
		process.exit(2);
	}

	let result;
	try {
		result = buildResult({ filenames });
	} catch (err) {
		console.error(`check-migration-versions failed to run: ${err.message}`);
		process.exit(2);
	}

	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatReport(result).join('\n'));
	}

	if (!result.ok && process.env.GITHUB_ACTIONS === 'true') {
		for (const violation of result.violations) annotate(violation);
	}

	process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
	main();
}

module.exports = {
	isCalendarTimestamp,
	describeMalformed,
	parseMigrationFilename,
	duplicateGroups,
	buildResult,
	describeViolation,
	formatReport,
	annotate,
	readMigrationFilenames,
	MIGRATIONS_DIR,
	MIGRATIONS_DIR_REL,
	PRE_CONVENTION_FILES,
	GRANDFATHERED_SEQUENCE_COLLISIONS,
	MONOTONICITY_CUTOFF,
};
