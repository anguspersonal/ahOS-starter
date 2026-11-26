import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	classifyEmbeddingError,
	embedEntityText,
	embedText,
	withEmbeddingRetry,
	type RetryOptions,
} from "../../domain/embeddings.js";
import type {
	BackfillArtifactRow,
	BackfillEntityRow,
	BackfillRow,
	EmbeddableTable,
	EmbeddingBackfillStore,
	EmbeddingPort,
} from "../../ports/embeddings.js";

const TABLES: EmbeddableTable[] = ["artifacts", "entities"];
const DEFAULT_RUNNER_BATCH_SIZE = 50;
const DEFAULT_TOOL_BATCH_SIZE = 25;
const DEFAULT_TOOL_MAX_BATCHES = 2;
const INTER_BATCH_DELAY_MS = 200;
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_CIRCUIT_BREAK = 3;
const NON_RETRYABLE_CIRCUIT_BREAK = 3;

export const ARTIFACT_EMBED_BACKFILL_DESCRIPTION =
	"Embed artifacts, entities and people that have no vector yet, so they become reachable by " +
	"meaning rather than keywords. Embedding otherwise happens only at write time, so anything " +
	"written while the embedding key was unset or out of credits stays permanently unsearchable until " +
	"this runs. Full notes: docs/guides/tools/artifact_embed_backfill.md";

export const backfillEmbeddingsInput = {
	batch_size: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe(`Rows fetched and embedded per round trip. Default ${DEFAULT_TOOL_BATCH_SIZE}.`),
	max_batches: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe(
			`Cap on batches processed by THIS call \u2014 the budget that keeps one call bounded. Default ${DEFAULT_TOOL_MAX_BATCHES} (so ${DEFAULT_TOOL_BATCH_SIZE * DEFAULT_TOOL_MAX_BATCHES} rows). Raise it to drain faster, at the cost of a longer call.`,
		),
	dry_run: z
		.boolean()
		.optional()
		.describe(
			"Count what would be embedded without calling OpenAI or writing anything. Use to size the backlog before spending credits. Defaults to false.",
		),
};

export const backfillEmbeddingsSchema = z.object(backfillEmbeddingsInput);
export type ArtifactEmbedBackfillInput = z.infer<typeof backfillEmbeddingsSchema>;

export type BackfillOptions = {
	table?: EmbeddableTable;
	batchSize?: number;
	maxBatches?: number;
	dryRun?: boolean;
	retryMaxAttempts?: number;
	retryBaseDelayMs?: number;
	userId?: string;
};

export type BackfillResult = {
	scanned: number;
	embedded: number;
	failed: number;
	remaining: number;
	rateLimited?: boolean;
	configError?: boolean;
};

export type ArtifactEmbedBackfillResult = {
	dryRun: boolean;
	artifacts: BackfillResult;
	entities: BackfillResult;
};

export interface ArtifactEmbedBackfillPorts {
	store?: EmbeddingBackfillStore;
	embeddings?: EmbeddingPort | null | (() => EmbeddingPort | null | undefined);
	userId?: string | (() => string | undefined);
	embedArtifactText?: (row: BackfillArtifactRow) => string;
	embedEntityRowText?: (row: BackfillEntityRow) => string;
	embedWithRetryFn?: (text: string, options: RetryOptions) => Promise<number[]>;
	runTableBackfill?: (
		options: BackfillOptions & { table: EmbeddableTable },
	) => Promise<BackfillResult>;
}

