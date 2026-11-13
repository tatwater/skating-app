/**
 * Undo for the Body console's levers (D226, B01 §11): each verb acted through its real mutation,
 * undone through `api.undo.run`, and the state compared with what it was before — side effects
 * included where they are cheap to see (a re-stamp, a standing, a cell row).
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { readSnapshot, SNAPSHOT_PART_CHARS, writeAudit, writeSnapshot } from './lib/audit';
import schema from './schema';
import type { MergeChangeSet } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');

/** Fake timers from the start, so a scheduled re-stamp can be drained before asserting on it. */
function harness() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof harness>;

async function settle(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

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
};

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
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

/** A 1° × 1° stand-in lake at Champlain's latitude, so geodesic areas are realistic. */
const LAKE = rect(-73.5, 44.0, -72.5, 45.0);

async function seedBody(
  t: T,
  name = 'Lake Champlain',
  extra: Partial<Doc<'waterBodies'>> = {},
): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: LAKE,
      bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
      centroid: { lat: 44.5, lng: -73.0 },
      surfaceAreaSqM: 8.7e9,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  );
}

async function seedReport(
  t: T,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  point: { lat: number; lng: number },
) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point,
      skateEndTime: now,
      reportTime: now,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
}

type Target = Doc<'moderationActions'>['targetType'];

/** The newest audit row on a target. */
async function newestOn(t: T, targetType: Target, targetId: string) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .order('desc')
      .collect(),
  );
  const row = rows[0];
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}

/** Every audit row an undo of `actionId` wrote. */
async function undoRowsOf(t: T, actionId: Id<'moderationActions'>) {
  return t.run((ctx) =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', actionId))
      .collect(),
  );
}

/** A row as it was written before undo existed: the verb, and nothing it replaced. */
async function legacyRow(
  t: T,
  actorId: Id<'profiles'>,
  action: Doc<'moderationActions'>['action'],
  targetType: Target,
  targetId: string,
  metadata?: Record<string, unknown>,
) {
  return t.run((ctx) =>
    ctx.db.insert('moderationActions', {
      actorId,
      action,
      targetType,
      targetId,
      reason: 'from before undo',
      ...(metadata ? { metadata } : {}),
      createdAt: Date.now(),
    }),
  );
}

const body = (t: T, id: Id<'waterBodies'>) => t.run((ctx) => ctx.db.get(id));

// ── A body's identity and water ─────────────────────────────────────────────────────────────────

