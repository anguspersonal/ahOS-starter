// Export golden-extraction examples as JSONL eval/training pairs.
//
// Reads artifacts tagged 'golden-extraction' (see ADR-016 "map, don't store" +
// issue #190: the example IS the live artifact + its links/edges, marked in
// place rather than copied into a separate table). For each tagged artifact,
// emits one JSONL record shaped:
//
//   {
//     artifact_id, captured_at,
//     input: <raw artifact text, from artifacts.plain_text>,
//     labels: {
//       entities: [{ title, entity_type, properties_subset }],
//       edges: [{ from_title, relationship_type, to_title, notes }]
//     },
//     refs: { entities: [{ id, title }], edges: [{ from_id, relationship_type, to_id }] },
//     meta: <artifacts.processing_metadata.golden_extraction>
//   }
//
// Labels use titles (not raw ids) for training/eval readability; a parallel
// `refs` block carries ids for traceability back to the source rows.
//
// This script is READ-ONLY: it queries artifacts, artifact_entity_links,
// entities, and entity_relationships, and never writes to the database.
//
// Usage:
//   npm run build -w @ahkms/shared            # build shared first (provides the vocab)
//   node scripts/export-golden-extractions.js [--dry-run] [--user-id=<uuid>] [--out=<path>]
//
// With no --out, JSONL is written to stdout (one compact JSON object per line).
// --dry-run prints counts only (no JSONL emitted) and still exits non-zero if
// zero golden artifacts are found for the resolved user, since an empty export
// is a signal something's wrong (mistagged/wrong user), not quiet success.
//
// Requires env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.
// The service role bypasses RLS, so this can read across the user's own data.

const fs = require('fs');
const { supabase } = require('../src/db/client');

const GOLDEN_TAG = 'golden-extraction';

function parseArgs(argv) {
  const args = { dryRun: false, userId: null, out: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--user-id=')) args.userId = a.slice('--user-id='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
  }
  return args;
}

