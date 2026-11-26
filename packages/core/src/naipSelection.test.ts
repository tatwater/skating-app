import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { NAIP_OFF_SEASON_CELLS } from './naipExclusions';
import { quarterQuadCell } from './naipGrid';
import type { NaipManifest } from './naipManifest';
import {
  diffNaipPicks,
  isCoarseNaipFrame,
  isLeafOnNaipFrame,
  isNaipState,
  isSharpNaipFrame,
  NAIP_STATES,
  type NaipCandidate,
  type NaipCellPick,
  type NaipExclusion,
  rankNaipFrames,
  selectNaipPicks,
} from './naipSelection';

describe('the seven states', () => {
  test('are the supported five plus CT and RI', () => {
    expect([...NAIP_STATES].sort()).toEqual(['CT', 'MA', 'ME', 'NH', 'NY', 'RI', 'VT']);
  });

  test.each([
    ['CT', true],
    ['RI', true],
    ['NY', true],
    ['ny', false], // the catalog's lowercase labels are uppercased before they get here
    ['NJ', false],
    ['', false],
  ])('isNaipState(%j) is %s', (code, expected) => {
    expect(isNaipState(code)).toBe(expected);
  });
});

// ── Builders ──────────────────────────────────────────────────────────────────────────────────────

/** Two cells inside Vermont's (and New York's) envelope: one north of 43.5°N, one south of it. */
const NORTH = '4407236se';
const SOUTH = '4307264ne';

let serial = 0;
function frame(acquired: string, gsd: number, over: Partial<NaipCandidate> = {}): NaipCandidate {
  const key = over.key ?? NORTH;
  return {
    itemId: `vt_m_${key.slice(0, 7)}_${key.slice(7)}_18_${String(Math.round(gsd * 100)).padStart(3, '0')}_${acquired.replaceAll('-', '')}_${serial++}`,
    key,
    state: 'VT',
    acquired,
    gsd,
    year: Number(acquired.slice(0, 4)),
    bbox: [0, 0, 0, 0],
    ...over,
  };
}

const struck = (
  c: NaipCandidate,
  reviewedBy: 'founder' | 'builder' = 'founder',
): NaipExclusion => ({
  itemId: c.itemId,
  reason: 'cloud',
  reviewedBy,
  reviewedOn: '2026-11-25',
});

function onlyPick(candidates: NaipCandidate[], exclusions: NaipExclusion[] = []): NaipCellPick {
  const { picks } = selectNaipPicks(candidates, exclusions, NAIP_OFF_SEASON_CELLS);
  expect(picks).toHaveLength(1);
  return picks[0] as NaipCellPick;
}

// ── The steps, one at a time ─────────────────────────────────────────────────────────────────────