describe('undo: a body’s identity and water (D226)', () => {
  test('a curated boost undoes to no boost, re-scored, and the undo row names what it undid', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 0 });
    const before = await body(t, id);

    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 4 });
    const boost = await newestOn(t, 'waterbody', id);
    expect(boost.metadata.prev).toEqual({ curatedBoost: 0 });
    expect((await body(t, id))?.displayScore).not.toBe(before?.displayScore);

    await mod.as.mutation(api.undo.run, { actionId: boost._id });
    const after = await body(t, id);
    expect(after?.curatedBoost).toBe(0);
    expect(after?.displayScore).toBe(before?.displayScore);
    expect(after?.minVisibleZoom).toBe(before?.minVisibleZoom);
    const undo = await newestOn(t, 'waterbody', id);
    expect(undo.action).toBe('set_curated_boost');
    expect(undo.undoesActionId).toBe(boost._id);
  });

  test('a boost that brought a shelved body back shelves it again, and asks why', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'Mud Pond', {
      dormant: { since: Date.now() - 1000, reason: 'inactive' },
    });
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 2 });
    expect((await body(t, id))?.dormant).toBeUndefined();
    const boost = await newestOn(t, 'waterbody', id);

    await expect(mod.as.mutation(api.undo.run, { actionId: boost._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: boost._id, reason: 'boosted the wrong pond' });
    const after = await body(t, id);
    expect(after?.curatedBoost).toBeUndefined();
    expect(after?.dormant?.reason).toBe('inactive');
    const rows = await undoRowsOf(t, boost._id);
    expect(rows.map((r) => r.action).sort()).toEqual(['set_curated_boost', 'set_standing']);
  });

  test('a boost from before undo existed is blocked as predating it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    const actionId = await legacyRow(t, mod.id, 'set_curated_boost', 'waterbody', id, {
      curatedBoost: 3,
    });
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      /before undo existed/i,
    );
  });

  test('reference links undo to the list they replaced', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    const first = [{ label: 'Association', url: 'https://example.org/lake' }];
    await mod.as.mutation(api.waterBodies.setReferenceLinks, { waterBodyId: id, links: first });
    await mod.as.mutation(api.waterBodies.setReferenceLinks, { waterBodyId: id, links: [] });
    const cleared = await newestOn(t, 'waterbody', id);

    await mod.as.mutation(api.undo.run, { actionId: cleared._id });
    expect((await body(t, id))?.referenceLinks).toEqual(first);
    expect((await newestOn(t, 'waterbody', id)).undoesActionId).toBe(cleared._id);
  });

  test('a name pick undoes to the ranked name; a pick over a pick undoes to the first pick', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const catalog = [
      { source: 'nhd' as const, value: 'The Basin' },
      { source: 'osm' as const, value: 'Lake Auburn' },
    ];
    const id = await seedBody(t, 'The Basin', { nameClaims: catalog });

    await mod.as.mutation(api.waterBodies.setWaterBodyName, {
      waterBodyId: id,
      name: 'Lake Auburn',
    });
    const pick = await newestOn(t, 'waterbody', id);
    expect(pick.metadata.prev).toEqual({ name: 'The Basin', overridden: false });
    await mod.as.mutation(api.undo.run, { actionId: pick._id });
    let row = await body(t, id);
    expect(row?.name).toBe('The Basin');
    expect(row?.nameClaims).toEqual(catalog);

    await mod.as.mutation(api.waterBodies.setWaterBodyName, {
      waterBodyId: id,
      name: 'Lake Auburn',
    });
    await mod.as.mutation(api.waterBodies.setWaterBodyName, { waterBodyId: id, name: 'The Basin' });
    const second = await newestOn(t, 'waterbody', id);
    await mod.as.mutation(api.undo.run, { actionId: second._id });
    row = await body(t, id);
    expect(row?.name).toBe('Lake Auburn');
    expect(row?.nameClaims?.[0]).toEqual({ source: 'user', value: 'Lake Auburn' });
  });

  test('a name row from before prev.overridden is blocked', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    const actionId = await legacyRow(t, mod.id, 'set_water_body_name', 'waterbody', id, {
      name: 'Lake Champlain',
      prev: { name: 'Champlain' },
    });
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      /before undo existed/i,
    );
  });

  test('a depth reading undoes to the imported value and its rung; a release undoes to the reading', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'Lake Morey', {
      meanDepthM: 5,
      meanDepthSource: 'hydrolakes_modeled',
    });

    await mod.as.mutation(api.waterBodies.setDepth, {
      waterBodyId: id,
      meanDepthM: 7,
      sourceNote: 'VT ANR 1998',
    });
    const reading = await newestOn(t, 'waterbody', id);
    await mod.as.mutation(api.undo.run, { actionId: reading._id });
    let row = await body(t, id);
    expect(row?.meanDepthM).toBe(5);
    expect(row?.meanDepthSource).toBe('hydrolakes_modeled');
    expect(row?.depthSourceNote).toBeUndefined();

    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: id, meanDepthM: 7 });
    await mod.as.mutation(api.waterBodies.clearDepthOverride, {
      waterBodyId: id,
      measurements: ['mean'],
    });
    const release = await newestOn(t, 'waterbody', id);
    expect((await body(t, id))?.meanDepthM).toBeUndefined();
    await mod.as.mutation(api.undo.run, { actionId: release._id });
    row = await body(t, id);
    expect(row?.meanDepthM).toBe(7);
    expect(row?.meanDepthSource).toBe('operator');
  });

  test('a release the import has refilled since is not undone over the newer depth', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'Lake Morey', { externalId: 'way/42' });
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: id, meanDepthM: 7 });
    await mod.as.mutation(api.waterBodies.clearDepthOverride, {
      waterBodyId: id,
      measurements: ['mean'],
    });
    const release = await newestOn(t, 'waterbody', id);

    // The A06a import fills the released measurement — and writes no audit row, so the release
    // still looks like the newest action on the body.
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm',
          externalId: 'way/42',
          meanDepthM: 6.2,
          meanDepthSource: 'state_agency',
          maxDepthM: 18,
          maxDepthSource: 'state_agency',
        },
      ],
    });
    expect((await newestOn(t, 'waterbody', id))._id).toBe(release._id);

    await expect(mod.as.mutation(api.undo.run, { actionId: release._id })).rejects.toThrow(
      /depth has changed since/,
    );
    expect(await body(t, id)).toMatchObject({ meanDepthM: 6.2, maxDepthM: 18 });
  });

  test('a satellite mode undoes to auto, and the undo of that puts "off" back', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    await mod.as.mutation(api.waterBodies.setSatelliteImagery, { waterBodyId: id, mode: 'off' });
    const off = await newestOn(t, 'waterbody', id);
    await mod.as.mutation(api.undo.run, { actionId: off._id });
    expect((await body(t, id))?.satelliteImagery).toBeUndefined();

    const back = await newestOn(t, 'waterbody', id);
    expect(back.undoesActionId).toBe(off._id);
    // Putting `off` back withholds the link, so it asks why (D226).
    await expect(mod.as.mutation(api.undo.run, { actionId: back._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: back._id, reason: 'the link misleads here' });
    expect((await body(t, id))?.satelliteImagery).toBe('off');
  });

  test('weather sample points undo to the grid they replaced, from the snapshot', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    const first = [
      { lat: 44.2, lng: -73.2 },
      { lat: 44.8, lng: -72.8 },
    ];
    await mod.as.mutation(api.waterBodies.setWeatherSamplePoints, {
      waterBodyId: id,
      points: first,
    });
    await mod.as.mutation(api.waterBodies.setWeatherSamplePoints, {
      waterBodyId: id,
      points: [{ lat: 44.5, lng: -73.0 }],
    });
    const second = await newestOn(t, 'waterbody', id);
    expect(await t.run((ctx) => readSnapshot(ctx, second._id))).toEqual({
      weatherSamplePoints: first,
    });

    await mod.as.mutation(api.undo.run, { actionId: second._id });
    expect((await body(t, id))?.weatherSamplePoints).toEqual(first);

    const legacy = await legacyRow(t, mod.id, 'set_weather_sample_points', 'waterbody', id, {
      count: 1,
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: legacy })).rejects.toThrow(
      /before undo existed/i,
    );
  });

  test('a no-access ruling undoes to unruled and active; putting a closure back asks why', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    expect((await body(t, id))?.publicAccess?.verdict).toBe('none');
    const ruling = await newestOn(t, 'waterbody', id);

    await mod.as.mutation(api.undo.run, { actionId: ruling._id });
    expect((await body(t, id))?.publicAccess).toBeUndefined();
    const cleared = await newestOn(t, 'waterbody', id);
    expect(cleared.undoesActionId).toBe(ruling._id);

    await expect(mod.as.mutation(api.undo.run, { actionId: cleared._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, {
      actionId: cleared._id,
      reason: 'the landowner confirmed again',
    });
    expect((await body(t, id))?.publicAccess?.verdict).toBe('none');
  });

  test('an open ruling that brought a shelved body back shelves it again, and asks why', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'Mud Pond', {
      dormant: { since: Date.now() - 1000, reason: 'moderator', note: 'posted closed' },
    });
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'open' });
    expect((await body(t, id))?.dormant).toBeUndefined();
    const ruling = await newestOn(t, 'waterbody', id);
    expect(ruling.metadata.prev.dormant?.reason).toBe('moderator');

    await expect(mod.as.mutation(api.undo.run, { actionId: ruling._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: ruling._id, reason: 'ruled the wrong pond' });
    const after = await body(t, id);
    expect(after?.publicAccess).toBeUndefined();
    expect(after?.dormant).toMatchObject({ reason: 'moderator', note: 'posted closed' });
    const rows = await undoRowsOf(t, ruling._id);
    expect(rows.map((r) => r.action).sort()).toEqual(['set_public_access', 'set_standing']);
  });

  test('kept-by-request undoes to not kept, and asks why; a catalog admission is not this lever', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'Wetland', { osmId: 'way/1' });
    await t.mutation(internal.waterBodies.setIncludedByRequest, {
      actorUserId: mod.id,
      osmId: 'way/1',
      included: true,
    });
    const keep = await newestOn(t, 'waterbody', id);
    await expect(mod.as.mutation(api.undo.run, { actionId: keep._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: keep._id, reason: 'kept the wrong row' });
    expect((await body(t, id))?.includedByRequest).toBeUndefined();

    const admitted = await legacyRow(t, mod.id, 'set_included_by_request', 'waterbody', id, {
      includedByRequest: true,
      requestId: 'r1',
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: admitted })).rejects.toThrow(
      /reopening the request/i,
    );
  });
});

