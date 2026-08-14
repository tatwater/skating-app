/**
 * The access join (N6d B3 / D72, D143).
 *
 * The load-bearing properties here are the two an ETL gets wrong quietly: a re-run must never undo an
 * operator's work (the source ladder, and a moderator's `hide`), and a launch must never attach to the
 * wrong lake. The second is the only failure mode of a geometric join that produces a *wrong* answer
 * rather than no answer, which is why `PUTIN_SHORE_RADIUS_M` is tight where the parking radius is not.
 */

import {
  chooseAccessTarget,
  PARKING_INFER_RADIUS_M,
  PUTIN_SHORE_RADIUS_M,
  RICHNESS_PUT_IN_DERIVED,
  RICHNESS_PUT_IN_OFFICIAL,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { MAX_ACCESS_ROWS_PER_BODY } from './lib/accessLimits';
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

  /**
   * ⚠ The water-relevance gate, and the number that forced it. The first real transform found **4,656
   * parking lots in Vermont, 202 of them paired with a launch** — the rest supermarkets, schools and
   * fire departments. Without this, every downtown lot in every lakeside town becomes a directions
   * target.
   */
  test('an unpaired lot with no water near it is refused, not stored', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(PARKING_INFER_RADIUS_M + 200), paired: false }],
    });
    expect(result.created).toBe(0);
    expect(result.notNearWater).toBe(1);
    expect(await t.run((ctx) => ctx.db.query('parkingAreas').collect())).toHaveLength(0);
  });

  /**
   * The other side of the same gate: pairing is a human-mapped relationship between a lot and a
   * launch, and it outranks any proximity guess. This is the mile-in trailhead the phase exists for.
   */
  test('a paired lot is stored however far from the water it sits', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(PARKING_INFER_RADIUS_M + 5_000), paired: true }],
    });
    expect(result.created).toBe(1);
    expect(result.withoutBody).toBe(1);
    expect(result.linksCreated).toBe(0);
    expect(result.notNearWater).toBe(0);
  });

  test('an unpaired lot beside the water is still stored — the gate is water, not pairing', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);

    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(80), paired: false }],
    });
    expect(result.created).toBe(1);
    expect(result.linksCreated).toBe(1);
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
      lots: [{ ...LOT, point: northOfShore(PARKING_INFER_RADIUS_M + 900), paired: true }],
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

