/**
 * **Placing has an undo, every one** (B01-6b, D300): a put-in placed by hand is removed by its undo,
 * a lot placed by hand is deleted with its lake links, a link puts back only which lot — and the walk
 * of a link is routed fresh, in the background, by ORS `foot-hiking`. Each acted through its real
 * mutation, undone through `api.undo.run`, the state read back; the engine's offer (`undoState`) is
 * read beside each refusal so History offers exactly what the write accepts.
 */

import { HIKE_IN_ASSERT_M } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { relinkRefusalOf } from './accessPoints';
import { undoState } from './lib/undo';
import { PLACEMENT_ALERTS_READ, PLACEMENT_ALERTS_UNCHECKED, placementRefusalOf } from './putIns';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NOTIF_PREFS = {
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
  moderatorDecision: false,
};

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' = 'moderator') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

async function seedBody(t: T) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      searchText: 'Shelburne Pond',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: SQUARE,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

/** The newest audit row on a target. */
async function newestOn(t: T, targetType: string, targetId: string) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}

/** What the engine offers for `row` to `viewer`, as the toast asks it. */
async function offer(t: T, viewer: Id<'profiles'>, row: Doc<'moderationActions'>) {
  return t.run(async (ctx) => {
    const me = await ctx.db.get(viewer);
    const fresh = await ctx.db.get(row._id);
    if (!me || !fresh) throw new Error('missing');
    return undoState(ctx, me, fresh, 'one');
  });
}

const scheduledNames = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).map((f) => f.name),
  );

// ── A put-in placed by hand ───────────────────────────────────────────────────────────────────────

