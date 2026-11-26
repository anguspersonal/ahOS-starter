/**
 * Unit tests for merge_suggested approval — entity identity resolution (#174).
 * Exercises handleMergeSuggestedFeedback: repoint edges/links loser->winner,
 * tombstone the loser, alias the winner, and resolve the decision.
 */

import { handleMergeSuggestedFeedback } from '../../../src/workflows/resume';
import {
  resetMockData,
  setMockData,
  getMockData,
  getSelectCalls,
  resetMockSupabase,
} from '../../__mocks__/supabase';
import { ENTITY_LIST_COLUMNS } from '@ahkms/shared';
import { embedEntityAndStore } from '../../../src/utils/embeddings';

jest.mock('../../../src/utils/embeddings');
const mockEmbedEntityAndStore = embedEntityAndStore as jest.MockedFunction<typeof embedEntityAndStore>;

const USER = 'user-1';

function seedDecision(overrides: Record<string, any> = {}) {
  setMockData('system_decisions', [
    {
      id: 'dec-1',
      user_id: USER,
      decision_type: 'merge_suggested',
      status: 'pending',
      decision_payload: { winnerEntityId: 'w', loserEntityId: 'l' },
      ...overrides,
    },
  ]);
}

function seedEntities(winnerProps: any = {}, loserProps: any = {}, loserExtra: any = {}) {
  setMockData('entities', [
    { id: 'w', title: 'Angus Hally', entity_type: 'people', user_id: USER, archived: false, properties: winnerProps },
    { id: 'l', title: 'Angus', entity_type: 'people', user_id: USER, archived: false, properties: loserProps, ...loserExtra },
  ]);
}

