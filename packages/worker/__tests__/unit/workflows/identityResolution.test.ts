/**
 * Unit tests for entity identity resolution — duplicate detection (issue #174).
 */

import {
  normalizeName,
  nameSimilarity,
  levenshtein,
  detectMergeCandidates,
  emitMergeSuggestions,
  DEFAULT_DEDUP_ENTITY_TYPES,
  type MergeCandidateEntity,
} from '../../../src/workflows/identityResolution';
import {
  resetMockData,
  setMockData,
  getMockData,
  resetMockSupabase,
  createQueryBuilder,
  supabase as mockSupabase,
} from '../../__mocks__/supabase';

function person(id: string, title: string, extra: Partial<MergeCandidateEntity> = {}): MergeCandidateEntity {
  return {
    id,
    title,
    entity_type: 'people',
    created_at: '2026-01-01T00:00:00.000Z',
    properties: {},
    ...extra,
  };
}

describe('normalizeName', () => {
  it('lowercases, strips punctuation and diacritics, collapses whitespace', () => {
    expect(normalizeName('  Ángus   Hally! ')).toBe('angus hally');
    expect(normalizeName("O'Brien-Smith")).toBe('o brien smith');
  });

  it('returns empty string for blank input', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('briana', 'brianna')).toBe(1);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('nameSimilarity', () => {
  it('scores identical names 1.0 (exact)', () => {
    const r = nameSimilarity('Angus Hally', 'angus  hally');
    expect(r.score).toBe(1);
    expect(r.reason).toBe('exact-name');
  });

  it('scores a name that is a token-subset of another highly (name-subset)', () => {
    const r = nameSimilarity('Angus', 'Angus Hally');
    expect(r.reason).toBe('name-subset');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('scores a typo within a token-subset highly (Briana Longe vs Brianna)', () => {
    const r = nameSimilarity('Brianna', 'Briana Longe');
    expect(r.reason).toBe('name-subset');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('scores unrelated names low', () => {
    const r = nameSimilarity('Angus Hally', 'Sundar Pichai');
    expect(r.score).toBeLessThan(0.85);
  });
});

describe('detectMergeCandidates', () => {
  it('detects "Angus Hally" vs "Angus" as a duplicate, winner = the fuller name', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Angus Hally'),
      person('b', 'Angus'),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].winnerId).toBe('a');
    expect(candidates[0].loserId).toBe('b');
    expect(candidates[0].winnerName).toBe('Angus Hally');
  });

  it('detects "Briana Longe" vs "Brianna" as a duplicate', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Brianna'),
      person('b', 'Briana Longe'),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].winnerId).toBe('b'); // more tokens => canonical
    expect(candidates[0].loserId).toBe('a');
  });

  it('never merges entities of different types', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Design'),
      { id: 'b', title: 'Design', entity_type: 'project', properties: {} },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('matches on aliases stored in properties (legacy)', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Robert Smith', { properties: { aliases: ['Bob Smith'] } }),
      person('b', 'Bob Smith'),
    ]);
    expect(candidates).toHaveLength(1);
    expect(new Set([candidates[0].winnerId, candidates[0].loserId])).toEqual(new Set(['a', 'b']));
  });

  it('matches on aliases stored in the aliases column (#1152)', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Robert Smith', { aliases: ['Bob Smith'] }),
      person('b', 'Bob Smith'),
    ]);
    expect(candidates).toHaveLength(1);
    expect(new Set([candidates[0].winnerId, candidates[0].loserId])).toEqual(new Set(['a', 'b']));
  });

  it('unions aliases from column and legacy properties (#1152)', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Robert Smith', { aliases: ['Bobby'], properties: { aliases: ['Bob Smith'] } }),
      person('b', 'Bobby'),
    ]);
    expect(candidates).toHaveLength(1);
    expect(new Set([candidates[0].winnerId, candidates[0].loserId])).toEqual(new Set(['a', 'b']));
  });

  it('returns nothing when there are no duplicates', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Angus Hally'),
      person('b', 'Sundar Pichai'),
      person('c', 'Grace Hopper'),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('sorts highest-confidence pairs first', () => {
    const candidates = detectMergeCandidates([
      person('a', 'Angus Hally'),
      person('b', 'Angus Hally'), // exact => 1.0
      person('c', 'Briana Longe'),
      person('d', 'Brianna'), // subset => 0.9
    ]);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].score).toBeGreaterThanOrEqual(candidates[1].score);
    expect(candidates[0].score).toBe(1);
  });
});

