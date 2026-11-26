// ---------------------------------------------------------------------------
// Entity read column list (#550 / migration 095)
//
// WHY THIS EXISTS: migration 095 (ADR-047 slice 1) added two heavy columns to
// `public.entities`, mirroring the pair `public.artifacts` has carried since
// migrations 044/051:
//   * `search_vector` — `tsvector`, GENERATED ALWAYS ... STORED
//   * `embedding`     — `vector(1536)`, nullable
// Both are inert until slices 2/3 (#551 embed-on-write, #552 hybrid RPCs) read
// them, and both are consumed SERVER-SIDE by those RPCs — a GIN/HNSW index scan
// and a similarity score, never a value a client renders. Neither is on
// {@link BaseEntity}, so no TypeScript reader can touch them; a `select('*')`
// nonetheless ships both, as JSON, on every row. That is the same waste #609
// and #775 already removed for artifacts, which is where the
// `ARTIFACT_LIST_COLUMNS` pattern this mirrors comes from.
//
// WHY IT LIVES IN `shared` AND NOT NEXT TO ITS CALLERS (unlike
// ARTIFACT_LIST_COLUMNS, which is local to packages/web): entities are read
// with the same wanted shape from BOTH `packages/web` (five list/detail
// fetchers) and `packages/worker` (candidate matching in organizeEntities, the
// merge winner/loser reads in resume). Artifacts had one reader package, so a
// local constant could not drift; two do, so a local constant is two lists to
// keep in step with one table.
//
// THE MAINTENANCE HAZARD, AND WHAT CLOSES IT: an explicit list silently stops
// selecting a column a later migration adds. `_allEntityColumnsSelected` below
// makes that a compile error the moment the new column reaches
// {@link BaseEntity} — and `packages/worker/src/workflows/steps/types.ts`
// carries the mirror-image guard for the worker's narrower `Entity`. The rule
// for adding a column here: it belongs if a reader reads it. A column that
// exists only to be scanned by an index (these two, and anything like them)
// stays out.
//
// WHAT THAT GUARD DOES NOT COVER — it is a TYPE check, not a SCHEMA one. It
// fires on `BaseEntity` gaining a key this list lacks. It CANNOT fire on
// `public.entities` gaining a column the types never learn about, which is the
// likelier order of events: the migration lands first, and the interface
// follows in a later change, or never. Nothing in TypeScript knows that column
// exists, so there is nothing to compare the list against — and no test catches
// it either, because a reader cannot read what was never selected. The gap is
// silent by construction. The discipline that actually closes it is procedural,
// not mechanical: a migration that adds a column readers will want must add it
// to `BaseEntity` AND to this list in the same change (QA round 1 L1 on #813).
//
// NOT AFFECTED: `public.people`. It is a view over
// `entities WHERE entity_type = 'people'`, but it ENUMERATES its columns
// (migration 077) rather than selecting `*`, and 095 deliberately did not
// redefine it — so the two new columns are not projected through it and a
// `select('*')` against `people` costs exactly what it did before. Reads
// through the view need no change.
// ---------------------------------------------------------------------------

import type { BaseEntity, GraphEntityType } from '../types/entities';

/**
 * The `public.entities` row as its readers want it: every {@link BaseEntity}
 * field plus the discriminator. `entity_type` is not on `BaseEntity` (the
 * per-type interfaces that extend it are already discriminated by their own
 * shape), but it is a real column and the generic readers — `fetchEntityById`,
 * `fetchEntitiesForArtifact`, the worker's candidate matching and merge path —
 * all branch on it.
 */
export type EntityReadRow = BaseEntity & { entity_type: GraphEntityType };

/**
 * Every column a reader of `public.entities` actually consumes — i.e. the whole
 * row except `search_vector` and `embedding`.
 *
 * Use as `.select(ENTITY_LIST_COLUMNS.join(', '))`, exactly as
 * `ARTIFACT_LIST_COLUMNS` is used in `packages/web/utils/knowledge/api.ts`.
 * Note that a dynamic (non-literal) `.select()` string defeats postgrest-js's
 * column-parsing type inference, so cast the returned rows at the call site
 * rather than leaving them typed as its `GenericStringError` fallback.
 */
export const ENTITY_LIST_COLUMNS = [
	'id',
	'entity_type',
	'title',
	'description',
	'tags',
	'archived',
	'archived_at',
	'properties',
	'source_url',
	'aliases',
	'hot',
	'user_id',
	'team_id',
	'created_at',
	'updated_at',
	'local_name',
	'namespace',
] as const satisfies readonly (keyof EntityReadRow)[];

/** A column name selected by {@link ENTITY_LIST_COLUMNS}. */
export type EntityListColumn = (typeof ENTITY_LIST_COLUMNS)[number];

/**
 * Errors — naming the offender — if an {@link EntityReadRow} key is missing
 * above. `satisfies` alone only checks that every listed name IS a valid key;
 * it does not require every key to be listed, so a column added to
 * `BaseEntity` but forgotten here would still compile. Same guard shape as
 * `_allListColumnsSelected` in `packages/web/utils/knowledge/api.ts`.
 */
type MissingEntityColumn = Exclude<keyof EntityReadRow, EntityListColumn>;
const _allEntityColumnsSelected: MissingEntityColumn extends never
	? true
	: MissingEntityColumn = true;