// ── A body's removal ────────────────────────────────────────────────────────────────────────────

describe('undo: a body’s removal (D226)', () => {
  test('only an admin undoes a removal; the restore that undid it removes again for the same reason', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t);
    await admin.as.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' });
    const removal = await newestOn(t, 'waterbody', id);

    await expect(mod.as.mutation(api.undo.run, { actionId: removal._id })).rejects.toThrow(
      /admin/i,
    );
    await admin.as.mutation(api.undo.run, { actionId: removal._id });
    let row = await body(t, id);
    expect(row?.removedAt).toBeUndefined();
    expect(row?.activatedAt).toBeDefined();
    const restore = await newestOn(t, 'waterbody', id);
    expect(restore.action).toBe('restore');
    expect(restore.undoesActionId).toBe(removal._id);
    expect(restore.metadata.prev).toEqual({ removalReason: 'junk' });

    await expect(admin.as.mutation(api.undo.run, { actionId: restore._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await admin.as.mutation(api.undo.run, { actionId: restore._id, reason: 'it is junk' });
    row = await body(t, id);
    expect(row?.removedAt).toBeDefined();
    expect(row?.removalReason).toBe('junk');
    expect((await newestOn(t, 'waterbody', id)).reason).toBe('it is junk');
  });

  test('a restore from before undo existed is blocked', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t);
    const actionId = await legacyRow(t, admin.id, 'restore', 'waterbody', id);
    await expect(admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      /before undo existed/i,
    );
  });
});