/** Resolve the target user: explicit flag, else the sole owner of golden-tagged artifacts. */
async function resolveUserId(explicit) {
  if (explicit) return explicit;
  const { data, error } = await supabase
    .from('artifacts')
    .select('user_id')
    .contains('tags', [GOLDEN_TAG])
    .limit(1000);
  if (error) throw new Error(`Failed to read artifacts: ${error.message}`);
  const ids = [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
  if (ids.length === 0) throw new Error(`No '${GOLDEN_TAG}'-tagged artifacts found — nothing to export.`);
  if (ids.length > 1) {
    throw new Error(`Multiple users found (${ids.length}); pass --user-id=<uuid> to pick one.`);
  }
  return ids[0];
}

/** Key properties worth carrying into the label set — enough to disambiguate, not the whole blob. */
function propertiesSubset(properties) {
  if (!properties || typeof properties !== 'object') return {};
  const KEYS = ['role', 'organization', 'relation', 'relationship', 'email', 'is_self', 'status', 'entity_type'];
  const subset = {};
  for (const key of KEYS) {
    if (properties[key] !== undefined && properties[key] !== null) subset[key] = properties[key];
  }
  return subset;
}

/**
 * Pure shaping function: turn one golden artifact row (plus its resolved links,
 * entities, and edges) into the JSONL-ready export object. No I/O — easy to
 * unit-test with fixture rows.
 *
 * @param {object} artifact - artifacts row (id, captured_at, plain_text, processing_metadata, ...)
 * @param {Array<{id: string, entity_type: string, title: string, properties: object|null}>} entities
 *   - entities linked to this artifact (already resolved from artifact_entity_links)
 * @param {Array<{from_entity_id: string, to_entity_id: string, relationship_type: string, notes: string|null}>} edges
 *   - entity_relationships rows where both endpoints are in `entities`
 */
function shapeGoldenRecord(artifact, entities, edges) {
  const entityById = new Map(entities.map((e) => [e.id, e]));

  const labelEntities = entities.map((e) => ({
    title: e.title,
    entity_type: e.entity_type,
    properties_subset: propertiesSubset(e.properties),
  }));

  const labelEdges = edges.map((edge) => ({
    from_title: entityById.get(edge.from_entity_id)?.title ?? null,
    relationship_type: edge.relationship_type,
    to_title: entityById.get(edge.to_entity_id)?.title ?? null,
    notes: edge.notes ?? null,
  }));

  const refEntities = entities.map((e) => ({ id: e.id, title: e.title }));
  const refEdges = edges.map((edge) => ({
    from_id: edge.from_entity_id,
    relationship_type: edge.relationship_type,
    to_id: edge.to_entity_id,
  }));

  return {
    artifact_id: artifact.id,
    captured_at: artifact.captured_at ?? artifact.created_at ?? null,
    input: artifact.plain_text ?? '',
    labels: {
      entities: labelEntities,
      edges: labelEdges,
    },
    refs: {
      entities: refEntities,
      edges: refEdges,
    },
    meta: (artifact.processing_metadata && artifact.processing_metadata.golden_extraction) || null,
  };
}

/** Fetch all golden-tagged artifacts for a user. */
async function fetchGoldenArtifacts(userId) {
  const { data, error } = await supabase
    .from('artifacts')
    .select('id, captured_at, created_at, plain_text, processing_metadata')
    .eq('user_id', userId)
    .contains('tags', [GOLDEN_TAG])
    .order('captured_at', { ascending: true });
  if (error) throw new Error(`Failed to read golden artifacts: ${error.message}`);
  return data || [];
}

/** Fetch linked entities for one artifact via artifact_entity_links. */
async function fetchLinkedEntities(userId, artifactId) {
  const { data: links, error: linkError } = await supabase
    .from('artifact_entity_links')
    .select('entity_id')
    .eq('user_id', userId)
    .eq('artifact_id', artifactId);
  if (linkError) throw new Error(`Failed to read artifact_entity_links for ${artifactId}: ${linkError.message}`);

  const entityIds = [...new Set((links || []).map((l) => l.entity_id).filter(Boolean))];
  if (entityIds.length === 0) return [];

  const { data: entities, error: entityError } = await supabase
    .from('entities')
    .select('id, entity_type, title, properties')
    .eq('user_id', userId)
    .in('id', entityIds);
  if (entityError) throw new Error(`Failed to read entities for ${artifactId}: ${entityError.message}`);
  return entities || [];
}

/**
 * Fetch entity_relationships edges where BOTH endpoints are in `entityIds`
 * (i.e. edges scoped to this artifact's linked entities). Two queries
 * (out + in), matching entityNeighbourhood.ts's convention of avoiding
 * `.or()` over UUID-laden filters.
 */
async function fetchEdgesAmong(userId, entityIds) {
  if (entityIds.length === 0) return [];
  const idSet = new Set(entityIds);
  const edgeSelect = 'from_entity_id, to_entity_id, relationship_type, notes';

  const [out, inc] = await Promise.all([
    supabase.from('entity_relationships').select(edgeSelect).eq('user_id', userId).in('from_entity_id', entityIds),
    supabase.from('entity_relationships').select(edgeSelect).eq('user_id', userId).in('to_entity_id', entityIds),
  ]);
  if (out.error) throw new Error(`Failed to read entity_relationships (out): ${out.error.message}`);
  if (inc.error) throw new Error(`Failed to read entity_relationships (in): ${inc.error.message}`);

  const seen = new Set();
  const edges = [];
  for (const row of [...(out.data || []), ...(inc.data || [])]) {
    // Both endpoints must be within this artifact's entity set — an edge with
    // one foot outside isn't part of this example's label graph.
    if (!idSet.has(row.from_entity_id) || !idSet.has(row.to_entity_id)) continue;
    const key = `${row.from_entity_id}|${row.to_entity_id}|${row.relationship_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(row);
  }
  return edges;
}

async function exportGolden({ dryRun, userId, out }) {
  const targetUser = await resolveUserId(userId);
  console.log(`Exporting golden extractions for user ${targetUser}${dryRun ? ' (dry-run)' : ''}`);

  const artifacts = await fetchGoldenArtifacts(targetUser);
  console.log(`Found ${artifacts.length} '${GOLDEN_TAG}'-tagged artifact(s).`);

  if (artifacts.length === 0) {
    throw new Error(`No '${GOLDEN_TAG}'-tagged artifacts found for user ${targetUser} — nothing to export.`);
  }

  const summary = { scanned: artifacts.length, exported: 0, totalEntities: 0, totalEdges: 0 };

  if (dryRun) {
    for (const artifact of artifacts) {
      const entities = await fetchLinkedEntities(targetUser, artifact.id);
      const edges = await fetchEdgesAmong(targetUser, entities.map((e) => e.id));
      summary.exported++;
      summary.totalEntities += entities.length;
      summary.totalEdges += edges.length;
      console.log(`  would export: artifact ${artifact.id} — ${entities.length} entities, ${edges.length} edges`);
    }
    console.log('\nSummary (dry-run):', JSON.stringify(summary, null, 2));
    return summary;
  }

  const lines = [];
  for (const artifact of artifacts) {
    const entities = await fetchLinkedEntities(targetUser, artifact.id);
    const edges = await fetchEdgesAmong(targetUser, entities.map((e) => e.id));
    const record = shapeGoldenRecord(artifact, entities, edges);
    lines.push(JSON.stringify(record));
    summary.exported++;
    summary.totalEntities += entities.length;
    summary.totalEdges += edges.length;
  }

  const jsonl = lines.join('\n') + '\n';
  if (out) {
    fs.writeFileSync(out, jsonl, 'utf-8');
    console.log(`Wrote ${lines.length} record(s) to ${out}`);
  } else {
    process.stdout.write(jsonl);
  }

  console.error('\nSummary:', JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  exportGolden(parseArgs(process.argv))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Export failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  exportGolden,
  resolveUserId,
  shapeGoldenRecord,
  propertiesSubset,
  fetchGoldenArtifacts,
  fetchLinkedEntities,
  fetchEdgesAmong,
  GOLDEN_TAG,
};
