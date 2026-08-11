/**
 * The access join (N6d B3 / D72, D143).
 *
 * The load-bearing properties here are the two an ETL gets wrong quietly: a re-run must never undo an
 * operator's work (the source ladder, and a moderator's `hide`), and a launch must never attach to the
 * wrong lake. The second is the only failure mode of a geometric join that produces a *wrong* answer
 * rather than no answer, which is why `PUTIN_SHORE_RADIUS_M` is tight where the parking radius is not.
 */

import { PARKING_INFER_RADIUS_M, PUTIN_SHORE_RADIUS_M } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** Degrees of latitude per metre — good enough to place a point a known distance from a shoreline. */
const DEG_PER_M = 1 / 111_320;

/**
 * A square body centred on (44, −72). Inserted and then run through `importCanonical`, because the
 * N1 cell rows that import builds are what `listedBodiesNearCoord` reads — a hand-inserted body is
 * unreachable from any spatial lookup, which is the same property that keeps an unlisted body
 * invisible.
 */
async function seedSquareBody(
  t: ReturnType<typeof convexTest>,
  {
    half = 0.01,
    name = 'Test Lake',
    lat = 44,
    lng = -72,
    areaSqM = 1e6,
  }: { half?: number; name?: string; lat?: number; lng?: number; areaSqM?: number } = {},
): Promise<Id<'waterBodies'>> {
  const externalId = `way/${name.replace(/\s+/g, '-')}`;
  const polygon = {
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
  };
  const bbox = { minLat: lat - half, minLng: lng - half, maxLat: lat + half, maxLng: lng + half };
  const body = {
    name,
    type: 'lakePond' as const,
    source: 'osm' as const,
    externalId,
    osmId: externalId,
    polygon,
    bbox,
    centroid: { lat, lng },
    surfaceAreaSqM: areaSqM,
  };
  const id = (await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      ...body,
      searchText: name,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  )) as Id<'waterBodies'>;
  await t.mutation(internal.waterBodies.importCanonical, { bodies: [body] });
  return id;
}

/** A point `metres` north of the body's northern shore (which sits at `lat + half`). */
function northOfShore(metres: number, { half = 0.01, lat = 44, lng = -72 } = {}) {
  return { lat: lat + half + metres * DEG_PER_M, lng };
}

const LOT = {
  externalId: 'way/lot-1',
  point: { lat: 44.0105, lng: -72 },
  name: 'Town Landing Lot',
  amenities: ['boat_ramp' as const],
};

