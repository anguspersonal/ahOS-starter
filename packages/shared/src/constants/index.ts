// Shared constants across all packages

import type { KnownRelationshipType, RelationshipType } from '../types/entities';

// Placeholder export to make this a valid module
export const SHARED_CONSTANTS = {} as const;

// Namespace bindings (ADR-037 §2) — the canonical prefix ⟷ namespace-IRI set.
export * from './namespaces';

// Term-node row shape (ADR-037 §1, #453) — local_name + namespace pointer;
// CURIE and full IRI are derived projections, never stored.
export * from './termNodes';

// Synthesis marker vocabulary (ADR-050 §6, #560) — the artifact_external_links
// `kind` values that mean "this atom has been through the Synthesize step".
export * from './synthesisMarkers';

// Artifact surface vocabulary (ADR-026, ADR-046 §2/§3; #570, #584) — the
// `artifacts.surface` values this repo's writers stamp. Free-text column, so
// the vocabulary is enforced here rather than in the schema.
export * from './artifactSurfaces';

// Entity read column list (#550, migration 095) — every `public.entities`
// column a reader consumes, i.e. the row minus the index-only `search_vector`
// and `embedding`. Shared because web and worker read the same shape.
export * from './entityColumns';

// Entity property vocabularies and merge helpers (#173, #456, ADR-085, ADR-092)
export * from './entityProperties';

// ---------------------------------------------------------------------------
// Relationship vocabulary (FOAF + RELATIONSHIP)
//
// See ADR-021. The type union lives in ../types/entities; this module holds the
// runtime metadata used to label, categorise, and traverse edges.
// ---------------------------------------------------------------------------

export type RelationshipCategory =
  | 'family'
  | 'romantic'
  | 'social'
  | 'professional'
  | 'negative'
  | 'foaf'
  | 'place'
  | 'hierarchy'
  | 'system'
  | 'other';

export interface RelationshipVocabularyEntry {
  /** Compact URI (CURIE) in the FOAF / RELATIONSHIP namespaces; null for system/other. */
  curie: string | null;
  /** Human-readable label for UI (edge captions, pickers). */
  label: string;
  category: RelationshipCategory;
  /** True when `A rel B` implies `B rel A` — store one row, read both directions. */
  symmetric?: boolean;
  /** The inverse edge type for directional relationships (e.g. parentOf ↔ childOf). */
  inverseOf?: KnownRelationshipType;
  /** RELATIONSHIP terms are all `rdfs:subPropertyOf foaf:knows`. */
  subPropertyOf?: string;
}

const KNOWS = 'foaf:knows';