describe('access-point photos (Workstream D / D88)', () => {
  async function seedUploader(t: ReturnType<typeof convexTest>, subject: string, role: 'member' | 'moderator' = 'member') {
    const id = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: subject,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyFulfilled: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: Date.now(),
      }),
    );
    return { id, as: t.withIdentity({ subject }) };
  }

  /**
   * Real stored blobs, not string placeholders. `deletePhotoAndBlobs` deliberately keeps a row whose
   * blob it could not prove gone — the row is the only pointer to those bytes — so a fake storage id
   * makes every photo look undeletable and quietly turns a sweep test into a no-op.
   */
  async function seedPhoto(t: ReturnType<typeof convexTest>, uploaderId: Id<'profiles'>, createdAt = Date.now()) {
    return t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([`photo-${createdAt}-${Math.random()}`]));
      const thumbStorageId = await ctx.storage.store(new Blob([`thumb-${createdAt}-${Math.random()}`]));
      return ctx.db.insert('photos', {
        storageId,
        thumbStorageId,
        uploaderId,
        placeOnMap: false,
        createdAt,
      });
    }) as Promise<Id<'photos'>>;
  }

  async function seedVisiblePutIn(t: ReturnType<typeof convexTest>) {
    const waterBodyId = await seedSquareBody(t);
    const putInId = (await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 44.01, lng: -72 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'putIns'>;
    return { waterBodyId, putInId };
  }

  test('attaches a photo and serves it back', async () => {
    const t = convexTest(schema, modules);
    const { putInId } = await seedVisiblePutIn(t);
    const user = await seedUploader(t, 'skater');
    const photoId = await seedPhoto(t, user.id);

    await user.as.mutation(api.accessPoints.attachPhoto, {
      targetType: 'put_in',
      putInId,
      photoId,
    });

    const photos = await t.query(api.accessPoints.listPhotos, { targetType: 'put_in', putInId });
    expect(photos).toHaveLength(1);
    expect(photos[0]?.photoId).toBe(photoId);
  });

  test('caps an access point at three photos', async () => {
    const t = convexTest(schema, modules);
    const { putInId } = await seedVisiblePutIn(t);
    const user = await seedUploader(t, 'skater');

    for (let i = 0; i < 3; i++) {
      const photoId = await seedPhoto(t, user.id, Date.now() - i);
      await user.as.mutation(api.accessPoints.attachPhoto, { targetType: 'put_in', putInId, photoId });
    }
    const overflow = await seedPhoto(t, user.id, Date.now() - 99);
    await expect(
      user.as.mutation(api.accessPoints.attachPhoto, { targetType: 'put_in', putInId, photoId: overflow }),
    ).rejects.toThrow(/at most 3 photos/);
  });

  /** The invariant `photoOrphans`' scan-by-author rests on. */
  test("you cannot attach someone else's photo", async () => {
    const t = convexTest(schema, modules);
    const { putInId } = await seedVisiblePutIn(t);
    const owner = await seedUploader(t, 'owner');
    const other = await seedUploader(t, 'other');
    const photoId = await seedPhoto(t, owner.id);

    await expect(
      other.as.mutation(api.accessPoints.attachPhoto, { targetType: 'put_in', putInId, photoId }),
    ).rejects.toThrow(/not owned/);
  });

  test('re-attaching the same photo is idempotent rather than a second row', async () => {
    const t = convexTest(schema, modules);
    const { putInId } = await seedVisiblePutIn(t);
    const user = await seedUploader(t, 'skater');
    const photoId = await seedPhoto(t, user.id);

    await user.as.mutation(api.accessPoints.attachPhoto, { targetType: 'put_in', putInId, photoId });
    await user.as.mutation(api.accessPoints.attachPhoto, { targetType: 'put_in', putInId, photoId });
    expect(await t.run((ctx) => ctx.db.query('accessPhotos').collect())).toHaveLength(1);
  });

  test('the uploader or a moderator may detach; a stranger may not', async () => {
    const t = convexTest(schema, modules);
    const { putInId } = await seedVisiblePutIn(t);
    const user = await seedUploader(t, 'skater');
    const stranger = await seedUploader(t, 'stranger');
    const mod = await seedUploader(t, 'mod', 'moderator');
    const photoId = await seedPhoto(t, user.id);
    const accessPhotoId = (await user.as.mutation(api.accessPoints.attachPhoto, {
      targetType: 'put_in',
      putInId,
      photoId,
    })) as Id<'accessPhotos'>;

    await expect(
      stranger.as.mutation(api.accessPoints.detachPhoto, { accessPhotoId }),
    ).rejects.toThrow(/uploader or a moderator/);

    await mod.as.mutation(api.accessPoints.detachPhoto, { accessPhotoId, reason: 'Wrong lot' });
    expect(await t.run((ctx) => ctx.db.query('accessPhotos').collect())).toHaveLength(0);
    // Detaching is not deleting — the decision to destroy the image belongs to the orphan sweep alone.
    expect(await t.run((ctx) => ctx.db.get(photoId))).not.toBeNull();
  });

  /**
   * ⚠ The N6d kickoff's data-loss finding, pinned.
   *
   * `referencedPhotoIds` decides whether a photo may be destroyed by scanning the uploader's own
   * reports and hazards. An access photo hangs off a put-in the *ETL* created, so before `accessPhotos`
   * carried its own `uploaderId` this photo was an orphan by construction — swept thirty days later,
   * silently, by a cron.
   */
  test('an attached access photo is not an orphan', async () => {
    const t = convexTest(schema, modules);
    const { putInId } = await seedVisiblePutIn(t);
    const user = await seedUploader(t, 'skater');
    // Older than the 30-day grace, so the sweep would genuinely consider it.
    const photoId = await seedPhoto(t, user.id, Date.now() - 60 * 24 * 60 * 60 * 1000);
    await user.as.mutation(api.accessPoints.attachPhoto, { targetType: 'put_in', putInId, photoId });

    await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});

    expect(await t.run((ctx) => ctx.db.get(photoId))).not.toBeNull();
  });

  test('an unattached photo past the grace window still is', async () => {
    const t = convexTest(schema, modules);
    const user = await seedUploader(t, 'skater');
    const photoId = await seedPhoto(t, user.id, Date.now() - 60 * 24 * 60 * 60 * 1000);

    await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});

    expect(await t.run((ctx) => ctx.db.get(photoId))).toBeNull();
  });
});

