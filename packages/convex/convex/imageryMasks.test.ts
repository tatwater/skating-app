/**
 * The corpus read behind the imagery reveal mask (N6e PR 2a, D148).
 *
 * The load-bearing properties here are the ones that fail *quietly*. This query runs once a season
 * and its output is a binary artifact nobody reads by eye, so a body wrongly omitted does not raise an
 * error — it just never appears under a photograph, months later, on somebody's lake. The three tests
 * that matter are therefore about what gets left out: the corpus floor, a moderator's suppression,
 * and a routed path that is not one.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** A square body. `areaSqM` is what decides whether it clears the corpus floor. */
async function seedBody(
  t: ReturnType<typeof convexTest>,
  { name = 'Test Lake', lat = 44, lng = -72, half = 0.01, areaSqM = 1e6 } = {},
): Promise<Id<'waterBodies'>> {
  return (await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      externalId: `way/${name.replace(/\s+/g, '-')}`,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [lng - half, lat - half],
            [lng + half, lat - half],
            [lng + half, lat + half],
            [lng - half, lat + half],
            [lng - half, lat - half],
          ],
        ],
      },
      bbox: { minLat: lat - half, minLng: lng - half, maxLat: lat + half, maxLng: lng + half },
      centroid: { lat, lng },
      surfaceAreaSqM: areaSqM,
      searchText: name,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  )) as Id<'waterBodies'>;
}

async function seedPutIn(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  extra: Record<string, unknown> = {},
) {
  await t.run((ctx) =>
    ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 44.02, lng: -72 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  );
}

const run = (t: ReturnType<typeof convexTest>) =>
  t.query(internal.imageryMasks.listForImageryMask, { batchSize: 50 });

describe('listForImageryMask', () => {
  test('returns a corpus body with its polygon', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, { name: 'Lake Iroquois' });

    const { masks, belowFloor } = await run(t);
    expect(masks).toHaveLength(1);
    expect(masks[0]?.name).toBe('Lake Iroquois');
    expect(masks[0]?.polygon.type).toBe('Polygon');
    expect(belowFloor).toBe(0);
  });

  test('counts a below-floor body rather than silently walking past it', async () => {
    const t = convexTest(schema, modules);
    // Unnamed and far under the 5-acre floor — `belongsInCorpus` refuses it, exactly as the import
    // would. Counting it is what keeps "scanned 25,197, masked 18,400" from reading as a failure.
    await seedBody(t, { name: '', areaSqM: 100 });

    const { masks, belowFloor, scanned } = await run(t);
    expect(masks).toHaveLength(0);
    expect(belowFloor).toBe(1);
    expect(scanned).toBe(1);
  });

  test('excludes a hidden put-in, so a suppressed coordinate cannot pull the reveal out to it', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t);
    await seedPutIn(t, bodyId, { status: 'hidden' as const, coord: { lat: 44.5, lng: -72.5 } });

    const { masks } = await run(t);
    // A moderator hid that coordinate. Buffering it would reveal ground we have decided not to show —
    // and worse, it would do so on a lake whose own shape looks perfectly correct.
    expect(masks[0]?.markerCoords).toHaveLength(0);
  });

  test('⚠ a hidden coord suppresses its neighbours here too, not just itself', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t);
    // A hide kills every marker within `HIDE_SUPPRESS_METERS`, which is how a moderator kills a bad
    // access point that OSM and a report cluster both keep re-deriving. Filtering on `status` alone
    // would let the visible twin a few metres away buffer the exact ground the hide was protecting —
    // the map suppression, defeated on the one surface nobody looks at.
    await seedPutIn(t, bodyId, { status: 'hidden' as const, coord: { lat: 44.02, lng: -72 } });
    await seedPutIn(t, bodyId, { coord: { lat: 44.02001, lng: -72.00001 } });

    const { masks } = await run(t);
    expect(masks[0]?.markerCoords).toHaveLength(0);
  });

  test('⚠ a delisted body gets no mask, because a takedown must reach the photograph too', async () => {
    const t = convexTest(schema, modules);
    // `removedAt` is an admin soft-delisting — curation, or a landowner takedown (D48). The reveal
    // mask is the shape a satellite frame shows through, so baking one publishes an aerial photo of
    // exactly the ground somebody asked us to stop showing. This is the one filter here that fails
    // *open*, which is why it runs before the corpus floor.
    const bodyId = await seedBody(t, { name: 'Taken Down Pond' });
    await t.run((ctx) => ctx.db.patch(bodyId, { removedAt: Date.now() }));

    const { masks, unlisted, belowFloor } = await run(t);
    expect(masks).toHaveLength(0);
    expect(unlisted).toBe(1);
    // Counted apart from the floor: one is a body the import would never have taken, the other is a
    // body somebody took off the map.
    expect(belowFloor).toBe(0);
  });

  test('a merged duplicate and a rejected body are unlisted too', async () => {
    const t = convexTest(schema, modules);
    const merged = await seedBody(t, { name: 'Loser Of A Dedup' });
    await t.run((ctx) => ctx.db.patch(merged, { dedupStatus: 'merged' as const }));
    const rejected = await seedBody(t, { name: 'Rejected Draw', lng: -72.4 });
    await t.run((ctx) => ctx.db.patch(rejected, { reviewStatus: 'rejected' as const }));

    const { masks, unlisted } = await run(t);
    expect(masks).toHaveLength(0);
    expect(unlisted).toBe(2);
  });

  test('keeps a visible put-in as a marker coordinate', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t);
    await seedPutIn(t, bodyId);

    const { masks } = await run(t);
    expect(masks[0]?.markerCoords).toHaveLength(1);
  });

  test('drops a one-point approach path, which is a marker that lost its other end', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t);
    await seedPutIn(t, bodyId, { approachPath: [{ lat: 44.02, lng: -72 }] });

    const { masks } = await run(t);
    expect(masks[0]?.approachPaths).toHaveLength(0);
  });

  test('keeps a routed approach path of two or more points', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t);
    await seedPutIn(t, bodyId, {
      approachPath: [
        { lat: 44.02, lng: -72 },
        { lat: 44.03, lng: -72.01 },
      ],
    });

    const { masks } = await run(t);
    expect(masks[0]?.approachPaths).toHaveLength(1);
    expect(masks[0]?.approachPaths[0]).toHaveLength(2);
  });

  test('pages to completion, and a page of only below-floor bodies is not the end', async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) await seedBody(t, { name: `Lake ${i}`, lng: -72 - i * 0.1 });

    // Deliberately smaller than the corpus so the caller has to follow the cursor. `isDone` is the
    // authority the generator trusts — an empty page is legitimate when a batch is all below floor,
    // and stopping on that would truncate a bake mid-alphabet with nothing saying so.
    let cursor: string | undefined;
    const names: string[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const page = await t.query(internal.imageryMasks.listForImageryMask, {
        batchSize: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      names.push(...page.masks.map((m) => m.name ?? ''));
      if (page.isDone || !page.cursor) break;
      cursor = page.cursor;
    }
    expect(names).toHaveLength(5);
  });
});
