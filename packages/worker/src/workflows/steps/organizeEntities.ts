/**
 * Step 3: Organize Entities
 * 
 * Matches, links, and creates entities (people, areas, projects, resources) based on AI analysis.
 * This step is the core of the knowledge graph, connecting artifacts to entities and building relationships over time.
 * 
 * Features:
 * - Fuzzy matching of entity mentions to existing entities
 * - Confidence scoring (name similarity, recency, co-occurrence, context)
 * - Auto-linking high-confidence matches
 * - Entity creation with AI enrichment
 * - Co-occurrence relationship tracking
 * - User disambiguation for ambiguous matches
 * 
 * @see docs/Step03_Organise.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import { callAnthropicText } from '../../utils/anthropic';
import { calculateStringSimilarity, generateUUID } from '../../utils/helpers';
import { mapEntityType } from '../../utils/entityTypes';
import { embedEntityAndStore } from '../../utils/embeddings';
import { ENTITY_LIST_COLUMNS, RELATIONSHIP_VOCABULARY, normalizeRelationshipType } from '@ahkms/shared';
import type {
  WorkflowStep,
  AnalysisResult,
  Entity,
  ScoredCandidate,
  OrganizeResult,
  SystemDecision,
} from './types';
import type { ArtifactId, StepId } from './types';
import { updateStepStatus } from './stepStatus';

// Constants
const DEFAULT_MATCH_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_CREATE_CONFIDENCE_THRESHOLD = 0.7;
const RECENCY_WINDOW_DAYS = 60;
const MAX_RECENCY_INTERACTIONS = 20;
const MAX_COOCCURRENCE_COUNT = 10;

// Relationship extraction (#178): threshold for auto-applying an LLM-proposed
// typed edge vs. surfacing it as a `relationship_suggested` decision for review.
// Mirrors the `entity_creation`/`entity_match` thresholds above — a plain 0-1
// value with an in-file default, read from the same `relationship_suggestion`
// family the mcp-server's updateUserPreferences tool already lets users tune
// (packages/mcp-server/src/tools/updateUserPreferences.ts). The stored shape is
// a 0-100 auto_apply/review/block window (see the `user_preferences.confidence_thresholds`
// column default and `get_user_preferences`'s seed value, both in
// supabase/migrations/20251226182232_remote_schema.sql), so we read `.auto_apply / 100` here.
const DEFAULT_RELATIONSHIP_SUGGESTION_THRESHOLD = 0.8;
// Cap the number of relationship proposals accepted per artifact, bounding LLM
// cost/output size regardless of how many entities are linked.
const MAX_RELATIONSHIP_PROPOSALS_PER_ARTIFACT = 20;

// PARA containment (issue #170): shared enrichment-prompt description for the
// `parent_entity_hint` attribute added to `project`/`resource`'s attribute
// schema below. A free-text NAME, not a uuid — unlike `area`'s `parent_area_id`
// (which the AI can't know, since sub-areas are rare and rarely named in the
// same breath as their parent), project/resource containment is common enough
// that the enrichment prompt already has the artifact content in view, so
// asking for the parent's plain name here and resolving it against the user's
// real graph in `proposeContainmentEdge` avoids a second content-reading LLM
// call. Mirrors `getEntityAttributesForType('area')`'s `parent_area_id` hint
// shape (properties.* is an unvalidated AI suggestion; the write path below
// validates it), just keyed by name instead of id.
const PARENT_ENTITY_HINT_ATTRIBUTE =
  'string (name of the existing Area or Project this belongs under, if the content indicates one, e.g. "Business" or "Work AI")';

/**
 * Fetch user preferences for confidence thresholds
 */
async function getUserPreferences(userId: string): Promise<{
  entityMatchThreshold: number;
  entityCreateThreshold: number;
}> {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('entity_match_threshold, entity_create_threshold')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      // Use defaults if preferences not found
      return {
        entityMatchThreshold: DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
        entityCreateThreshold: DEFAULT_CREATE_CONFIDENCE_THRESHOLD,
      };
    }

    return {
      entityMatchThreshold: data.entity_match_threshold ?? DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
      entityCreateThreshold: data.entity_create_threshold ?? DEFAULT_CREATE_CONFIDENCE_THRESHOLD,
    };
  } catch (err) {
    logger.warn('Failed to fetch user preferences, using defaults', { userId, err });
    return {
      entityMatchThreshold: DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
      entityCreateThreshold: DEFAULT_CREATE_CONFIDENCE_THRESHOLD,
    };
  }
}

/**
 * Fetch the auto-apply threshold for the `relationship_suggestion` decision
 * family (issue #178). Stored as a 0-100 auto_apply/review/block window on
 * `user_preferences.confidence_thresholds` (see the column default and the
 * `get_user_preferences` DB function's seed value, both in
 * supabase/migrations/20251226182232_remote_schema.sql); we only need
 * `auto_apply` here, normalised to the 0-1 scale the LLM proposal
 * confidences use.
 */
async function getRelationshipSuggestionThreshold(userId: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('confidence_thresholds')
      .eq('user_id', userId)
      .single();

    const autoApply = (data?.confidence_thresholds as any)?.relationship_suggestion?.auto_apply;

    if (error || !data || typeof autoApply !== 'number') {
      return DEFAULT_RELATIONSHIP_SUGGESTION_THRESHOLD;
    }

    return autoApply / 100;
  } catch (err) {
    logger.warn('Failed to fetch relationship_suggestion threshold, using default', { userId, err });
    return DEFAULT_RELATIONSHIP_SUGGESTION_THRESHOLD;
  }
}

/**
 * Find candidate entities using multiple matching strategies
 *
 * All three strategies select {@link ENTITY_LIST_COLUMNS} rather than `*`
 * (#550): migration 095 put a `search_vector` and a 1536-float `embedding` on
 * `public.entities`, and these lookups are the widest entity reads in the
 * workflow — one per mention, per co-occurrence pass, unbounded in row count.
 * Neither column is on {@link Entity} and nothing here reads them.
 *
 * A dynamic (non-literal) `.select()` string defeats postgrest-js's
 * column-parsing type inference, so each result is cast to `Entity[]` at the
 * point of use rather than left as its `GenericStringError` fallback.
 */
export async function findEntityCandidates(
  entityMention: { name: string; type: string },
  userId: string
): Promise<Entity[]> {
  const searchTerm = entityMention.name.toLowerCase().trim();
  const words = searchTerm.split(/\s+/).filter(w => w.length > 0);
  const entityType = mapEntityType(entityMention.type);
  const candidates: Entity[] = [];

  if (!searchTerm || words.length === 0) {
    return candidates;
  }

  // Strategy 1: Exact match
  const { data: exactRows, error: exactError } = await supabase
    .from('entities')
    .select(ENTITY_LIST_COLUMNS.join(', '))
    .eq('user_id', userId)
    .eq('entity_type', entityType)
    .eq('archived', false)
    .ilike('title', searchTerm);

  const exactMatches = exactRows as unknown as Entity[] | null;

  if (!exactError && exactMatches) {
    // Check for true exact match (case-insensitive)
    const trueExact = exactMatches.filter(
      e => e.title.toLowerCase() === searchTerm
    );
    if (trueExact.length > 0) {
      return trueExact;
    }
  }

  // Strategy 2: Partial match (all words present)
  if (words.length > 1) {
    let query = supabase
      .from('entities')
      .select(ENTITY_LIST_COLUMNS.join(', '))
      .eq('user_id', userId)
      .eq('entity_type', entityType)
      .eq('archived', false);

    // Add LIKE filter for each word
    for (const word of words) {
      query = query.ilike('title', `%${word}%`);
    }

    const { data: partialRows, error: partialError } = await query;

    const partialMatches = partialRows as unknown as Entity[] | null;

    if (!partialError && partialMatches) {
      // Filter to ensure all words are present
      const filtered = partialMatches.filter(entity => {
        const entityTitleLower = entity.title.toLowerCase();
        return words.every(word => entityTitleLower.includes(word));
      });

      if (filtered.length > 0) {
        return filtered;
      }
    }
  }

  // Strategy 3: Abbreviation match (e.g., "David L" -> "David Lynch")
  if (words.length === 2 && words[1].length === 1) {
    const firstWord = words[0];
    const initialLetter = words[1];

    const { data: abbrevRows, error: abbrevError } = await supabase
      .from('entities')
      .select(ENTITY_LIST_COLUMNS.join(', '))
      .eq('user_id', userId)
      .eq('entity_type', entityType)
      .eq('archived', false)
      .ilike('title', `${firstWord}% ${initialLetter}%`);

    const abbrevMatches = abbrevRows as unknown as Entity[] | null;

    if (!abbrevError && abbrevMatches) {
      return abbrevMatches;
    }
  }

  return candidates;
}

/**
 * Score entity candidates based on multiple factors
 */