describe('handleMergeSuggestedFeedback', () => {
  beforeEach(() => {
    resetMockData();
    resetMockSupabase();
    mockEmbedEntityAndStore.mockReset();
    mockEmbedEntityAndStore.mockResolvedValue('skipped');
  });

  it('repoints edges and links, tombstones the loser, aliases the winner, resolves approved', async () => {
    seedDecision();
    seedEntities();
    setMockData('entity_relationships', [
      { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
      { id: 'e2', user_id: USER, from_entity_id: 'y', to_entity_id: 'l', relationship_type: 'colleagueOf', archived: false },
    ]);
    setMockData('artifact_entity_links', [
      { id: 'lnk1', artifact_id: 'art1', entity_id: 'l', link_type: 'primary' },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    const edges = getMockData('entity_relationships');
    expect(edges.find((e: any) => e.id === 'e1').from_entity_id).toBe('w');
    expect(edges.find((e: any) => e.id === 'e2').to_entity_id).toBe('w');

    const links = getMockData('artifact_entity_links');
    expect(links.find((l: any) => l.id === 'lnk1').entity_id).toBe('w');

    const entities = getMockData('entities');
    const loser = entities.find((e: any) => e.id === 'l');
    const winner = entities.find((e: any) => e.id === 'w');
    expect(loser.archived).toBe(true);
    expect(loser.properties.merged_into).toBe('w');
    expect(loser.properties.archived_reason).toBe('merged_duplicate');
    expect(winner.aliases).toContain('Angus');
    expect(winner.properties.aliases).toBeUndefined();

    const decision = getMockData('system_decisions')[0];
    expect(decision.status).toBe('approved');
    expect(decision.decision_payload.mergedAt).toBeTruthy();
  });

  it('archives a repointed edge that would collide with an existing winner edge', async () => {
    seedDecision();
    seedEntities();
    setMockData('entity_relationships', [
      { id: 'e0', user_id: USER, from_entity_id: 'w', to_entity_id: 'x', relationship_type: 'knows', archived: false },
      { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    const edges = getMockData('entity_relationships');
    expect(edges.find((e: any) => e.id === 'e0').archived).toBe(false);
    const e1 = edges.find((e: any) => e.id === 'e1');
    expect(e1.archived).toBe(true);
    // not repointed (still points at loser) because it was archived as a duplicate
    expect(e1.from_entity_id).toBe('l');
  });

  describe('PARA primary-containment demotion on repoint (#170 decision 2026-07-17)', () => {
    function seedProjectPair() {
      setMockData('entities', [
        { id: 'w', title: 'Work AI', entity_type: 'project', user_id: USER, archived: false, properties: {} },
        { id: 'l', title: 'Work', entity_type: 'project', user_id: USER, archived: false, properties: {} },
      ]);
    }

    it("demotes the loser's inherited belongs_to to associated_with when the winner already has a live primary to a different Area", async () => {
      seedDecision();
      seedProjectPair();
      setMockData('entity_relationships', [
        // Winner's own primary parent (must survive untouched — it wins).
        { id: 'eW', user_id: USER, from_entity_id: 'w', to_entity_id: 'area-business', relationship_type: 'belongs_to', archived: false },
        // Loser's primary parent, pointing at a DIFFERENT area: no UNIQUE
        // collision on repoint, so without demotion the winner would end up
        // with two live primaries and double-counting roll-ups.
        { id: 'eL', user_id: USER, from_entity_id: 'l', to_entity_id: 'area-tech', relationship_type: 'belongs_to', archived: false },
      ]);

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      const edges = getMockData('entity_relationships');
      expect(edges.find((e: any) => e.id === 'eW')).toMatchObject({
        from_entity_id: 'w',
        relationship_type: 'belongs_to',
        archived: false,
      });
      expect(edges.find((e: any) => e.id === 'eL')).toMatchObject({
        from_entity_id: 'w',
        to_entity_id: 'area-tech',
        relationship_type: 'associated_with',
        archived: false,
      });

      // The pre-demotion type is captured on the merge record so
      // entity_unmerge can reverse it (#457 PR 2 QA round 1 High).
      const loser = getMockData('entities').find((e: any) => e.id === 'l');
      expect(loser.properties._merge.demoted_edge_types).toEqual({ eL: 'belongs_to' });
    });

    it("keeps the loser's belongs_to as the primary when the winner has none of its own", async () => {
      seedDecision();
      seedProjectPair();
      setMockData('entity_relationships', [
        { id: 'eL', user_id: USER, from_entity_id: 'l', to_entity_id: 'area-tech', relationship_type: 'belongs_to', archived: false },
      ]);

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      expect(getMockData('entity_relationships').find((e: any) => e.id === 'eL')).toMatchObject({
        from_entity_id: 'w',
        relationship_type: 'belongs_to',
      });
    });

    it('does not demote for non-project/resource winners (people merges keep belongs_to as-is)', async () => {
      seedDecision();
      seedEntities(); // people pair
      setMockData('entity_relationships', [
        { id: 'eW', user_id: USER, from_entity_id: 'w', to_entity_id: 'org-1', relationship_type: 'belongs_to', archived: false },
        { id: 'eL', user_id: USER, from_entity_id: 'l', to_entity_id: 'org-2', relationship_type: 'belongs_to', archived: false },
      ]);

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      expect(getMockData('entity_relationships').find((e: any) => e.id === 'eL')).toMatchObject({
        from_entity_id: 'w',
        relationship_type: 'belongs_to',
      });
    });
  });

  it('archives the loser<->winner edge (self-loop) instead of repointing it', async () => {
    seedDecision();
    seedEntities();
    setMockData('entity_relationships', [
      { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'w', relationship_type: 'friendOf', archived: false },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    const e1 = getMockData('entity_relationships').find((e: any) => e.id === 'e1');
    expect(e1.archived).toBe(true);
  });

  it('deletes a loser link that would collide with an existing winner link', async () => {
    seedDecision();
    seedEntities();
    setMockData('artifact_entity_links', [
      { id: 'lnkW', artifact_id: 'art1', entity_id: 'w', link_type: 'primary' },
      { id: 'lnkL', artifact_id: 'art1', entity_id: 'l', link_type: 'primary' },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    const links = getMockData('artifact_entity_links');
    expect(links.find((l: any) => l.id === 'lnkL')).toBeUndefined();
    expect(links.find((l: any) => l.id === 'lnkW')).toBeDefined();

    // The dropped (hard-deleted, not repointed) link must be recorded on the
    // `_merge` audit trail so the merge record isn't silently incomplete.
    const loser = getMockData('entities').find((e: any) => e.id === 'l');
    expect(loser.properties._merge.links_deleted).toEqual(['lnkL']);
    expect(loser.properties._merge.links_moved).toEqual([]);
  });

  it('reject resolves the decision without merging', async () => {
    seedDecision();
    seedEntities();
    setMockData('entity_relationships', [
      { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'reject', resolvedBy: USER });

    expect(getMockData('system_decisions')[0].status).toBe('rejected');
    expect(getMockData('entity_relationships')[0].from_entity_id).toBe('l');
    expect(getMockData('entities').find((e: any) => e.id === 'l').archived).toBe(false);
  });

  it('is idempotent when the loser is already merged', async () => {
    seedDecision();
    seedEntities({}, { merged_into: 'w', archived_reason: 'merged_duplicate' }, { archived: true });
    setMockData('entity_relationships', [
      { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    // No repoint attempted on an already-merged loser.
    expect(getMockData('entity_relationships')[0].from_entity_id).toBe('l');
    expect(getMockData('system_decisions')[0].status).toBe('approved');
  });

  it('rejects a payload missing the entity ids', async () => {
    seedDecision({ decision_payload: { winnerEntityId: 'w' } });
    seedEntities();

    await expect(
      handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER }),
    ).rejects.toThrow(/loserEntityId/);
  });

  it('refuses to merge onto an archived winner (out-of-order chained-duplicate approval)', async () => {
    // Cluster of 3 duplicates: A, B, C. Two independent pending decisions from
    // one sweep — D1: winner=A loser=B; D2: winner=C loser=A. Approving D2
    // first tombstones A (merged_into=C). Approving D1 afterwards must not
    // repoint B's data onto the now-dead A.
    setMockData('system_decisions', [
      { id: 'd1', user_id: USER, decision_type: 'merge_suggested', status: 'pending', decision_payload: { winnerEntityId: 'a', loserEntityId: 'b' } },
      { id: 'd2', user_id: USER, decision_type: 'merge_suggested', status: 'pending', decision_payload: { winnerEntityId: 'c', loserEntityId: 'a' } },
    ]);
    setMockData('entities', [
      { id: 'a', title: 'Angus H', entity_type: 'people', user_id: USER, archived: false, properties: {} },
      { id: 'b', title: 'Angus', entity_type: 'people', user_id: USER, archived: false, properties: {} },
      { id: 'c', title: 'Angus Hally', entity_type: 'people', user_id: USER, archived: false, properties: {} },
    ]);
    setMockData('entity_relationships', [
      { id: 'e1', user_id: USER, from_entity_id: 'b', to_entity_id: 'x', relationship_type: 'knows', archived: false },
    ]);

    // Approve D2 first: A merges into C and is tombstoned.
    await handleMergeSuggestedFeedback({ decisionId: 'd2', action: 'approve', resolvedBy: USER });
    const aAfterD2 = getMockData('entities').find((e: any) => e.id === 'a');
    expect(aAfterD2.archived).toBe(true);
    expect(aAfterD2.properties.merged_into).toBe('c');

    // Approving D1 (stale winner=A) must fail fast rather than repoint B onto dead A.
    await expect(
      handleMergeSuggestedFeedback({ decisionId: 'd1', action: 'approve', resolvedBy: USER }),
    ).rejects.toThrow(/archived/);

    // B's edge must remain untouched (not repointed onto the dead entity A).
    const edge = getMockData('entity_relationships').find((e: any) => e.id === 'e1');
    expect(edge.from_entity_id).toBe('b');
    // B itself must not have been tombstoned.
    const b = getMockData('entities').find((e: any) => e.id === 'b');
    expect(b.archived).toBe(false);
    // D1 must remain pending (not falsely marked approved) so it can be re-triaged.
    const d1 = getMockData('system_decisions').find((d: any) => d.id === 'd1');
    expect(d1.status).toBe('pending');
  });

  it('supersedes (rejects) the decision when the loser was already merged into a different winner', async () => {
    seedDecision();
    // Loser 'l' was already merged into some other entity 'z', not this decision's winner 'w'.
    seedEntities({}, { merged_into: 'z', archived_reason: 'merged_duplicate' }, { archived: true });
    setMockData('entity_relationships', [
      { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
    ]);

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    // No repoint attempted for this (winner='w') pairing since the merge never happened for it.
    expect(getMockData('entity_relationships')[0].from_entity_id).toBe('l');
    const decision = getMockData('system_decisions')[0];
    expect(decision.status).toBe('rejected');
    expect(decision.resolution_notes).toMatch(/already merged/i);
  });

  it('refuses to reprocess a decision that is no longer pending', async () => {
    seedDecision({ status: 'approved' });
    seedEntities();

    await expect(
      handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER }),
    ).rejects.toThrow(/not pending/);

    await expect(
      handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'reject', resolvedBy: USER }),
    ).rejects.toThrow(/not pending/);
  });

  describe('selectedEntityId survivor override (#310)', () => {
    it('flips the merge when selectedEntityId is the payload loser: the payload winner is tombstoned onto the chosen survivor', async () => {
      seedDecision();
      seedEntities();
      setMockData('entity_relationships', [
        { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
        { id: 'e2', user_id: USER, from_entity_id: 'y', to_entity_id: 'w', relationship_type: 'colleagueOf', archived: false },
      ]);

      await handleMergeSuggestedFeedback({
        decisionId: 'dec-1',
        action: 'approve',
        resolvedBy: USER,
        selectedEntityId: 'l', // payload loser -> becomes the survivor
      });

      const entities = getMockData('entities');
      const w = entities.find((e: any) => e.id === 'w');
      const l = entities.find((e: any) => e.id === 'l');
      // The payload winner ('w') is the one tombstoned now.
      expect(w.archived).toBe(true);
      expect(w.properties.merged_into).toBe('l');
      expect(l.archived).toBe(false);

      // Edges repoint toward the chosen survivor ('l'), not the payload winner.
      const edges = getMockData('entity_relationships');
      expect(edges.find((e: any) => e.id === 'e1').from_entity_id).toBe('l');
      expect(edges.find((e: any) => e.id === 'e2').to_entity_id).toBe('l');

      const decision = getMockData('system_decisions')[0];
      expect(decision.decision_payload.winnerEntityId).toBe('l');
      expect(decision.decision_payload.loserEntityId).toBe('w');
      expect(decision.decision_payload.survivorOverridden).toBe(true);
    });

    it('is a no-op when selectedEntityId is the payload winner: winner/loser unchanged, survivorOverridden false', async () => {
      seedDecision();
      seedEntities();
      setMockData('entity_relationships', [
        { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
      ]);

      await handleMergeSuggestedFeedback({
        decisionId: 'dec-1',
        action: 'approve',
        resolvedBy: USER,
        selectedEntityId: 'w', // payload winner -> confirms auto-orientation
      });

      const entities = getMockData('entities');
      expect(entities.find((e: any) => e.id === 'l').archived).toBe(true);
      expect(entities.find((e: any) => e.id === 'w').archived).toBe(false);

      const decision = getMockData('system_decisions')[0];
      expect(decision.decision_payload.winnerEntityId).toBe('w');
      expect(decision.decision_payload.loserEntityId).toBe('l');
      expect(decision.decision_payload.survivorOverridden).toBe(false);
    });

    it('throws when selectedEntityId is not part of the merge decision', async () => {
      seedDecision();
      seedEntities();

      await expect(
        handleMergeSuggestedFeedback({
          decisionId: 'dec-1',
          action: 'approve',
          resolvedBy: USER,
          selectedEntityId: 'someone-else',
        }),
      ).rejects.toThrow(/selectedEntityId someone-else is not part of merge decision/);

      // Nothing should have been mutated by the rejected call.
      expect(getMockData('entities').find((e: any) => e.id === 'l').archived).toBe(false);
      expect(getMockData('system_decisions')[0].status).toBe('pending');
    });

    it('omitting selectedEntityId behaves exactly as before: default winner survives, survivorOverridden false', async () => {
      seedDecision();
      seedEntities();

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      const entities = getMockData('entities');
      expect(entities.find((e: any) => e.id === 'l').archived).toBe(true);
      expect(entities.find((e: any) => e.id === 'w').archived).toBe(false);

      const decision = getMockData('system_decisions')[0];
      expect(decision.decision_payload.winnerEntityId).toBe('w');
      expect(decision.decision_payload.loserEntityId).toBe('l');
      expect(decision.decision_payload.survivorOverridden).toBe(false);
    });
  });

  // #550: migration 095 put `search_vector` (tsvector, generated) and
  // `embedding` (vector(1536)) on `public.entities`. The merge path reads only
  // id / entity_type / title / archived / properties / user_id off each side,
  // so `select('*')` would drag two columns per read that this code cannot even
  // see (neither is on the worker's `Entity` type). The mock does not project
  // columns, so this asserts on what the queries ASKED FOR.
  it('reads the winner and loser with an explicit column list, never *', async () => {
    seedDecision();
    seedEntities();

    await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

    const entitySelects = getSelectCalls('entities');
    expect(entitySelects).toHaveLength(2); // winner + loser

    for (const selected of entitySelects) {
      expect(selected).not.toBe('*');
      expect(selected).not.toMatch(/\bsearch_vector\b/);
      expect(selected).not.toMatch(/\bembedding\b/);

      // Derived from the single source of truth, so a column added to
      // ENTITY_LIST_COLUMNS is covered without editing this test.
      for (const column of ENTITY_LIST_COLUMNS) {
        expect(selected).toMatch(new RegExp(`\\b${column}\\b`));
      }
    }

    // The narrowed read still carries everything the merge actually consumes.
    const entities = getMockData('entities');
    expect(entities.find((e: any) => e.id === 'l').archived).toBe(true);
    expect(entities.find((e: any) => e.id === 'w').aliases).toContain('Angus');
    expect(entities.find((e: any) => e.id === 'w').properties.aliases).toBeUndefined();
  });

  // #882 (ADR-047 §2 follow-up to #551): "merge/dedup rewrites ... rewrite
  // the surviving row's text — it must re-embed."
  describe('embed-on-write for the merge survivor (#882)', () => {
    it('embeds the winner with its rewritten text after approval', async () => {
      seedDecision();
      seedEntities({ role: 'Engineer' });

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      expect(mockEmbedEntityAndStore).toHaveBeenCalledTimes(1);
      expect(mockEmbedEntityAndStore).toHaveBeenCalledWith('w', {
        title: 'Angus Hally',
        description: undefined,
        properties: { role: 'Engineer' },
      });
    });

    it('does not fail the merge when embedEntityAndStore rejects (best-effort contract)', async () => {
      seedDecision();
      seedEntities();
      mockEmbedEntityAndStore.mockRejectedValueOnce(new Error('embed provider down'));

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      // The merge itself (repoint, alias, tombstone, resolve) still landed —
      // embedding is best-effort and must never block it.
      const entities = getMockData('entities');
      const loser = entities.find((e: any) => e.id === 'l');
      const winner = entities.find((e: any) => e.id === 'w');
      expect(loser.archived).toBe(true);
      expect(winner.aliases).toContain('Angus');
      expect(winner.properties.aliases).toBeUndefined();

      const decision = getMockData('system_decisions')[0];
      expect(decision.status).toBe('approved');
    });

    it('does not embed on reject (nothing was rewritten)', async () => {
      seedDecision();
      seedEntities();

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'reject', resolvedBy: USER });

      expect(mockEmbedEntityAndStore).not.toHaveBeenCalled();
    });
  });

  describe('property union and merge provenance record (#456, #457)', () => {
    it('unions non-conflicting scalar properties onto winner, preserves winner values on conflict, and writes _merge record', async () => {
      seedDecision();
      seedEntities(
        // Winner has role and existing alias
        { role: 'Principal Engineer', aliases: ['Angus H.'] },
        // Loser has conflicting role, non-conflicting scalar properties, non-scalar object, invalid email, and system props
        {
          role: 'Junior Dev', // conflict: winner wins
          phone: '+44 7700 900077', // carried
          homepage: 'https://angus.dev', // carried
          email: 12345, // invalid for people schema (must be string): skipped
          metadata: { notes: 'private' }, // non-scalar: skipped
          merged_into: 'stale-id', // system: excluded
          archived_reason: 'old', // system: excluded
        },
      );

      setMockData('entity_relationships', [
        // Colliding edge -> archived
        { id: 'e0', user_id: USER, from_entity_id: 'w', to_entity_id: 'x', relationship_type: 'knows', archived: false },
        { id: 'e1', user_id: USER, from_entity_id: 'l', to_entity_id: 'x', relationship_type: 'knows', archived: false },
        // Moveable edge -> repointed
        { id: 'e2', user_id: USER, from_entity_id: 'l', to_entity_id: 'y', relationship_type: 'colleagueOf', archived: false },
      ]);
      setMockData('artifact_entity_links', [
        { id: 'lnk1', artifact_id: 'art1', entity_id: 'l', link_type: 'primary' },
      ]);

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      const entities = getMockData('entities');
      const winner = entities.find((e: any) => e.id === 'w');
      const loser = entities.find((e: any) => e.id === 'l');

      // 1. Winner properties check (#456)
      expect(winner.properties.role).toBe('Principal Engineer'); // winner kept its value
      expect(winner.properties.phone).toBe('+44 7700 900077'); // loser property unioned
      expect(winner.properties.homepage).toBe('https://angus.dev'); // loser property unioned
      expect(winner.properties.email).toBeUndefined(); // skipped due to schema validation
      expect(winner.properties.metadata).toBeUndefined(); // skipped because non-scalar
      expect(winner.properties.merged_into).toBeUndefined(); // system property not copied
      expect(winner.aliases).toEqual(expect.arrayContaining(['Angus H.', 'Angus']));
      expect(winner.properties.aliases).toBeUndefined();

      // 2. Survivor re-embed includes the unioned properties (#882)
      expect(mockEmbedEntityAndStore).toHaveBeenCalledWith('w', {
        title: 'Angus Hally',
        description: undefined,
        properties: expect.objectContaining({
          role: 'Principal Engineer',
          phone: '+44 7700 900077',
          homepage: 'https://angus.dev',
        }),
      });

      // 3. Loser tombstone _merge record check (#457 PR 1)
      expect(loser.archived).toBe(true);
      expect(loser.properties.merged_into).toBe('w');
      expect(loser.properties._merge).toBeDefined();

      const mergeOp = loser.properties._merge;
      expect(typeof mergeOp.op_id).toBe('string');
      expect(mergeOp.winner_id).toBe('w');
      expect(mergeOp.merged_at).toBeTruthy();
      expect(mergeOp.moved_edge_ids).toEqual(['e2']);
      expect(mergeOp.archived_edge_ids).toEqual(['e1']);
      expect(mergeOp.links_moved).toEqual(['lnk1']);
      expect(mergeOp.links_deleted).toEqual([]);
      expect(mergeOp.aliases_added).toEqual(['Angus']);
      expect(mergeOp.properties_carried).toEqual(expect.arrayContaining(['phone', 'homepage']));
      expect(mergeOp.properties_skipped).toEqual({
        role: 'conflict_winner_preferred',
        email: 'schema_invalid',
        metadata: 'non_scalar',
      });
      // No #170 demotion in this fixture (people merge, no belongs_to edges),
      // so the field stays unset rather than an empty object (#457 PR 2 QA
      // round 1 High — entity_unmerge needs to tell "no demotion happened"
      // apart from "demotion happened but wasn't recorded").
      expect(mergeOp.demoted_edge_types).toBeUndefined();

      // 4. Decision payload contains mergeOpId
      const decision = getMockData('system_decisions')[0];
      expect(decision.decision_payload.mergeOpId).toBe(mergeOp.op_id);
    });

    it('handles open scalar properties for entity types without strict schemas', async () => {
      seedDecision();
      setMockData('entities', [
        { id: 'w', title: 'ahOS', entity_type: 'project', user_id: USER, archived: false, properties: { status: 'active' } },
        { id: 'l', title: 'ahOS Repo', entity_type: 'project', user_id: USER, archived: false, properties: { priority: 'high', score: 99, open_sourced: true } },
      ]);

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      const winner = getMockData('entities').find((e: any) => e.id === 'w');
      expect(winner.properties.status).toBe('active');
      expect(winner.properties.priority).toBe('high');
      expect(winner.properties.score).toBe(99);
      expect(winner.properties.open_sourced).toBe(true);

      const loser = getMockData('entities').find((e: any) => e.id === 'l');
      expect(loser.properties._merge.properties_carried).toEqual(
        expect.arrayContaining(['priority', 'score', 'open_sourced']),
      );
    });

    it('unions column aliases from both entities into winner.aliases without writing properties.aliases (#1152)', async () => {
      seedDecision();
      setMockData('entities', [
        {
          id: 'w',
          title: 'Angus Hally',
          entity_type: 'people',
          user_id: USER,
          archived: false,
          properties: { role: 'Engineer' },
          aliases: ['Angus H.'],
        },
        {
          id: 'l',
          title: 'Angus',
          entity_type: 'people',
          user_id: USER,
          archived: false,
          properties: { phone: '+44 7700 900077' },
          aliases: ['Gus', 'A. Hally'],
        },
      ]);

      await handleMergeSuggestedFeedback({ decisionId: 'dec-1', action: 'approve', resolvedBy: USER });

      const winner = getMockData('entities').find((e: any) => e.id === 'w');
      expect(winner.aliases).toEqual(expect.arrayContaining(['Angus H.', 'Angus', 'Gus', 'A. Hally']));
      expect(winner.properties.aliases).toBeUndefined();

      const loser = getMockData('entities').find((e: any) => e.id === 'l');
      expect(loser.properties._merge.aliases_added).toEqual(
        expect.arrayContaining(['Angus', 'Gus', 'A. Hally']),
      );
    });
  });
});
