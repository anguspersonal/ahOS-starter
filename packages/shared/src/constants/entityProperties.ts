/**
 * Property vocabularies and validation for knowledge graph entities (#173, #456, ADR-085, ADR-092).
 *
 * Used at entity merge time to union non-conflicting scalar properties from
 * loser to winner with conflict resolution and schema validation.
 */

/**
 * Known property keys and their expected value validator per entity type.
 * Derived from ADR-085 (people/organization/place/event) and ADR-092 (term).
 * Used at entity merge time (#456) to validate candidate properties from the loser.
 */
export const ENTITY_PROPERTY_VALIDATORS: Record<
  string,
  Record<string, (val: unknown) => boolean>
> = {
  people: {
    email: (v) => typeof v === 'string' && v.trim().length > 0,
    phone: (v) => typeof v === 'string' && v.trim().length > 0,
    role: (v) => typeof v === 'string' && v.trim().length > 0,
    organization: (v) => typeof v === 'string' && v.trim().length > 0,
    relationship: (v) => typeof v === 'string' && v.trim().length > 0,
    last_contact: (v) => typeof v === 'string' && v.trim().length > 0,
    homepage: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  organization: {
    legal_name: (v) => typeof v === 'string' && v.trim().length > 0,
    url: (v) => typeof v === 'string' && v.trim().length > 0,
    email: (v) => typeof v === 'string' && v.trim().length > 0,
    telephone: (v) => typeof v === 'string' && v.trim().length > 0,
    address: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  place: {
    place_type: (v) => typeof v === 'string' && v.trim().length > 0,
    address: (v) => typeof v === 'string' && v.trim().length > 0,
    geo: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  event: {
    date: (v) => typeof v === 'string' && v.trim().length > 0,
    attendees: (v) => typeof v === 'string' && v.trim().length > 0,
    start_date: (v) => typeof v === 'string' && v.trim().length > 0,
    end_date: (v) => typeof v === 'string' && v.trim().length > 0,
    location: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  term: {
    expansion: (v) => typeof v === 'string' && v.trim().length > 0,
    context: (v) => typeof v === 'string' && v.trim().length > 0,
    local_name: (v) => typeof v === 'string' && v.trim().length > 0,
    namespace: (v) => typeof v === 'string' && v.trim().length > 0,
  },
};

export interface MergePropertiesResult {
  mergedProperties: Record<string, unknown>;
  carriedKeys: string[];
  skippedKeys: Record<string, string>;
}

/**
 * Union non-conflicting scalar properties from loser to winner (#456).
 *
 * Conflict-resolution rules (grilled 2026-09-25 with Angus):
 * 1. Conflicts: winner keeps its value. No lists, no newest-wins.
 * 2. Non-conflicting scalar properties on the loser are unioned onto the winner.
 * 3. Scalars only (string, number, boolean). Non-scalars (arrays, objects) are skipped.
 * 4. Internal/metadata keys (_*, merged_into, merged_at, archived_reason, aliases) are excluded.
 * 5. If the winner entity type defines a property validator, candidate loser properties must pass it.
 *
 * Provenance is preserved on the loser tombstone (`_merge` property, #457).
 */
export function mergeEntityProperties(
  winnerType: string,
  winnerProps: Record<string, unknown> | null | undefined,
  loserProps: Record<string, unknown> | null | undefined,
): MergePropertiesResult {
  const winner = { ...(winnerProps || {}) };
  const loser = loserProps || {};
  const carriedKeys: string[] = [];
  const skippedKeys: Record<string, string> = {};

  const SYSTEM_KEYS = new Set([
    'aliases',
    'merged_into',
    'merged_at',
    'archived_reason',
    '_merge',
  ]);

  for (const [key, val] of Object.entries(loser)) {
    if (!key || SYSTEM_KEYS.has(key) || key.startsWith('_')) {
      continue;
    }

    // Check conflict: winner already has a non-null, non-empty value
    const winnerVal = winner[key];
    const winnerHasValue =
      winnerVal !== undefined &&
      winnerVal !== null &&
      !(typeof winnerVal === 'string' && winnerVal.trim() === '');

    if (winnerHasValue) {
      skippedKeys[key] = 'conflict_winner_preferred';
      continue;
    }

    // Check scalar: string, number, boolean
    const isScalar =
      typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean';

    if (!isScalar) {
      skippedKeys[key] = 'non_scalar';
      continue;
    }

    // Check schema validation if winner entity type has validators for this key
    const typeValidators = ENTITY_PROPERTY_VALIDATORS[winnerType];
    if (typeValidators && typeValidators[key]) {
      const isValid = typeValidators[key](val);
      if (!isValid) {
        skippedKeys[key] = 'schema_invalid';
        continue;
      }
    }

    // Valid and non-conflicting: carry it over
    winner[key] = val;
    carriedKeys.push(key);
  }

  return {
    mergedProperties: winner,
    carriedKeys,
    skippedKeys,
  };
}