describe('undo: a put-in placed by hand (D300)', () => {
  async function placed() {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const putInId = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId,
      coord: { lat: 0.5, lng: 0.0001 },
      name: 'Town Beach',
    });
    const row = await newestOn(t, 'waterbody', waterBodyId);
    return { t, waterBodyId, mod, putInId, row };
  }

  test('its undo removes it (asking why), and undoing that places it again, by its name', async () => {
    const { t, waterBodyId, mod, putInId, row } = await placed();
    expect(row.metadata).toMatchObject({ direction: 'placed', putInId, name: 'Town Beach' });
    expect(await offer(t, mod.id, row)).toEqual({ state: 'available', needsReason: true });
    await expect(mod.as.mutation(api.undo.run, { actionId: row._id })).rejects.toThrow(
      /needs a reason/,
    );

    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'misplaced' });
    expect(await t.run((ctx) => ctx.db.get(putInId))).toBeNull();
    const removal = await newestOn(t, 'waterbody', waterBodyId);
    expect(removal).toMatchObject({ action: 'set_put_in', undoesActionId: row._id });
    expect(removal.metadata).toMatchObject({ direction: 'unplaced', name: 'Town Beach' });
    expect(await t.query(api.putIns.listForBody, { waterBodyId })).toEqual([]);

    // Placing it again gives something back: no reason.
    expect(await offer(t, mod.id, removal)).toEqual({ state: 'available', needsReason: false });
    await mod.as.mutation(api.undo.run, { actionId: removal._id });
    const again = await t.run((ctx) =>
      ctx.db
        .query('putIns')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
        .collect(),
    );
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      source: 'official',
      name: 'Town Beach',
      coord: row.metadata?.coord,
    });
    const replaced = await newestOn(t, 'waterbody', waterBodyId);
    expect(replaced.metadata).toMatchObject({ direction: 'placed', putInId: again[0]?._id });

    // And that placement's own undo removes the new row.
    await mod.as.mutation(api.undo.run, { actionId: replaced._id, reason: 'still wrong' });
    expect(await t.run((ctx) => ctx.db.get(again[0]?._id as Id<'putIns'>))).toBeNull();
  });

  test('a placement from before its direction was recorded undoes the same way', async () => {
    const { t, mod, putInId, row } = await placed();
    await t.run(async (ctx) => {
      const { direction: _d, ...rest } = row.metadata as Record<string, unknown>;
      await ctx.db.patch(row._id, { metadata: rest });
    });
    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'misplaced' });
    expect(await t.run((ctx) => ctx.db.get(putInId))).toBeNull();
  });

  test('refused once a lot is linked to it, and offered again once it is unlinked', async () => {
    const { t, mod, putInId, row } = await placed();
    const lotId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.001 },
      amenities: [],
      waterBodyIds: [],
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: lotId });
    const why = 'A lot is linked to that put-in now. Unlink it first, then undo.';
    expect(await offer(t, mod.id, row)).toEqual({ state: 'unavailable', why });
    await expect(mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'r' })).rejects.toThrow(
      why,
    );
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, clearParking: true });
    expect((await offer(t, mod.id, row)).state).toBe('available');
  });

  test('refused once a skater attached a photo, filed an alert, or an import moved it', async () => {
    const photo = await placed();
    await photo.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['x']));
      const photoId = await ctx.db.insert('photos', {
        moderationStatus: 'visible' as const,
        storageId,
        thumbStorageId: storageId,
        uploaderId: photo.mod.id,
        placeOnMap: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert('accessPhotos', {
        targetType: 'put_in' as const,
        putInId: photo.putInId,
        photoId,
        uploaderId: photo.mod.id,
        createdAt: Date.now(),
      });
    });
    expect(await offer(photo.t, photo.mod.id, photo.row)).toMatchObject({
      why: 'Someone added a photo of that put-in. Hide it instead.',
    });

    const alert = await placed();
    await alert.t.run((ctx) =>
      ctx.db.insert('accessAlerts', {
        targetType: 'put_in' as const,
        putInId: alert.putInId,
        waterBodyId: alert.waterBodyId,
        reason: 'road_closed' as const,
        kind: 'blocker' as const,
        createdByUserId: alert.mod.id,
        createdAt: Date.now(),
        season: 2026,
        status: 'expired' as const,
        confirmCount: 0,
        denyCount: 0,
      }),
    );
    await expect(
      alert.mod.as.mutation(api.undo.run, { actionId: alert.row._id, reason: 'r' }),
    ).rejects.toThrow('Someone filed an access alert on that put-in. Hide it instead.');

    const moved = await placed();
    await moved.t.run((ctx) => ctx.db.patch(moved.putInId, { name: 'Ramp Road' }));
    expect(await offer(moved.t, moved.mod.id, moved.row)).toMatchObject({
      why: 'That put-in changed since it was placed, so undo can’t remove it now.',
    });
  });

  test('placing it again is refused once the outline moved away from the spot', async () => {
    const { t, waterBodyId, mod, row } = await placed();
    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'misplaced' });
    const removal = await newestOn(t, 'waterbody', waterBodyId);
    await t.run((ctx) =>
      ctx.db.patch(waterBodyId, {
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [0.5, 0],
              [0.5, 1],
              [1, 1],
              [1, 0],
              [0.5, 0],
            ],
          ],
        },
      }),
    );
    expect(await offer(t, mod.id, removal)).toMatchObject({
      state: 'unavailable',
      why: 'The lake’s outline moved away from that spot since, so undo can’t place it again.',
    });
  });

  test('the rule on its own: gone, a past-the-bound alert read, a live alert elsewhere', () => {
    const launch = {
      _id: 'p1' as Id<'putIns'>,
      source: 'official',
      status: 'visible',
      coord: { lat: 1, lng: 2 },
    } as Doc<'putIns'>;
    const recorded = { coord: { lat: 1, lng: 2 }, name: null };
    expect(placementRefusalOf(null, recorded, { photo: false, alerts: [] })).toBe(
      'That put-in is already gone.',
    );
    const many = Array.from({ length: PLACEMENT_ALERTS_READ + 1 }, () => ({}));
    expect(placementRefusalOf(launch, recorded, { photo: false, alerts: many })).toBe(
      PLACEMENT_ALERTS_UNCHECKED,
    );
    const other = [{ putInId: 'p2' as Id<'putIns'> }];
    expect(placementRefusalOf(launch, recorded, { photo: false, alerts: other })).toBeNull();
    expect(
      placementRefusalOf({ ...launch, approachKindOverride: 'hike_in' }, recorded, {
        photo: false,
        alerts: [],
      }),
    ).toMatch(/own approach or posted rule/);
  });
});

// ── A lot placed by hand ──────────────────────────────────────────────────────────────────────────