export const RELATIONSHIP_VOCABULARY: Record<KnownRelationshipType, RelationshipVocabularyEntry> = {
  // Family
  parentOf: { curie: 'rel:parentOf', label: 'Parent of', category: 'family', inverseOf: 'childOf', subPropertyOf: KNOWS },
  childOf: { curie: 'rel:childOf', label: 'Child of', category: 'family', inverseOf: 'parentOf', subPropertyOf: KNOWS },
  grandparentOf: { curie: 'rel:grandparentOf', label: 'Grandparent of', category: 'family', inverseOf: 'grandchildOf', subPropertyOf: KNOWS },
  grandchildOf: { curie: 'rel:grandchildOf', label: 'Grandchild of', category: 'family', inverseOf: 'grandparentOf', subPropertyOf: KNOWS },
  ancestorOf: { curie: 'rel:ancestorOf', label: 'Ancestor of', category: 'family', inverseOf: 'descendantOf', subPropertyOf: KNOWS },
  descendantOf: { curie: 'rel:descendantOf', label: 'Descendant of', category: 'family', inverseOf: 'ancestorOf', subPropertyOf: KNOWS },
  siblingOf: { curie: 'rel:siblingOf', label: 'Sibling of', category: 'family', symmetric: true, subPropertyOf: KNOWS },
  spouseOf: { curie: 'rel:spouseOf', label: 'Spouse of', category: 'family', symmetric: true, subPropertyOf: KNOWS },
  lifePartnerOf: { curie: 'rel:lifePartnerOf', label: 'Life partner of', category: 'family', symmetric: true, subPropertyOf: KNOWS },
  engagedTo: { curie: 'rel:engagedTo', label: 'Engaged to', category: 'family', symmetric: true, subPropertyOf: KNOWS },

  // Romantic (dating stage — the rung below engagedTo). Ungendered per ADR-021 / the
  // kinship pattern: the specific kind (boyfriend / girlfriend / situationship / going
  // steady) rides as an open-vocab qualifier on the edge (see normalizeRelationshipType),
  // NOT as a distinct predicate. No FOAF/rel: term exists for the dating stage, so coined
  // under ahos: per ADR-033 (mint when there is no exact external match).
  romanticPartnerOf: { curie: 'ahos:romanticPartnerOf', label: 'Romantic partner of', category: 'romantic', symmetric: true, subPropertyOf: KNOWS },

  // Social
  friendOf: { curie: 'rel:friendOf', label: 'Friend of', category: 'social', symmetric: true, subPropertyOf: KNOWS },
  closeFriendOf: { curie: 'rel:closeFriendOf', label: 'Close friend of', category: 'social', symmetric: true, subPropertyOf: KNOWS },
  acquaintanceOf: { curie: 'rel:acquaintanceOf', label: 'Acquaintance of', category: 'social', symmetric: true, subPropertyOf: KNOWS },
  neighborOf: { curie: 'rel:neighborOf', label: 'Neighbour of', category: 'social', symmetric: true, subPropertyOf: KNOWS },
  livesWith: { curie: 'rel:livesWith', label: 'Lives with', category: 'social', symmetric: true, subPropertyOf: KNOWS },
  hasMet: { curie: 'rel:hasMet', label: 'Has met', category: 'social', symmetric: true, subPropertyOf: KNOWS },
  knowsOf: { curie: 'rel:knowsOf', label: 'Knows of', category: 'social', subPropertyOf: KNOWS },
  knowsInPassing: { curie: 'rel:knowsInPassing', label: 'Knows in passing', category: 'social', subPropertyOf: KNOWS },
  knowsByReputation: { curie: 'rel:knowsByReputation', label: 'Knows by reputation', category: 'social', subPropertyOf: KNOWS },
  wouldLikeToKnow: { curie: 'rel:wouldLikeToKnow', label: 'Would like to know', category: 'social', subPropertyOf: KNOWS },
  lostContactWith: { curie: 'rel:lostContactWith', label: 'Lost contact with', category: 'social', symmetric: true, subPropertyOf: KNOWS },

  // Professional
  colleagueOf: { curie: 'rel:colleagueOf', label: 'Colleague of', category: 'professional', symmetric: true, subPropertyOf: KNOWS },
  worksWith: { curie: 'rel:worksWith', label: 'Works with', category: 'professional', symmetric: true, subPropertyOf: KNOWS },
  collaboratesWith: { curie: 'rel:collaboratesWith', label: 'Collaborates with', category: 'professional', symmetric: true, subPropertyOf: KNOWS },
  employedBy: { curie: 'rel:employedBy', label: 'Employed by', category: 'professional', inverseOf: 'employerOf', subPropertyOf: KNOWS },
  employerOf: { curie: 'rel:employerOf', label: 'Employer of', category: 'professional', inverseOf: 'employedBy', subPropertyOf: KNOWS },
  mentorOf: { curie: 'rel:mentorOf', label: 'Mentor of', category: 'professional', inverseOf: 'apprenticeTo', subPropertyOf: KNOWS },
  apprenticeTo: { curie: 'rel:apprenticeTo', label: 'Apprentice to', category: 'professional', inverseOf: 'mentorOf', subPropertyOf: KNOWS },
  influencedBy: { curie: 'rel:influencedBy', label: 'Influenced by', category: 'professional', subPropertyOf: KNOWS },

  // Negative / ambivalent
  enemyOf: { curie: 'rel:enemyOf', label: 'Enemy of', category: 'negative', symmetric: true, subPropertyOf: KNOWS },
  antagonistOf: { curie: 'rel:antagonistOf', label: 'Antagonist of', category: 'negative', subPropertyOf: KNOWS },
  ambivalentOf: { curie: 'rel:ambivalentOf', label: 'Ambivalent of', category: 'negative', subPropertyOf: KNOWS },

  // FOAF core
  knows: { curie: 'foaf:knows', label: 'Knows', category: 'foaf', symmetric: true },
  member: { curie: 'foaf:member', label: 'Has member', category: 'foaf' },
  currentProject: { curie: 'foaf:currentProject', label: 'Current project', category: 'foaf' },
  pastProject: { curie: 'foaf:pastProject', label: 'Past project', category: 'foaf' },
  made: { curie: 'foaf:made', label: 'Made', category: 'foaf' },

  // Place edges (#188) — person -> place and place -> place containment.
  // Not subPropertyOf foaf:knows: these aren't interpersonal `knows` edges.
  livesAt: { curie: null, label: 'Lives at', category: 'place' },
  basedNear: { curie: 'foaf:based_near', label: 'Based near', category: 'place' },
  locatedIn: { curie: null, label: 'Located in', category: 'place' },

  // SKOS concept-hierarchy edges (#195/#232) — the Areas tree. writeAreaHierarchyEdge
  // (packages/worker) writes both directions as an auto-paired inverse: this
  // `inverseOf` declaration is what lets the web graph layer (#233) recognise the
  // pair and collapse them to one rendered line instead of two overlapping ones.
  // Not subPropertyOf foaf:knows: a concept-hierarchy edge isn't interpersonal.
  broader: { curie: 'skos:broader', label: 'Broader', category: 'hierarchy', inverseOf: 'narrower' },
  narrower: { curie: 'skos:narrower', label: 'Narrower', category: 'hierarchy', inverseOf: 'broader' },

  // System-generated
  co_occurs_with: { curie: null, label: 'Co-occurs with', category: 'system', symmetric: true },

  // Fallback
  other: { curie: null, label: 'Related to', category: 'other' },
};