describe('D2 richness — the term this phase unblocks (D143)', () => {
  /**
   * `backfillCells` has been held since 2026-08-02 waiting for this phase, because D2's put-in terms
   * are the strongest static signals in the richness model and nothing had ever written a put-in row.
   * These are that rung assignment, pinned.
   *
   * Measured as the gap between two otherwise-identical bodies rather than as a before/after on one,
   * because `importCanonical` resets `displayScore` to area + boost — so a before/after also picks up
   * every *other* richness term the backfill adds (the name, most obviously).
   */
  async function scoreWithPutIn(source: 'osm' | 'official' | null) {
    const t = convexTest(schema, modules);
    const withPutIn = await seedSquareBody(t, { name: 'With Access' });
    const without = await seedSquareBody(t, { name: 'With Access Bare', lat: 45 });
    if (source) {
      await t.run((ctx) =>
        ctx.db.insert('putIns', {
          waterBodyId: withPutIn,
          coord: { lat: 44.01, lng: -72 },
          source,
          status: 'visible' as const,
          createdAt: Date.now(),
        }),
      );
    }
    await t.mutation(internal.waterBodies.backfillCells, {});
    const a = (await t.run((ctx) => ctx.db.get(withPutIn)))?.displayScore ?? 0;
    const b = (await t.run((ctx) => ctx.db.get(without)))?.displayScore ?? 0;
    return a - b;
  }

  test('an OSM put-in scores as derived, never as official', async () => {
    const gap = await scoreWithPutIn('osm');
    expect(gap).toBeCloseTo(RICHNESS_PUT_IN_DERIVED, 6);
    expect(gap).not.toBeCloseTo(RICHNESS_PUT_IN_OFFICIAL, 6);
  });

  test('an operator promoting it to official moves the body further up the ladder', async () => {
    const gap = await scoreWithPutIn('official');
    expect(gap).toBeCloseTo(RICHNESS_PUT_IN_OFFICIAL, 6);
    expect(gap).toBeGreaterThan(RICHNESS_PUT_IN_DERIVED);
  });

  test('no put-in, no term — the two bodies score identically', async () => {
    expect(await scoreWithPutIn(null)).toBeCloseTo(0, 6);
  });
});

