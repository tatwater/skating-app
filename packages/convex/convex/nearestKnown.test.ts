/**
 * **The nearest body already on the map, stamped by the catalog lookup** (B01-5d): a bounded geo read
 * (`listedBodiesNearCoord` with a 2 km margin — never the resolution-grade default, never a corpus
 * scan) at the lookup's write, served as an admit's `candidate.nearestKnown` (board 2.3's *Nearest*).
 * Tested at the bound: a body just past the margin isn't named, nor one whose box is inside it but
 * whose water isn't. An ask looked up before the stamp reads `null`.
 */

import { NOTIFICATION_PREF_DEFAULTS } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { NEAREST_KNOWN_MARGIN_M, nearestKnownOf } from './corpusRequests';
import { fileMember, requestSource } from './lib/inboxItems';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

const ASK = { lat: 44, lng: -72 };
const M_LAT = 111_320;
const M_LNG = 111_320 * Math.cos((ASK.lat * Math.PI) / 180);
/** The point `east` and `north` meters from the ask. */
const at = (east: number, north: number): [number, number] => [
  ASK.lng + east / M_LNG,
  ASK.lat + north / M_LAT,
];

/** A listed lake whose outline is `ring` (meters from the ask), imported so its cells are written. */
async function lake(t: T, key: string, ring: [number, number][]): Promise<Id<'waterBodies'>> {
  const coords = [...ring, ring[0] as [number, number]].map(([e, n]) => at(e, n));
  const polygon: Polygon = { type: 'Polygon', coordinates: [coords] };
  const lngs = coords.map((c) => c[0] as number);
  const lats = coords.map((c) => c[1] as number);
  const bbox = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId: `osm/${key}`,
        osmId: `osm/${key}`,
        name: `Pond ${key}`,
        type: 'lakePond',
        polygon,
        bbox,
        centroid: { lat: (bbox.minLat + bbox.maxLat) / 2, lng: (bbox.minLng + bbox.maxLng) / 2 },
        surfaceAreaSqM: 250_000,
      },
    ],
  });
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === `osm/${key}`,
  );
  return row?._id as Id<'waterBodies'>;
}

/** A 500 m square whose west shore is `east` meters east of the ask. */
const squareEastOf = (east: number): [number, number][] => [
  [east, -250],
  [east, 250],
  [east + 500, 250],
  [east + 500, -250],
];

const nearest = (t: T) => t.run((ctx) => nearestKnownOf(ctx, ASK));

describe('nearestKnownOf: the nearest listed body within the margin', () => {
  test('the nearest by its shore, rounded to the meter; 0 inside one', async () => {
    const t = harness();
    await lake(t, 'far', squareEastOf(1_900));
    const near = await lake(t, 'near', squareEastOf(1_000));
    const found = await nearest(t);
    expect(found).toMatchObject({ waterBodyId: near, name: 'Pond near' });
    expect(found?.meters).toBeGreaterThan(990);
    expect(found?.meters).toBeLessThan(1_010);
    expect(Number.isInteger(found?.meters)).toBe(true);
    const under = await lake(t, 'under', squareEastOf(-250));
    expect(await nearest(t)).toMatchObject({ waterBodyId: under, meters: 0 });
  });

  test('at the bound: just inside the margin is named, just past it is not', async () => {
    const inside = harness();
    await lake(inside, 'in', squareEastOf(NEAREST_KNOWN_MARGIN_M - 50));
    expect(await nearest(inside)).not.toBeNull();
    const past = harness();
    await lake(past, 'out', squareEastOf(NEAREST_KNOWN_MARGIN_M + 50));
    expect(await nearest(past)).toBeNull();
  });

  test('a body whose box reaches inside the margin but whose water doesn’t is not named', async () => {
    const t = harness();
    // A triangle: its box's corner sits 1.9 km east and north, its nearest water ~2.7 km off.
    await lake(t, 'tri', [
      [1_900 + 2_000, 1_900],
      [1_900 + 2_000, 1_900 + 2_000],
      [1_900, 1_900 + 2_000],
    ]);
    const read = await t.run(async (ctx) => {
      const { listedBodiesNearCoord } = await import('./waterBodies');
      return (await listedBodiesNearCoord(ctx, ASK, NEAREST_KNOWN_MARGIN_M)).size;
    });
    expect(read).toBe(1);
    expect(await nearest(t)).toBeNull();
  });
});

describe('the lookup stamps it, and the admit serves it', () => {
  test('a found candidate carries it; an older ask reads null; a lookup that finds nothing clears it', async () => {
    const t = harness();
    const near = await lake(t, 'near', squareEastOf(1_000));
    const mod = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'mod',
        displayName: 'mod Test-Person',
        username: 'mod',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'moderator',
        status: 'active',
        createdAt: NOW,
      }),
    );
    const asker = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'asker',
        displayName: 'asker Test-Person',
        username: 'asker',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: NOW,
      }),
    );
    const requestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: asker,
        coord: ASK,
        createdAt: NOW,
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    const candidate = {
      source: '3dhp' as const,
      externalId: 'catalog/1',
      name: 'Hidden Pond',
      featureType: 390,
      cls: 'lakePond',
      polygon: {
        type: 'Polygon',
        coordinates: [[at(-50, -50), at(-50, 50), at(50, 50), at(-50, -50)]],
      },
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: ASK,
      surfaceAreaSqM: 10_000,
      serviceUrl: 'https://example.invalid/3dhp',
      fetchedAt: NOW,
    };
    const as = t.withIdentity({ subject: 'mod' });
    const served = async () => {
      const { item } = await as.query(api.inbox.item, { ref: `request:${requestId}` });
      return item?.kind === 'request' ? item.candidate?.nearestKnown : 'no candidate';
    };
    // Looked up before the stamp existed: the candidate, and no neighbor named.
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: NOW,
      candidate,
    });
    expect(await served()).toBeNull();
    // *Look up again*: the lookup's read, stamped by its write.
    const nearestKnown = await t.query(internal.corpusRequests.nearestKnownForResolve, {
      coord: ASK,
    });
    expect(nearestKnown?.waterBodyId).toBe(near);
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: NOW + 1,
      candidate,
      ...(nearestKnown ? { nearestKnown } : {}),
    });
    expect(await served()).toEqual(nearestKnown);
    // A lookup that found no water writes no neighbor beside it.
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: NOW + 2,
      resolveError: 'No catalog water at this point',
      ...(nearestKnown ? { nearestKnown } : {}),
    });
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.nearestKnown).toBeUndefined();
    void mod;
  });
});