export async function scoreEntityCandidates(
  candidates: Entity[],
  entityMention: { name: string; type: string },
  artifact: any,
  analysisResult: AnalysisResult
): Promise<ScoredCandidate[]> {
  const scoredCandidates: ScoredCandidate[] = [];
  const otherEntitiesInArtifact = analysisResult.entities_mentioned.filter(
    e => e.name !== entityMention.name
  );

  const mentionNameLower = entityMention.name.toLowerCase();

  for (const candidate of candidates) {
    logger.debug('Scoring candidate', { candidateId: candidate.id, candidateTitle: candidate.title });

    // Component 1: Name similarity (40%)
    const nameSimilarity = calculateStringSimilarity(
      mentionNameLower,
      candidate.title.toLowerCase()
    );

    // Component 2: Recency score (25%)
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setDate(twoMonthsAgo.getDate() - RECENCY_WINDOW_DAYS);

    const { count: recentInteractionsCount } = await supabase
      .from('artifact_entity_links')
      .select('*', { count: 'exact', head: true })
      .eq('entity_id', candidate.id)
      .gt('created_at', twoMonthsAgo.toISOString());

    const recencyScore = Math.min(
      (recentInteractionsCount || 0) / MAX_RECENCY_INTERACTIONS,
      1.0
    );

    // Component 3: Co-occurrence score (25%)
    let cooccurrenceScore = 0;

    if (otherEntitiesInArtifact.length > 0) {
      for (const otherEntity of otherEntitiesInArtifact) {
        const otherCandidates = await findEntityCandidates(otherEntity, artifact.user_id);

        for (const otherCandidate of otherCandidates) {
          // Check bidirectional co-occurrence
          const { data: cooccurrence1 } = await supabase
            .from('entity_relationships')
            .select('*')
            .eq('relationship_type', 'co_occurs_with')
            .eq('from_entity_id', candidate.id)
            .eq('to_entity_id', otherCandidate.id)
            .single();

          const { data: cooccurrence2 } = await supabase
            .from('entity_relationships')
            .select('*')
            .eq('relationship_type', 'co_occurs_with')
            .eq('from_entity_id', otherCandidate.id)
            .eq('to_entity_id', candidate.id)
            .single();

          const cooccurrence = cooccurrence1 || cooccurrence2;

          if (cooccurrence && cooccurrence.metadata) {
            const count = (cooccurrence.metadata as any).co_occurrence_count || 0;
            const thisCooccurrenceScore = Math.min(count / MAX_COOCCURRENCE_COUNT, 1.0);
            cooccurrenceScore = Math.max(cooccurrenceScore, thisCooccurrenceScore);
          }
        }
      }
    }

    // Component 4: Context score (10%) - only for people entities
    let contextScore = 0;

    if (candidate.entity_type === 'people') {
      const artifactText = artifact.user_content || artifact.extracted_content || '';
      const artifactTextLower = artifactText.toLowerCase();

      const workKeywords = ['work', 'meeting', 'project', 'client', 'colleague'];
      const personalKeywords = ['home', 'family', 'personal', 'friend'];

      const hasWorkContext = workKeywords.some(kw => artifactTextLower.includes(kw));
      const hasPersonalContext = personalKeywords.some(kw => artifactTextLower.includes(kw));

      const relation = (candidate.properties as any)?.relation || '';

      if (hasWorkContext) {
        if (
          relation.includes('colleague') ||
          relation.includes('coworker') ||
          relation.includes('client')
        ) {
          contextScore = 0.8;
        }
      } else if (hasPersonalContext) {
        if (relation.includes('friend') || relation.includes('family')) {
          contextScore = 0.8;
        }
      }
    }

    // Weighted combination
    const WEIGHT_NAME = 0.4;
    const WEIGHT_RECENCY = 0.25;
    const WEIGHT_COOCCURRENCE = 0.25;
    const WEIGHT_CONTEXT = 0.1;

    const finalScore =
      nameSimilarity * WEIGHT_NAME +
      recencyScore * WEIGHT_RECENCY +
      cooccurrenceScore * WEIGHT_COOCCURRENCE +
      contextScore * WEIGHT_CONTEXT;

    scoredCandidates.push({
      entity: candidate,
      confidence: finalScore,
      breakdown: {
        nameSimilarity,
        recencyScore,
        cooccurrenceScore,
        contextScore,
      },
    });
  }

  // Sort by confidence descending
  scoredCandidates.sort((a, b) => b.confidence - a.confidence);

  return scoredCandidates;
}

/**
 * Score a single entity candidate
 */
export async function scoreEntityCandidate(
  candidate: Entity,
  entityMention: { name: string; type: string },
  artifact: any,
  analysisResult: AnalysisResult
): Promise<ScoredCandidate> {
  const results = await scoreEntityCandidates([candidate], entityMention, artifact, analysisResult);
  return results[0];
}

/**
 * Get entity attributes schema for a given entity type
 */
function getEntityAttributesForType(entityType: string): Record<string, string> {
  if (entityType === 'people') {
    return {
      phone: 'string',
      email: 'string',
      relation: 'string (colleague, friend, family, client, etc.)',
      birthday: 'date (YYYY-MM-DD)',
    };
  }

  if (entityType === 'area') {
    return {
      category: 'string (Finance, Home, Work, Health, etc.)',
      parent_area_id: 'uuid (parent area if this is a sub-area)',
    };
  }

  if (entityType === 'project') {
    return {
      start_date: 'date (YYYY-MM-DD)',
      end_date: 'date (YYYY-MM-DD)',
      budget: 'number',
      status: 'string (active, completed, on_hold)',
      parent_entity_hint: PARENT_ENTITY_HINT_ATTRIBUTE,
    };
  }

  if (entityType === 'resource') {
    return {
      category: 'string (article, recipe, tutorial, template, etc.)',
      format: 'string (url, pdf, video, etc.)',
      parent_entity_hint: PARENT_ENTITY_HINT_ATTRIBUTE,
    };
  }

  return {};
}

/**
 * Create entity from mention with AI enrichment
 */
