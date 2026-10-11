import { describe, expect, it } from 'vitest';
import {
  acceptsLoad,
  applyRefusal,
  type BodyLine,
  landmarkLines,
  packLines,
  runIsComplete,
  summarySources,
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

describe('summarySources', () => {
  it('turns the summary’s per-source counts into what the importer weighs, or nothing', () => {
    expect(summarySources({ bySource: { 'vt.osm': 9, 'vt.gnis': 1 } })).toEqual([
      { source: 'vt.osm', count: 9 },
      { source: 'vt.gnis', count: 1 },
    ]);
    expect(summarySources({})).toBeUndefined();
    expect(summarySources(undefined)).toBeUndefined();
  });
});

describe('acceptsLoad', () => {
  const complete = [{ waterBodyId: 'a', landmarks: [], complete: true }];
  const partial = [{ waterBodyId: 'a', landmarks: [{}] }];

  it('moves the bar only for an applied complete load with no failed batch', () => {
    expect(acceptsLoad({ apply: true, lines: complete, failedBatches: 0 })).toBe(true);
    expect(acceptsLoad({ apply: false, lines: complete, failedBatches: 0 })).toBe(false);
    expect(acceptsLoad({ apply: true, lines: partial, failedBatches: 0 })).toBe(false);
    expect(acceptsLoad({ apply: true, lines: complete, failedBatches: 1 })).toBe(false);
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