describe('the operator write path (D72 amendment / D144)', () => {
  async function seedModerator(t: ReturnType<typeof convexTest>) {
    const subject = 'mod';
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: subject,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyFulfilled: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'moderator' as const,
        status: 'active' as const,
        createdAt: Date.now(),
      }),
    );
    return t.withIdentity({ subject });
  }

  /**
   * The amendment, as a test. The ~250 m radius bounds what the ETL will *guess*; a human's assertion
   * has no distance limit, and a mile-away trailhead is the case this phase exists for.
   */
  test('an operator may associate a lot with a body at any distance whatsoever', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const mod = await seedModerator(t);

    const parkingAreaId = await mod.mutation(api.accessPoints.setOfficialParking, {
      coord: northOfShore(5_000), // three miles from the ice
      name: 'Trailhead Lot',
      amenities: ['trail'],
      waterBodyIds: [body],
    });

    const links = await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect());
    expect(links).toHaveLength(1);
    expect(links[0]?.inferred).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(parkingAreaId)))?.source).toBe('official');
  });

  test('a member cannot write the operator rung', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    await expect(
      t.mutation(api.accessPoints.setOfficialParking, {
        coord: northOfShore(50),
        amenities: [],
        waterBodyIds: [body],
      }),
    ).rejects.toThrow();
  });

  /**
   * D144's gate, enforced server-side as well as in the form — a rule only the UI knows is a rule the
   * next UI forgets. It **refuses** rather than defaulting, because stamping `hike_in` silently would
   * be the system making the assertion on the author's behalf.
   */
  test('a mile-long approach is refused unless hike-in is asserted explicitly', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const mod = await seedModerator(t);
    const putInId = (await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: northOfShore(5),
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'putIns'>;
    const parkingAreaId = await mod.mutation(api.accessPoints.setOfficialParking, {
      coord: northOfShore(3_000),
      amenities: [],
      waterBodyIds: [body],
    });

    await expect(
      mod.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId }),
    ).rejects.toThrow(/asserted as hike-in/);

    await mod.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      parkingAreaId,
      approachKindOverride: 'hike_in',
    });
    const row = await t.run((ctx) => ctx.db.get(putInId));
    expect(row?.approachKindOverride).toBe('hike_in');
    // Straight-line and flagged as such: this is a request path, and D87 says never route from one.
    expect(row?.approachRouted).toBe(false);
    expect(row?.approachMeters).toBeGreaterThan(2_000);
  });

  test('a short association needs no assertion', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const mod = await seedModerator(t);
    const putInId = (await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: northOfShore(5),
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'putIns'>;
    const parkingAreaId = await mod.mutation(api.accessPoints.setOfficialParking, {
      coord: northOfShore(120),
      amenities: [],
      waterBodyIds: [body],
    });

    await mod.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.parkingAreaId).toBe(parkingAreaId);
  });

  /** A distance with nothing to walk from is worse than no distance. */
  test('clearing the parking clears the approach it measured', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const mod = await seedModerator(t);
    const putInId = (await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: northOfShore(5),
        source: 'osm' as const,
        status: 'visible' as const,
        approachMeters: 400,
        approachRouted: true,
        createdAt: Date.now(),
      }),
    )) as Id<'putIns'>;

    await mod.mutation(api.accessPoints.setPutInAccess, { putInId, clearParking: true });
    const row = await t.run((ctx) => ctx.db.get(putInId));
    expect(row?.parkingAreaId).toBeUndefined();
    expect(row?.approachMeters).toBeUndefined();
    expect(row?.approachRouted).toBeUndefined();
  });

  /** Hand edits and the ETL must not fight: an inference nobody thought about is left alone. */
  test('an operator edit does not delete OSM inferences it simply did not mention', async () => {
    const t = convexTest(schema, modules);
    const a = await seedSquareBody(t, { name: 'Pond A' });
    const b = await seedSquareBody(t, { name: 'Pond B', lat: 45 });
    const mod = await seedModerator(t);

    const parkingAreaId = await mod.mutation(api.accessPoints.setOfficialParking, {
      coord: northOfShore(50),
      amenities: [],
      waterBodyIds: [a],
    });
    await t.run((ctx) =>
      ctx.db.insert('parkingAreaBodies', {
        parkingAreaId,
        waterBodyId: b,
        inferred: true,
        createdAt: Date.now(),
      }),
    );

    await mod.mutation(api.accessPoints.setOfficialParking, {
      parkingAreaId,
      coord: northOfShore(60),
      amenities: [],
      waterBodyIds: [a],
    });

    const links = await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect());
    expect(links).toHaveLength(2);
  });
});

describe('per-body read caps (the listInViewport lesson)', () => {
  /**
   * `loadParkingForBody` runs on **every drawer open** and costs one `get` per link, so an uncapped
   * read is fine on today's corpus and a drawer that won't load once the ETL has run everywhere. A
   * 200-lot slice of Vermont — our sparsest state — already put 9 lots on one body.
   */
  test('a body with more lots than the cap still returns, bounded', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_ACCESS_ROWS_PER_BODY + 20; i++) {
        const parkingAreaId = await ctx.db.insert('parkingAreas', {
          coord: { lat: 44.011 + i * 1e-5, lng: -72 },
          source: 'osm' as const,
          status: 'visible' as const,
          amenities: [],
          externalId: `way/bulk-${i}`,
          createdAt: Date.now(),
        });
        await ctx.db.insert('parkingAreaBodies', {
          parkingAreaId,
          waterBodyId: body,
          inferred: true,
          createdAt: Date.now(),
        });
      }
    });

    const lots = await t.query(api.accessPoints.listParkingForBody, { waterBodyId: body });
    expect(lots.length).toBe(MAX_ACCESS_ROWS_PER_BODY);

    // And the composite read a drawer actually makes stays bounded too.
    const access = await t.query(api.accessPoints.accessForBody, { waterBodyId: body });
    expect(access.parking.length).toBe(MAX_ACCESS_ROWS_PER_BODY);
  });

  /** Total shape: a caller reading `alerts` shouldn't have to know it is sometimes absent. */
  test('accessForBody returns every key even for an unknown body', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    await t.run((ctx) => ctx.db.delete(body));
    const access = await t.query(api.accessPoints.accessForBody, { waterBodyId: body });
    expect(access).toEqual({ putIns: [], parking: [], blockedIds: [], alerts: [] });
  });
});