export async function createEntityFromMention(
  entityMention: { name: string; type: string; confidence: number },
  artifact: any
): Promise<{ entity: Entity; enriched: boolean; confidence: number }> {
  logger.info('Creating new entity', { entityName: entityMention.name, entityType: entityMention.type });

  // Step 1: Create base entity
  const entityId = generateUUID();
  const entityType = mapEntityType(entityMention.type);

  const { data: newEntity, error: createError } = await supabase
    .from('entities')
    .insert({
      id: entityId,
      user_id: artifact.user_id,
      team_id: artifact.team_id || null,
      entity_type: entityType,
      title: entityMention.name,
      description: null,
      properties: {},
      tags: [],
      archived: false,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (createError || !newEntity) {
    if (createError && (createError as { code?: string }).code === '23505') {
      const { data: existing } = await supabase
        .from('entities')
        .select()
        .eq('user_id', artifact.user_id)
        .eq('entity_type', entityType)
        .eq('title', entityMention.name)
        .eq('archived', false)
        .maybeSingle();
      if (existing) {
        return { entity: existing as Entity, enriched: false, confidence: entityMention.confidence };
      }
    }
    throw new Error(`Failed to create entity: ${createError?.message || 'Unknown error'}`);
  }

  logger.info('Base entity created', { entityId: newEntity.id });

  // Step 2: AI enrichment
  let enriched = false;
  let enrichmentConfidence = 0;

  try {
    // Get artifact content for context
    let artifactContent = artifact.user_content || '';
    if (artifact.content_type === 'binary' && artifact.metadata?.analysis?.extracted_text) {
      artifactContent = artifact.metadata.analysis.extracted_text;
    }

    // Get entity type schema
    const entityAttributes = getEntityAttributesForType(entityType);

    // Build enrichment prompt
    const enrichmentPrompt = `We have identified an entity within this content:

Entity Name: ${entityMention.name}
Entity Type: ${entityMention.type}

Content:
${artifactContent}

Available attributes for ${entityMention.type}:
${JSON.stringify(entityAttributes, null, 2)}

Please extract any of these attributes that are present in the content.
Return JSON format: {"attributes": {...}, "confidence": 0-1}

If no attributes can be extracted with confidence, return empty attributes object.`;

    logger.info('Calling AI for entity enrichment');

    const aiResponse = await callAnthropicText(enrichmentPrompt);
    const enrichmentResult = JSON.parse(aiResponse.content);

    enrichmentConfidence = enrichmentResult.confidence || 0;

    logger.info('Enrichment confidence', { confidence: enrichmentConfidence });

    // Update entity with enriched properties
    if (enrichmentResult.attributes && Object.keys(enrichmentResult.attributes).length > 0) {
      const { error: updateError } = await supabase
        .from('entities')
        .update({ properties: enrichmentResult.attributes })
        .eq('id', newEntity.id);

      if (updateError) {
        logger.warn('Failed to update entity with enriched properties', { error: updateError.message });
      } else {
        enriched = true;
        // Keep the in-memory record in sync with what was just persisted —
        // without this, callers (e.g. writeAreaHierarchyEdge, issue #195)
        // would only ever see the pre-enrichment `{}` properties, since
        // newEntity itself is never re-fetched after this update.
        newEntity.properties = enrichmentResult.attributes;
        logger.info('Entity enriched with attributes', {
          entityId: newEntity.id,
          attributes: Object.keys(enrichmentResult.attributes).join(', '),
        });
      }
    }
  } catch (error: any) {
    // Enrichment failed - entity created with minimal info
    logger.warn('Entity enrichment failed', { error: error.message, entityId: newEntity.id });
  }

  // Embed-on-write (#882, ADR-047 §2): best-effort, after enrichment so the
  // embedded text reflects any properties.{role,organization,relationship}
  // the enrichment call just added. `embedEntityAndStore` already swallows
  // its own provider/DB errors and never throws; the try/catch here is
  // defense in depth (mirrors the enrichment try/catch above) so entity
  // creation can never fail on this call regardless. A failure either way
  // leaves the row `embedding IS NULL` for the backfill sweep to pick up.
  try {
    await embedEntityAndStore(newEntity.id, {
      title: newEntity.title,
      description: newEntity.description,
      properties: newEntity.properties,
    });
  } catch (error: any) {
    logger.warn('Embed-on-write failed for newly created entity', {
      error: error.message,
      entityId: newEntity.id,
    });
  }

  return {
    entity: newEntity,
    enriched,
    confidence: enrichmentConfidence,
  };
}

/**
 * Update entity co-occurrence relationships
 */
export async function updateEntityCooccurrence(
  entitiesLinked: Entity[],
  artifactId: string
): Promise<{ success: boolean; pairsUpdated: number; error?: string }> {
  if (entitiesLinked.length < 2) {
    return { success: true, pairsUpdated: 0 };
  }

  try {
    let pairsUpdated = 0;

    for (let i = 0; i < entitiesLinked.length - 1; i++) {
      for (let j = i + 1; j < entitiesLinked.length; j++) {
        let entity1 = entitiesLinked[i];
        let entity2 = entitiesLinked[j];

        // Ensure consistent ordering (smaller ID first)
        if (entity1.id > entity2.id) {
          [entity1, entity2] = [entity2, entity1];
        }

        logger.debug('Updating co-occurrence', {
          entity1Title: entity1.title,
          entity2Title: entity2.title,
        });

        // Check if relationship exists
        const { data: existing, error: fetchError } = await supabase
          .from('entity_relationships')
          .select('*')
          .eq('from_entity_id', entity1.id)
          .eq('to_entity_id', entity2.id)
          .eq('relationship_type', 'co_occurs_with')
          .single();

        if (existing && !fetchError) {
          // Update existing relationship
          const currentCount = ((existing.metadata as any)?.co_occurrence_count || 0) as number;
          const newCount = currentCount + 1;

          const { error: updateError } = await supabase
            .from('entity_relationships')
            .update({
              confidence_score: Math.min((existing.confidence_score || 50) + 5, 100),
              metadata: {
                ...(existing.metadata as any),
                co_occurrence_count: newCount,
                last_occurred_at: new Date().toISOString(),
              },
            })
            .eq('from_entity_id', entity1.id)
            .eq('to_entity_id', entity2.id)
            .eq('relationship_type', 'co_occurs_with');

          if (updateError) {
            logger.warn('Failed to update co-occurrence', { error: updateError.message });
          } else {
            logger.debug('Updated existing co-occurrence', { count: newCount });
          }
        } else {
          // Create new relationship
          const { error: createError } = await supabase.from('entity_relationships').insert({
            user_id: entity1.user_id,
            from_entity_id: entity1.id,
            to_entity_id: entity2.id,
            relationship_type: 'co_occurs_with',
            confidence_score: 50,
            metadata: {
              co_occurrence_count: 1,
              first_occurred_at: new Date().toISOString(),
              last_occurred_at: new Date().toISOString(),
              artifact_id: artifactId,
            },
          });

          if (createError) {
            logger.warn('Failed to create co-occurrence', { error: createError.message });
          } else {
            logger.debug('Created new co-occurrence');
          }
        }

        pairsUpdated++;
      }
    }

    logger.info('Updated entity co-occurrence pairs', { pairsUpdated });
    return { success: true, pairsUpdated };
  } catch (error: any) {
    // Non-fatal - log and continue
    logger.warn('Failed to update co-occurrence', { error: error.message });
    return { success: false, pairsUpdated: 0, error: error.message };
  }
}

/** A single LLM-proposed typed relationship between two of this artifact's linked entities. */
export interface ProposedRelationship {
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  confidence: number; // 0-1
  notes?: string;
}

/**
 * Ask the LLM to propose typed relationships between the entities linked to
 * this artifact, constrained to `RELATIONSHIP_VOCABULARY` (issue #178 /
 * ADR-021). This is the producer half of the `relationship_suggested`
 * decision family: `writeOrSuggestRelationship` below routes each proposal by
 * confidence exactly like `createEntityFromMention`/candidate scoring route
 * entity decisions in `executeOrganizeEntitiesStep`.
 *
 * Reuses `callAnthropicText` (the same client `createEntityFromMention` uses
 * for enrichment) rather than adding a new Anthropic client/model config.
 *
 * Only entities actually linked to this artifact are passed to the prompt —
 * never the whole graph — to keep the prompt small and avoid leaking
 * unrelated entities' names to the model.
 */
export async function proposeEntityRelationships(
  entitiesLinked: Entity[],
  artifact: any
): Promise<ProposedRelationship[]> {
  if (entitiesLinked.length < 2) {
    return [];
  }

  const vocabByCategory: Record<string, string[]> = {};
  for (const [term, entry] of Object.entries(RELATIONSHIP_VOCABULARY)) {
    if (term === 'other' || term === 'co_occurs_with') continue; // not proposable
    (vocabByCategory[entry.category] ??= []).push(term);
  }
  const vocabSummary = Object.entries(vocabByCategory)
    .map(([category, terms]) => `${category}: ${terms.join(', ')}`)
    .join('; ');

  const entityList = entitiesLinked.map(e => ({ id: e.id, name: e.title, type: e.entity_type }));

  let artifactContent = artifact.user_content || artifact.extracted_content || '';
  if (artifact.content_type === 'binary' && artifact.metadata?.analysis?.extracted_text) {
    artifactContent = artifact.metadata.analysis.extracted_text;
  }

  const prompt = `We identified the following entities in a single piece of captured content:

${JSON.stringify(entityList, null, 2)}

Content:
${artifactContent}

Propose typed relationships between pairs of these entities, using ONLY relationship types from this vocabulary (grouped by category):
${vocabSummary}

Rules:
- Only propose a relationship if the content actually supports it — omit uncertain or unsupported pairs entirely rather than guessing.
- relationship_type must be exactly one of the vocabulary terms above (no synonyms, no new terms).
- from_entity_id and to_entity_id must be different ids from the list above (no self-relationships).
- Propose at most ${MAX_RELATIONSHIP_PROPOSALS_PER_ARTIFACT} relationships.
- confidence is your certainty from 0 to 1 that this relationship is correct given the content.

Return ONLY JSON in this exact format, with no other text:
{"relationships": [{"from_entity_id": "...", "to_entity_id": "...", "relationship_type": "...", "confidence": 0.0, "notes": "optional short justification"}]}

If no relationships can be confidently proposed, return {"relationships": []}.`;

  try {
    const aiResponse = await callAnthropicText(prompt);
    const parsed = JSON.parse(aiResponse.content);
    const rawRelationships = Array.isArray(parsed?.relationships) ? parsed.relationships : [];

    const validIds = new Set(entitiesLinked.map(e => e.id));
    const proposals: ProposedRelationship[] = [];

    for (const raw of rawRelationships.slice(0, MAX_RELATIONSHIP_PROPOSALS_PER_ARTIFACT)) {
      const fromId = String(raw?.from_entity_id ?? '');
      const toId = String(raw?.to_entity_id ?? '');
      const relationshipType = String(raw?.relationship_type ?? '').trim();
      const confidence = typeof raw?.confidence === 'number' ? raw.confidence : 0;

      // Never propose self-loops, and only reference entities we actually passed in.
      if (!fromId || !toId || fromId === toId) continue;
      if (!validIds.has(fromId) || !validIds.has(toId)) continue;
      if (!relationshipType) continue;
      if (confidence <= 0) continue;

      proposals.push({
        from_entity_id: fromId,
        to_entity_id: toId,
        relationship_type: relationshipType,
        confidence: Math.min(Math.max(confidence, 0), 1),
        notes: typeof raw?.notes === 'string' ? raw.notes : undefined,
      });
    }

    return proposals;
  } catch (error: any) {
    // Non-fatal - relationship extraction is a bonus signal, not required for the step to succeed.
    logger.warn('Failed to propose entity relationships', { error: error.message, artifactId: artifact.id });
    return [];
  }
}

/**
 * Legacy/system `entity_relationships.relationship_type` values that must
 * pass through `writeTypedRelationshipEdge` unchanged rather than going
 * through `normalizeRelationshipType` (which only knows the ADR-021
 * People<->People `RELATIONSHIP_VOCABULARY` and falls back to 'other' for
 * anything else — including these). This is the original DB CHECK's
 * allowed set (migration 049 dropped the CHECK; see
 * `20251226182232_remote_schema.sql`'s `entity_relationships_relationship_type_check`)
 * plus `associated_with` (the #170 secondary-containment edge, minted in
 * mcp-server's EDGE_TYPES and written by `proposeContainmentEdge` below),
 * mirrored here rather than imported from mcp-server's `EDGE_TYPES` — `worker`
 * has no dependency on `@ahkms/mcp-server` (an app-layer tool package
 * importing another app-layer tool package would be a layering violation),
 * and this small core is the only part of that vocabulary `worker`
 * itself ever writes (`belongs_to`/`associated_with` from
 * `proposeContainmentEdge`, issue #170).
 * If `worker` starts writing other mcp-server EDGE_TYPES terms, extend this
 * set — do not reach for a cross-package import as the fix.
 */
const SYSTEM_RELATIONSHIP_TYPES = new Set([
  'belongs_to',
  'associated_with',
  'related_to',
  'mentions',
  'depends_on',
  'supersedes',
]);

/**
 * Write a typed `entity_relationships` edge, deduping on the
 * `UNIQUE(user_id, from_entity_id, to_entity_id, relationship_type)` constraint
 * (migration 062) the same way `relateEntities.ts` (mcp-server) does: look up
 * first, update if present, insert if not. Unknown/normalised-away types fall
 * back to 'other' with the raw phrase preserved in notes (ADR-021 soft
 * validation) — this path must never throw on an unrecognised type.
 */
async function writeTypedRelationshipEdge(params: {
  userId: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  confidence: number; // 0-1
  notes?: string;
  createdBy: string;
}): Promise<{ success: boolean; error?: string }> {
  const { userId, fromEntityId, toEntityId, relationshipType, confidence, notes, createdBy } = params;

  if (fromEntityId === toEntityId) {
    return { success: false, error: 'from_entity_id and to_entity_id must differ (no self-edges)' };
  }

  const resolved = SYSTEM_RELATIONSHIP_TYPES.has(relationshipType)
    ? { type: relationshipType }
    : normalizeRelationshipType(relationshipType);
  const edgeNotes = [notes, resolved.notes].filter(Boolean).join(' | ') || null;

  try {
    // Dedup on (user, from, to, type): update if present, else insert. `.single()`
    // errors (e.g. PGRST116) on zero rows — same "not found" signal used elsewhere
    // in this file (findEntityCandidates, writeAreaHierarchyEdge), so a findError
    // here just means "no existing edge", not a real failure.
    const { data: existing } = await supabase
      .from('entity_relationships')
      .select('id')
      .eq('user_id', userId)
      .eq('from_entity_id', fromEntityId)
      .eq('to_entity_id', toEntityId)
      .eq('relationship_type', resolved.type)
      .single();

    if (existing) {
      const { error: updateError } = await supabase
        .from('entity_relationships')
        .update({
          confidence_score: Math.round(confidence * 100),
          notes: edgeNotes,
        })
        .eq('id', existing.id);

      if (updateError) {
        return { success: false, error: updateError.message };
      }
      return { success: true };
    }

    const { error: insertError } = await supabase.from('entity_relationships').insert({
      user_id: userId,
      from_entity_id: fromEntityId,
      to_entity_id: toEntityId,
      relationship_type: resolved.type,
      confidence_score: Math.round(confidence * 100),
      created_by: createdBy,
      notes: edgeNotes,
    });

    if (insertError) {
      return { success: false, error: insertError.message };
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Route each LLM-proposed relationship by confidence against the
 * `relationship_suggestion` threshold (issue #178), mirroring how
 * `executeOrganizeEntitiesStep` routes entity matches/creations: at or above
 * threshold, auto-apply (write the edge directly); below threshold, create a
 * `relationship_suggested` decision for human review instead of writing.
 *
 * Intentional reimplementation, not drift (issue #265): the DB function
 * `should_auto_apply_decision` (supabase/migrations/20251226182232_remote_schema.sql)
 * implements the same `relationship_suggestion` family but as a 4-tier
 * block/review/apply_with_review/auto_apply decision — it's built for
 * decision types that can be *blocked* outright. This call site only ever
 * has two outcomes (write the edge now, or ask a human), so it reads just
 * the `auto_apply` threshold and skips the `review`/`block` tiers entirely;
 * calling the DB function here would require mapping its 4 outcomes back
 * down to these 2, which is more indirection than the two-branch logic
 * below. If a third (block) outcome is ever needed for relationship
 * suggestions, switch this call site to `should_auto_apply_decision` rather
 * than growing a third branch here.
 */
function relationshipSubjectKey(fromEntityId: string, toEntityId: string, relationshipType: string): string {
  const [left, right] = [fromEntityId, toEntityId].sort();
  return `${left}::${right}::${relationshipType}`;
}

async function hasActiveRelationshipLesson(
  userId: string,
  fromEntityId: string,
  toEntityId: string,
  relationshipType: string
): Promise<boolean> {
  try {
    const key = relationshipSubjectKey(fromEntityId, toEntityId, relationshipType);
    const { data, error } = await supabase
      .from('review_lessons')
      .select('id, cooling_off_until')
      .eq('user_id', userId)
      .eq('decision_type', 'relationship_suggested')
      .eq('subject_key', key);

    if (error || !Array.isArray(data) || data.length === 0) {
      return false;
    }

    const nowMs = Date.now();
    return data.some((row: any) => {
      if (row.cooling_off_until === null || row.cooling_off_until === undefined) {
        return true;
      }
      const untilMs = new Date(row.cooling_off_until).getTime();
      return !Number.isNaN(untilMs) && untilMs > nowMs;
    });
  } catch {
    return false;
  }
}

export async function routeProposedRelationships(
  proposals: ProposedRelationship[],
  artifact: any,
  step: WorkflowStep,
  entitiesById: Map<string, Entity>
): Promise<SystemDecision[]> {
  if (proposals.length === 0) {
    return [];
  }

  const threshold = await getRelationshipSuggestionThreshold(artifact.user_id);
  const notificationsCreated: SystemDecision[] = [];
  let lessonsSkipped = 0;

  for (const proposal of proposals) {
    if (proposal.confidence >= threshold) {
      // Auto-apply: write the edge directly.
      const writeResult = await writeTypedRelationshipEdge({
        userId: artifact.user_id,
        fromEntityId: proposal.from_entity_id,
        toEntityId: proposal.to_entity_id,
        relationshipType: proposal.relationship_type,
        confidence: proposal.confidence,
        notes: proposal.notes,
        createdBy: 'organize_entities_step',
      });

      if (!writeResult.success) {
        logger.warn('Failed to auto-apply proposed relationship', {
          error: writeResult.error,
          proposal,
        });
      }
    } else {
      // Below threshold: surface for human review instead of writing, unless an active lesson suppresses it (#1649).
      const suppressed = await hasActiveRelationshipLesson(
        artifact.user_id,
        proposal.from_entity_id,
        proposal.to_entity_id,
        proposal.relationship_type
      );
      if (suppressed) {
        lessonsSkipped++;
        continue;
      }

      const fromEntity = entitiesById.get(proposal.from_entity_id);
      const toEntity = entitiesById.get(proposal.to_entity_id);

      const notification = await createSystemDecision({
        user_id: artifact.user_id,
        team_id: artifact.team_id || null,
        artifact_id: artifact.id,
        decision_type: 'relationship_suggested',
        stage: 'contextualize',
        title: 'Suggested relationship',
        description: `I noticed '${fromEntity?.title ?? proposal.from_entity_id}' might be related to '${toEntity?.title ?? proposal.to_entity_id}' (${proposal.relationship_type}, ${(proposal.confidence * 100).toFixed(0)}% confidence). Add this relationship?`,
        confidence_score: proposal.confidence * 100,
        blocking: false,
        status: 'pending',
        review_type: 'approval',
        decision_payload: {
          fromEntityId: proposal.from_entity_id,
          toEntityId: proposal.to_entity_id,
          fromEntityName: fromEntity?.title,
          toEntityName: toEntity?.title,
          relationshipType: proposal.relationship_type,
          confidence: proposal.confidence,
          notes: proposal.notes,
          artifactId: artifact.id,
        },
        workflow_task_id: step.id,
      });

      if (notification) {
        notificationsCreated.push(notification);
      }
    }
  }

  if (lessonsSkipped > 0) {
    logger.info('Skipped relationship suggestions with active review lessons', {
      userId: artifact.user_id,
      artifactId: artifact.id,
      skipped: lessonsSkipped,
    });
  }

  return notificationsCreated;
}

/**
 * Write the Areas hierarchy as SKOS edges (issue #195 / ADR-033).
 *
 * `properties.parent_area_id` is an AI-enrichment HINT, not a validated
 * pointer: `getEntityAttributesForType('area')` just tells the enrichment
 * prompt "you may extract this," and whatever comes back lands unvalidated
 * in `entities.properties` (JSONB, no FK, no reader anywhere in the codebase
 * before this change — verified: no column, no query, no UI depends on it).
 * This function is the first thing that actually DOES something with that
 * hint: it validates the referenced parent is a real, non-archived Area
 * owned by the same user, then writes the relationship as a proper
 * `entity_relationships` edge pair instead of leaving it as an inert string.
 *
 * Direction (verified against https://www.w3.org/TR/skos-reference/#semantic-relations,
 * S25): `<A> skos:broader <B>` means B is broader than A — the SUBJECT is
 * the narrower concept, the OBJECT is the broader one. So the child area is
 * the subject: `child --broader--> parent`. `skos:narrower` is the declared
 * `owl:inverseOf` (S25), so the reverse edge `parent --narrower--> child` is
 * written alongside it — this keeps the tree traversable in both directions
 * without a query-time direction flip, matching the is_part_of/has_part
 * precedent (#192) of carrying both directions as flat strings.
 *
 * `properties.parent_area_id` itself is left in place as a denormalised
 * cache (dual-write, not a replacement) — nothing reads it today, so there
 * is no compatibility risk either way, and dropping it is a separate,
 * later cleanup (see PR body / issue #195 discussion) rather than something
 * to force into this change.
 */
export async function writeAreaHierarchyEdge(
  childArea: Entity,
  userId: string
): Promise<{ success: boolean; skipped?: string; error?: string }> {
  const parentAreaId = (childArea.properties as any)?.parent_area_id;

  if (childArea.entity_type !== 'area' || !parentAreaId || typeof parentAreaId !== 'string') {
    return { success: true, skipped: 'no parent_area_id hint on this entity' };
  }

  if (parentAreaId === childArea.id) {
    logger.warn('Skipping self-referential area hierarchy edge', { areaId: childArea.id });
    return { success: false, error: 'parent_area_id equals the area\'s own id' };
  }

  try {
    // Validate the parent is a real, owned, non-archived Area — the one thing
    // the old JSON-only hint never did. `.single()` errors (e.g. PGRST116) on
    // zero rows, same "not found" signal used elsewhere in this file
    // (findEntityCandidates, updateEntityCooccurrence).
    const { data: parentArea, error: parentError } = await supabase
      .from('entities')
      .select('id')
      .eq('id', parentAreaId)
      .eq('user_id', userId)
      .eq('entity_type', 'area')
      .eq('archived', false)
      .single();

    if (parentError || !parentArea) {
      logger.warn('parent_area_id hint does not reference a real owned Area; skipping edge write', {
        childAreaId: childArea.id,
        parentAreaId,
        error: parentError?.message,
      });
      return { success: false, error: 'parent_area_id does not reference an existing, owned, non-archived area' };
    }

    // Dedup on (from, to, type): update if present, else insert — mirrors
    // relateEntities.ts's dedup shape for the mcp-server write path.
    //
    // NOTE (QA Low, #232/#233): this lookup is not scoped by `.eq('user_id', ...)`.
    // Safe today because both ids are already validated as owned-by-userId rows
    // before we get here (parentArea via the `.eq('user_id', userId)` check
    // above; childArea via the caller's own fetch) and (from_entity_id,
    // to_entity_id, relationship_type) come from ids already proven unique to
    // this user's Areas — there's no cross-user id collision possible under
    // Postgres UUIDs. Flagged rather than fixed here because scoping this
    // lookup means threading `userId` through, which touches the same
    // dedup shape `relateEntities.ts` (mcp-server) uses — a follow-up cleanup
    // if that shape is ever hardened, not something specific to this function.
    for (const [fromId, toId, relationshipType] of [
      [childArea.id, parentArea.id, 'broader'],
      [parentArea.id, childArea.id, 'narrower'],
    ] as const) {
      const { data: existing, error: findError } = await supabase
        .from('entity_relationships')
        .select('id')
        .eq('from_entity_id', fromId)
        .eq('to_entity_id', toId)
        .eq('relationship_type', relationshipType)
        .single();

      if (existing && !findError) {
        continue; // Edge already recorded; nothing to update for a structural hierarchy edge.
      }

      const { error: insertError } = await supabase.from('entity_relationships').insert({
        user_id: userId,
        from_entity_id: fromId,
        to_entity_id: toId,
        relationship_type: relationshipType,
        confidence_score: 100,
        metadata: { source: 'organize_entities_step' },
      });

      if (insertError) {
        logger.warn('Failed to write area hierarchy edge', { error: insertError.message, relationshipType });
        return { success: false, error: insertError.message };
      }
    }

    logger.info('Wrote area hierarchy edges', { childAreaId: childArea.id, parentAreaId: parentArea.id });
    return { success: true };
  } catch (error: any) {
    logger.warn('Failed to write area hierarchy edge', { error: error.message, childAreaId: childArea.id });
    return { success: false, error: error.message };
  }
}

/**
 * PARA primary/secondary containment (issue #170, decision 2026-07-17): does
 * `entityId` already have a live (non-archived) primary `belongs_to` parent
 * OTHER than `parentId`? If so, a newly resolved containment parent must be
 * emitted as a secondary `associated_with` edge, not a 2nd primary — one
 * primary parent per project/resource is what keeps roll-ups/counting (which
 * traverse `belongs_to` exclusively) free of double-counting. Demoting to
 * secondary (rather than skipping or blocking) preserves the extracted signal:
 * cross-area projects get one primary + the rest associated, per the decision.
 * Errors are swallowed to "no existing primary" — this is a best-effort
 * advisory path (2026-07-05 rule: containment never blocks), and the
 * mcp-server's relate_entities guard is the authoritative single-parent
 * enforcement surface.
 */
async function hasOtherActivePrimaryParent(
  userId: string,
  entityId: string,
  parentId: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('entity_relationships')
      .select('id, to_entity_id')
      .eq('user_id', userId)
      .eq('from_entity_id', entityId)
      .eq('relationship_type', 'belongs_to')
      .eq('archived', false);

    if (error || !data) {
      return false;
    }
    return (data as Array<{ to_entity_id: string }>).some(r => r.to_entity_id !== parentId);
  } catch {
    return false;
  }
}

/** Outcome of `resolveContainmentParent`: which branch fired and why. */
type ContainmentParentResolution =
  | { outcome: 'resolved'; parent: Entity; confidence: number }
  | { outcome: 'no_hint' }
  | { outcome: 'unresolved'; hint: string };

/**
 * Resolve a `parent_entity_hint` (free-text name from AI enrichment) against
 * the user's real, owned, non-archived `area`/`project` entities — the PARA
 * containment counterpart to `writeAreaHierarchyEdge`'s `parent_area_id`
 * validation, but matched by name rather than id (project/resource entities
 * have no id-typed parent hint; see `PARENT_ENTITY_HINT_ATTRIBUTE`).
 *
 * A parent can be an Area (the common case: resource/project -> Area) or
 * another Project (sub-project -> parent Project, e.g. Intelligence Layer ->
 * Work AI per the #170 back-fill) — never a Resource or a People entity,
 * which are never containers in the PARA model.
 *
 * Confidence reflects match quality only (exact title match = 1.0, single
 * fuzzy candidate = 0.7, ambiguous/no match = unresolved) — deliberately
 * simpler than `scoreEntityCandidates`'s multi-factor scoring, since a
 * containment parent is a single well-known name, not a fuzzy mention needing
 * recency/co-occurrence signals.
 */
async function resolveContainmentParent(
  hint: string | undefined,
  userId: string
): Promise<ContainmentParentResolution> {
  const trimmedHint = hint?.trim();
  if (!trimmedHint) {
    return { outcome: 'no_hint' };
  }

  const { data: candidates, error } = await supabase
    .from('entities')
    .select(ENTITY_LIST_COLUMNS.join(', '))
    .eq('user_id', userId)
    .in('entity_type', ['area', 'project'])
    .eq('archived', false)
    .ilike('title', `%${trimmedHint}%`);

  if (error) {
    logger.warn('Containment parent lookup failed', { error: error.message, hint: trimmedHint });
    return { outcome: 'unresolved', hint: trimmedHint };
  }

  const rows = (candidates ?? []) as unknown as Entity[];
  const exact = rows.filter(e => e.title.toLowerCase() === trimmedHint.toLowerCase());
  if (exact.length === 1) {
    return { outcome: 'resolved', parent: exact[0], confidence: 1.0 };
  }
  if (exact.length === 0 && rows.length === 1) {
    return { outcome: 'resolved', parent: rows[0], confidence: 0.7 };
  }

  // Zero or ambiguous (multiple same-titled Areas/Projects): can't safely pick one.
  return { outcome: 'unresolved', hint: trimmedHint };
}

/**
 * PARA containment emission (issue #170): the `belongs_to` counterpart to
 * `routeProposedRelationships` (#178). Resolves a newly-created Project or
 * Resource's `parent_entity_hint` against the user's real Areas/Projects,
 * then routes exactly like a proposed relationship — auto-write the
 * `belongs_to` edge at/above the `relationship_suggestion` auto-apply
 * threshold, otherwise surface a `relationship_suggested` decision instead of
 * writing. Reuses that family rather than minting a new one: containment is,
 * mechanically, a proposed typed edge between two entities, and `#178`'s own
 * threshold plumbing (`getRelationshipSuggestionThreshold`) already covers it
 * — see that function's comment for why a new decision *type* doesn't need a
 * new threshold *family*.
 *
 * Per the settled 2026-07-05 design decision (issue #170): containment is
 * advisory only. When no parent can be resolved at all (no hint, or the hint
 * doesn't match a real owned Area/Project), this does NOT block, retry, or
 * invent a parent — it surfaces a non-blocking `missing_containment`
 * decision so the entity is never silently left orphaned, and never writes
 * a DB constraint or write-time block.
 */
export async function proposeContainmentEdge(
  entity: Entity,
  artifact: any,
  step: WorkflowStep
): Promise<{ wrote: boolean; notification: SystemDecision | null }> {
  if (entity.entity_type !== 'project' && entity.entity_type !== 'resource') {
    return { wrote: false, notification: null };
  }

  const hint = (entity.properties as any)?.parent_entity_hint;
  const resolution = await resolveContainmentParent(
    typeof hint === 'string' ? hint : undefined,
    entity.user_id
  );

  if (resolution.outcome === 'resolved' && resolution.parent.id === entity.id) {
    logger.warn('Skipping self-referential containment edge', { entityId: entity.id });
    return { wrote: false, notification: null };
  }

  if (resolution.outcome === 'resolved') {
    const threshold = await getRelationshipSuggestionThreshold(entity.user_id);

    // #170 primary/secondary: if this entity already carries a live primary
    // belongs_to parent pointing elsewhere, this resolution becomes a
    // secondary `associated_with` edge (non-counted) rather than a 2nd
    // primary. Computed once so the auto-write AND the below-threshold
    // suggestion payload agree on the type — an approved suggestion is
    // applied verbatim by the feedback path, which must not then violate
    // single-parent.
    const containmentType = (await hasOtherActivePrimaryParent(
      entity.user_id,
      entity.id,
      resolution.parent.id
    ))
      ? 'associated_with'
      : 'belongs_to';

    if (resolution.confidence >= threshold) {
      const writeResult = await writeTypedRelationshipEdge({
        userId: entity.user_id,
        fromEntityId: entity.id,
        toEntityId: resolution.parent.id,
        relationshipType: containmentType,
        confidence: resolution.confidence,
        notes: `Resolved from parent_entity_hint "${(hint as string).trim()}"${
          containmentType === 'associated_with'
            ? ' (secondary: a primary belongs_to parent already exists, #170)'
            : ''
        }`,
        createdBy: 'organize_entities_step',
      });

      if (!writeResult.success) {
        logger.warn('Failed to auto-apply containment edge', {
          error: writeResult.error,
          entityId: entity.id,
          parentId: resolution.parent.id,
        });
      }
      return { wrote: writeResult.success, notification: null };
    }

    // Below threshold: surface for human review instead of writing (same
    // shape as routeProposedRelationships's below-threshold branch).
    const skippedByLesson = await hasActiveRelationshipLesson(
      entity.user_id,
      entity.id,
      resolution.parent.id,
      containmentType,
    );
    if (skippedByLesson) {
      logger.info('Skipping containment suggestion due to active review lesson', {
        artifactId: artifact.id,
        userId: entity.user_id,
        fromEntityId: entity.id,
        toEntityId: resolution.parent.id,
        relationshipType: containmentType,
      });
      return { wrote: false, notification: null };
    }

    const notification = await createSystemDecision({
      user_id: entity.user_id,
      team_id: artifact.team_id || null,
      artifact_id: artifact.id,
      decision_type: 'relationship_suggested',
      stage: 'contextualize',
      title: 'Suggested containment',
      description: `I noticed '${entity.title}' might belong under '${resolution.parent.title}' (${containmentType}, ${(resolution.confidence * 100).toFixed(0)}% confidence). Add this relationship?`,
      confidence_score: resolution.confidence * 100,
      blocking: false,
      status: 'pending',
      review_type: 'approval',
      decision_payload: {
        fromEntityId: entity.id,
        toEntityId: resolution.parent.id,
        fromEntityName: entity.title,
        toEntityName: resolution.parent.title,
        relationshipType: containmentType,
        confidence: resolution.confidence,
        artifactId: artifact.id,
      },
      workflow_task_id: step.id,
    });
    return { wrote: false, notification };
  }

  // No hint, or the hint didn't resolve to a real owned Area/Project: flag as
  // missing containment rather than leaving the entity silently orphaned.
  // Advisory only (issue #170 decision) — never blocking, never a constraint.
  const unresolvedHint = resolution.outcome === 'unresolved' ? resolution.hint : null;
  const notification = await createSystemDecision({
    user_id: entity.user_id,
    team_id: artifact.team_id || null,
    artifact_id: artifact.id,
    decision_type: 'missing_containment',
    stage: 'contextualize',
    title: `No PARA parent found for '${entity.title}'`,
    description: unresolvedHint
      ? `'${entity.title}' looks like it belongs under '${unresolvedHint}', but I couldn't find an Area or Project with that name. Link it manually?`
      : `'${entity.title}' isn't linked under any Area or Project yet. Where does it belong?`,
    confidence_score: 0,
    blocking: false,
    status: 'pending',
    review_type: 'suggestion',
    decision_payload: {
      entityId: entity.id,
      entityName: entity.title,
      entityType: entity.entity_type,
      attemptedHint: unresolvedHint,
      artifactId: artifact.id,
    },
    workflow_task_id: step.id,
  });
  return { wrote: false, notification };
}

/**
 * Create a system decision (notification)
 */
async function createSystemDecision(
  decisionData: Partial<SystemDecision>
): Promise<SystemDecision | null> {
  try {
    const { data, error } = await supabase
      .from('system_decisions')
      .insert(decisionData)
      .select()
      .single();

    if (error) {
      logger.error('Failed to create system decision', { error: error.message });
      return null;
    }

    return data;
  } catch (err: any) {
    logger.error('Error creating system decision', { err: err.message });
    return null;
  }
}

/**
 * Create artifact-entity link
 */
async function createArtifactEntityLink(
  artifactId: string,
  entityId: string,
  confidenceScore: number,
  userId: string
): Promise<boolean> {
  try {
    const { error } = await supabase.from('artifact_entity_links').insert({
      user_id: userId,
      artifact_id: artifactId,
      entity_id: entityId,
      link_type: 'primary',
      confidence_score: confidenceScore * 100, // Convert 0-1 to 0-100
    });

    if (error) {
      logger.error('Failed to create artifact-entity link', { error: error.message });
      return false;
    }

    return true;
  } catch (err: any) {
    logger.error('Error creating artifact-entity link', { err: err.message });
    return false;
  }
}

/**
 * Confidence thresholds governing entity-mention routing decisions
 * (issue #36 extraction — previously inline `MATCH_CONFIDENCE_THRESHOLD` /
 * `CREATE_CONFIDENCE_THRESHOLD` locals in `executeOrganizeEntitiesStep`).
 */
interface EntityMentionThresholds {
  matchConfidenceThreshold: number;
  createConfidenceThreshold: number;
}

/** Outcome of processing a single entity mention (issue #36). */
interface ProcessedEntityMention {
  linked: Entity | null;
  created: Entity | null;
  notifications: SystemDecision[];
}

/**
 * 5b. No candidate entities found for this mention: auto-create above the
 * create-confidence threshold, otherwise skip and surface for review.
 * Extracted verbatim from `executeOrganizeEntitiesStep`'s former inline loop
 * body (issue #36) — same branching, same calls, same logging.
 */
async function createOrSkipUnmatchedMention(
  entityMention: AnalysisResult['entities_mentioned'][number],
  artifact: any,
  artifactId: ArtifactId,
  step: WorkflowStep,
  createConfidenceThreshold: number
): Promise<ProcessedEntityMention> {
  if (entityMention.confidence > createConfidenceThreshold) {
    // Auto-create - High confidence, no existing entity
    logger.info('Auto-creating entity', { confidence: entityMention.confidence });

    try {
      const newEntityResult = await createEntityFromMention(entityMention, artifact);

      // Link to artifact
      await createArtifactEntityLink(
        artifactId.value,
        newEntityResult.entity.id,
        entityMention.confidence,
        artifact.user_id
      );

      // If AI enrichment surfaced a parent_area_id hint (Areas only), write
      // it as a validated SKOS broader/narrower edge pair (issue #195).
      // Non-fatal: a bad or missing hint just means no hierarchy edge, same
      // as today.
      let containmentNotification: SystemDecision | null = null;
      if (newEntityResult.entity.entity_type === 'area') {
        const hierarchyResult = await writeAreaHierarchyEdge(newEntityResult.entity, artifact.user_id);
        if (!hierarchyResult.success) {
          logger.warn('Area hierarchy edge not written', {
            entityId: newEntityResult.entity.id,
            reason: hierarchyResult.error,
          });
        }
      } else {
        // PARA containment (issue #170): Projects/Resources resolve a
        // `belongs_to` parent from their `parent_entity_hint` enrichment
        // attribute, auto-writing above the relationship_suggestion
        // threshold and surfacing a decision (relationship_suggested, or
        // missing_containment when no parent could be resolved) otherwise.
        // Non-fatal, same posture as the Area hierarchy branch above.
        const containmentResult = await proposeContainmentEdge(newEntityResult.entity, artifact, step);
        containmentNotification = containmentResult.notification;
      }

      // Notify user (info, non-blocking)
      const notification = await createSystemDecision({
        user_id: artifact.user_id,
        team_id: artifact.team_id || null,
        artifact_id: artifactId.value,
        decision_type: 'entity_created',
        stage: 'contextualize',
        title: 'New entity created',
        description: `I created a new ${entityMention.type}: ${entityMention.name}`,
        confidence_score: entityMention.confidence * 100,
        blocking: false,
        status: 'auto_applied',
        review_type: 'suggestion',
        decision_payload: {
          entityId: newEntityResult.entity.id,
          entityType: entityMention.type,
          entityName: entityMention.name,
          enriched: newEntityResult.enriched,
          attributes: newEntityResult.entity.properties,
        },
        workflow_task_id: step.id,
      });

      logger.info('Entity created', { entityId: newEntityResult.entity.id });

      return {
        linked: newEntityResult.entity,
        created: newEntityResult.entity,
        notifications: [notification, containmentNotification].filter(
          (n): n is SystemDecision => n !== null
        ),
      };
    } catch (error: any) {
      logger.error('Failed to create entity', { error: error.message, entityName: entityMention.name });
      // Continue with next entity
      return { linked: null, created: null, notifications: [] };
    }
  }

  // Below threshold: skip (don't create). Surface non-blocking decision for review (edge case #9).
  logger.info('Below create threshold, skipping and surfacing for review', { confidence: entityMention.confidence });

  const notification = await createSystemDecision({
    user_id: artifact.user_id,
    team_id: artifact.team_id || null,
    artifact_id: artifactId.value,
    decision_type: 'entity_creation_skipped',
    stage: 'contextualize',
    title: 'Skipped: ' + entityMention.name,
    description: `I skipped creating '${entityMention.name}' (${(entityMention.confidence * 100).toFixed(0)}% confidence). Create anyway?`,
    confidence_score: entityMention.confidence * 100,
    blocking: false,
    status: 'pending',
    review_type: 'suggestion',
    decision_payload: {
      entityMention,
      artifactId: artifactId.value,
      workflowId: step.workflow_id,
      workflow_task_id: step.id,
    },
    workflow_task_id: step.id,
  });

  return { linked: null, created: null, notifications: notification ? [notification] : [] };
}

/**
 * 5c. Exactly one candidate entity found for this mention: link automatically
 * above the match-confidence threshold, otherwise link the best guess and
 * surface for review. Extracted verbatim from `executeOrganizeEntitiesStep`'s
 * former inline loop body (issue #36).
 */
async function linkSingleCandidateMention(
  entityMention: AnalysisResult['entities_mentioned'][number],
  candidate: Entity,
  artifact: any,
  artifactId: ArtifactId,
  step: WorkflowStep,
  analysisResult: AnalysisResult,
  matchConfidenceThreshold: number
): Promise<ProcessedEntityMention> {
  logger.info('Single candidate found', { candidateId: candidate.id, candidateTitle: candidate.title });

  // Score the candidate
  const scoredCandidate = await scoreEntityCandidate(candidate, entityMention, artifact, analysisResult);

  logger.info('Candidate score', {
    score: scoredCandidate.confidence,
    threshold: matchConfidenceThreshold,
  });

  if (scoredCandidate.confidence > matchConfidenceThreshold) {
    // Clear match - Link automatically
    logger.info('Clear match, auto-linking');

    await createArtifactEntityLink(artifactId.value, candidate.id, scoredCandidate.confidence, artifact.user_id);

    logger.info('Entity linked', { entityTitle: candidate.title });

    return { linked: candidate, created: null, notifications: [] };
  }

  // Uncertain match: best guess + non-blocking review (consistent with edge case #9)
  logger.info('Uncertain match, auto-linking and surfacing for review');

  await createArtifactEntityLink(artifactId.value, candidate.id, scoredCandidate.confidence, artifact.user_id);

  const notification = await createSystemDecision({
    user_id: artifact.user_id,
    team_id: artifact.team_id || null,
    artifact_id: artifactId.value,
    decision_type: 'confirm_entity_match',
    stage: 'contextualize',
    title: 'Is this the right entity?',
    description: `I found '${entityMention.name}' which might match '${candidate.title}' (confidence: ${(scoredCandidate.confidence * 100).toFixed(0)}%). Is this correct?`,
    confidence_score: scoredCandidate.confidence * 100,
    blocking: false,
    status: 'pending',
    review_type: 'approval',
    decision_payload: {
      entityMention,
      candidateEntity: {
        id: candidate.id,
        title: candidate.title,
        type: candidate.entity_type,
        properties: candidate.properties,
      },
      score: scoredCandidate,
      artifactId,
      alternativeAction: 'create_new',
      workflowId: step.workflow_id,
      workflow_id: step.workflow_id,
    },
    workflow_task_id: step.id,
  });

  return { linked: candidate, created: null, notifications: notification ? [notification] : [] };
}

/**
 * 5d. Multiple candidate entities found for this mention: link the best match
 * automatically above the match-confidence threshold, otherwise link the
 * best guess and surface a disambiguation decision. Extracted verbatim from
 * `executeOrganizeEntitiesStep`'s former inline loop body (issue #36).
 */
async function linkBestOfMultipleCandidatesMention(
  entityMention: AnalysisResult['entities_mentioned'][number],
  candidates: Entity[],
  artifact: any,
  artifactId: ArtifactId,
  step: WorkflowStep,
  analysisResult: AnalysisResult,
  matchConfidenceThreshold: number
): Promise<ProcessedEntityMention> {
  logger.info('Multiple candidates found', { count: candidates.length });

  // Score all candidates
  const scoredCandidates = await scoreEntityCandidates(candidates, entityMention, artifact, analysisResult);

  const bestMatch = scoredCandidates[0];

  logger.info('Best match', {
    entityTitle: bestMatch.entity.title,
    confidence: bestMatch.confidence,
  });

  if (bestMatch.confidence > matchConfidenceThreshold) {
    // Clear best match - Link automatically
    logger.info('Clear best match, auto-linking');

    await createArtifactEntityLink(artifactId.value, bestMatch.entity.id, bestMatch.confidence, artifact.user_id);

    logger.info('Entity linked', { entityTitle: bestMatch.entity.title });

    return { linked: bestMatch.entity, created: null, notifications: [] };
  }

  // Ambiguous: best guess + non-blocking review (consistent with edge case #9)
  logger.info('Ambiguous match, auto-linking to best and surfacing for review');

  await createArtifactEntityLink(artifactId.value, bestMatch.entity.id, bestMatch.confidence, artifact.user_id);

  const notification = await createSystemDecision({
    user_id: artifact.user_id,
    team_id: artifact.team_id || null,
    artifact_id: artifactId.value,
    decision_type: 'entity_disambiguation',
    stage: 'contextualize',
    title: 'Which entity did you mean?',
    description: `I found multiple matches for '${entityMention.name}'. Which one?`,
    confidence_score: bestMatch.confidence * 100,
    blocking: false,
    status: 'pending',
    review_type: 'approval',
    decision_payload: {
      entityMention,
      candidates: scoredCandidates.slice(0, 5).map(sc => ({
        id: sc.entity.id,
        title: sc.entity.title,
        type: sc.entity.entity_type,
        properties: sc.entity.properties,
        confidence: sc.confidence,
        breakdown: sc.breakdown,
      })),
      artifactId,
      alternativeAction: 'create_new',
      autoLinkedEntityId: bestMatch.entity.id,
      workflowId: step.workflow_id,
      workflow_id: step.workflow_id,
    },
    workflow_task_id: step.id,
  });

  return { linked: bestMatch.entity, created: null, notifications: notification ? [notification] : [] };
}

/**
 * Process a single entity mention end-to-end: find candidates, then route to
 * the create/link/disambiguate branch that matches the candidate count,
 * exactly as `executeOrganizeEntitiesStep`'s loop body used to inline
 * (issue #36 — "Extract entity mention processing in organize_entities").
 * Pure structural extraction: same candidate lookup, same branch conditions,
 * same DB calls/args, same decision routing, same logging, same error
 * handling as before — only the orchestrator now iterates and aggregates.
 */
async function processEntityMention(
  entityMention: AnalysisResult['entities_mentioned'][number],
  artifact: any,
  artifactId: ArtifactId,
  step: WorkflowStep,
  analysisResult: AnalysisResult,
  thresholds: EntityMentionThresholds
): Promise<ProcessedEntityMention> {
  logger.info('Processing entity', {
    name: entityMention.name,
    type: entityMention.type,
    confidence: entityMention.confidence,
  });

  // 5a. Find candidate entities
  const candidates = await findEntityCandidates(entityMention, artifact.user_id);

  logger.info('Found candidates', {
    entityName: entityMention.name,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    return createOrSkipUnmatchedMention(
      entityMention,
      artifact,
      artifactId,
      step,
      thresholds.createConfidenceThreshold
    );
  }

  if (candidates.length === 1) {
    return linkSingleCandidateMention(
      entityMention,
      candidates[0],
      artifact,
      artifactId,
      step,
      analysisResult,
      thresholds.matchConfidenceThreshold
    );
  }

  return linkBestOfMultipleCandidatesMention(
    entityMention,
    candidates,
    artifact,
    artifactId,
    step,
    analysisResult,
    thresholds.matchConfidenceThreshold
  );
}

/**
 * Execute the organize entities step
 */
export async function executeOrganizeEntitiesStep(
  step: WorkflowStep,
  artifactId: ArtifactId,
  stepId: StepId,
  analysisResult: AnalysisResult
): Promise<OrganizeResult> {
  const startTime = Date.now();

  logger.info('Starting organize entities step', {
    stepId: stepId.value,
    artifactId: artifactId.value,
    entityCount: analysisResult.entities_mentioned.length,
  });

  // 1. Update step status to processing
  await updateStepStatus(stepId, 'running', {
    started_at: new Date().toISOString(),
    message: `Organizing ${analysisResult.entities_mentioned.length} entities...`,
  });

  // 2. Fetch artifact
  const { data: artifact, error: artifactError } = await supabase
    .from('artifacts')
    .select('*')
    .eq('id', artifactId.value)
    .single();

  if (artifactError || !artifact) {
    logger.error('Artifact not found', { artifactId: artifactId.value, error: artifactError?.message });
    await updateStepStatus(stepId, 'failed', {
      message: 'Artifact not found',
      error_message: artifactError?.message || 'Artifact not found',
      completed_at: new Date().toISOString(),
    });

    return {
      success: false,
      error: 'Artifact not found',
      entitiesLinked: [],
      entitiesCreated: [],
      notificationsCreated: [],
    };
  }

  // 3. Fetch user preferences (confidence thresholds)
  const preferences = await getUserPreferences(artifact.user_id);
  const MATCH_CONFIDENCE_THRESHOLD = preferences.entityMatchThreshold;
  const CREATE_CONFIDENCE_THRESHOLD = preferences.entityCreateThreshold;

  // 4. Track results
  const entitiesLinked: Entity[] = [];
  const entitiesCreated: Entity[] = [];
  const notificationsCreated: SystemDecision[] = [];

  logger.info('Organizing entities', { count: analysisResult.entities_mentioned.length });

  // 5. Process each entity mention
  const thresholds: EntityMentionThresholds = {
    matchConfidenceThreshold: MATCH_CONFIDENCE_THRESHOLD,
    createConfidenceThreshold: CREATE_CONFIDENCE_THRESHOLD,
  };

  for (const entityMention of analysisResult.entities_mentioned) {
    const result = await processEntityMention(entityMention, artifact, artifactId, step, analysisResult, thresholds);

    if (result.created) {
      entitiesCreated.push(result.created);
    }
    if (result.linked) {
      entitiesLinked.push(result.linked);
    }
    notificationsCreated.push(...result.notifications);
  }

  // 6. Update entity co-occurrence
  if (entitiesLinked.length > 1) {
    logger.info('Updating co-occurrence', { entityCount: entitiesLinked.length });

    const cooccurrenceResult = await updateEntityCooccurrence(entitiesLinked, artifactId.value);

    if (!cooccurrenceResult.success) {
      logger.warn('Failed to update co-occurrence', { error: cooccurrenceResult.error });
    }
  }

  // 6b. Extract typed relationships between this artifact's linked entities (#178).
  // co_occurs_with (above) is a separate statistical signal and is left untouched.
  // Only runs with >=2 linked entities (LLM cost/latency guard).
  if (entitiesLinked.length >= 2) {
    logger.info('Proposing typed relationships', { entityCount: entitiesLinked.length });

    try {
      const proposals = await proposeEntityRelationships(entitiesLinked, artifact);

      if (proposals.length > 0) {
        const entitiesById = new Map(entitiesLinked.map(e => [e.id, e]));
        const relationshipNotifications = await routeProposedRelationships(
          proposals,
          artifact,
          step,
          entitiesById
        );
        notificationsCreated.push(...relationshipNotifications);
      }
    } catch (error: any) {
      // Non-fatal - relationship extraction is a bonus signal, not required for the step to succeed.
      logger.warn('Failed to extract typed relationships', { error: error.message });
    }
  }

  // 7. Update step status
  const blockingNotifications = notificationsCreated.filter(n => n.blocking === true);

  let stepStatus: WorkflowStep['status'];
  let stepMessage: string;

  if (blockingNotifications.length > 0) {
    stepStatus = 'running'; // Keep as running, will be updated when user responds
    stepMessage = `Processed ${analysisResult.entities_mentioned.length} entities. Created: ${entitiesCreated.length}, Linked: ${entitiesLinked.length}, Pending user input: ${blockingNotifications.length}`;
  } else {
    stepStatus = 'completed';
    stepMessage = `Processed ${analysisResult.entities_mentioned.length} entities. Created: ${entitiesCreated.length}, Linked: ${entitiesLinked.length}`;
  }

  await updateStepStatus(stepId, stepStatus, {
    message: stepMessage,
    output: {
      entitiesLinked: entitiesLinked.map(e => ({ id: e.id, title: e.title })),
      entitiesCreated: entitiesCreated.map(e => ({ id: e.id, title: e.title })),
      notificationIds: notificationsCreated.map(n => n.id),
    },
    completed_at: stepStatus === 'completed' ? new Date().toISOString() : null,
    duration_ms: Date.now() - startTime,
  });

  // 8. Update artifact lifecycle
  if (blockingNotifications.length === 0) {
    // All entities processed without user input needed
    await supabase
      .from('artifacts')
      .update({ lifecycle_stage: 'entities_extracted' })
      .eq('id', artifactId.value);

    logger.info('Artifact lifecycle updated to entities_extracted');
  } else {
    // Paused for user input. Ensure artifact is at least 'analysed' so UIs and reports don't
    // show "Uploaded" when we've clearly run analyze + organize_entities (e.g. if analyze
    // never persisted lifecycle_stage due to a bug or race).
    if (artifact.lifecycle_stage === 'uploaded') {
      const { error: stageError } = await supabase
        .from('artifacts')
        .update({ lifecycle_stage: 'analysed' })
        .eq('id', artifactId.value);

      if (stageError) {
        logger.warn('Failed to backfill artifact lifecycle_stage to analysed', {
          artifactId: artifactId.value,
          error: stageError.message,
        });
      } else {
        logger.info('Artifact lifecycle backfilled to analysed (was uploaded while awaiting user)');
      }
    }
    logger.info('Artifact awaiting user input for entity disambiguation');
  }

  // 9. Return results
  logger.info('Entity organization complete', {
    linked: entitiesLinked.length,
    created: entitiesCreated.length,
    notifications: notificationsCreated.length,
  });

  return {
    success: true,
    status: blockingNotifications.length > 0 ? 'awaiting_user' : 'completed',
    entitiesLinked,
    entitiesCreated,
    notificationsCreated,
  };
}