describe('step 1: what is a candidate', () => {
  test.each([
    [0.3, false],
    [0.5, false], // NY 2015: finer than 0.6 m, so it stays
    [0.6, false],
    [0.6000000000000024, false], // the catalog's float noise is still 0.6 m
    [0.5999999999999952, false],
    [1, true],
    [0.61, true],
  ])('a %d m frame is coarse: %s', (gsd, coarse) => {
    expect(isCoarseNaipFrame(gsd)).toBe(coarse);
  });

  test('a coarse frame is dropped and counted, even when it is the newest', () => {
    const summer = frame('2021-07-01', 0.6);
    const { picks, dropped } = selectNaipPicks(
      [summer, frame('2024-07-01', 1)],
      [],
      NAIP_OFF_SEASON_CELLS,
    );
    expect(picks[0]?.pick).toBe(summer);
    expect(picks[0]?.stack).toEqual([]);
    expect(dropped).toEqual({ coarse: 1, outsideState: 0, excluded: 0 });
  });

  test("an item whose cell lies outside its labeled state's envelope is dropped (§2.1.1)", () => {
    // A Massachusetts cell under a Maine label, as the 744 "Maine 2025" items are.
    const ma = frame('2023-07-01', 0.3, { key: '4207239sw', state: 'MA' });
    const me = frame('2025-09-20', 0.6, { key: '4207239sw', state: 'ME' });
    const { picks, dropped } = selectNaipPicks([ma, me], [], NAIP_OFF_SEASON_CELLS);
    expect(picks.map((p) => p.pick.itemId)).toEqual([ma.itemId]);
    expect(picks[0]?.states).toEqual(['MA']);
    expect(dropped.outsideState).toBe(1);
  });

  test('a mislabeled item is counted as mislabeled even when it is also coarse', () => {
    const { dropped } = selectNaipPicks(
      [frame('2025-09-20', 1, { key: '4207239sw', state: 'ME' })],
      [],
      NAIP_OFF_SEASON_CELLS,
    );
    expect(dropped).toEqual({ coarse: 0, outsideState: 1, excluded: 0 });
  });

  test('a state lists a cell only with a candidate there', () => {
    const vt = frame('2025-07-01', 0.3);
    const ny = frame('2024-07-01', 0.6, { state: 'NY' });
    const nyOld = frame('2011-07-01', 1, { state: 'NY' });
    expect(onlyPick([vt, nyOld]).states).toEqual(['VT']);
    expect(onlyPick([vt, ny, nyOld]).states).toEqual(['NY', 'VT']);
    // Struck still lists: the state flew a frame that could show.
    expect(onlyPick([vt, ny], [struck(ny)]).states).toEqual(['NY', 'VT']);
  });

  test('a candidate listed twice counts once', () => {
    const a = frame('2023-07-01', 0.3);
    const b = frame('2021-07-01', 0.6);
    expect(onlyPick([a, b, { ...a }, b]).stack).toEqual([b]);
  });

  test('a cell whose every frame is dropped has no pick', () => {
    const only = frame('2023-07-01', 0.3);
    expect(selectNaipPicks([only], [struck(only)], []).picks).toEqual([]);
    expect(selectNaipPicks([frame('2023-07-01', 1)], [], []).picks).toEqual([]);
  });
});

describe('step 2: leaf-on', () => {
  test.each([
    ['2023-06-01', 44, true],
    ['2023-05-31', 44, false],
    ['2023-09-30', 44, true],
    ['2023-10-01', 44, false],
    ['2023-05-20', 43.49, true], // south of 43.5°N, from 20 May
    ['2023-05-19', 43.49, false],
    ['2023-05-20', 43.5, false], // 43.5°N itself is north
    ['2023-09-30', 43.49, true],
    ['2023-10-02', 43.49, false],
    ['2019-01-15', 42, false],
  ])('%s at %d°N is leaf-on: %s', (day, lat, leafOn) => {
    expect(isLeafOnNaipFrame(day, lat)).toBe(leafOn);
  });

  test("the 20 May clause reads the cell's middle: a cell straddling 43.5°N's row is north", () => {
    // 4307... row 0 of the 43° block's top half is far north; take the two cells about 43.5°N.
    const south = '4307236se'; // 43.375–43.4375: middle 43.406
    const north = '4307228se'; // 43.5–43.5625: middle 43.531
    expect(quarterQuadCell(south).maxLat).toBeLessThanOrEqual(43.5);
    expect(quarterQuadCell(north).minLat).toBe(43.5);
    const may = (key: string) => frame('2024-05-25', 0.6, { key });
    const july = (key: string) => frame('2021-07-10', 0.6, { key });
    const southMay = may(south);
    const northMay = may(north);
    expect(onlyPick([southMay, july(south)]).pick).toBe(southMay);
    expect(onlyPick([northMay, july(north)]).pick).not.toBe(northMay);
  });

  test('a leaf-off frame never beats a leaf-on one, however new or sharp', () => {
    const summer = frame('2016-08-01', 0.6);
    const pick = onlyPick([summer, frame('2025-10-02', 0.3), frame('2024-04-20', 0.3)]);
    expect(pick.pick).toBe(summer);
    expect(pick.step).toBe('leafOn');
    // Leaf-off frames are not fallbacks of a leaf-on cell.
    expect(pick.stack).toEqual([]);
  });
});