describe('the lot a chosen put-in points at is always resolvable', () => {
  /**
   * ⚠ Found by the first full load, not by reasoning. It put **160 lots on Lake Champlain**, 97 on
   * Winnipesaukee and 64 on Seneca — all legitimate for lakes that size. `loadParkingForBody` reads a
   * capped window in *index* order, so on those bodies the lot a put-in references can sit outside it,
   * and `chooseAccessTarget` would fall back to routing a car at the launch: precisely the pre-N6d
   * behaviour this phase exists to fix, on the four lakes that matter most.
   */
  test('a referenced lot is returned even when it sits past the read cap', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);

    // Fill the window with unrelated lots first, so the referenced one lands beyond it.
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_ACCESS_ROWS_PER_BODY + 10; i++) {
        const id = await ctx.db.insert('parkingAreas', {
          coord: { lat: 44.011 + i * 1e-5, lng: -72 },
          name: `filler-${i}`,
          source: 'osm' as const,
          status: 'visible' as const,
          amenities: [],
          externalId: `way/filler-${i}`,
          createdAt: Date.now(),
        });
        await ctx.db.insert('parkingAreaBodies', {
          parkingAreaId: id,
          waterBodyId: body,
          inferred: true,
          createdAt: Date.now(),
        });
      }
    });

    const theLot = await t.run(async (ctx) => {
      const id = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44.0125, lng: -72 },
        name: 'The Actual Lot',
        source: 'official' as const,
        status: 'visible' as const,
        amenities: [],
        externalId: 'way/the-lot',
        createdAt: Date.now(),
      });
      await ctx.db.insert('parkingAreaBodies', {
        parkingAreaId: id,
        waterBodyId: body,
        inferred: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.0101, lng: -72 },
        name: 'Town Landing',
        source: 'osm' as const,
        status: 'visible' as const,
        parkingAreaId: id,
        approachMeters: 300,
        approachRouted: true,
        createdAt: Date.now(),
      });
      return id;
    });

    const access = await t.query(api.accessPoints.accessForBody, { waterBodyId: body });
    expect(access.parking.some((p) => p.id === theLot)).toBe(true);

    // And the whole point: the target routes to the lot, not the launch.
    const target = chooseAccessTarget(access.putIns, access.parking, new Set(access.blockedIds));
    expect(target?.via).toBe('parking');
    expect(target?.parking?.name).toBe('The Actual Lot');
  });
});

describe('the candidate box is sized to the radius (the 105 GB lesson)', () => {
  /**
   * ⚠ N6d's parking pass ran 95,294 lookups on `listedBodiesNearCoord`'s default ~1,113 m net and
   * spent **104.95 GB of database I/O — 1.1 MB per lot** — enough to disable the deployment. Convex
   * has no projection, so reading a candidate reads its whole document, `polygon` included, and
   * Champlain's ~300 KB outline was re-read for every lot within a kilometre of it.
   *
   * Tightening the box is safe because `bodiesCoveringBox` matches on **bbox**, and a polygon within
   * *r* of a point always has a bbox within *r* of it. These two tests pin both halves: nothing that
   * should match is lost, and something outside the radius is not dragged in.
   */
  test('a lot inside the radius still matches with the tightened box', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, point: northOfShore(PARKING_INFER_RADIUS_M - 20), paired: false }],
    });
    expect(result.created).toBe(1);
    expect(result.linksCreated).toBe(1);
    expect(body).toBeDefined();
  });

  test('a launch just inside the shore radius still matches, though the box is now 30 m', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t);
    const result = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [{ externalId: 'node/tight', point: northOfShore(PUTIN_SHORE_RADIUS_M - 5) }],
    });
    expect(result.created).toBe(1);
    expect(result.noBodyNearby).toBe(0);
    const row = (await t.run((ctx) => ctx.db.query('putIns').collect()))[0];
    expect(row?.waterBodyId).toBe(body);
  });

  /** Longitude degrees shrink with latitude; a metres→degrees conversion that forgets cos(lat) at
   *  44°N would under-reach by ~28% in longitude and silently miss bodies to the east and west. */
  test('a lot due EAST of the shore still matches, so the longitude conversion is right', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t);
    const eastOfShore = { lat: 44, lng: -72 + 0.01 + (PARKING_INFER_RADIUS_M - 30) / (111_320 * Math.cos((44 * Math.PI) / 180)) };
    const result = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [{ ...LOT, externalId: 'way/east', point: eastOfShore, paired: false }],
    });
    expect(result.created).toBe(1);
    expect(result.linksCreated).toBe(1);
  });
});
