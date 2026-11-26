/**
 * Unit tests for the sweep-outcome measurement (issue #2270).
 *
 * `@ahkms/core` is never loaded: the loader is injected, so these tests pin how
 * the measurement USES core (window, per-domain read, missed rule, failure
 * isolation) without depending on a built ESM package.
 */

import { getSweepOutcomes, type SweepCore } from '../../../src/utils/sweepOutcome';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-11-20T14:00:00Z');
const client = { from: jest.fn() };

const day = (date: string, atoms: number, s = 0, u = 0, e = 0) => ({
  date,
  captured_atoms: atoms,
  no_material: atoms === 0 && s + u + e === 0,
  synthesized: s,
  synthesized_unattended: u,
  evidence_aggregated: e,
  evidence_aggregated_unattended: 0,
});

function fakeCore(overrides: Partial<SweepCore> = {}): SweepCore {
  return {
    DOMAINS: ['work', 'angus'],
    sweepCheckWindow: jest.fn(() => ({ from: '2026-11-13', to: '2026-11-17' })),
    // A stand-in for core's rule. The point of these tests is that the worker
    // reports whatever core calls missed, not that it knows the rule itself.
    missedSweepDays: jest.fn((days) =>
      days.filter((d) => !d.no_material && d.synthesized + d.synthesized_unattended + d.evidence_aggregated === 0),
    ) as SweepCore['missedSweepDays'],
    getSynthesisCoverage: jest.fn(async () => []),
    ...overrides,
  };
}

describe('getSweepOutcomes', () => {
  it("reads core's window once per domain, as the given user, through the given client", async () => {
    const core = fakeCore();

    const outcomes = await getSweepOutcomes(USER, NOW, client, () => core);

    expect(core.sweepCheckWindow).toHaveBeenCalledWith(NOW);
    expect(outcomes.map((o) => o.domain)).toEqual(['work', 'angus']);
    const calls = (core.getSynthesisCoverage as jest.Mock).mock.calls;
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['2026-11-13', '2026-11-17', 'work'],
      ['2026-11-13', '2026-11-17', 'angus'],
    ]);
    expect(calls[0][3].client).toBe(client);
    expect(calls[0][3].ownerId()).toBe(USER);
  });

  it('reports the days core calls missed, with their atom counts', async () => {
    const core = fakeCore({
      getSynthesisCoverage: jest.fn(async (_f, _t, domain) =>
        domain === 'work'
          ? [day('2026-11-13', 3), day('2026-11-14', 0), day('2026-11-15', 2, 1)]
          : [day('2026-11-13', 3, 0, 1)],
      ),
    });

    const [work, angus] = await getSweepOutcomes(USER, NOW, client, () => core);

    expect(work).toEqual({
      domain: 'work',
      from: '2026-11-13',
      to: '2026-11-17',
      missed: [{ date: '2026-11-13', atoms: 3 }],
      error: null,
    });
    expect(angus.missed).toEqual([]);
  });

  it("turns one domain's failed read into a finding without losing the other domain", async () => {
    const core = fakeCore({
      getSynthesisCoverage: jest.fn(async (_f, _t, domain) => {
        if (domain === 'work') {
          throw new Error('Coverage artifact lookup failed: canceling statement due to statement timeout.');
        }
        return [day('2026-11-13', 3)];
      }),
    });

    const [work, angus] = await getSweepOutcomes(USER, NOW, client, () => core);

    expect(work.missed).toBeNull();
    expect(work.error).toContain('statement timeout');
    expect(angus).toMatchObject({ missed: [{ date: '2026-11-13', atoms: 3 }], error: null });
  });
});