/** Type guard: is `t` one of the canonical vocabulary terms? */
export function isKnownRelationshipType(t: string): t is KnownRelationshipType {
  return Object.prototype.hasOwnProperty.call(RELATIONSHIP_VOCABULARY, t);
}

/**
 * The inverse of an edge type. Symmetric and unknown/other types return
 * themselves; directional types return their declared inverse. Used to render a
 * stored `from → to` edge from the opposite node's perspective.
 */
export function inverseOf(t: RelationshipType): RelationshipType {
  const entry = RELATIONSHIP_VOCABULARY[t as KnownRelationshipType];
  if (!entry) return t;
  if (entry.symmetric) return t;
  return entry.inverseOf ?? t;
}

/**
 * Curated synonym table mapping free-text relation words to canonical terms.
 *
 * Keyed by slug; each value is the vocabulary term describing the SUBJECT of the
 * word (e.g. "mentor" → `mentorOf`, i.e. the person IS a mentor; "mother" →
 * `parentOf`). We use a curated table rather than string-similarity because the
 * only similarity helper available is longest-common-substring, which mishandles
 * short synonyms (mom/mother). Longer keys are matched before shorter ones.
 */
const RELATION_SYNONYMS: Record<string, KnownRelationshipType> = {
  'close friend': 'closeFriendOf',
  'best friend': 'closeFriendOf',
  bestie: 'closeFriendOf',
  friend: 'friendOf',
  buddy: 'friendOf',
  mate: 'friendOf',
  pal: 'friendOf',
  acquaintance: 'acquaintanceOf',
  'co-worker': 'colleagueOf',
  coworker: 'colleagueOf',
  colleague: 'colleagueOf',
  workmate: 'colleagueOf',
  collaborator: 'collaboratesWith',
  mentor: 'mentorOf',
  mentee: 'apprenticeTo',
  apprentice: 'apprenticeTo',
  protege: 'apprenticeTo',
  student: 'apprenticeTo',
  manager: 'employerOf',
  supervisor: 'employerOf',
  employer: 'employerOf',
  boss: 'employerOf',
  employee: 'employedBy',
  subordinate: 'employedBy',
  grandmother: 'grandparentOf',
  grandfather: 'grandparentOf',
  grandparent: 'grandparentOf',
  grandson: 'grandchildOf',
  granddaughter: 'grandchildOf',
  grandchild: 'grandchildOf',
  mother: 'parentOf',
  father: 'parentOf',
  parent: 'parentOf',
  mom: 'parentOf',
  mum: 'parentOf',
  dad: 'parentOf',
  daughter: 'childOf',
  son: 'childOf',
  child: 'childOf',
  brother: 'siblingOf',
  sister: 'siblingOf',
  sibling: 'siblingOf',
  husband: 'spouseOf',
  wife: 'spouseOf',
  spouse: 'spouseOf',
  partner: 'lifePartnerOf',
  fiance: 'engagedTo',
  fiancee: 'engagedTo',
  girlfriend: 'romanticPartnerOf',
  boyfriend: 'romanticPartnerOf',
  situationship: 'romanticPartnerOf',
  'going steady': 'romanticPartnerOf',
  'romantic partner': 'romanticPartnerOf',
  neighbour: 'neighborOf',
  neighbor: 'neighborOf',
  'lives at': 'livesAt',
};

