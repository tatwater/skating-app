import { readFileSync } from 'node:fs';
import {
  NAIP_OFF_SEASON_CELLS,
  type NaipCandidate,
  type NaipCellPick,
  type NaipSelection,
  selectNaipPicks,
} from '@skating/core';
import { describe, expect, test } from 'vitest';
import { checkSelection } from './selectChecks';

// A slice of the real catalog (cut from core's fixture, kept here so Turbo hashes it with this
// package): the checks must pass on the rule's real answer.
const FIXTURE = readFileSync(new URL('./selectFixture.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => {
    const { scoutsPick: _, ...c } = JSON.parse(l) as NaipCandidate & { scoutsPick?: true };
    return c as NaipCandidate;
  });

const f = (key: string, acquired: string, gsd: number, state = 'VT'): NaipCandidate => ({
  itemId: `${key}-${acquired}-${gsd}-${state}`,
  key,
  state: state as NaipCandidate['state'],
  acquired,
  gsd,
  year: Number(acquired.slice(0, 4)),
  bbox: [0, 0, 0, 0],
});

const K = '4407236se';

describe('checkSelection', () => {
  test("passes on the rule's answer for a real slice", () => {
    const selection = selectNaipPicks(FIXTURE, [], NAIP_OFF_SEASON_CELLS);
    expect(checkSelection(FIXTURE, [], selection)).toEqual({
      holes: [],
      noCandidate: [],
      violations: [],
    });
  });

  test('a cell whose every candidate is struck is a hole', () => {
    const only = f(K, '2025-07-01', 0.3);
    const ex = [
      {
        itemId: only.itemId,
        reason: 'cloud' as const,
        reviewedBy: 'founder' as const,
        reviewedOn: '2026-11-26',
      },
    ];
    expect(checkSelection([only], ex, selectNaipPicks([only], ex, [])).holes).toEqual([K]);
  });

  test('a cell flown only coarse has no candidate (reported); a mislabeled item lists nothing', () => {
    const coarse = f(K, '2011-07-01', 1);
    const mislabeled = f('4207239sw', '2025-09-20', 0.6, 'ME');
    const cands = [coarse, mislabeled];
    expect(checkSelection(cands, [], selectNaipPicks(cands, [], []))).toEqual({
      holes: [],
      noCandidate: [K],
      violations: [],
    });
  });

  const newer = f(K, '2025-07-01', 0.6);
  const sharp = f(K, '2023-07-01', 0.3);
  const october = f(K, '2025-10-02', 0.3);
  const cands = [newer, sharp, october];
  const right = selectNaipPicks(cands, [], []);
  const tamper = (p: Partial<NaipCellPick>): NaipSelection => ({
    ...right,
    picks: [{ ...(right.picks[0] as NaipCellPick), ...p }],
  });

  test('a pick the rule would not choose is a violation: the newer frame over the sharp one in the window', () => {
    expect(right.picks[0]?.pick).toBe(sharp);
    expect(checkSelection(cands, [], tamper({ pick: newer, stack: [sharp] })).violations).toEqual([
      expect.stringMatching(/is not the rule's choice of 2/),
    ]);
  });

  test('a leaf-off pick where a leaf-on frame exists is a violation', () => {
    expect(
      checkSelection(cands, [], tamper({ pick: october, stack: [sharp] })).violations,
    ).toHaveLength(1);
  });

  test('a stack short of the alternates is a violation', () => {
    expect(checkSelection(cands, [], tamper({ stack: [] })).violations).toEqual([
      expect.stringMatching(/a stack of 0 for 1 alternates/),
    ]);
  });

  test('a cell with candidates and no pick, or a pick with none, is a violation', () => {
    expect(checkSelection(cands, [], { ...right, picks: [] }).violations).toEqual([
      expect.stringMatching(/3 candidates and no pick/),
    ]);
    expect(checkSelection([], [], right).violations).toEqual([
      expect.stringMatching(/a pick for a cell with no candidate/),
    ]);
  });
});
