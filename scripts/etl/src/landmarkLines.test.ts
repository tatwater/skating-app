import { describe, expect, it } from 'vitest';
import {
  applyRefusal,
  type BodyLine,
  landmarkLines,
  MAX_BODY_EXPORT_AGE_MS,
  packLines,
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
  const now = 1_000_000_000_000;
  const fresh = { corpusApplied: true, complete: true, bodiesExportedAt: now - 60_000 };
  const flags = { withoutCorpus: false, staleBodies: false };

  it('lets a fresh run with the corpus through', () => {
    expect(applyRefusal(fresh, flags, now)).toBeNull();
    expect(applyRefusal({ corpusApplied: true }, flags, now)).toBeNull();
  });

  it('refuses a run without the corpus unless told so', () => {
    expect(applyRefusal({ ...fresh, corpusApplied: false }, flags, now)).toMatch(
      /--without-corpus/,
    );
    expect(applyRefusal(undefined, flags, now)).toMatch(/--without-corpus/);
    expect(
      applyRefusal({ ...fresh, corpusApplied: false }, { ...flags, withoutCorpus: true }, now),
    ).toBeNull();
  });

  it('refuses a complete run matched against an old or undated export unless told so', () => {
    const old = { ...fresh, bodiesExportedAt: now - MAX_BODY_EXPORT_AGE_MS - 1 };
    expect(applyRefusal(old, flags, now)).toMatch(/--refresh-bodies/);
    expect(applyRefusal({ corpusApplied: true, complete: true }, flags, now)).toMatch(
      /--stale-bodies/,
    );
    expect(applyRefusal(old, { ...flags, staleBodies: true }, now)).toBeNull();
    // A partial run retires nothing, so its export's age does not matter.
    expect(applyRefusal({ ...old, complete: false }, flags, now)).toBeNull();
  });
});