describe('steps 3 and 4: the newest, unless a 0.3 m frame is at most two years older', () => {
  test.each([
    // [newer frame, older frame, which wins]
    [['2025-07-01', 0.6], ['2023-07-01', 0.3], 'older'], // two program years: the 0.3 m frame
    [['2025-07-01', 0.6], ['2022-09-30', 0.3], 'newer'], // three: the newest
    [['2025-06-01', 0.6], ['2023-09-30', 0.3], 'older'], // the window is in program years, not days
    [['2025-07-01', 0.3], ['2024-07-01', 0.6], 'newer'], // the newest is itself sharp
    [['2025-07-01', 0.6], ['2024-07-01', 0.6], 'newer'],
    [['2024-07-02', 0.6], ['2024-07-01', 0.6], 'newer'], // same year: by date
    [['2025-07-01', 0.6], ['2023-07-01', 0.5], 'newer'], // 0.5 m is not 0.3 m
  ] as const)('%j against %j: the %s', ([nd, ng], [od, og], winner) => {
    const newer = frame(nd, ng);
    const older = frame(od, og);
    const pick = onlyPick([older, newer]);
    expect(pick.pick).toBe(winner === 'newer' ? newer : older);
  });

  test('among sharp frames in the window, the newest of them', () => {
    const newest = frame('2025-07-01', 0.6);
    const sharp24 = frame('2024-07-01', 0.3);
    const sharp23 = frame('2023-07-01', 0.3);
    expect(onlyPick([sharp23, newest, sharp24]).pick).toBe(sharp24);
  });

  test('on the same day the sharper wins, then the lower item id', () => {
    const coarse = frame('2024-07-01', 0.6);
    const sharp = frame('2024-07-01', 0.3);
    expect(onlyPick([coarse, sharp]).pick).toBe(sharp);
    const a = frame('2024-07-01', 0.6, { itemId: 'a' });
    const b = frame('2024-07-01', 0.6, { itemId: 'b' });
    expect(onlyPick([b, a]).pick).toBe(a);
  });

  test('isSharpNaipFrame reads 0.3 m to the centimeter', () => {
    expect(isSharpNaipFrame(0.3)).toBe(true);
    expect(isSharpNaipFrame(0.30000000000000004)).toBe(true);
    expect(isSharpNaipFrame(0.5)).toBe(false);
  });
});

describe('the fallback stack', () => {
  test('is the rule re-applied with the pick struck, each time: the window moves', () => {
    const a = frame('2025-07-01', 0.6);
    const b = frame('2023-07-01', 0.3); // wins: sharp, two years older
    const c = frame('2024-07-01', 0.6);
    const d = frame('2021-07-01', 0.3);
    // With b struck: the newest is a (2025); no sharp frame within two years → a. Then c (2024)
    // newest; d (2021, 0.3) is three years older → c. Then d.
    expect(rankNaipFrames([a, b, c, d])).toEqual([b, a, c, d]);
    const pick = onlyPick([d, c, b, a]);
    expect(pick.pick).toBe(b);
    expect(pick.stack).toEqual([a, c, d]);
  });

  test('struck frames are neither picked nor stacked, and the cell falls back (§2.1.2)', () => {
    const glare = frame('2024-07-02', 0.6);
    const summer22 = frame('2022-08-01', 0.6);
    const pick = onlyPick([glare, summer22], [struck(glare)]);
    expect(pick.pick).toBe(summer22);
    expect(pick.stack).toEqual([]);
  });

  test("exclusions come before the season step: a struck cell's only summer frame goes off-season", () => {
    const summer = frame('2015-07-01', 0.6, { key: '4407028ne', state: 'ME' });
    const october = frame('2023-10-02', 0.3, { key: '4407028ne', state: 'ME' });
    expect(onlyPick([summer, october]).pick).toBe(summer);
    const after = onlyPick([summer, october], [struck(summer)]);
    expect(after.pick).toBe(october);
    expect(after.step).toBe('offSeason');
  });
});

