import { readFileSync } from 'node:fs';
import {
  type NaipCandidate,
  type NaipCellPick,
  type NaipFoliageStrike,
  type NaipSelection,
  selectNaipPicks,
} from '@skating/core';
import { describe, expect, test } from 'vitest';
import { checkManifestFrames, checkSelection } from './selectChecks';

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
    const selection = selectNaipPicks(FIXTURE, []);
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

  // The foliage review (D319): 2025's summer struck as turned, so 2023's sharp frame is the pick.
  const sept = f(K, '2025-09-20', 0.3);
  const turnedDay: NaipFoliageStrike = {
    flight: { state: 'VT', acquired: '2025-09-20' },
    keep: [],
    reason: 'turned',
    reviewedBy: 'founder',
    reviewedOn: '2026-11-27',
  };
  const foliage = [sept, sharp, newer];
  const struckRight = selectNaipPicks(foliage, [], [turnedDay]);

  test("passes on the rule's answer with a foliage strike", () => {
    expect(struckRight.picks[0]?.pick).toBe(sharp);
    expect(checkSelection(foliage, [], struckRight, [turnedDay]).violations).toEqual([]);
  });

  test('a struck frame picked over a green one, or stacked above one, is a violation', () => {
    const pick = struckRight.picks[0] as NaipCellPick;
    const as = (p: Partial<NaipCellPick>): NaipSelection => ({
      ...struckRight,
      picks: [{ ...pick, ...p }],
    });
    expect(
      checkSelection(foliage, [], as({ pick: sept, stack: [sharp, newer] }), [turnedDay])
        .violations,
    ).toEqual([expect.stringMatching(/is not the rule's choice of 2/)]);
    expect(
      checkSelection(foliage, [], as({ stack: [sept, newer] }), [turnedDay]).violations,
    ).toEqual([expect.stringMatching(/a frame struck as turned sits above a green one/)]);
  });

  test('an off-season list that disagrees with the rule is a violation', () => {
    const allTurned = selectNaipPicks([sept], [], [turnedDay]);
    expect(allTurned.offSeason).toEqual([{ key: K, why: 'allTurned' }]);
    expect(checkSelection([sept], [], allTurned, [turnedDay]).violations).toEqual([]);
    expect(
      checkSelection([sept], [], { ...allTurned, offSeason: [] }, [turnedDay]).violations,
    ).toEqual([expect.stringMatching(/off-season no, the rule says allTurned/)]);
    expect(
      checkSelection(foliage, [], { ...struckRight, offSeason: [{ key: K, why: 'noLeafOn' }] }, [
        turnedDay,
      ]).violations,
    ).toEqual([expect.stringMatching(/off-season noLeafOn, the rule says no/)]);
  });
});

describe('checkManifestFrames', () => {
  const frame = (acquired: string, gsd = 0.6) => ({
    acquired,
    gsd,
    year: Number(acquired.slice(0, 4)),
    state: 'NY' as const,
  });
  const cell = (key: string, pick: string, stack: string[] = []) => ({ key, pick, stack });
  const PICK = 'ny_m_4307536_sw_18_060_20240702';
  // Every resolution token the catalog uses reads as core reads it.
  const OLD = [
    'ny_m_4307536_sw_18_.5_20150923_20151109',
    'ny_m_4307536_sw_18_1_20110501_20111115',
    'ny_m_4307536_sw_18_h_20160913',
    'ny_m_4307536_sw_18_.6_20160803_20160913',
  ];

  test('passes frames of every format, each dated by its id’s first date', () => {
    const frames = Object.fromEntries([
      [PICK, frame('2024-07-02')],
      [OLD[0], frame('2015-09-23', 0.5)],
      [OLD[1], frame('2011-05-01', 1)],
      [OLD[2], frame('2016-09-13')],
      [OLD[3], frame('2016-08-03')],
    ]);
    expect(checkManifestFrames({ frames, cells: [cell('4307536sw', PICK, OLD)] })).toEqual([]);
  });

  test('refuses an id core can’t read, a day that isn’t one or isn’t the id’s, a frame of another cell or none', () => {
    const other = 'ny_m_4307535_sw_18_060_20240702';
    expect(
      checkManifestFrames({
        frames: {
          [PICK]: frame('2024-07-03'),
          'ny-2024': frame('2024-07-02'),
          [OLD[0] as string]: frame('2015-02-30'),
          [other]: frame('2024-07-02'),
        },
        cells: [cell('4307536sw', PICK, [OLD[0] as string, other, 'missing'])],
      }),
    ).toEqual([
      `frame ${PICK}: acquired 2024-07-03, but its id says 2024-07-02`,
      'frame ny-2024: not an item id core can read',
      `frame ${OLD[0]}: acquired "2015-02-30" is not a real day`,
      `cell 4307536sw: ${other} is cell 4307535sw's frame`,
      "cell 4307536sw: missing is not in the manifest's frames",
    ]);
  });
});
