import { HAZARD_TYPES, HAZARD_VERDICTS, verdictLabel } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { DISTINCT_VOTES } from './flagFixtures';
import { verdictRows } from './flagModel';

describe('a hazard’s votes, as cast', () => {
  test('every type: core’s words for each verdict, in core’s order, each its own count', () => {
    for (const type of HAZARD_TYPES) {
      const rows = verdictRows({ type, votes: DISTINCT_VOTES, votesCapped: false });
      expect(rows?.map((r) => r.verdict)).toEqual([...HAZARD_VERDICTS]);
      for (const r of rows ?? []) {
        expect(r.label).toBe(verdictLabel(r.verdict, type));
        expect(r.count).toBe(String(DISTINCT_VOTES[r.verdict]));
      }
    }
  });
  test('a ridge crossing is relabeled by core', () => {
    const rows = verdictRows({ type: 'ridge_crossing', votes: DISTINCT_VOTES, votesCapped: false });
    expect(rows?.map((r) => r.label)).toEqual([
      'Still crossable',
      'Crossing looks dicey now',
      'Ridge closed / healed',
      'No crossing here',
    ]);
  });
  test('no votes is said in words; a capped read makes every count a floor', () => {
    const zero = { still_there: 0, healing_unsafe: 0, fully_healed: 0, never_existed: 0 };
    expect(verdictRows({ type: 'open_water', votes: zero, votesCapped: false })).toBeNull();
    const capped = verdictRows({ type: 'open_water', votes: zero, votesCapped: true });
    expect(capped?.map((r) => [r.count, r.none])).toEqual([
      ['0+', false],
      ['0+', false],
      ['0+', false],
      ['0+', false],
    ]);
  });
  test('property: the order never follows the counts, and no figure folds verdicts together', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HAZARD_TYPES),
        fc.record({
          still_there: fc.nat(500),
          healing_unsafe: fc.nat(500),
          fully_healed: fc.nat(500),
          never_existed: fc.nat(500),
        }),
        (type, votes) => {
          const rows = verdictRows({ type, votes, votesCapped: false });
          if (rows === null) {
            expect(Object.values(votes).every((n) => n === 0)).toBe(true);
            return;
          }
          expect(rows.map((r) => r.verdict)).toEqual([...HAZARD_VERDICTS]);
          expect(rows.map((r) => Number(r.count))).toEqual(HAZARD_VERDICTS.map((v) => votes[v]));
          expect(rows.map((r) => r.none)).toEqual(HAZARD_VERDICTS.map((v) => votes[v] === 0));
        },
      ),
    );
  });
});