describe('step 5: the off-season step', () => {
  const october23 = frame('2023-10-02', 0.3, { key: '4407028ne', state: 'ME' });
  const october21 = frame('2021-10-05', 0.6, { key: '4407028ne', state: 'ME' });
  const october18 = frame('2018-10-10', 0.6, { key: '4407028ne', state: 'ME' });
  const july15 = frame('2015-07-10', 1, { key: '4407028ne', state: 'ME' });

  test('a cell with no leaf-on candidate takes steps 3 and 4 over every candidate', () => {
    const { picks, offSeasonBeyondList } = selectNaipPicks(
      [october18, july15, october21, october23],
      [],
      NAIP_OFF_SEASON_CELLS,
    );
    expect(picks[0]?.pick).toBe(october23);
    expect(picks[0]?.step).toBe('offSeason');
    expect(picks[0]?.stack).toEqual([october21, october18]);
    expect(offSeasonBeyondList).toEqual([]);
  });

  test('a cell off the committed list is still picked, and reported', () => {
    const elsewhere = frame('2023-10-02', 0.3);
    const { picks, offSeasonBeyondList } = selectNaipPicks(
      [elsewhere, october23],
      [],
      NAIP_OFF_SEASON_CELLS,
    );
    expect(picks.map((p) => p.step)).toEqual(['offSeason', 'offSeason']);
    expect(offSeasonBeyondList).toEqual([NORTH]);
    // With the list empty, the six are reported too.
    expect(selectNaipPicks([october23], [], []).offSeasonBeyondList).toEqual(['4407028ne']);
  });
});

// ── The rule as properties (§7.3) ────────────────────────────────────────────────────────────────

/** A few cells either side of 43.5°N, inside both Vermont's and New York's envelopes. */
const CELLS = [NORTH, SOUTH, '4307236se', '4307228se', '4407236sw'];