// ── Standing ────────────────────────────────────────────────────────────────────────────────────

describe('undo: standing (D226)', () => {
  test('a moderator’s shelving undoes to active with no reason', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    await mod.as.mutation(api.standing.setStanding, {
      waterBodyId: id,
      standing: 'dormant',
      note: 'private camp',
    });
    const shelve = await newestOn(t, 'waterbody', id);
    expect(shelve.action).toBe('set_standing');

    await mod.as.mutation(api.undo.run, { actionId: shelve._id });
    expect((await body(t, id))?.dormant).toBeUndefined();
    const undo = await newestOn(t, 'waterbody', id);
    expect(undo.action).toBe('activate_body');
    expect(undo.undoesActionId).toBe(shelve._id);
  });

  test('an activation undoes to the dormancy it cleared, reason and all, and asks why', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'Mud Pond', {
      dormant: { since: Date.now() - 1000, reason: 'not_in_campaign' },
    });
    await mod.as.mutation(api.standing.setStanding, { waterBodyId: id, standing: 'active' });
    const activation = await newestOn(t, 'waterbody', id);
    expect(activation.action).toBe('activate_body');

    await expect(mod.as.mutation(api.undo.run, { actionId: activation._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, {
      actionId: activation._id,
      reason: 'the campaign was right',
    });
    expect((await body(t, id))?.dormant?.reason).toBe('not_in_campaign');
  });

  test('a standing an access ruling decided points at the ruling; a row without prev predates undo', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t);
    const ruled = await legacyRow(t, mod.id, 'set_standing', 'waterbody', id, {
      prev: { standing: 'dormant', since: 1, reason: 'no_public_access' },
      next: { standing: 'active' },
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: ruled })).rejects.toThrow(
      /access ruling/i,
    );
    const legacy = await legacyRow(t, mod.id, 'activate_body', 'waterbody', id);
    await expect(mod.as.mutation(api.undo.run, { actionId: legacy })).rejects.toThrow(
      /before undo existed/i,
    );
  });
});

// ── Sub-areas ───────────────────────────────────────────────────────────────────────────────────

