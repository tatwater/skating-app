import { describe, expect, it } from 'vitest';
import {
  buildSubAreaSpread,
  SPREAD_LOW_SIMILAR_C,
  SPREAD_MIN_DAYS,
  SPREAD_SNOW_SIMILAR_CM,
  type SpreadBayInput,
} from './subAreaSpread';

const DAY = 86_400_000;
const D0 = Date.UTC(2027, 0, 10);

/** `n` complete days for a bay, every night at `lowC`, with `snowCm` falling on the first day. */
function bay(
  subAreaId: string,
  name: string,
  lowC: number,
  snowCm = 0,
  n = 7,
  over: { skipDays?: number[] } = {},
): SpreadBayInput {
  const days = [];
  for (let i = 0; i < n; i++) {
    if (over.skipDays?.includes(i)) continue;
    days.push({
      dayMs: D0 + i * DAY,
      nightMinTempC: lowC,
      minTempC: lowC + 1,
      snowfallCm: i === 0 ? snowCm : 0,
    });
  }
  return { subAreaId, name, days };
}

describe('buildSubAreaSpread', () => {
  it('names the ends of the range, and every clause is true of somewhere real', () => {
    const spread = buildSubAreaSpread([
      bay('miss', 'Missisquoi Bay', -18, 0),
      bay('burl', 'Burlington Bay', -11, 10),
      bay('mall', 'Malletts Bay', -14, 0),
    ]);
    expect(spread).not.toBeNull();
    expect(spread?.similar).toBe(false);
    expect(spread?.bays).toBe(3);
    expect(spread?.days).toBe(7);
    const lows = spread?.lines.find((l) => l.kind === 'lows');
    const snow = spread?.lines.find((l) => l.kind === 'snow');
    expect(lows?.kind === 'lows' && lows.coldest.name).toBe('Missisquoi Bay');
    expect(lows?.kind === 'lows' && lows.mildest.name).toBe('Burlington Bay');
    expect(lows?.text).toBe(
      'Lows 0°F to 12°F — coldest at Missisquoi Bay, mildest at Burlington Bay',
    );
    // Least snow ties between Missisquoi and Malletts at zero; the tie goes to the first by name so
    // two renders cannot disagree about the tap target.
    expect(snow?.kind === 'snow' && snow.least.name).toBe('Malletts Bay');
    expect(snow?.kind === 'snow' && snow.most.name).toBe('Burlington Bay');
    expect(snow?.text).toBe(
      'Snow in the last 7 days: none at Malletts Bay, 3.9 in at Burlington Bay',
    );
    expect(spread?.summary).toBe('Across 3 bays over the last 7 days');
    // The places are parts of the line, so a client can make them pressable without restating copy.
    const places = lows?.parts.filter((p) => typeof p !== 'string').map((p) => p.name);
    expect(places).toEqual(['Missisquoi Bay', 'Burlington Bay']);
  });

  it('never builds a day that happened nowhere — the extremes are places, not a composite row', () => {
    const spread = buildSubAreaSpread([bay('a', 'A Bay', -20, 0), bay('b', 'B Bay', -5, 12)]);
    const text = spread?.lines.map((l) => l.text).join(' ') ?? '';
    // Coldest and snowiest are different places, and the copy says which is which rather than
    // pairing "-4°F" with "4.7 in" as if one lake did both.
    expect(text).toContain('coldest at A Bay');
    expect(text).toContain('4.7 in at B Bay');
  });

  it('collapses to "similar" when the bays agree, per line and overall', () => {
    const spread = buildSubAreaSpread([
      bay('a', 'A Bay', -10, 0),
      bay('b', 'B Bay', -10 + SPREAD_LOW_SIMILAR_C - 0.5, 0),
    ]);
    expect(spread?.similar).toBe(true);
    expect(spread?.summary).toMatch(/^Similar across the lake's 2 bays/);
    expect(spread?.lines.find((l) => l.kind === 'snow')?.text).toBe(
      'No snow at any bay in the last 7 days',
    );
    expect(spread?.lines.find((l) => l.kind === 'lows')?.text).toMatch(
      /^Lows within a few degrees/,
    );
  });

  it('a partial collapse keeps the line that differs', () => {
    const spread = buildSubAreaSpread([
      bay('a', 'A Bay', -10, 0),
      bay('b', 'B Bay', -11, SPREAD_SNOW_SIMILAR_CM + 3),
    ]);
    expect(spread?.similar).toBe(false);
    expect(spread?.lines.find((l) => l.kind === 'lows')?.similar).toBe(true);
    expect(spread?.lines.find((l) => l.kind === 'snow')?.similar).toBe(false);
  });

  it('compares every bay over the SAME days — a bay with a hole is not "less snow"', () => {
    // B Bay is missing the day the snow fell. Over its own days it has zero snow; over the shared
    // days neither bay has any, because the snow day is dropped from both.
    const spread = buildSubAreaSpread([
      bay('a', 'A Bay', -10, 8),
      bay('b', 'B Bay', -10, 0, 7, { skipDays: [0] }),
    ]);
    expect(spread?.days).toBe(6);
    expect(spread?.lines.find((l) => l.kind === 'snow')?.text).toBe(
      'No snow at any bay in the last 6 days',
    );
  });

  it('withholds the spread on too few shared days or too few bays, rather than ranking a thin sample', () => {
    expect(
      buildSubAreaSpread([bay('a', 'A', -10, 0, SPREAD_MIN_DAYS - 1), bay('b', 'B', -12, 0)]),
    ).toBeNull();
    expect(buildSubAreaSpread([bay('a', 'A', -10)])).toBeNull();
    expect(
      buildSubAreaSpread([bay('a', 'A', -10), { subAreaId: 'b', name: 'B', days: [] }]),
    ).toBeNull();
    expect(buildSubAreaSpread([])).toBeNull();
  });

  it('falls back to the day minimum when a night was not fully observed', () => {
    const a: SpreadBayInput = {
      subAreaId: 'a',
      name: 'A',
      days: [0, 1, 2].map((i) => ({ dayMs: D0 + i * DAY, nightMinTempC: null, minTempC: -20 })),
    };
    const spread = buildSubAreaSpread([a, bay('b', 'B', -5, 0, 3)]);
    const lows = spread?.lines.find((l) => l.kind === 'lows');
    expect(lows?.kind === 'lows' && lows.coldest.name).toBe('A');
  });

  it('never says "best" or recommends a bay (D3 / D150)', () => {
    const spread = buildSubAreaSpread([bay('a', 'A Bay', -20, 0), bay('b', 'B Bay', -5, 12)]);
    const text = [spread?.summary, ...(spread?.lines.map((l) => l.text) ?? [])].join(' ');
    expect(text).not.toMatch(/best|recommend|safe|go to|should/i);
  });
});