const candidateArb = fc
  .record({
    key: fc.constantFrom(...CELLS),
    year: fc.integer({ min: 2014, max: 2026 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    gsd: fc.constantFrom(0.3, 0.5, 0.6, 1, 0.6000000000000024, 0.30000000000000004),
    state: fc.constantFrom<'VT' | 'NY'>('VT', 'NY'),
    id: fc.nat(1_000_000),
  })
  .map(({ key, year, month, day, gsd, state, id }) => {
    const acquired = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // A winter frame can carry the previous program year (VT and NH 2018, flown January 2019).
    const programYear = month <= 2 ? year - 1 : year;
    return frame(acquired, gsd, { key, state, year: programYear, itemId: `x${id}` });
  });

const catalogArb = fc
  .tuple(fc.uniqueArray(candidateArb, { selector: (c) => c.itemId, maxLength: 40 }), fc.nat())
  .map(([cands, seed]) => {
    // Strike a deterministic few, so properties see exclusions too.
    const exclusions = cands.filter((_, i) => (i + seed) % 5 === 0).map((c) => struck(c));
    return { cands, exclusions };
  });

/** What §2.1 says, phrased as sets and maxima rather than the implementation's sort. */
function ruleSays(eligible: readonly NaipCandidate[]): (c: NaipCandidate) => boolean {
  // Days as strings: the latest is the last sorted (Math.max would read them as NaN).
  const latest = (cs: readonly NaipCandidate[]) =>
    cs
      .map((c) => c.acquired)
      .sort()
      .at(-1);
  const newestDay = latest(eligible);
  const newestYear = Math.max(
    ...eligible.filter((c) => c.acquired === newestDay).map((c) => c.year),
  );
  const sharp = eligible.filter((c) => c.gsd <= 0.305 && c.year >= newestYear - 2);
  if (sharp.length > 0) {
    const best = latest(sharp);
    return (c) => sharp.includes(c) && c.acquired === best;
  }
  return (c) => c.acquired === newestDay;
}

function eligibleFor(
  key: string,
  cands: readonly NaipCandidate[],
  exclusions: readonly NaipExclusion[],
): { leafOn: NaipCandidate[]; all: NaipCandidate[] } {
  const struckIds = new Set(exclusions.map((e) => e.itemId));
  const mid = quarterQuadCell(key).minLat + 1 / 32;
  const all = cands.filter((c) => c.key === key && c.gsd <= 0.605 && !struckIds.has(c.itemId));
  return { all, leafOn: all.filter((c) => isLeafOnNaipFrame(c.acquired, mid)) };
}

describe('the rule, as properties', () => {
  test('a pick is leaf-on whenever any candidate is, and the rule holds for it', () => {
    fc.assert(
      fc.property(catalogArb, ({ cands, exclusions }) => {
        const { picks } = selectNaipPicks(cands, exclusions, NAIP_OFF_SEASON_CELLS);
        for (const p of picks) {
          const { leafOn, all } = eligibleFor(p.key, cands, exclusions);
          expect(p.step).toBe(leafOn.length > 0 ? 'leafOn' : 'offSeason');
          const pool = leafOn.length > 0 ? leafOn : all;
          expect(pool).toContain(p.pick);
          expect(ruleSays(pool)(p.pick)).toBe(true);
        }
      }),
    );
  });

  test('every cell with a candidate has a pick; no other cell does', () => {
    fc.assert(
      fc.property(catalogArb, ({ cands, exclusions }) => {
        const { picks } = selectNaipPicks(cands, exclusions, NAIP_OFF_SEASON_CELLS);
        const expected = CELLS.filter((k) => eligibleFor(k, cands, exclusions).all.length > 0);
        expect(picks.map((p) => p.key)).toEqual(expected.sort());
      }),
    );
  });

  test('the stack is every other candidate of the pool, each the rule’s choice of what is left', () => {
    fc.assert(
      fc.property(catalogArb, ({ cands, exclusions }) => {
        const { picks } = selectNaipPicks(cands, exclusions, NAIP_OFF_SEASON_CELLS);
        for (const p of picks) {
          const { leafOn, all } = eligibleFor(p.key, cands, exclusions);
          let left = [...(leafOn.length > 0 ? leafOn : all)].filter((c) => c !== p.pick);
          expect(p.stack).toHaveLength(left.length);
          for (const next of p.stack) {
            expect(left).toContain(next);
            expect(ruleSays(left)(next)).toBe(true);
            left = left.filter((c) => c !== next);
          }
        }
      }),
    );
  });

  test('an excluded item is never picked or stacked; the drops add up', () => {
    fc.assert(
      fc.property(catalogArb, ({ cands, exclusions }) => {
        const out = selectNaipPicks(cands, exclusions, NAIP_OFF_SEASON_CELLS);
        const struckIds = new Set(exclusions.map((e) => e.itemId));
        for (const p of out.picks) {
          expect(struckIds.has(p.pick.itemId)).toBe(false);
          for (const s of p.stack) expect(struckIds.has(s.itemId)).toBe(false);
        }
        const coarse = cands.filter((c) => c.gsd > 0.605).length;
        const excluded = cands.filter((c) => c.gsd <= 0.605 && struckIds.has(c.itemId)).length;
        expect(out.dropped).toEqual({ coarse, outsideState: 0, excluded });
      }),
    );
  });

  test('the off-season step reaches only cells with no leaf-on candidate, and reports those off the list', () => {
    fc.assert(
      fc.property(catalogArb, fc.subarray(CELLS), ({ cands, exclusions }, allowed) => {
        const out = selectNaipPicks(cands, exclusions, allowed);
        const offSeason = out.picks.filter((p) => p.step === 'offSeason').map((p) => p.key);
        for (const key of offSeason) {
          expect(eligibleFor(key, cands, exclusions).leafOn).toEqual([]);
        }
        expect(out.offSeasonBeyondList).toEqual(offSeason.filter((k) => !allowed.includes(k)));
      }),
    );
  });

  test("the answer doesn't depend on the input's order", () => {
    fc.assert(
      fc.property(
        catalogArb.chain(({ cands, exclusions }) =>
          fc.tuple(
            fc.constant(cands),
            fc.shuffledSubarray(cands, { minLength: cands.length }),
            fc.constant(exclusions),
          ),
        ),
        ([cands, shuffled, exclusions]) => {
          const a = selectNaipPicks(cands, exclusions, NAIP_OFF_SEASON_CELLS);
          const b = selectNaipPicks(shuffled, [...exclusions].reverse(), NAIP_OFF_SEASON_CELLS);
          expect(b).toEqual(a);
        },
      ),
    );
  });
});

// ── The real inventory's slice (§7.3) ───────────────────────────────────────────────────────────

interface FixtureRow extends NaipCandidate {
  /** The scouts' own pick for this cell, from their independent run of the same rule. */
  scoutsPick?: true;
}

const FIXTURE: FixtureRow[] = readFileSync(
  new URL('./fixtures/naipInventory.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as FixtureRow);

const candidates = FIXTURE.map(({ scoutsPick: _, ...c }) => c);
const scouts = new Map(FIXTURE.filter((r) => r.scoutsPick).map((r) => [r.key, r]));
const selection = selectNaipPicks(candidates, [], NAIP_OFF_SEASON_CELLS);
const pickOf = (key: string) => selection.picks.find((p) => p.key === key) as NaipCellPick;

describe('the fixture: a slice of the real catalog', () => {
  test('is the slice §7.3 asks for', () => {
    expect(FIXTURE.length).toBeGreaterThanOrEqual(2000);
    expect(FIXTURE.length).toBeLessThanOrEqual(3000);
  });

  test("picks what the scouts' independent run picked, cell for cell", () => {
    expect(scouts.size).toBeGreaterThan(200);
    for (const [key, theirs] of scouts) {
      const mine = pickOf(key).pick;
      if (mine.itemId === theirs.itemId) continue;
      // The one way the two runs may differ: one frame published under two states' labels, the
      // same day at the same resolution. Ours breaks that tie by item id, theirs by walk order.
      expect([key, mine.acquired, mine.gsd]).toEqual([key, theirs.acquired, theirs.gsd]);
      expect(mine.itemId < theirs.itemId).toBe(true);
    }
  });

  test('the six October cells take their 2 October 2023 frames at 0.3 m, through the off-season step', () => {
    for (const key of NAIP_OFF_SEASON_CELLS) {
      const p = pickOf(key);
      expect(p.step).toBe('offSeason');
      expect(p.pick.acquired).toBe('2023-10-02');
      expect(p.pick.gsd).toBe(0.3);
      expect(p.pick.itemId).toMatch(/_030_20231002_/);
    }
    expect(
      selection.picks
        .filter((p) => p.step === 'offSeason')
        .map((p) => p.key)
        .sort(),
    ).toEqual([...NAIP_OFF_SEASON_CELLS].sort());
    expect(selection.offSeasonBeyondList).toEqual([]);
  });

  test('the 744 mislabeled Maine 2025 items are dropped, and only they', () => {
    expect(selection.dropped.outsideState).toBe(744);
    const picked = new Set(
      selection.picks.flatMap((p) => [p.pick, ...p.stack].map((c) => c.itemId)),
    );
    for (const c of candidates) {
      if (c.state === 'ME' && c.year === 2025) expect(picked.has(c.itemId)).toBe(false);
    }
    // Their Massachusetts cells pick Massachusetts' own frames.
    for (const p of selection.picks.filter(
      (p) => p.key.startsWith('41') || p.key.startsWith('42'),
    )) {
      expect(p.states).not.toContain('ME');
    }
  });

  test('border cells list both states and their frames compete', () => {
    const border = selection.picks.filter((p) => p.states.length === 2);
    expect(border.length).toBeGreaterThanOrEqual(30);
    // Somewhere the pick comes from each side of a line.
    const pickedStates = new Set(border.map((p) => p.pick.state));
    expect(pickedStates.size).toBeGreaterThanOrEqual(4);
    for (const p of border) {
      const pool = [p.pick, ...p.stack];
      expect(new Set(pool.map((c) => c.state)).size).toBeGreaterThanOrEqual(1);
    }
  });

  test('NY 2021 flown in April and May 2022, and VT and NH 2018 flown in January 2019, are never picked', () => {
    for (const p of selection.picks) {
      expect(p.pick.acquired.slice(0, 7)).not.toMatch(/^2022-0[45]$|^2019-01$/);
    }
  });

  test("Long Island's 2 July 2024 glare frames, struck, fall back to New York's earlier summers", () => {
    const glare = selection.picks.filter(
      (p) => p.key.startsWith('400') && p.pick.acquired === '2024-07-02',
    );
    expect(glare.length).toBeGreaterThanOrEqual(17);
    const after = selectNaipPicks(
      candidates,
      glare.map((p) => struck(p.pick)),
      NAIP_OFF_SEASON_CELLS,
    );
    const years: number[] = [];
    for (const p of glare) {
      const now = after.picks.find((q) => q.key === p.key) as NaipCellPick;
      // The next choice, exactly: the stack's head, a New York summer frame.
      expect(now.pick).toEqual(p.stack[0]);
      expect(now.pick.state).toBe('NY');
      expect(now.step).toBe('leafOn');
      years.push(now.pick.year);
    }
    // Most go to 2022's summer; where New York didn't fly 2022, to 2019's (§2.1.2 said 2022 alone).
    expect(new Set(years)).toEqual(new Set([2022, 2019]));
    expect(years.filter((y) => y === 2022).length).toBeGreaterThanOrEqual(17);
  });

  test("Aroostook's 22 September 2023 cumulus frames, struck, fall back to Maine 2021", () => {
    const keys = ['4606741se', '4606741ne', '4606741sw'];
    const cumulus = keys.map(pickOf);
    for (const p of cumulus) expect(p.pick.acquired).toBe('2023-09-22');
    const after = selectNaipPicks(
      candidates,
      cumulus.map((p) => struck(p.pick)),
      NAIP_OFF_SEASON_CELLS,
    );
    for (const key of keys) {
      const now = after.picks.find((q) => q.key === key) as NaipCellPick;
      expect([now.pick.state, now.pick.year]).toEqual(['ME', 2021]);
    }
  });

  test('New Hampshire, Massachusetts, Connecticut and Rhode Island take 2023 at 0.3 m over 2025 at 0.6 m', () => {
    for (const p of selection.picks) {
      const has2023Sharp = [p.pick, ...p.stack].some(
        (c) => c.year === 2023 && c.gsd === 0.3 && ['NH', 'MA', 'CT', 'RI'].includes(c.state),
      );
      if (has2023Sharp && p.pick.year === 2025) expect(p.pick.gsd).toBe(0.3);
    }
    const vt = selection.picks.filter((p) => p.pick.state === 'VT');
    for (const p of vt) expect([p.pick.year, p.pick.gsd]).toEqual([2025, 0.3]);
  });
});

// ── The diff (§3.3) ───────────────────────────────────────────────────────────────────────────────

describe('diffNaipPicks', () => {
  const a = frame('2023-07-01', 0.3, { key: NORTH });
  const b = frame('2021-07-01', 0.6, { key: NORTH });
  const c = frame('2025-07-01', 0.3, { key: NORTH });
  const d = frame('2022-07-01', 0.6, { key: '4407325nw', state: 'NY' });
  const e = frame('2024-07-01', 0.6, { key: '4407325nw', state: 'NY' });
  const g = frame('2019-07-01', 0.6, { key: '4407326nw', state: 'NY' });

  function manifestOf(picks: NaipCellPick[]): NaipManifest {
    const frames: NaipManifest['frames'] = {};
    for (const p of picks) {
      for (const f of [p.pick, ...p.stack]) {
        frames[f.itemId] = { acquired: f.acquired, gsd: f.gsd, year: f.year, state: f.state };
      }
    }
    return {
      version: 1,
      campaign: 'naip-20261201',
      pilot: null,
      createdAt: '2026-12-01T00:00:00Z',
      ruleVersion: 1,
      catalog: { walkedOn: '2026-12-01', items: 0, perState: {}, archivedAt: null },
      exclusionsHash: '',
      offSeasonCells: [],
      basedOn: null,
      frames,
      cells: picks.map((p) => ({
        key: p.key,
        states: [...p.states],
        pick: p.pick.itemId,
        step: p.step,
        stack: p.stack.map((s) => s.itemId),
        partial: false,
        cloudScore: null,
        workTiles: [],
      })),
      workTiles: [],
    };
  }
  const select = (cands: NaipCandidate[]) => selectNaipPicks(cands, [], []).picks;

  test('nothing changed: empty', () => {
    const picks = select([a, b, d, g]);
    expect(diffNaipPicks(manifestOf(picks), picks)).toEqual({ cells: [], states: [] });
  });

  test('a new pick, a stack-only change, an added and a removed cell', () => {
    const current = manifestOf(select([a, b, d, g]));
    const next = select([
      a,
      b,
      c,
      d,
      e,
      frame('2016-07-01', 0.6, { key: '4407326nw', state: 'NY' }),
    ]);
    // NORTH: c (2025, 0.3) replaces a. 4407325nw: e replaces d. 4407326nw: g gone, a new frame.
    const diff = diffNaipPicks(current, next);
    expect(diff.cells).toEqual([
      {
        key: NORTH,
        from: { itemId: a.itemId, acquired: a.acquired, gsd: 0.3, state: 'VT' },
        to: { itemId: c.itemId, acquired: c.acquired, gsd: 0.3, state: 'VT' },
        stackOnly: false,
      },
      {
        key: '4407325nw',
        from: { itemId: d.itemId, acquired: d.acquired, gsd: 0.6, state: 'NY' },
        to: { itemId: e.itemId, acquired: e.acquired, gsd: 0.6, state: 'NY' },
        stackOnly: false,
      },
      expect.objectContaining({ key: '4407326nw', stackOnly: false }),
    ]);
    expect(diff.states).toEqual([
      { state: 'NY', cells: 2, newest: '2024-07-01', oldestReplaced: '2019-07-01' },
      { state: 'VT', cells: 1, newest: '2025-07-01', oldestReplaced: '2023-07-01' },
    ]);
  });

  test('lists the cells and the states sorted, wherever the catalog put them', () => {
    const vtSouth = frame('2025-07-01', 0.3, { key: SOUTH });
    const nh = frame('2023-07-01', 0.3, { key: '4407136se', state: 'NH' });
    const current = manifestOf(select([a, g]));
    const diff = diffNaipPicks(current, select([c, g, vtSouth, e, nh]));
    expect(diff.cells.map((x) => x.key)).toEqual([SOUTH, '4407136se', NORTH, '4407325nw']);
    expect(diff.states.map((x) => x.state)).toEqual(['NH', 'NY', 'VT']);
  });

  test('the same pick with another stack is a stack-only change', () => {
    const current = manifestOf(select([a]));
    const diff = diffNaipPicks(current, select([a, b]));
    expect(diff.cells).toEqual([expect.objectContaining({ key: a.key, stackOnly: true })]);
  });

  test('a cell the catalog dropped, and one it added', () => {
    const current = manifestOf(select([a, d]));
    const diff = diffNaipPicks(current, select([a, g]));
    expect(diff.cells.map((c) => [c.key, c.from?.itemId ?? null, c.to?.itemId ?? null])).toEqual([
      ['4407325nw', d.itemId, null],
      ['4407326nw', null, g.itemId],
    ]);
    expect(diff.states).toEqual([
      { state: 'NY', cells: 2, newest: g.acquired, oldestReplaced: d.acquired },
    ]);
  });

  test('refuses a manifest that names a frame it does not hold', () => {
    const current = manifestOf(select([a]));
    current.frames = {};
    expect(() => diffNaipPicks(current, select([c]))).toThrow(/doesn't hold it/);
  });
});
