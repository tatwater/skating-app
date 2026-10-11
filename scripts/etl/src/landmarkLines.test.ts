import { describe, expect, it } from 'vitest';
import {
  applyRefusal,
  type BodyLine,
  landmarkLines,
  packLines,
  runCompleteness,
  runIsComplete,
} from './landmarkLines';
import type { PlacedLandmark } from './landmarkMatch';

const ALL = ['vt', 'nh', 'me', 'ma', 'ny'];

function placedOn(waterBodyId: string, name: string): PlacedLandmark {
  return {
    waterBodyId,
    name,
    kind: 'island',
    point: { lat: 44, lng: -73 },
    source: 'osm',
    externalIds: [`osm:way/${name}`],
    aliases: [],
  };
}

describe('runIsComplete', () => {
  it('is complete only when every state ran, in any order or case', () => {
    expect(runIsComplete([...ALL].reverse(), ALL)).toBe(true);
    expect(runIsComplete(['VT', 'NH', 'ME', 'MA', 'NY'], ALL)).toBe(true);
    expect(runIsComplete(['vt'], ALL)).toBe(false);
    expect(runIsComplete(['vt', 'nh', 'me', 'ma'], ALL)).toBe(false);
  });
});

describe('runCompleteness', () => {
  const counts = { 'vt.osm': 9_000, 'vt.gnis': 1_200 };
  const baseline = { 'vt.osm': 9_000, 'vt.gnis': 1_250, 'ny.osm': 55_000 };

  it('vouches for a full run whose sources read what they read last time, and moves the baseline', () => {
    expect(runCompleteness(ALL, ALL, counts, baseline, false)).toEqual({
      complete: true,
      shortfalls: [],
      baseline: { 'vt.osm': 9_000, 'vt.gnis': 1_200, 'ny.osm': 55_000 },
    });
    // No baseline yet: only an empty source is caught, and this run becomes the baseline.
    expect(runCompleteness(ALL, ALL, counts, undefined, false)).toMatchObject({
      complete: true,
      baseline: counts,
    });
  });

  it('will not vouch for a source that came back empty or short, and keeps the old baseline', () => {
    const short = runCompleteness(ALL, ALL, { 'vt.osm': 4_000, 'vt.gnis': 0 }, baseline, false);
    expect(short.complete).toBe(false);
    expect(short.shortfalls).toEqual([
      "vt.osm: 4000 candidates, 56% under the last good run's 9000",
      'vt.gnis: no candidates',
    ]);
    expect(short.baseline).toBe(baseline);
    // Within the margin is fine.
    expect(runCompleteness(ALL, ALL, { 'vt.osm': 8_200 }, baseline, false).complete).toBe(true);
  });

  it('vouches for a real shrink when told so, and never for a partial run', () => {
    const real = runCompleteness(ALL, ALL, { 'vt.osm': 4_000 }, baseline, true);
    expect(real).toMatchObject({ complete: true, baseline: { 'vt.osm': 4_000 } });
    expect(real.shortfalls).toHaveLength(1);
    const partial = runCompleteness(['vt'], ALL, counts, baseline, false);
    expect(partial).toMatchObject({ complete: false, shortfalls: [] });
    expect(partial.baseline).toMatchObject(counts);
  });
});

describe('landmarkLines', () => {
  const byBody = new Map([['a', [placedOn('a', 'Gull')]]]);

  it('writes only the bodies a partial run placed something on, unmarked', () => {
    const { waterBodyId: _, ...gull } = placedOn('a', 'Gull');
    expect(landmarkLines(['a', 'b'], byBody, false)).toEqual([
      { waterBodyId: 'a', landmarks: [gull] },
    ]);
  });

  it('writes every body on a complete run, an empty line where nothing landed', () => {
    const lines = landmarkLines(['a', 'b'], byBody, true);
    expect(lines.map((l) => [l.waterBodyId, l.landmarks.length, l.complete])).toEqual([
      ['a', 1, true],
      ['b', 0, true],
    ]);
    expect(lines[0]?.landmarks[0]).not.toHaveProperty('waterBodyId');
  });
});

describe('packLines', () => {
  const line = (id: string, n: number): BodyLine => ({
    waterBodyId: id,
    landmarks: Array.from({ length: n }, () => ({})),
  });

  it('packs to the batch size and never splits a body', () => {
    const batches = packLines([line('a', 2), line('b', 2), line('c', 5), line('d', 1)], 4);
    expect(batches.map((b) => b.map((l) => l.waterBodyId))).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('weighs an empty line as one, so a complete run’s empties still batch', () => {
    const empties = Array.from({ length: 7 }, (_, i) => line(`e${i}`, 0));
    expect(packLines(empties, 3).map((b) => b.length)).toEqual([3, 3, 1]);
    expect(packLines([], 3)).toEqual([]);
  });
});

describe('applyRefusal', () => {
  const flags = { withoutCorpus: false };

  it('lets a run with the corpus through', () => {
    expect(applyRefusal({ corpusApplied: true, complete: true }, flags)).toBeNull();
  });

  it('refuses a run without the corpus unless told so', () => {
    expect(applyRefusal({ corpusApplied: false }, flags)).toMatch(/--without-corpus/);
    expect(applyRefusal(undefined, flags)).toMatch(/--without-corpus/);
    expect(applyRefusal({ corpusApplied: false }, { withoutCorpus: true })).toBeNull();
  });
});
