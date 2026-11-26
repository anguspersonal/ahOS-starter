/**
 * CLI entry point for the embedding backfill (#427 Part 1; extended to sweep
 * `entities` too by #551 / ADR-047 §2 slice 2). All resumable/batched/
 * idempotent logic lives in src/embeddings/backfill.ts (unit-tested there) —
 * this is a thin wrapper that parses args and logs the result.
 *
 * Safe to run repeatedly: only ever touches `<table>.embedding IS NULL` rows,
 * and no-ops cleanly if OPENAI_API_KEY (#429) isn't set yet.
 *
 *   npm --workspace @ahkms/mcp-server run backfill-embeddings
 *   npm --workspace @ahkms/mcp-server run backfill-embeddings -- --batch-size=25 --max-batches=5 --dry-run
 *   npm --workspace @ahkms/mcp-server run backfill-embeddings -- --retry-attempts=8 --retry-base-delay-ms=2000
 *
 * Sweeps `artifacts` then `entities` (which covers `people` too — a view over
 * the same physical rows, migration 095) using the SAME budget for each; exits
 * 1 if EITHER table's run stopped early — either because the provider kept
 * rate-limiting or because consecutive rows failed with a non-retryable
 * (auth/config) error — so a wrapper script/cron notices rather than reporting
 * a successful no-op. The exit-code decision itself lives in backfillExitCode
 * (src/embeddings/backfill.ts) and is unit tested there: this script is a tsx
 * entry point, not something the test runner imports, so round 1 added
 * `configError` to the result but this file never gained a matching check — a
 * revoked API key exited 0 silently until round 2 QA review, #515.
 */
import { runEmbeddingBackfill, backfillExitCode, type BackfillResult } from "../src/embeddings/backfill.js";
import type { EmbeddableTable } from "../src/embeddings.js";

const TABLES: EmbeddableTable[] = ["artifacts", "entities"];

function intArg(flag: string): number | undefined {
	const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
	if (!arg) return undefined;
	const value = Number(arg.split("=")[1]);
	return Number.isFinite(value) ? value : undefined;
}

const batchSize = intArg("batch-size");
const maxBatches = intArg("max-batches");
const retryMaxAttempts = intArg("retry-attempts");
const retryBaseDelayMs = intArg("retry-base-delay-ms");
const dryRun = process.argv.includes("--dry-run");

console.log(
	`[backfill-embeddings] starting${dryRun ? " (dry run)" : ""}` +
		(batchSize !== undefined ? ` batchSize=${batchSize}` : "") +
		(maxBatches !== undefined ? ` maxBatches=${maxBatches}` : ""),
);

let anyRateLimited = false;
let anyConfigError = false;

for (const table of TABLES) {
	const result: BackfillResult = await runEmbeddingBackfill({
		table,
		batchSize,
		maxBatches,
		dryRun,
		retryMaxAttempts,
		retryBaseDelayMs,
	});

	console.log(
		`[backfill-embeddings] ${table}: scanned=${result.scanned} embedded=${result.embedded} ` +
			`failed=${result.failed} remaining=${result.remaining}`,
	);

	if (result.rateLimited) {
		anyRateLimited = true;
		console.error(
			`[backfill-embeddings] ${table} stopped early — the embedding provider kept returning ` +
				"rate-limit/quota errors. Nothing is lost: re-run once quota is restored and " +
				"it resumes from where it stopped.",
		);
	} else if (result.configError) {
		anyConfigError = true;
		console.error(
			`[backfill-embeddings] ${table} stopped early — the embedding provider's API key looks ` +
				"broken (missing, revoked, or invalid). Nothing is lost: fix OPENAI_API_KEY " +
				"and re-run — it resumes from where it stopped.",
		);
	}
}

process.exit(backfillExitCode({ rateLimited: anyRateLimited, configError: anyConfigError }));