describe('undo: a lot placed by hand (D300)', () => {
  async function lotPlaced() {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const lotId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.001 },
      name: 'Town lot',
      amenities: ['toilets'],
      waterBodyIds: [waterBodyId],
    });
    const row = await newestOn(t, 'parkingArea', lotId);
    return { t, waterBodyId, mod, lotId, row };
  }

  const links = (t: T, lotId: Id<'parkingAreas'>) =>
    t.run(async (ctx) =>
      (await ctx.db.query('parkingAreaBodies').collect()).filter((l) => l.parkingAreaId === lotId),
    );

  test('its undo deletes it with its lake links (asking why); undoing that places it again', async () => {
    const { t, waterBodyId, mod, lotId, row } = await lotPlaced();
    expect(await offer(t, mod.id, row)).toEqual({ state: 'available', needsReason: true });
    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'wrong lot' });
    expect(await t.run((ctx) => ctx.db.get(lotId))).toBeNull();
    expect(await links(t, lotId)).toEqual([]);
    const removal = await newestOn(t, 'parkingArea', lotId);
    expect(removal.metadata).toMatchObject({ removed: true, waterBodyIds: [waterBodyId] });
    // The removal is in the lake's History: its row was linked before the lot's links went.
    const history = await mod.as.query(api.bodyConsole.history, { waterBodyId, limit: 10 });
    expect(history.entries.map((e) => e.id)).toContain(removal._id);

    expect(await offer(t, mod.id, removal)).toEqual({ state: 'available', needsReason: false });
    await mod.as.mutation(api.undo.run, { actionId: removal._id });
    const lots = await t.run((ctx) => ctx.db.query('parkingAreas').collect());
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ name: 'Town lot', amenities: ['toilets'], source: 'official' });
    expect(await links(t, lots[0]?._id as Id<'parkingAreas'>)).toHaveLength(1);
  });

  test('a lot put back by undoing its removal keeps its capacity and fee', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const lotId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.001 },
      name: 'Town lot',
      amenities: [],
      capacity: 12,
      fee: true,
      waterBodyIds: [waterBodyId],
    });
    const row = await newestOn(t, 'parkingArea', lotId);
    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'wrong lot' });
    const removal = await newestOn(t, 'parkingArea', lotId);
    expect(removal.metadata).toMatchObject({ capacity: 12, fee: true });
    await mod.as.mutation(api.undo.run, { actionId: removal._id });
    const lots = await t.run((ctx) => ctx.db.query('parkingAreas').collect());
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ name: 'Town lot', capacity: 12, fee: true });
  });

  test('a lot put back after its lake was merged away goes to the lake that survived', async () => {
    const { t, waterBodyId, mod, row } = await lotPlaced();
    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'wrong lot' });
    const removal = await newestOn(t, 'parkingArea', row.targetId as Id<'parkingAreas'>);
    const survivor = await seedBody(t);
    await t.run((ctx) => ctx.db.patch(waterBodyId, { mergedIntoId: survivor }));
    await mod.as.mutation(api.undo.run, { actionId: removal._id });
    const links = await t.run((ctx) => ctx.db.query('parkingAreaBodies').collect());
    expect(links.map((l) => l.waterBodyId)).toEqual([survivor]);
  });

  test('a lot placed serving no lake comes back serving none', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const lotId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.001 },
      name: 'Lonely lot',
      amenities: [],
      waterBodyIds: [],
    });
    const row = await newestOn(t, 'parkingArea', lotId);
    await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'wrong lot' });
    const removal = await newestOn(t, 'parkingArea', lotId);
    await mod.as.mutation(api.undo.run, { actionId: removal._id });
    const lots = await t.run((ctx) => ctx.db.query('parkingAreas').collect());
    expect(lots.map((l) => l.name)).toEqual(['Lonely lot']);
  });

  test('refused once a put-in links to it, or a skater filed an alert on it', async () => {
    const linked = await lotPlaced();
    const putInId = await linked.mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId: linked.waterBodyId,
      coord: { lat: 0.5, lng: 0 },
    });
    await linked.mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      parkingAreaId: linked.lotId,
    });
    const why = 'A put-in is linked to that lot now. Unlink it first, then undo.';
    expect(await offer(linked.t, linked.mod.id, linked.row)).toEqual({ state: 'unavailable', why });
    await expect(
      linked.mod.as.mutation(api.undo.run, { actionId: linked.row._id, reason: 'r' }),
    ).rejects.toThrow(why);

    const alerted = await lotPlaced();
    await alerted.t.run((ctx) =>
      ctx.db.insert('accessAlerts', {
        targetType: 'parking_area' as const,
        parkingAreaId: alerted.lotId,
        waterBodyId: alerted.waterBodyId,
        reason: 'road_closed' as const,
        kind: 'blocker' as const,
        createdByUserId: alerted.mod.id,
        createdAt: Date.now(),
        season: 2026,
        status: 'expired' as const,
        confirmCount: 0,
        denyCount: 0,
      }),
    );
    expect(await offer(alerted.t, alerted.mod.id, alerted.row)).toMatchObject({
      why: 'Someone filed an access alert on that lot, so undo can’t remove it.',
    });
  });

  test('an edit of an existing lot stays refused, saying so', async () => {
    const { t, waterBodyId, mod, lotId } = await lotPlaced();
    await mod.as.mutation(api.accessPoints.setOfficialParking, {
      parkingAreaId: lotId,
      coord: { lat: 0.5, lng: -0.002 },
      name: 'Town lot',
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    const edit = await newestOn(t, 'parkingArea', lotId);
    expect(await offer(t, mod.id, edit)).toEqual({
      state: 'unavailable',
      why: 'Undoing a lot’s edit isn’t built yet.',
    });
  });
});