describe('undo: sub-areas (D226)', () => {
  const BAY = rect(-73.2, 44.2, -73.0, 44.4);

  async function seedBay(t: T) {
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const lake = await seedBody(t);
    const report = await seedReport(t, lake, author.id, { lat: 44.38, lng: -73.05 });
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: lake,
      name: 'Malletts Bay',
      aliases: ['Mallets Bay'],
      polygon: BAY,
    });
    await settle(t);
    return { mod, lake, report, bay };
  }

  const subArea = (t: T, id: Id<'waterBodySubAreas'>) => t.run((ctx) => ctx.db.get(id));
  const report = (t: T, id: Id<'reports'>) => t.run((ctx) => ctx.db.get(id));

  test('a drawn bay undoes to delisted, and its stamp comes off the reports', async () => {
    const t = harness();
    const { mod, report: r, bay } = await seedBay(t);
    expect((await report(t, r))?.subAreaId).toBe(bay);
    const create = await newestOn(t, 'waterBodySubArea', bay);

    await mod.as.mutation(api.undo.run, { actionId: create._id });
    await settle(t);
    expect((await subArea(t, bay))?.removedAt).toBeDefined();
    expect((await report(t, r))?.subAreaId).toBeUndefined();
    expect((await newestOn(t, 'waterBodySubArea', bay)).undoesActionId).toBe(create._id);
  });

  test('a redraw undoes to the outline it replaced, re-stamping the reports', async () => {
    const t = harness();
    const { mod, report: r, bay } = await seedBay(t);
    const before = await subArea(t, bay);
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: bay,
      polygon: rect(-73.2, 44.2, -73.0, 44.3),
    });
    await settle(t);
    expect((await report(t, r))?.subAreaId).toBeUndefined();
    const redraw = await newestOn(t, 'waterBodySubArea', bay);

    await mod.as.mutation(api.undo.run, { actionId: redraw._id });
    await settle(t);
    const after = await subArea(t, bay);
    expect(after?.polygon).toEqual(before?.polygon);
    expect(after?.bbox).toEqual(before?.bbox);
    expect((await report(t, r))?.subAreaId).toBe(bay);
    expect((await newestOn(t, 'waterBodySubArea', bay)).undoesActionId).toBe(redraw._id);
  });

  test('a free redraw of a chord bay undoes with its mouth back', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const lake = await seedBody(t);
    const CORNER = {
      a: { lat: 44.2, lng: -73.5 },
      b: { lat: 44.0, lng: -73.3 },
      side: { lat: 44.05, lng: -73.45 },
      sagittaM: 0,
    };
    const { subAreaId } = await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: lake,
      name: 'Corner Bay',
      mouth: CORNER,
    });
    const before = await subArea(t, subAreaId);
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId,
      polygon: rect(-73.5, 44.0, -73.35, 44.15),
    });
    expect((await subArea(t, subAreaId))?.mouth).toBeUndefined();
    const redraw = await newestOn(t, 'waterBodySubArea', subAreaId);

    await mod.as.mutation(api.undo.run, { actionId: redraw._id });
    const after = await subArea(t, subAreaId);
    expect(after?.mouth).toEqual(CORNER);
    expect(after?.bbox).toEqual(before?.bbox);
  });

  test('a rename undoes to the name and aliases it replaced, on the reports too', async () => {
    const t = harness();
    const { mod, report: r, bay } = await seedBay(t);
    await mod.as.mutation(api.subAreas.rename, {
      subAreaId: bay,
      name: 'Mallett’s Bay',
      aliases: [],
    });
    await settle(t);
    const rename = await newestOn(t, 'waterBodySubArea', bay);

    await mod.as.mutation(api.undo.run, { actionId: rename._id });
    await settle(t);
    const after = await subArea(t, bay);
    expect(after?.name).toBe('Malletts Bay');
    expect(after?.aliases).toEqual(['Mallets Bay']);
    expect((await report(t, r))?.subAreaName).toBe('Malletts Bay');
  });

  test('a delist undoes to restored; undoing that restore asks why; an automatic delist is not undone here', async () => {
    const t = harness();
    const { mod, bay } = await seedBay(t);
    await mod.as.mutation(api.subAreas.remove, { subAreaId: bay, reason: 'not a real bay' });
    const remove = await newestOn(t, 'waterBodySubArea', bay);
    await mod.as.mutation(api.undo.run, { actionId: remove._id });
    expect((await subArea(t, bay))?.removedAt).toBeUndefined();

    const restore = await newestOn(t, 'waterBodySubArea', bay);
    await expect(mod.as.mutation(api.undo.run, { actionId: restore._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: restore._id, reason: 'not a real bay' });
    expect((await subArea(t, bay))?.removedAt).toBeDefined();

    const automatic = await legacyRow(t, mod.id, 'remove', 'waterBodySubArea', bay, {
      automatic: true,
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: automatic })).rejects.toThrow(
      /system delisted/i,
    );
  });

  test('a bay’s curated boost undoes to none; a redraw without a snapshot predates undo', async () => {
    const t = harness();
    const { mod, bay } = await seedBay(t);
    const before = await subArea(t, bay);
    await mod.as.mutation(api.subAreas.setCuratedBoost, { subAreaId: bay, curatedBoost: 3 });
    const boost = await newestOn(t, 'waterBodySubArea', bay);
    await mod.as.mutation(api.undo.run, { actionId: boost._id });
    const after = await subArea(t, bay);
    expect(after?.curatedBoost).toBeUndefined();
    expect(after?.minVisibleZoom).toBe(before?.minVisibleZoom);

    const legacy = await legacyRow(t, mod.id, 'redraw_sub_area', 'waterBodySubArea', bay);
    await expect(mod.as.mutation(api.undo.run, { actionId: legacy })).rejects.toThrow(
      /before undo existed/i,
    );
  });
});

