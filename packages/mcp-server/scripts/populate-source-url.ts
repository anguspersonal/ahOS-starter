/**
 * CLI entry point for the entities.source_url backfill (#445). All resumable/
 * batched/idempotent logic lives in src/entities/populateSourceUrl.ts (unit-
 * tested there) — this is a thin wrapper that parses args and prints the
 * result, including the "reviewable" list of entities left NULL that a human
 * should work through by hand via people_update.
 *
 * Safe to run repeatedly: only ever touches `people` rows where
 * `source_url IS NULL`, and only ever WRITES when a name has exactly one
 * unambiguous exact-name match in a searched Notion workspace — everything
 * else stays NULL and is reported instead (see the module's own header for
 * why, and #445 / migration 077 for the "NULL = native to the graph" rule
 * this must not violate).
 *
 *   npm --workspace @ahkms/mcp-server run populate-source-url
 *   npm --workspace @ahkms/mcp-server run populate-source-url -- --dry-run
 *   npm --workspace @ahkms/mcp-server run populate-source-url -- --batch-size=10 --max-batches=3
 *   npm --workspace @ahkms/mcp-server run populate-source-url -- --domain=work
 */
import { DOMAINS, type Domain } from "../src/domains.js";
import { runPopulateSourceUrl, type PopulateSourceUrlResult } from "../src/entities/populateSourceUrl.js";

function intArg(flag: string): number | undefined {
	const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
	if (!arg) return undefined;
	const value = Number(arg.split("=")[1]);
	return Number.isFinite(value) ? value : undefined;
}

function domainArg(): Domain[] | undefined {
	const arg = process.argv.find((a) => a.startsWith("--domain="));
	if (!arg) return undefined;
	const value = arg.split("=")[1];
	if (!DOMAINS.includes(value as Domain)) {
		throw new Error(`--domain must be one of ${DOMAINS.join(", ")}, got '${value}'`);
	}
	return [value as Domain];
}

const batchSize = intArg("batch-size");
const maxBatches = intArg("max-batches");
const domains = domainArg();
const dryRun = process.argv.includes("--dry-run");

console.log(`[populate-source-url] starting${dryRun ? " (dry run — no writes)" : ""}`);

const result: PopulateSourceUrlResult = await runPopulateSourceUrl({
	batchSize,
	maxBatches,
	dryRun,
	domains,
});

console.log(
	`[populate-source-url] done: scanned=${result.scanned} populated=${result.populated} ` +
		`no-candidate=${result.skippedNoCandidate} ambiguous=${result.skippedAmbiguous} ` +
		`low-confidence=${result.skippedLowConfidence} conflict=${result.skippedConflict} ` +
		`failed=${result.failed} remaining=${result.remaining}`,
);

if (result.review.length > 0) {
	console.log(
		`\n[populate-source-url] ${result.review.length} entity(ies) left NULL for manual review ` +
			`(confirm via people_update, or people_get to inspect first):\n`,
	);
	for (const item of result.review) {
		console.log(`• [${item.entityId}] ${item.entityName} — ${item.reason}`);
		for (const candidate of item.candidates) {
			console.log(`    (${candidate.domain}) ${candidate.title} — ${candidate.url}`);
		}
	}
}

process.exit(result.failed > 0 ? 1 : 0);