describe('emitMergeSuggestions', () => {
  beforeEach(() => {
    resetMockData();
    resetMockSupabase();
  });

  it('creates a merge_suggested decision per new candidate pair', async () => {
    setMockData('entities', [
      { id: 'a', title: 'Angus Hally', entity_type: 'people', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', title: 'Angus', entity_type: 'people', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-02T00:00:00.000Z' },
    ]);

    const result = await emitMergeSuggestions({ userId: 'u1' });

    expect(result.created).toBe(1);
    const decisions = getMockData('system_decisions');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision_type).toBe('merge_suggested');
    expect(decisions[0].status).toBe('pending');
    expect(decisions[0].decision_payload.winnerEntityId).toBe('a');
    expect(decisions[0].decision_payload.loserEntityId).toBe('b');
    expect(decisions[0].blocking).toBe(false);
  });

  it('is idempotent: skips pairs that already have a merge_suggested decision', async () => {
    setMockData('entities', [
      { id: 'a', title: 'Angus Hally', entity_type: 'people', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', title: 'Angus', entity_type: 'people', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-02T00:00:00.000Z' },
    ]);
    setMockData('system_decisions', [
      {
        id: 'existing',
        user_id: 'u1',
        decision_type: 'merge_suggested',
        status: 'rejected',
        decision_payload: { winnerEntityId: 'a', loserEntityId: 'b' },
      },
    ]);

    const result = await emitMergeSuggestions({ userId: 'u1' });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getMockData('system_decisions')).toHaveLength(1);
  });

  it('DEFAULT_DEDUP_ENTITY_TYPES is people + project + organization (#310)', () => {
    expect(DEFAULT_DEDUP_ENTITY_TYPES).toEqual(['people', 'project', 'organization']);
  });

  it('scans project entities by default (#310 — catches a duplicate project like Work/Work AI)', async () => {
    setMockData('entities', [
      { id: 'a', title: 'Work AI', entity_type: 'project', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', title: 'Work', entity_type: 'project', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-02T00:00:00.000Z' },
    ]);

    const result = await emitMergeSuggestions({ userId: 'u1' });

    expect(result.created).toBe(1);
    expect(getMockData('system_decisions')).toHaveLength(1);
  });

  it('does not scan entity types outside the default set (e.g. concept)', async () => {
    setMockData('entities', [
      { id: 'a', title: 'Design', entity_type: 'concept', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', title: 'Design', entity_type: 'concept', user_id: 'u1', archived: false, properties: {}, created_at: '2026-01-02T00:00:00.000Z' },
    ]);

    const result = await emitMergeSuggestions({ userId: 'u1' });

    expect(result.created).toBe(0);
    expect(getMockData('system_decisions')).toHaveLength(0);
  });

  it('queries entities with .in("entity_type", [people, project, organization]) when entityTypes is omitted', async () => {
    setMockData('entities', []);
    const inSpy = jest.fn();
    (mockSupabase.from as jest.Mock).mockImplementationOnce((table: string) => {
      const builder = createQueryBuilder(table);
      const originalIn = builder.in.bind(builder);
      builder.in = (field: string, values: any[]) => {
        inSpy(field, values);
        return originalIn(field, values);
      };
      return builder;
    });

    await emitMergeSuggestions({ userId: 'u1' });

    expect(inSpy).toHaveBeenCalledWith('entity_type', ['people', 'project', 'organization']);
  });
});