// ── Landmarks ───────────────────────────────────────────────────────────────────────────────────

describe('undo: landmarks (D226)', () => {
  async function seedLandmark(t: T) {
    const mod = await seedUser(t, 'mod', 'moderator');
    const lake = await seedBody(t);
    const landmark = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: 'Gull Island',
      kind: 'island',
      point: { lat: 44.6, lng: -73.1 },
      aliases: ['Gull Rock'],
    });
    return { mod, lake, landmark };
  }
  const landmarkRow = (t: T, id: Id<'bodyLandmarks'>) => t.run((ctx) => ctx.db.get(id));

  test('a created landmark undoes to removed', async () => {
    const t = harness();
    const { mod, landmark } = await seedLandmark(t);
    const create = await newestOn(t, 'bodyLandmark', landmark);
    await mod.as.mutation(api.undo.run, { actionId: create._id });
    expect((await landmarkRow(t, landmark))?.removedAt).toBeDefined();
    expect((await newestOn(t, 'bodyLandmark', landmark)).undoesActionId).toBe(create._id);
  });

  test('an edit undoes to the name, aliases, kind and point it replaced', async () => {
    const t = harness();
    const { mod, landmark } = await seedLandmark(t);
    const before = await landmarkRow(t, landmark);
    await mod.as.mutation(api.landmarks.update, {
      landmarkId: landmark,
      name: 'Gull Point',
      kind: 'point',
      point: { lat: 44.7, lng: -73.2 },
      aliases: [],
    });
    const edit = await newestOn(t, 'bodyLandmark', landmark);
    await mod.as.mutation(api.undo.run, { actionId: edit._id });
    const after = await landmarkRow(t, landmark);
    expect(after?.name).toBe(before?.name);
    expect(after?.aliases).toEqual(before?.aliases);
    expect(after?.kind).toBe(before?.kind);
    expect(after?.point).toEqual(before?.point);
  });

  test('a place-names spelling and an edit from before undo are both blocked', async () => {
    const t = harness();
    const { mod, landmark } = await seedLandmark(t);
    const spelling = await legacyRow(t, mod.id, 'edit_landmark', 'bodyLandmark', landmark, {
      corpusName: 'Gull Is.',
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: spelling })).rejects.toThrow(
      /place-names queue/i,
    );
    const legacy = await legacyRow(t, mod.id, 'edit_landmark', 'bodyLandmark', landmark);
    await expect(mod.as.mutation(api.undo.run, { actionId: legacy })).rejects.toThrow(
      /before undo existed/i,
    );
  });

  test('a removal undoes to restored; undoing the restore asks why', async () => {
    const t = harness();
    const { mod, landmark } = await seedLandmark(t);
    await mod.as.mutation(api.landmarks.remove, { landmarkId: landmark, reason: 'a buoy' });
    const remove = await newestOn(t, 'bodyLandmark', landmark);
    await mod.as.mutation(api.undo.run, { actionId: remove._id });
    expect((await landmarkRow(t, landmark))?.removedAt).toBeUndefined();

    const restore = await newestOn(t, 'bodyLandmark', landmark);
    await expect(mod.as.mutation(api.undo.run, { actionId: restore._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: restore._id, reason: 'it is a buoy' });
    expect((await landmarkRow(t, landmark))?.removedAt).toBeDefined();
  });
});