describe('accessPoints.matchAndImportParking', () => {
  test('attaches a lot to the body it sits beside, and stores it', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(50), capacity: 12, fee: false }],
    });

    expect(result.created).toBe(1);
    expect(result.linksCreated).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query('parkingAreas').collect());
    expect(rows[0]?.source).toBe('osm');
    expect(rows[0]?.capacity).toBe(12);
    const links = await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect());
    expect(links[0]?.waterBodyId).toBe(body);
    expect(links[0]?.inferred).toBe(true);
  });

  /** D72's amendment made this the normal case, not an edge one: a trailhead serving three ponds. */
  test('one lot attaches to every body inside the inference radius', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t, { name: 'Pond A', lat: 44, lng: -72, half: 0.005 });
    await seedSquareBody(t, { name: 'Pond B', lat: 44.004, lng: -72, half: 0.005 });

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: { lat: 44.002, lng: -72 } }],
    });
    expect(result.linksCreated).toBe(2);
  });

  test('a lot beyond the inference radius attaches to nothing but is still stored', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(PARKING_INFER_RADIUS_M + 200) }],
    });
    // Stored, because it may be a mile from the ice and paired to a launch that is on it — the case
    // the whole phase exists for. Dropping it here would be the phase deleting its own subject.
    expect(result.created).toBe(1);
    expect(result.withoutBody).toBe(1);
    expect(result.linksCreated).toBe(0);
  });

  test('a re-run updates in place rather than duplicating', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);
    const lots = [{ ...LOT, point: northOfShore(50) }];

    await t.mutation(internal.accessPoints.matchAndImportParking, { lots });
    const second = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(50), name: 'Renamed Lot', amenities: ['toilets' as const] }],
    });

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query('parkingAreas').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Renamed Lot');
    expect(rows[0]?.amenities).toEqual(['toilets']);
    // One association, not two — the join row is upserted on (lot, body).
    expect(await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect())).toHaveLength(1);
  });

  /**
   * The ladder. A correction a re-import can erase is not worth making — the same argument the N6a
   * depth ladder rests on.
   */
  test("an operator's lot keeps its fields, and still gets its associations refreshed", async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const parkingAreaId = await t.run((ctx) =>
      ctx.db.insert('parkingAreas', {
        coord: northOfShore(40),
        name: 'The Real Name',
        source: 'official' as const,
        status: 'visible' as const,
        amenities: ['toilets' as const],
        externalId: LOT.externalId,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(50), name: 'OSM Name', amenities: [] }],
    });

    expect(result.operatorHeld).toBe(1);
    expect(result.updated).toBe(0);
    const row = await t.run((ctx) => ctx.db.get(parkingAreaId));
    expect(row?.name).toBe('The Real Name');
    expect(row?.amenities).toEqual(['toilets']);
    // Which lakes a lot serves is a fact about geography an operator never asserted by promoting it.
    const links = await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect());
    expect(links[0]?.waterBodyId).toBe(body);
    expect(result.notes[0]?.reason).toContain('an operator owns this lot');
  });

  /** Inference may be promoted to assertion, never the reverse (D72 amendment). */
  test('a human-asserted association survives a re-run that would have inferred it', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(50) }],
    });
    const link = (await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect()))[0];
    await t.run((ctx) => ctx.db.patch(link!._id, { inferred: false }));

    await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(50) }],
    });

    const after = await t.run((ctx) => ctx.db.get(link!._id));
    expect(after?.inferred).toBe(false);
    expect(after?.waterBodyId).toBe(body);
  });
});