// ── A link ────────────────────────────────────────────────────────────────────────────────────────

describe('undo: a lot linked to a put-in (D300)', () => {
  async function linkedTwice() {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const putInId = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId,
      coord: { lat: 0.5, lng: 0 },
    });
    const lot = (lng: number) =>
      mod.as.mutation(api.accessPoints.setOfficialParking, {
        coord: { lat: 0.5, lng },
        amenities: [],
        waterBodyIds: [waterBodyId],
      });
    const near = await lot(-0.001);
    const nearer = await lot(-0.0005);
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: near });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: nearer });
    const row = await newestOn(t, 'putIn', putInId);
    return { t, waterBodyId, mod, putInId, near, nearer, row };
  }

  test('restores only which lot, takes nothing away, re-walks it; undoing that links again', async () => {
    const { t, mod, putInId, near, nearer, row } = await linkedTwice();
    expect(row).toMatchObject({ action: 'set_parking_area' });
    expect(await offer(t, mod.id, row)).toEqual({ state: 'available', needsReason: false });
    await mod.as.mutation(api.undo.run, { actionId: row._id });
    const back = await t.run((ctx) => ctx.db.get(putInId));
    expect(back).toMatchObject({ parkingAreaId: near, approachRouted: false });
    expect(back?.approachMeters).toBeGreaterThan(100);
    // The walk is asked for again, in the background.
    expect(
      (await scheduledNames(t)).filter((n) => n.includes('routeLinkedApproach')).length,
    ).toBeGreaterThanOrEqual(3);

    const undoRow = await newestOn(t, 'putIn', putInId);
    expect(undoRow.undoesActionId).toBe(row._id);
    await mod.as.mutation(api.undo.run, { actionId: undoRow._id });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.parkingAreaId).toBe(nearer);
  });

  test('a first link undoes to none; "No parking" undoes to the lot it cleared', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const putInId = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId,
      coord: { lat: 0.5, lng: 0 },
    });
    const lotId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.001 },
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: lotId });
    await mod.as.mutation(api.undo.run, { actionId: (await newestOn(t, 'putIn', putInId))._id });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.parkingAreaId).toBeUndefined();

    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: lotId });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, clearParking: true });
    await mod.as.mutation(api.undo.run, { actionId: (await newestOn(t, 'putIn', putInId))._id });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.parkingAreaId).toBe(lotId);
  });

  test('refused when the lot it would put back is gone, or the hike-in gate would refuse it', async () => {
    const gone = await linkedTwice();
    await gone.t.run((ctx) => ctx.db.delete(gone.near));
    expect(await gone.t.run((ctx) => ctx.db.get(gone.near))).toBeNull();
    expect(await offer(gone.t, gone.mod.id, gone.row)).toEqual({
      state: 'unavailable',
      why: 'The lot it was linked to is gone, so undo can’t link it again.',
    });

    // A far lot linked with the hike-in asserted; the assertion later dropped by an import.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const putInId = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId,
      coord: { lat: 0.5, lng: 0 },
    });
    const lot = (lng: number) =>
      mod.as.mutation(api.accessPoints.setOfficialParking, {
        coord: { lat: 0.5, lng },
        amenities: [],
        waterBodyIds: [waterBodyId],
      });
    const far = await lot(-0.03);
    const near = await lot(-0.001);
    await expect(
      mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: far }),
    ).rejects.toThrow(/asserted as hike-in/);
    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      parkingAreaId: far,
      approachKindOverride: 'hike_in',
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: near });
    const row = await newestOn(t, 'putIn', putInId);
    await t.run((ctx) => ctx.db.patch(putInId, { approachKindOverride: undefined }));
    const state = await offer(t, mod.id, row);
    expect(state).toMatchObject({ state: 'unavailable' });
    expect(state.state === 'unavailable' ? state.why : '').toMatch(
      /needs the walk marked a hike-in/,
    );
  });

  test('a link that asserted the hike-in undoes to the lot and the kind it replaced', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const putInId = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId,
      coord: { lat: 0.5, lng: 0 },
    });
    const far = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.03 },
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      parkingAreaId: far,
      approachKindOverride: 'hike_in',
    });
    const row = await newestOn(t, 'putIn', putInId);
    expect(row.action).toBe('set_approach_kind');
    expect(await offer(t, mod.id, row)).toEqual({ state: 'available', needsReason: false });
    await mod.as.mutation(api.undo.run, { actionId: row._id });
    const back = await t.run((ctx) => ctx.db.get(putInId));
    expect(back?.parkingAreaId).toBeUndefined();
    expect(back?.approachKindOverride).toBeUndefined();
  });

  test('the gate on its own', () => {
    const putIn = { coord: { lat: 0.5, lng: 0 } } as Doc<'putIns'>;
    const lotAt = (lng: number) => ({ coord: { lat: 0.5, lng } }) as Doc<'parkingAreas'>;
    expect(relinkRefusalOf(null, 'none', null)).toBe('That put-in no longer exists.');
    expect(relinkRefusalOf(putIn, 'none', null)).toBeNull();
    expect(relinkRefusalOf(putIn, lotAt(-0.001), null)).toBeNull();
    expect(relinkRefusalOf(putIn, lotAt(-0.03), null)).toContain(
      HIKE_IN_ASSERT_M.toLocaleString('en-US'),
    );
    expect(relinkRefusalOf(putIn, lotAt(-0.03), 'hike_in')).toBeNull();
  });
});

