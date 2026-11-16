/**
 * A landmark's catalog ids are bounded by their total length, never by their count (B01-3j): the load
 * never skips or freezes a waterway stitched from many ways, a merge's fold keeps the union whole
 * under the total, and past it both keep the newest, count what they dropped and say so.
 */

import { MAX_LANDMARK_EXTERNAL_ID_CHARS } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();
const way = (n: number) => `osm:way/${String(n).padStart(10, '0')}`;
const ways = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => way(from + i));
/** Ids long enough that a couple of hundred pass the total. */
const longIds = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `osm:way/${String(from + i).padStart(92, '0')}`);
const total = (ids: readonly string[]) => ids.reduce((sum, id) => sum + id.length, 0);

const SQUARE = (x: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [x - 0.01, 43.99],
      [x + 0.01, 43.99],
      [x + 0.01, 44.01],
      [x - 0.01, 44.01],
      [x - 0.01, 43.99],
    ],
  ],
});
async function body(t: T, externalId: string, x = -72) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: `Lake ${externalId}`,
        type: 'lakePond',
        polygon: SQUARE(x),
        bbox: { minLat: 43.99, minLng: x - 0.01, maxLat: 44.01, maxLng: x + 0.01 },
        centroid: { lat: 44, lng: x },
        surfaceAreaSqM: 40_000,
        // The import's region rule (D266): a body carries the states its producer decided.
        states: ['NH'],
      },
    ],
  } as never);
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!row) throw new Error('not imported');
  return row._id;
}
const landmarkRow = (
  t: T,
  waterBodyId: Id<'waterBodies'>,
  externalIds: string[],
  name = 'Monument Brook',
) =>
  t.run((ctx) =>
    ctx.db.insert('bodyLandmarks', {
      waterBodyId,
      name,
      kind: 'point',
      point: { lat: 44, lng: -72 },
      aliases: [],
      source: 'osm',
      externalIds,
      createdAt: NOW,
      updatedAt: NOW,
    } as never),
  );
const load = (
  t: T,
  waterBodyId: Id<'waterBodies'>,
  externalIds: string[],
  name = 'Monument Brook',
  dryRun = false,
) =>
  t.mutation(internal.landmarks.importBatch, {
    bodies: [
      {
        waterBodyId,
        landmarks: [
          {
            name,
            kind: 'point',
            point: { lat: 44, lng: -72 },
            source: 'osm',
            externalIds,
            aliases: [],
          },
        ],
      },
    ],
    dryRun,
  } as never);

describe('the landmark load and a waterway stitched from many ways', () => {
  test('a 142-id waterway is updated, not skipped; one more id is kept', async () => {
    const t = harness();
    const id = await body(t, 'way/1');
    const ids = ways(0, 142);
    const row = await landmarkRow(t, id, ids);
    const first = await load(t, id, ids, 'Monument Brook East');
    expect(first).toMatchObject({ updated: 1, tooLong: 0, idsTrimmed: 0 });
    expect((await t.run((ctx) => ctx.db.get(row)))?.name).toBe('Monument Brook East');
    const more = [...ids, way(142)];
    await load(t, id, more, 'Monument Brook East');
    expect((await t.run((ctx) => ctx.db.get(row)))?.externalIds).toEqual(more);
  });

  test('past the total the newest are kept, counted and named; nothing throws', async () => {
    const t = harness();
    const id = await body(t, 'way/1');
    const ids = longIds(0, 200);
    expect(total(ids)).toBeGreaterThan(MAX_LANDMARK_EXTERNAL_ID_CHARS);
    // The dry run says what the applied run will: the same row, counted and named.
    const dry = await load(t, id, ids, 'Monument Brook', true);
    expect(dry).toMatchObject({ created: 1, idsTrimmed: 1 });
    expect(dry.notes).toHaveLength(1);
    const out = await load(t, id, ids);
    expect(out).toMatchObject({ created: 1, tooLong: 0, idsTrimmed: 1 });
    expect(out.notes).toEqual([
      { key: ids.at(-1), reason: expect.stringMatching(/oldest catalog ids dropped/) },
    ]);
    const row = (
      await t.run((ctx) => ctx.db.query('bodyLandmarks').collect())
    )[0] as Doc<'bodyLandmarks'>;
    expect(total(row.externalIds)).toBeLessThanOrEqual(MAX_LANDMARK_EXTERNAL_ID_CHARS);
    expect(row.externalIds).toEqual(ids.slice(ids.length - row.externalIds.length));
    // The next run of the same catalogs leaves the row as it is — the same newest ids, not a
    // different slice each run.
    const again = await load(t, id, ids);
    expect(again).toMatchObject({ unchanged: 1, updated: 0 });
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.externalIds).toEqual(row.externalIds);
  });

  test('one catalog id past its 128 characters still skips the candidate', async () => {
    const t = harness();
    const id = await body(t, 'way/1');
    const out = await load(t, id, [...ways(0, 3), `osm:way/${'9'.repeat(121)}`]);
    expect(out).toMatchObject({ created: 0, tooLong: 1, idsTrimmed: 0 });
  });
});

describe('a merge folding one waterway into its twin', () => {
  async function merged(loserIds: string[], survivorIds: string[]) {
    const t = harness();
    const subject = 'fold-admin';
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: 'Robin',
        username: 'robin',
        dateOfBirth: Date.UTC(1990, 0, 1),
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyAnswered: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
        },
        reputationPoints: 0,
        role: 'admin',
        status: 'active',
        createdAt: NOW,
      }),
    );
    const loser = await body(t, 'way/1');
    const survivor = await body(t, 'way/2', -71.999);
    await landmarkRow(t, loser, loserIds);
    const twin = await landmarkRow(t, survivor, survivorIds);
    await t
      .withIdentity({ subject })
      .mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const kept = (await t.run((ctx) => ctx.db.get(twin)))?.externalIds ?? [];
    const audit = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).find(
      (r) => r.action === 'merge_waterbody',
    );
    return { kept, twin, metadata: audit?.metadata as Record<string, unknown> };
  }

  test('two big rows: every id kept under the total', async () => {
    const { kept, metadata } = await merged(ways(0, 120), ways(1_000, 142));
    expect(kept).toHaveLength(262);
    expect(metadata).toMatchObject({ repointed: { landmarkIdsTrimmed: 0 } });
    expect(metadata).not.toHaveProperty('landmarkIdsTrimmedOn');
  });

  test('over the total: the oldest dropped, counted and named in the merge’s row', async () => {
    const survivorIds = longIds(0, 100);
    const loserIds = longIds(1_000, 100);
    const { kept, twin, metadata } = await merged(loserIds, survivorIds);
    expect(total(kept)).toBeLessThanOrEqual(MAX_LANDMARK_EXTERNAL_ID_CHARS);
    const union = [...survivorIds, ...loserIds];
    expect(kept).toEqual(union.slice(union.length - kept.length));
    expect(metadata).toMatchObject({
      repointed: { landmarkIdsTrimmed: 1 },
      landmarkIdsTrimmedOn: [twin],
    });
  });
});