describe('accessPoints.matchAndImportPutIns', () => {
  const LAUNCH = { externalId: 'node/launch-1', name: 'Town Beach' };

  test('attaches a launch on the shore, with its routed approach', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [
        {
          ...LAUNCH,
          point: northOfShore(10),
          approachMeters: 420,
          approachAscentM: 18,
          approachRouted: true,
        },
      ],
    });

    expect(result.created).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query('putIns').collect());
    expect(rows[0]?.waterBodyId).toBe(body);
    expect(rows[0]?.source).toBe('osm');
    expect(rows[0]?.approachMeters).toBe(420);
    expect(rows[0]?.approachRouted).toBe(true);
  });

  /**
   * The tight radius is what stops a launch claiming the lake across the road. A slipway is *on* the
   * water by definition, so the only slack it needs is the shoreline disagreement between OSM and us.
   */
  test('a candidate beyond the shore radius attaches to nothing, and is counted as out of scope', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ ...LAUNCH, point: northOfShore(PUTIN_SHORE_RADIUS_M + 40) }],
    });

    expect(result.created).toBe(0);
    // `noBodyNearby`, not `unmatched`: coastal slipways and river landings are a scope boundary, not
    // a fault, and folding them into a failure counter would make the rate unreadable.
    expect(result.noBodyNearby).toBe(1);
  });

  test('picks the nearest body when two are in range', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t, { name: 'Far Pond', lat: 44, lng: -72, half: 0.01 });
    const near = await seedSquareBody(t, { name: 'Near Pond', lat: 44.0104, lng: -72, half: 0.0002 });

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ ...LAUNCH, point: { lat: 44.01055, lng: -72 } }],
    });

    expect(result.created).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query('putIns').collect());
    expect(rows[0]?.waterBodyId).toBe(near);
  });

  test('links the lot the transform paired it with', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);
    await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(80) }],
    });

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ ...LAUNCH, point: northOfShore(10), parkingExternalId: LOT.externalId }],
    });

    expect(result.parkingLinked).toBe(1);
    const putIn = (await t.run((ctx) => ctx.db.query('putIns').collect()))[0];
    expect(putIn?.parkingAreaId).toBeDefined();
  });

  /**
   * The sequencing error, named as one. Running the stages backwards must read as "you ran these out
   * of order", not as a data problem.
   */
  test('an unloaded lot is reported by name rather than silently dropped', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ ...LAUNCH, point: northOfShore(10), parkingExternalId: 'way/never-loaded' }],
    });

    expect(result.parkingMissing).toBe(1);
    expect(result.notes[0]?.reason).toContain('run the parking stage first');
    // The launch itself still lands — losing the lot must not lose the access point.
    expect(result.created).toBe(1);
  });

  /**
   * A mile-in trailhead: the lot is nowhere near any shoreline, and the launch is on one. The pairing
   * established the relationship locally, so the association follows the launch's body.
   */
  test('a far-flung lot inherits the body from the launch it serves', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(PARKING_INFER_RADIUS_M + 900) }],
    });
    expect(await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect())).toHaveLength(0);

    await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ ...LAUNCH, point: northOfShore(10), parkingExternalId: LOT.externalId }],
    });

    const links = await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect());
    expect(links).toHaveLength(1);
    expect(links[0]?.waterBodyId).toBe(body);
  });

  /** A `hide` is a statement about this launch; an import must not make it whack-a-mole. */
  test('a moderator-hidden coordinate is not resurrected by an import', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: northOfShore(10),
        source: 'derived' as const,
        status: 'hidden' as const,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ ...LAUNCH, point: northOfShore(20) }],
    });

    expect(result.created).toBe(0);
    expect(result.moderatorSuppressed).toBe(1);
    expect(result.notes[0]?.reason).toContain('a moderator hid this access point');
  });

  test("an operator's put-in keeps its coordinate and name; only the approach refreshes", async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const operatorCoord = northOfShore(5);
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: operatorCoord,
        name: 'The Real Landing',
        source: 'official' as const,
        status: 'visible' as const,
        externalId: LAUNCH.externalId,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [
        {
          ...LAUNCH,
          name: 'OSM Name',
          point: northOfShore(25),
          approachMeters: 900,
          approachRouted: true,
        },
      ],
    });

    expect(result.operatorHeld).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(putInId));
    expect(row?.name).toBe('The Real Landing');
    expect(row?.coord).toEqual(operatorCoord);
    // The approach is measured, not asserted — pinning a marker said "you can get on the ice here",
    // not "the walk is 40 m".
    expect(row?.approachMeters).toBe(900);
  });

  test('a re-run updates the same row rather than duplicating it', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);
    const putIns = [{ ...LAUNCH, point: northOfShore(10) }];

    await t.mutation(internal.accessPoints.matchAndImportPutIns, { putIns });
    const second = await t.mutation(internal.accessPoints.matchAndImportPutIns, { putIns });

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(await t.run((ctx) => ctx.db.query('putIns').collect())).toHaveLength(1);
  });
});

describe('accessPoints.listParkingForBody', () => {
  test('returns visible lots, operator-set first, and hides suppressed ones', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);

    const insertLot = async (
      externalId: string,
      source: 'osm' | 'official',
      status: 'visible' | 'hidden',
    ) => {
      const id = await t.run((ctx) =>
        ctx.db.insert('parkingAreas', {
          coord: northOfShore(50),
          name: externalId,
          source,
          status,
          amenities: [],
          externalId,
          createdAt: Date.now(),
        }),
      );
      await t.run((ctx) =>
        ctx.db.insert('parkingAreaBodies', {
          parkingAreaId: id,
          waterBodyId: body,
          inferred: true,
          createdAt: Date.now(),
        }),
      );
    };
    await insertLot('osm-lot', 'osm', 'visible');
    await insertLot('official-lot', 'official', 'visible');
    await insertLot('hidden-lot', 'osm', 'hidden');

    const lots = await t.query(api.accessPoints.listParkingForBody, { waterBodyId: body });
    expect(lots.map((l) => l.name)).toEqual(['official-lot', 'osm-lot']);
  });
});