// ── A body merge: recorded, not yet undone ──────────────────────────────────────────────────────

describe('a body merge records its change set (D226)', () => {
  test('every moved row, every deleted favorite, and the bays and labels as they stood', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const fan = await seedUser(t, 'fan');
    const loner = await seedUser(t, 'loner');
    const survivor = await seedBody(t, 'Lake Champlain');
    const loser = await seedBody(t, 'Champlain (dup)');
    const reportId = await seedReport(t, loser, fan.id, { lat: 44.5, lng: -73.0 });
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: loser,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const landmark = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: loser,
      name: 'Gull Island',
      kind: 'island',
      point: { lat: 44.6, lng: -73.1 },
    });
    const { dupFav, soloFav } = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('waterBodyFavorites', {
        userId: fan.id,
        waterBodyId: survivor,
        createdAt: now,
      });
      const dupFav = await ctx.db.insert('waterBodyFavorites', {
        userId: fan.id,
        waterBodyId: loser,
        createdAt: now,
      });
      const soloFav = await ctx.db.insert('waterBodyFavorites', {
        userId: loner.id,
        waterBodyId: loser,
        createdAt: now,
      });
      return { dupFav, soloFav };
    });

    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const merge = await newestOn(t, 'waterbody', loser);
    expect(merge.action).toBe('merge_waterbody');
    expect(merge.metadata.changeSet).toBe(true);

    const set = await t.run((ctx) => readSnapshot<MergeChangeSet>(ctx, merge._id));
    expect(set?.survivorId).toBe(survivor);
    expect(set?.loserId).toBe(loser);
    expect(set?.moved).toEqual(
      expect.arrayContaining([
        { table: 'reports', id: reportId, waterBodyId: loser },
        { table: 'waterBodyFavorites', id: soloFav, waterBodyId: loser },
      ]),
    );
    const keptFav = await t.run((ctx) =>
      ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_user_water_body_sub_area', (q) =>
          q.eq('userId', fan.id).eq('waterBodyId', survivor).eq('subAreaId', undefined),
        )
        .unique(),
    );
    expect(set?.deletedFavorites).toEqual([
      { id: dupFav, keptFavoriteId: keptFav?._id, createdAt: expect.any(Number) },
    ]);
    // A favorite is erased with its account (D33); the snapshot keeps no copy that names the person.
    for (const person of [fan.id, loner.id]) expect(JSON.stringify(set)).not.toContain(person);
    expect(set?.subAreasBefore.map((s) => [s.id, s.waterBodyId])).toEqual([[bay, loser]]);
    expect(set?.landmarksBefore.map((l) => [l.id, l.waterBodyId])).toEqual([[landmark, loser]]);
    expect(set?.landmarksAfter).toEqual([{ id: landmark, waterBodyId: survivor, removed: false }]);
    expect(set?.dedupBefore[0]).toEqual({
      id: loser,
      dedupStatus: 'clean',
      duplicateCandidateIds: null,
      mergedIntoId: null,
    });

    // The unmerge is §4's; until then History says so rather than offering an undo.
    await expect(mod.as.mutation(api.undo.run, { actionId: merge._id })).rejects.toThrow(
      /lands with §4/,
    );
  });

  test('a payload too big for one row splits into parts and reads back whole', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const payload = { rows: Array.from({ length: 3 }, () => 'x'.repeat(SNAPSHOT_PART_CHARS)) };
    const { parts, read } = await t.run(async (ctx) => {
      const actionId = await writeAudit(ctx, {
        actorId: mod.id,
        action: 'merge_waterbody',
        targetType: 'waterbody',
        targetId: 'x',
        reason: 'test',
      });
      const parts = await writeSnapshot(ctx, actionId, payload);
      return { parts, read: await readSnapshot(ctx, actionId) };
    });
    expect(parts).toBeGreaterThan(1);
    expect(read).toEqual(payload);
  });
});
