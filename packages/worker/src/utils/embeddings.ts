/**
 * Minimal embed-on-write client for the worker package (#882, ADR-047 §2
 * follow-up to #551).
 *
 * #551 wired `embedAndStore` (packages/mcp-server/src/embeddings.ts) into
 * every mcp-server write path that creates/updates `entities` rows. This
 * package has no dependency on `@ahkms/mcp-server` (an app-layer tool package
 * importing another app-layer tool package would be a layering violation —
 * see the SYSTEM_RELATIONSHIP_TYPES comment in organizeEntities.ts) and,
 * before this file, no embedding client at all: no `openai` dependency, no
 * `env.ts`/`supabase.ts` shape compatible with mcp-server's ESM-module
 * versions of the same names (this package is CommonJS; mcp-server's
 * `embeddings.ts` is bound to its own `./env.js` and `./supabase.js`
 * singletons, neither of which lives in `@ahkms/shared`). So rather than
 * relocating those singletons into `@ahkms/shared` (a materially bigger,
 * unrelated refactor of mcp-server's own module boundaries), this is a
 * minimal, self-contained duplicate that mirrors mcp-server's contract
 * exactly where it matters:
 *   - same env var (`OPENAI_API_KEY`), same optional model override
 *     (`KMS_EMBED_MODEL`, same `text-embedding-3-small` default — the same
 *     1536-dimension model migration 095's `entities.embedding vector(1536)`
 *     column assumes),
 *   - the same `embedEntityText` composition mcp-server's `embedEntityText`
 *     uses (title + description + properties.{role,organization,
 *     relationship}), matching migration 095's `search_vector` generated
 *     column so FTS and the embedding see the same text,
 *   - the same best-effort contract: never throws, logs and leaves
 *     `entities.embedding` untouched (NULL, or whatever it already was) on
 *     any failure — the backfill (`backfill_embeddings` / #551) already
 *     sweeps `entities.embedding IS NULL` as the catch-up path.
 *
 * Retries use this package's own `retryWithBackoff` (./retry.ts) rather than
 * porting mcp-server's `withEmbeddingRetry` + its `isRetryableEmbeddingError`
 * classification — the worker's convention retries every thrown failure
 * (network blip, 429, 5xx alike) instead of first bucketing errors by kind,
 * which is a fine trade here since the outer `embedEntityAndStore` swallows
 * whatever remains after retries anyway.
 */

import OpenAI from 'openai';
import { supabase } from './supabase';
import { retryWithBackoff } from './retry';
import logger from './logger';

const MAX_CHARS = 28_000;

type GeminiAdapterFactory = (config: {
  apiKey: string | undefined | (() => string | undefined);
  model?: string | (() => string | undefined);
  fetchFn?: typeof fetch;
}) => {
  embed(text: string): Promise<number[]>;
};

const builtinModule = process.getBuiltinModule('module') as typeof import('module');
const nativeRequire = builtinModule.createRequire(__filename);

let _client: OpenAI | null = null;
function openaiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set — embeddings disabled.');
  return (_client ??= new OpenAI({ apiKey }));
}

function embedModel(): string {
  return process.env.KMS_EMBED_MODEL || 'text-embedding-3-small';
}

export interface EntityEmbeddableFields {
  title?: string | null;
  description?: string | null;
  properties?: Record<string, unknown> | null;
}

/**
 * The text an `entities` row is embedded from. Mirrors
 * `packages/mcp-server/src/embeddings.ts`'s `embedEntityText` exactly (same
 * fields, same order, same join/truncate), which itself mirrors migration
 * 095's `search_vector` composition.
 */
export function embedEntityText(e: EntityEmbeddableFields): string {
  const props = e.properties ?? {};
  const role = typeof props.role === 'string' ? props.role : null;
  const organization = typeof props.organization === 'string' ? props.organization : null;
  const relationship = typeof props.relationship === 'string' ? props.relationship : null;
  return [e.title, e.description, role, organization, relationship]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_CHARS)
    .trim();
}

async function embedWithGemini(text: string, apiKey: string): Promise<number[]> {
  const { createGeminiEmbeddingAdapter } = nativeRequire('@ahkms/core/adapters') as {
    createGeminiEmbeddingAdapter: GeminiAdapterFactory;
  };
  const adapter = createGeminiEmbeddingAdapter({
    apiKey,
    model: process.env.KMS_GEMINI_EMBED_MODEL,
    fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
  });
  return adapter.embed(text);
}

async function embed(text: string): Promise<number[]> {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    return embedWithGemini(text, geminiKey);
  }
  const res = await openaiClient().embeddings.create({
    model: embedModel(),
    input: text,
  });
  const embedding = res.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    // Malformed/empty OpenAI response (missing `data`, an empty `data`
    // array, or a non-array `embedding`). Throw so the caller's catch-all
    // treats this the same as any other provider failure — logged,
    // swallowed, row left untouched — rather than writing a bad value to
    // entities.embedding.
    throw new Error('OpenAI embeddings response did not include a valid embedding array.');
  }
  return embedding;
}

export type EmbedOutcome =
  /** Vector computed and written to entities.embedding. */
  | 'embedded'
  /** Nothing to do: no key configured, or no embeddable text. */
  | 'skipped'
  /** Provider or DB error — logged, swallowed, row left untouched. */
  | 'failed';

/**
 * Best-effort: build the embed text, call the API (retrying transient
 * failures with this package's own backoff), write to
 * `entities.<id>.embedding`. Never throws — callers (entity extraction,
 * merge/dedup) must not fail their workflow step because embedding failed. A
 * row left unembedded here is picked up later by the backfill
 * (`embedding IS NULL` is the work queue), so a provider outage costs
 * recall, never data (same contract as mcp-server's `embedAndStore`).
 */
export async function embedEntityAndStore(
  id: string,
  fields: EntityEmbeddableFields,
): Promise<EmbedOutcome> {
  if (!process.env.GEMINI_API_KEY?.trim() && !process.env.OPENAI_API_KEY?.trim()) return 'skipped';
  const text = embedEntityText(fields);
  if (!text) return 'skipped';
  try {
    const vector = await retryWithBackoff(() => embed(text));
    const { error } = await supabase
      .from('entities')
      .update({ embedding: JSON.stringify(vector) })
      .eq('id', id);
    if (error) throw error;
    return 'embedded';
  } catch (err) {
    logger.warn('[embedEntityAndStore] failed', {
      entityId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