export function backfillExitCode(
	result: Pick<BackfillResult, "rateLimited" | "configError">,
): 0 | 1 {
	return result.rateLimited || result.configError ? 1 : 0;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEmbeddingPort(
	embeddings: ArtifactEmbedBackfillPorts["embeddings"],
): EmbeddingPort | null | undefined {
	return typeof embeddings === "function" ? embeddings() : embeddings;
}

function resolveUserId(
	portUserId: ArtifactEmbedBackfillPorts["userId"],
	override?: string,
): string | undefined {
	if (override && override.length > 0) return override;
	if (!portUserId) return undefined;
	return typeof portUserId === "function" ? portUserId() : portUserId;
}

export async function runCoreEmbeddingBackfill(
	ports: ArtifactEmbedBackfillPorts,
	options: BackfillOptions = {},
): Promise<BackfillResult> {
	const table = options.table ?? "artifacts";
	if (ports.runTableBackfill) {
		return ports.runTableBackfill({ ...options, table });
	}
	const store = ports.store;
	if (!store) {
		throw new Error("EmbeddingBackfillStore is not configured");
	}
	const embedPort = resolveEmbeddingPort(ports.embeddings);
	if (!embedPort && !ports.embedWithRetryFn) {
		console.error(
			"[backfill] Neither GEMINI_API_KEY nor OPENAI_API_KEY is set \u2014 skipping embedding backfill (no-op). Set the key (#429, #1974) and re-run.",
		);
		return { scanned: 0, embedded: 0, failed: 0, remaining: 0 };
	}

	const batchSize = options.batchSize ?? DEFAULT_RUNNER_BATCH_SIZE;
	const maxBatches = options.maxBatches;
	const dryRun = options.dryRun ?? false;
	const userId = resolveUserId(ports.userId, options.userId);
	const retry = {
		maxAttempts: options.retryMaxAttempts ?? RETRY_MAX_ATTEMPTS,
		baseDelayMs: options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS,
	};
	const buildArtifactText = ports.embedArtifactText ?? embedText;
	const buildEntityText = ports.embedEntityRowText ?? embedEntityText;
	const runEmbedWithRetry =
		ports.embedWithRetryFn ??
		((text: string, retryOpts: RetryOptions) =>
			withEmbeddingRetry(() => embedPort!.embed(text), retryOpts));

	let scanned = 0;
	let embedded = 0;
	let failed = 0;
	let cursor: string | null = null;
	let batches = 0;
	let consecutiveRateLimits = 0;
	let consecutiveNonRetryable = 0;
	let rateLimited = false;
	let configError = false;

	while (maxBatches === undefined || batches < maxBatches) {
		const rows = await store.selectUnembeddedBatch(table, batchSize, cursor, userId);
		if (rows.length === 0) break;
		batches += 1;

		for (const row of rows) {
			scanned += 1;
			try {
				const text =
					table === "entities"
						? buildEntityText(row as BackfillEntityRow)
						: buildArtifactText(row as BackfillArtifactRow);
				if (text) {
					if (!dryRun) {
						const vector = await runEmbedWithRetry(text, {
							maxAttempts: retry.maxAttempts,
							baseDelayMs: retry.baseDelayMs,
							onRetry: ({ attempt, delayMs }) =>
								console.error(
									`[backfill] ${row.id}: provider error, retry ${attempt} in ${delayMs}ms`,
								),
						});
						await store.setEmbedding(table, row.id, vector);
					}
					embedded += 1;
				}
				consecutiveRateLimits = 0;
				consecutiveNonRetryable = 0;
			} catch (err) {
				failed += 1;
				console.error(`[backfill] ${row.id}: ${errMessage(err)}`);
				const kind = classifyEmbeddingError(err);
				if (kind === "rate_limit") {
					consecutiveRateLimits += 1;
					if (consecutiveRateLimits >= RATE_LIMIT_CIRCUIT_BREAK) {
						rateLimited = true;
						break;
					}
				} else if (kind === "auth" || kind === "unknown") {
					consecutiveNonRetryable += 1;
					if (consecutiveNonRetryable >= NON_RETRYABLE_CIRCUIT_BREAK) {
						configError = true;
						break;
					}
				}
			}
		}

		cursor = (rows[rows.length - 1] as BackfillRow).id;
		if (rateLimited || configError) break;
		if (rows.length < batchSize) break;
		if (maxBatches !== undefined && batches >= maxBatches) break;
		if (!dryRun) await sleep(INTER_BATCH_DELAY_MS);
	}

	const remaining = await store.countRemaining(table, userId);
	if (rateLimited) return { scanned, embedded, failed, remaining, rateLimited: true };
	if (configError) return { scanned, embedded, failed, remaining, configError: true };
	return { scanned, embedded, failed, remaining };
}

function reportTable(table: EmbeddableTable, dryRun: boolean, result: BackfillResult): string[] {
	const skipped = result.scanned - result.embedded - result.failed;
	const noun = table === "entities" ? "entity/person" : "artifact";
	const lines = [
		`${table}: scanned=${result.scanned} embedded=${result.embedded} failed=${result.failed}` +
			(skipped > 0 ? ` skipped-no-text=${skipped}` : "") +
			` remaining=${result.remaining}`,
	];

	if (result.remaining > 0) {
		lines.push(
			`  ${result.remaining} ${noun}(s) still unembedded \u2014 call artifact_embed_backfill again to continue (it resumes automatically: only embedding IS NULL rows are ever selected).`,
		);
		if (skipped > 0) {
			lines.push(
				`  Note: ${skipped} row(s) this call had no embeddable text. Rows like that stay in 'remaining' permanently \u2014 if a repeat call reports scanned>0 but embedded=0, the backlog is exhausted apart from those.`,
			);
		}
	} else if (!dryRun) {
		lines.push(`  Backlog drained \u2014 every embeddable ${noun} now has a vector.`);
	}

	if (result.failed > 0) {
		lines.push(
			`  ${result.failed} row(s) failed this call (see server logs). They stay embedding IS NULL and will be retried on the next call.`,
		);
	}

	if (result.rateLimited) {
		lines.push(
			"  Stopped early: the embedding provider kept rate-limiting. Check quota/billing and re-run.",
		);
	} else if (result.configError) {
		lines.push(
			"  Stopped early: OPENAI_API_KEY looks broken (missing, revoked, or invalid). Fix it and re-run.",
		);
	}

	return lines;
}

export function formatArtifactEmbedBackfillMcp(result: ArtifactEmbedBackfillResult): string {
	const lines = [
		`artifact_embed_backfill${result.dryRun ? " (dry run \u2014 nothing written)" : ""}:`,
		...reportTable("artifacts", result.dryRun, result.artifacts),
		...reportTable("entities", result.dryRun, result.entities),
	];
	return lines.join("\n");
}


export function createArtifactEmbedBackfillAction(
	ports: ArtifactEmbedBackfillPorts,
): ActionDefinition<typeof backfillEmbeddingsSchema, ArtifactEmbedBackfillResult> {
	return defineAction({
		id: "artifact_embed_backfill",
		description: ARTIFACT_EMBED_BACKFILL_DESCRIPTION,
		domain: "artifacts",

		schema: backfillEmbeddingsSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input, ctx) => {
			const dryRun = input.dry_run ?? false;
			const baseOptions: BackfillOptions = {
				batchSize: input.batch_size ?? DEFAULT_TOOL_BATCH_SIZE,
				maxBatches: input.max_batches ?? DEFAULT_TOOL_MAX_BATCHES,
				dryRun,
				...(ctx.userId ? { userId: ctx.userId } : {}),
			};
			const results: Record<EmbeddableTable, BackfillResult> = {
				artifacts: { scanned: 0, embedded: 0, failed: 0, remaining: 0 },
				entities: { scanned: 0, embedded: 0, failed: 0, remaining: 0 },
			};
			for (const table of TABLES) {
				results[table] = await runCoreEmbeddingBackfill(ports, { ...baseOptions, table });
			}
			return {
				dryRun,
				artifacts: results.artifacts,
				entities: results.entities,
			};
		},
		formatMcp: formatArtifactEmbedBackfillMcp,
	});
}