// ── The walk, routed fresh ────────────────────────────────────────────────────────────────────────

describe('a linked lot’s walk is routed by ORS foot-hiking (D300)', () => {
  async function linked(lotLng = -0.001) {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    const putInId = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId,
      coord: { lat: 0.5, lng: 0 },
    });
    const lotId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: lotLng },
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      parkingAreaId: lotId,
      ...(lotLng < -0.0145 ? { approachKindOverride: 'hike_in' as const } : {}),
    });
    return { t, waterBodyId, mod, putInId, lotId };
  }

  /** An ORS answer: `meters` walked, `ascent` climbed, along `n` three-ordinate positions. */
  /** The link id a console link minted, which its route carries. */
  const linkIdOf = async (t: T, putInId: Id<'putIns'>) =>
    (await t.run((ctx) => ctx.db.get(putInId)))?.approachLinkId ?? 'none';

  function orsAnswer(meters: number, ascent: number, n = 3) {
    const coordinates = Array.from({ length: n }, (_, i) => [
      -0.001 + (0.001 * i) / (n - 1),
      0.5 + 0.0001 * (i % 2),
      200,
    ]);
    return {
      features: [
        { properties: { summary: { distance: meters }, ascent }, geometry: { coordinates } },
      ],
    };
  }

  function stubOrs(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  test('a link schedules the walk; ORS’s answer lands, routed, with its climb', async () => {
    const { t, putInId, lotId } = await linked();
    expect(await scheduledNames(t)).toContain('accessPoints:routeLinkedApproach');
    vi.stubEnv('ORS_API_KEY', 'test-key');
    const fetchMock = stubOrs(200, orsAnswer(312.4, 6.6));
    await t.action(internal.accessPoints.routeLinkedApproach, {
      putInId,
      parkingAreaId: lotId,
      linkId: await linkIdOf(t, putInId),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openrouteservice.org/v2/directions/foot-hiking/geojson');
    expect(JSON.parse(String(init.body))).toEqual({
      coordinates: [
        [-0.001, 0.5],
        [0, 0.5],
      ],
      elevation: true,
    });
    expect(await t.run((ctx) => ctx.db.get(putInId))).toMatchObject({
      approachMeters: 312,
      approachAscentM: 7,
      approachRouted: true,
    });
    // A short walk keeps no line, as the ETL's parser decides.
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachPath).toBeUndefined();
  });

  test('a hike-in’s line is kept, thinned to the path cap', async () => {
    const { t, putInId, lotId } = await linked(-0.02);
    vi.stubEnv('ORS_API_KEY', 'test-key');
    stubOrs(200, orsAnswer(2_600, 40, 12));
    await t.action(internal.accessPoints.routeLinkedApproach, {
      putInId,
      parkingAreaId: lotId,
      linkId: await linkIdOf(t, putInId),
    });
    const row = await t.run((ctx) => ctx.db.get(putInId));
    expect(row?.approachRouted).toBe(true);
    expect(row?.approachPath?.length).toBeGreaterThan(1);
    expect(row?.approachPath?.length).toBeLessThanOrEqual(256);
  });

  test('no key, a spent quota, an error, no path or an implausible walk leave the flagged line', async () => {
    for (const [key, status, body] of [
      [undefined, 200, orsAnswer(300, 1)],
      ['test-key', 403, {}],
      ['test-key', 500, {}],
      ['test-key', 200, { features: [] }],
      ['test-key', 200, orsAnswer(99_000, 1)],
    ] as const) {
      const { t, putInId, lotId } = await linked();
      vi.unstubAllEnvs();
      if (key) vi.stubEnv('ORS_API_KEY', key);
      const fetchMock = stubOrs(status, body);
      await t.action(internal.accessPoints.routeLinkedApproach, {
        putInId,
        parkingAreaId: lotId,
        linkId: await linkIdOf(t, putInId),
      });
      if (!key) expect(fetchMock).not.toHaveBeenCalled();
      expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachRouted).toBe(false);
    }
    // A transport failure too.
    const { t, putInId, lotId } = await linked();
    vi.stubEnv('ORS_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    await t.action(internal.accessPoints.routeLinkedApproach, {
      putInId,
      parkingAreaId: lotId,
      linkId: await linkIdOf(t, putInId),
    });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachRouted).toBe(false);
  });

  test('an answer for an earlier link to the same lot never lands on the newer one', async () => {
    const { t, waterBodyId, mod, putInId, lotId } = await linked();
    const first = await linkIdOf(t, putInId);
    const pair = await t.query(internal.accessPoints.linkedPair, { putInId, parkingAreaId: lotId });
    // Switched to B, then back to A (as an undo does) while A's first answer is still out.
    const other = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.0005 },
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: other });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: lotId });
    const again = await linkIdOf(t, putInId);
    expect(again).not.toBe(first);
    const answer = {
      putInId,
      parkingAreaId: lotId,
      from: pair?.from ?? { lat: 0, lng: 0 },
      to: pair?.to ?? { lat: 0, lng: 0 },
    };
    expect(
      await t.mutation(internal.accessPoints.storeRoutedApproach, {
        ...answer,
        linkId: first,
        meters: 111,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.accessPoints.storeRoutedApproach, {
        ...answer,
        linkId: again,
        meters: 222,
      }),
    ).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachMeters).toBe(222);
  });

  test('a stale answer never overwrites a newer link', async () => {
    const { t, waterBodyId, mod, putInId, lotId } = await linked();
    const pair = await t.query(internal.accessPoints.linkedPair, { putInId, parkingAreaId: lotId });
    expect(pair).not.toBeNull();
    // Relinked to another lot before the answer lands.
    const other = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.0005 },
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, parkingAreaId: other });
    const stored = await t.mutation(internal.accessPoints.storeRoutedApproach, {
      putInId,
      linkId: 'the first link',
      parkingAreaId: lotId,
      from: pair?.from ?? { lat: 0, lng: 0 },
      to: pair?.to ?? { lat: 0, lng: 0 },
      meters: 500,
    });
    expect(stored).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachRouted).toBe(false);
    // The old pair no longer reads as a link to route.
    expect(
      await t.query(internal.accessPoints.linkedPair, { putInId, parkingAreaId: lotId }),
    ).toBeNull();

    // One answer landed already: a second for the same link is dropped too.
    const current = await t.query(internal.accessPoints.linkedPair, {
      putInId,
      parkingAreaId: other,
    });
    const args = {
      putInId,
      linkId: await linkIdOf(t, putInId),
      parkingAreaId: other,
      from: current?.from ?? { lat: 0, lng: 0 },
      to: current?.to ?? { lat: 0, lng: 0 },
    };
    expect(
      await t.mutation(internal.accessPoints.storeRoutedApproach, { ...args, meters: 120 }),
    ).toBe(true);
    expect(
      await t.mutation(internal.accessPoints.storeRoutedApproach, { ...args, meters: 999 }),
    ).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachMeters).toBe(120);
    // Unlinked: nothing to route.
    await mod.as.mutation(api.accessPoints.setPutInAccess, { putInId, clearParking: true });
    expect(
      await t.query(internal.accessPoints.linkedPair, { putInId, parkingAreaId: other }),
    ).toBeNull();
    await t.action(internal.accessPoints.routeLinkedApproach, {
      putInId,
      parkingAreaId: other,
      linkId: 'gone',
    });
  });
});
