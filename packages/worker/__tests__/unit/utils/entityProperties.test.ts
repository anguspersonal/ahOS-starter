import { mergeEntityProperties } from '@ahkms/shared';

describe('mergeEntityProperties (#456)', () => {
  it('unions scalar properties from loser when winner does not have them', () => {
    const winnerProps = { name: 'Angus', role: 'CTO' };
    const loserProps = { phone: '+1234567890', organization: 'Work' };

    const result = mergeEntityProperties('people', winnerProps, loserProps);

    expect(result.mergedProperties).toEqual({
      name: 'Angus',
      role: 'CTO',
      phone: '+1234567890',
      organization: 'Work',
    });
    expect(result.carriedKeys).toEqual(['phone', 'organization']);
    expect(result.skippedKeys).toEqual({});
  });

  it('preserves winner value on conflict (winner-preferred)', () => {
    const winnerProps = { email: 'winner@example.com', role: 'Architect' };
    const loserProps = { email: 'loser@example.com', role: 'Dev', phone: '123' };

    const result = mergeEntityProperties('people', winnerProps, loserProps);

    expect(result.mergedProperties.email).toBe('winner@example.com');
    expect(result.mergedProperties.role).toBe('Architect');
    expect(result.mergedProperties.phone).toBe('123');
    expect(result.carriedKeys).toEqual(['phone']);
    expect(result.skippedKeys).toEqual({
      email: 'conflict_winner_preferred',
      role: 'conflict_winner_preferred',
    });
  });

  it('skips non-scalar properties (arrays, nested objects)', () => {
    const winnerProps = {};
    const loserProps = {
      phone: '123',
      tags: ['a', 'b'],
      metadata: { nested: true },
    };

    const result = mergeEntityProperties('people', winnerProps, loserProps);

    expect(result.mergedProperties).toEqual({ phone: '123' });
    expect(result.carriedKeys).toEqual(['phone']);
    expect(result.skippedKeys).toEqual({
      tags: 'non_scalar',
      metadata: 'non_scalar',
    });
  });

  it('validates properties against schema for types that define validators (e.g. people, organization, term)', () => {
    const winnerProps = {};
    const loserProps = {
      email: 99999, // invalid for people (must be string)
      homepage: 'https://example.com', // valid
    };

    const result = mergeEntityProperties('people', winnerProps, loserProps);

    expect(result.mergedProperties).toEqual({ homepage: 'https://example.com' });
    expect(result.carriedKeys).toEqual(['homepage']);
    expect(result.skippedKeys).toEqual({
      email: 'schema_invalid',
    });
  });

  it('ignores system and metadata properties from union', () => {
    const winnerProps = {};
    const loserProps = {
      aliases: ['Alias 1'],
      merged_into: 'some-id',
      merged_at: '2026-09-25T00:00:00Z',
      archived_reason: 'duplicate',
      _merge: { op_id: '1' },
      _custom: 'private',
      valid_key: 'value',
    };

    const result = mergeEntityProperties('project', winnerProps, loserProps);

    expect(result.mergedProperties).toEqual({ valid_key: 'value' });
    expect(result.carriedKeys).toEqual(['valid_key']);
    expect(result.skippedKeys).toEqual({});
  });
});
