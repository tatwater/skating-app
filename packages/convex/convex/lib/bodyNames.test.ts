/**
 * **A body's short list of names, as a rule** (B01-3u). The bound is held by an estimate that never
 * undercounts what the lists weigh; a list past it, or past the landmark cap, is `capped` and empty;
 * and the list's answer to the landmark undo's rule never says "no clash" where the whole rule
 * (`landmarkEditRefusal`, over the rows and the bays' outlines) refuses — a duplicate it says word for
 * word, a bay that answers to a name it sends to the landmark.
 */
import { type LandmarkKind, MAX_LANDMARKS_PER_BODY } from '@skating/core';
import { getDocumentSize } from 'convex/values';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Doc, Id } from '../_generated/dataModel';
import {
  BODY_NAMES_MAX_BYTES,
  NAMES_NEED_THE_BAY,
  nameListRefusal,
  namesBytes,
  namesOf,
} from './bodyNames';
import { landmarkEditRefusal } from './landmarkRows';
import { ROW_MAX } from './readBudget';

const KINDS: LandmarkKind[] = ['island', 'point', 'other'];

function landmark(i: number, over: Partial<Doc<'bodyLandmarks'>> = {}): Doc<'bodyLandmarks'> {
  return {
    _id: `landmark${i}` as Id<'bodyLandmarks'>,
    _creationTime: i,
    waterBodyId: 'body' as Id<'waterBodies'>,
    name: `Point ${i}`,
    kind: 'point',
    point: { lat: 44, lng: -73 },
    source: 'gnis',
    externalIds: [],
    aliases: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Doc<'bodyLandmarks'>;
}

function rect(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

function bay(i: number, name: string, over: Partial<Doc<'waterBodySubAreas'>> = {}) {
  return {
    _id: `bay${i}` as Id<'waterBodySubAreas'>,
    _creationTime: i,
    waterBodyId: 'body' as Id<'waterBodies'>,
    name,
    polygon: rect(-73.2 + i * 0.1, 44.0, -73.15 + i * 0.1, 44.05),
    ...over,
  } as unknown as Doc<'waterBodySubAreas'>;
}

const nameArb = fc.string({ minLength: 1, maxLength: 80, unit: 'grapheme' });

describe('the bound', () => {
  test('the estimate never undercounts what the lists weigh stored', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(nameArb, { minLength: 1, maxLength: 13 }), { maxLength: 30 }),
        fc.array(fc.array(nameArb, { minLength: 1, maxLength: 6 }), { maxLength: 10 }),
        (landmarkNames, bayNames) => {
          const rows = landmarkNames.map((names, i) =>
            landmark(i, { name: names[0] as string, aliases: names.slice(1) }),
          );
          const bays = bayNames.map((names, i) =>
            bay(i, names[0] as string, { aliases: names.slice(1) } as never),
          );
          const lists = namesOf(rows, bays);
          if (lists.capped) return;
          const stored = {
            waterBodyId: 'jd7a1b2c3d4e5f6g7h8j9k0m1n2p3q4r' as Id<'waterBodies'>,
            capped: false,
            landmarks: lists.landmarks.map((l) => ({
              ...l,
              id: 'jd7a1b2c3d4e5f6g7h8j9k0m1n2p3q4r',
            })),
            bays: lists.bays.map((b) => ({ ...b, id: 'jd7a1b2c3d4e5f6g7h8j9k0m1n2p3q4r' })),
            updatedAt: Date.now(),
          };
          expect(getDocumentSize(stored as never)).toBeLessThanOrEqual(
            namesBytes(lists.landmarks, lists.bays) + 1024,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test('the row’s worst case fits its declared read', () => {
    expect(BODY_NAMES_MAX_BYTES + 1024).toBeLessThanOrEqual(ROW_MAX.bodyNames);
  });

  test('past the bound the row is capped and holds nothing; at it, every name', () => {
    const long = 'x'.repeat(80);
    const rows: Doc<'bodyLandmarks'>[] = [];
    const estimate = () =>
      namesBytes(
        rows.map((r) => ({ names: [r.name, ...r.aliases] })),
        [],
      );
    for (let i = 0; estimate() <= BODY_NAMES_MAX_BYTES; i++) {
      rows.push(landmark(i, { name: `${long}${i}`, aliases: [long, long] }));
    }
    expect(namesOf(rows, [])).toEqual({ capped: true, landmarks: [], bays: [] });
    const fits = namesOf(rows.slice(0, -1), []);
    expect(fits.capped).toBe(false);
    expect(fits.landmarks).toHaveLength(rows.length - 1);
  });

  test('a read past the landmark cap is capped by the bound, however short the names', () => {
    const rows = Array.from({ length: MAX_LANDMARKS_PER_BODY + 1 }, (_, i) =>
      landmark(i, { name: 'A' }),
    );
    expect(namesOf(rows, []).capped).toBe(true);
  });

  test('removed landmarks and delisted bays are not on it', () => {
    const lists = namesOf(
      [landmark(1), landmark(2, { removedAt: 5 })],
      [bay(1, 'Mud Bay'), bay(2, 'Gone Bay', { removedAt: 5 })],
    );
    expect(lists.landmarks.map((l) => l.id)).toEqual(['landmark1']);
    expect(lists.bays).toEqual([{ id: 'bay1', names: ['Mud Bay'] }]);
  });
});

describe('the list’s answer to the landmark undo’s rule', () => {
  const NAMES = ['Mud Bay', 'Long Point', 'Apple Island', 'The Gut'];
  const pointArb = fc.record({
    lat: fc.constantFrom(44.0, 44.01, 44.025, 44.3),
    lng: fc.constantFrom(-73.2, -73.19, -73.175, -73.0),
  });
  const entryArb = fc.record({
    name: fc.constantFrom(...NAMES),
    alias: fc.option(fc.constantFrom(...NAMES), { nil: undefined }),
    kind: fc.constantFrom(...KINDS),
    point: pointArb,
    removed: fc.boolean(),
  });

  test('never "no clash" where the whole rule refuses; a duplicate word for word', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 6 }),
        fc.array(fc.record({ name: fc.constantFrom(...NAMES), removed: fc.boolean() }), {
          maxLength: 3,
        }),
        entryArb,
        fc.nat(6),
        (entries, bayEntries, cand, except) => {
          const rows = entries.map((e, i) =>
            landmark(i, {
              name: e.name,
              aliases: e.alias ? [e.alias] : [],
              kind: e.kind,
              point: e.point,
              ...(e.removed ? { removedAt: 1 } : {}),
            }),
          );
          const bays = bayEntries.map((b, i) =>
            bay(i, b.name, b.removed ? ({ removedAt: 1 } as never) : {}),
          );
          const candidate = {
            kind: cand.kind,
            point: cand.point,
            name: cand.name,
            aliases: cand.alias && cand.alias !== cand.name ? [cand.alias] : [],
          };
          const exceptId = `landmark${except}` as Id<'bodyLandmarks'>;
          const whole = landmarkEditRefusal(
            rows.filter((r) => r.removedAt === undefined),
            bays
              .filter((b) => b.removedAt === undefined)
              .map((b) => ({
                _id: b._id,
                polygon: b.polygon as never,
                names: [b.name, ...(b.aliases ?? [])],
              })),
            candidate,
            exceptId,
          );
          const list = nameListRefusal(namesOf(rows, bays), candidate, exceptId);
          if (list === null) expect(whole).toBeNull();
          else if (list === NAMES_NEED_THE_BAY) {
            // The outline decides: no duplicate stands in the way, and a bay answers to a name.
            expect(whole === null || whole.includes('is a bay on this lake')).toBe(true);
          } else expect(list).toBe(whole);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('a capped list answers nothing', () => {
    expect(
      nameListRefusal(
        { capped: true, landmarks: [], bays: [] },
        { kind: 'point', point: { lat: 0, lng: 0 }, name: 'A', aliases: [] },
        'x' as Id<'bodyLandmarks'>,
      ),
    ).toBeUndefined();
  });
});