// Match longer phrases before shorter ones so "close friend" beats "friend".
const RELATION_SYNONYM_KEYS = Object.keys(RELATION_SYNONYMS).sort((a, b) => b.length - a.length);

/**
 * Single source of truth for "does matching synonym `key` (which maps to
 * `type`) carry a vocab note?" — both `normalizeRelationshipType` (deriving a
 * note going forward) and `vocabNoteSynonymsForType` (recognising one already
 * stored, #501 QA round 2) must agree on this exact rule, or the two silently
 * drift apart. Currently true only for the romantic subtypes: `type` resolved
 * to `romanticPartnerOf` via a synonym OTHER than the bare "romantic partner"
 * itself (which maps to the same type but has no distinct subtype to record).
 */
function synonymCarriesVocabNote(type: KnownRelationshipType, key: string): boolean {
  return type === 'romanticPartnerOf' && key !== 'romantic partner';
}

/**
 * Normalise a free-text relation value to a canonical relationship type.
 *
 * Returns the matched vocabulary term, or `{ type: 'other', notes }` preserving
 * the raw value when nothing matches (soft validation — ADR-021). Values that are
 * already canonical terms pass through unchanged.
 */
export function normalizeRelationshipType(raw: string | null | undefined): {
  type: RelationshipType;
  notes?: string;
} {
  if (!raw || !raw.trim()) return { type: 'other' };
  const text = raw.trim();

  if (isKnownRelationshipType(text)) return { type: text };

  const lower = text.toLowerCase();
  for (const key of RELATION_SYNONYM_KEYS) {
    if (lower === key || lower.includes(key)) {
      const type = RELATION_SYNONYMS[key];
      // Romantic edges are ungendered (ADR-021 / the kinship pattern): the specific kind
      // (boyfriend / girlfriend / situationship / going steady / …) is an open-vocab
      // qualifier on the edge, not a distinct predicate. Carry the matched subtype as a
      // note so it survives; its structured home is entity_relationships.metadata (the
      // edge_type qualifier, ADR-036 §1a) once the write path threads it (#327).
      if (synonymCarriesVocabNote(type, key)) {
        return { type, notes: key };
      }
      return { type };
    }
  }

  return { type: 'other', notes: text };
}

/**
 * The bounded set of raw synonym phrases that resolve to `type` AND carry a
 * vocab note under `normalizeRelationshipType`'s rules — currently only the
 * romantic-subtype synonyms (girlfriend, boyfriend, situationship, …) that
 * feed the `romanticPartnerOf` branch above. Every other synonym mapping
 * (e.g. "mother"/"father"/"mom" → `parentOf`) resolves silently with NO note,
 * so this returns an EMPTY set for `parentOf` and every other non-romantic
 * type — not "every synonym key that maps to `type`" (#501 QA round 2: an
 * earlier version of this function re-wrote `synonymCarriesVocabNote`'s
 * exclusion in inverted form instead of reusing it, so it returned all 6
 * `parentOf` synonyms as if they carried notes). The `'other'` fallback has
 * no bounded set at all — its vocab note is the caller's own raw phrase,
 * verbatim, not a member of any fixed vocabulary.
 *
 * Exists so a write path can recognise a PREVIOUSLY recorded vocab note in
 * stored free text without re-deriving it from the original raw phrase —
 * which is no longer available by the time of a later call. `relate_entities`
 * (#501) needs this: an edge whose type was normalised from "girlfriend"
 * must still recognise "girlfriend" as a vocab note on a later re-assertion
 * that uses the canonical term `romanticPartnerOf` instead, or a different
 * romantic synonym.
 */
export function vocabNoteSynonymsForType(type: string): ReadonlySet<string> {
  const notes = new Set<string>();
  for (const [key, mappedType] of Object.entries(RELATION_SYNONYMS)) {
    if (mappedType !== type) continue;
    if (!synonymCarriesVocabNote(mappedType, key)) continue;
    notes.add(key);
  }
  return notes;
}
