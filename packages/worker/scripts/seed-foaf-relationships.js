// Seed FOAF/RELATIONSHIP edges from existing People entities' free-text relation.
//
// Reads each People entity's `properties.relation` (worker key; falls back to
// `properties.relationship`) and writes a typed `entity_relationships` row
// `person -> self` describing the person (e.g. relation "mentor" => person
// mentorOf you). Direction: from_entity_id = person, to_entity_id = the user's
// "self" People node (created if missing). See ADR-021.
//
// Usage:
//   npm run build -w @ahkms/shared            # build shared first (provides the vocab)
//   node scripts/seed-foaf-relationships.js [--dry-run] [--user-id=<uuid>]
//
// Requires env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.
// The service role bypasses RLS, so this can write on the user's behalf. Idempotent:
// an edge with the same (from, to, relationship_type) is never duplicated.

const { supabase } = require('../src/db/client');
const { normalizeRelationshipType } = require('@ahkms/shared');

const SEED_CREATED_BY = 'seed:foaf-backfill';
const SEED_CONFIDENCE = 80; // user's own captured data — high but not certain (0-100 scale)

function parseArgs(argv) {
  const args = { dryRun: false, userId: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--user-id=')) args.userId = a.slice('--user-id='.length);
  }
  return args;
}

/** Resolve the target user: explicit flag, else the sole owner of entities. */
async function resolveUserId(explicit) {
  if (explicit) return explicit;
  const { data, error } = await supabase.from('entities').select('user_id').limit(1000);
  if (error) throw new Error(`Failed to read entities: ${error.message}`);
  const ids = [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
  if (ids.length === 0) throw new Error('No entities found — nothing to seed.');
  if (ids.length > 1) {
    throw new Error(`Multiple users found (${ids.length}); pass --user-id=<uuid> to pick one.`);
  }
  return ids[0];
}

/** Find or create the user's "self" People node (properties.is_self = true). */
async function ensureSelfEntity(userId, dryRun) {
  const { data: existing, error } = await supabase
    .from('entities')
    .select('*')
    .eq('user_id', userId)
    .eq('entity_type', 'people')
    .eq('archived', false)
    .eq('properties->>is_self', 'true')
    .limit(1);
  if (error) throw new Error(`Failed to look up self entity: ${error.message}`);
  if (existing && existing.length > 0) return existing[0];

  if (dryRun) {
    return { id: '(dry-run-self)', title: 'Me', properties: { is_self: true } };
  }

  const { data: created, error: createError } = await supabase
    .from('entities')
    .insert({
      user_id: userId,
      entity_type: 'people',
      title: 'Me',
      description: 'You — the owner of this knowledge graph (foaf:me).',
      properties: { is_self: true },
      tags: [],
      archived: false,
    })
    .select()
    .single();
  if (createError || !created) {
    throw new Error(`Failed to create self entity: ${createError && createError.message}`);
  }
  return created;
}

async function edgeExists(userId, fromId, toId, type) {
  const { data, error } = await supabase
    .from('entity_relationships')
    .select('id')
    .eq('user_id', userId)
    .eq('from_entity_id', fromId)
    .eq('to_entity_id', toId)
    .eq('relationship_type', type)
    .limit(1);
  if (error) throw new Error(`Failed to check existing edge: ${error.message}`);
  return !!(data && data.length > 0);
}

async function seed({ dryRun, userId }) {
  const targetUser = await resolveUserId(userId);
  console.log(`Seeding FOAF relationships for user ${targetUser}${dryRun ? ' (dry-run)' : ''}`);

  const self = await ensureSelfEntity(targetUser, dryRun);
  console.log(`Self node: ${self.id} ("${self.title}")`);

  const { data: people, error } = await supabase
    .from('entities')
    .select('id, title, properties')
    .eq('user_id', targetUser)
    .eq('entity_type', 'people')
    .eq('archived', false);
  if (error) throw new Error(`Failed to read people: ${error.message}`);

  const summary = { scanned: 0, created: 0, skipped: 0, mappedToOther: 0, noRelation: 0 };

  for (const person of people || []) {
    if (person.id === self.id) continue;
    summary.scanned++;

    const props = person.properties || {};
    const raw = props.relation || props.relationship;
    if (!raw) {
      summary.noRelation++;
      continue;
    }

    const { type, notes } = normalizeRelationshipType(raw);
    if (type === 'other') summary.mappedToOther++;

    if (!dryRun && (await edgeExists(targetUser, person.id, self.id, type))) {
      summary.skipped++;
      continue;
    }
    if (dryRun && self.id === '(dry-run-self)') {
      // Can't check existence against a placeholder self; treat as would-create.
    }

    const row = {
      user_id: targetUser,
      from_entity_id: person.id,
      to_entity_id: self.id,
      relationship_type: type,
      confidence_score: SEED_CONFIDENCE,
      created_by: SEED_CREATED_BY,
      notes: notes || null,
      metadata: { source: 'relation_backfill', raw_relation: String(raw) },
    };

    console.log(`  ${dryRun ? 'would create' : 'create'}: "${person.title}" --${type}--> self` + (notes ? ` (raw: ${notes})` : ''));

    if (!dryRun) {
      const { error: insertError } = await supabase.from('entity_relationships').insert(row);
      if (insertError) {
        console.warn(`  ! failed to insert edge for "${person.title}": ${insertError.message}`);
        continue;
      }
    }
    summary.created++;
  }

  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  seed(parseArgs(process.argv))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}

module.exports = { seed, resolveUserId, ensureSelfEntity };
