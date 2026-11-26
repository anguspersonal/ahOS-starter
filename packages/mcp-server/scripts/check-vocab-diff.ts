/**
 * CLI entry point for the vocab-diff CI guard (#455, ADR-037 §5). All the
 * assertion logic lives in src/vocab/vocabDiff.ts (unit-tested there against
 * fixtures) — this just fetches the live graph, prints the report, and sets
 * the exit code.
 *
 * Needs a live DB: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the same two
 * vars packages/mcp-server/src/env.ts already requires). Not wired into
 * pr-guards.yml, which is deliberately credential-free — run on a schedule
 * instead (.github/workflows/vocab-diff.yml), same posture as
 * packages/worker/scripts/check-migration-drift.js and its
 * migration-drift.yml, and for the same reason: these are DATA assertions
 * against the live graph, not static repo checks.
 *
 *   npm --workspace @ahkms/mcp-server run check-vocab-diff
 *   npm --workspace @ahkms/mcp-server run check-vocab-diff -- --json
 *
 * Exit codes: 0 = clean; 1 = violations found; 2 = could not run (missing
 * env, query failure, unexpected error).
 */
import { runVocabDiff, formatVocabDiffReport } from "../src/vocab/vocabDiff.js";

const json = process.argv.includes("--json");

async function main() {
	const result = await runVocabDiff();
	if (json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		for (const line of formatVocabDiffReport(result)) console.log(line);
	}
	process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
	console.error(`check-vocab-diff failed to run: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
});
