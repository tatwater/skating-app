import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * The re-stamp is a `scheduler.runAfter(0)` chain, and convex-test leaves such a job `pending` until
 * a timer fires — so the harness has to own fake timers from before the first schedule, or
 * `finishAllScheduledFunctions` drains nothing and every stamp assertion reads a row the job hasn't
 * reached yet (which fails as a plausible-looking "the stamp didn't happen").
 */
function harness() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

const NOTIF_PREFS = {
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
};

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
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

/** An axis-aligned rectangle, in the degrees the rest of these fixtures use. */
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

async function seedBody(t: ReturnType<typeof convexTest>, name = 'Lake Champlain') {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: LAKE,
      bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
      centroid: { lat: 44.5, lng: -73.0 },
      surfaceAreaSqM: 8.7e9,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

/** Drain the scheduler so a re-stamp scheduled by a mutation actually runs before we assert on it. */
async function settle(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  point: { lat: number; lng: number },
  skateEndTime = Date.now(),
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point,
      skateEndTime,
      reportTime: skateEndTime,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: skateEndTime,
      updatedAt: skateEndTime,
    }),
  );
}

describe('subAreas.create', () => {
  test('a member cannot draw one — this is a moderator lever (D37)', async () => {
    const t = harness();
    const body = await seedBody(t);
    const member = await seedUser(t, 'member');
    await expect(
      member.as.mutation(api.subAreas.create, {
        waterBodyId: body,
        name: 'Malletts Bay',
        polygon: rect(-73.2, 44.2, -73.0, 44.4),
      }),
    ).rejects.toThrow(/moderator/i);
  });

  test('stores the shape, derives prominence, cell-indexes it, and audits the write', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      aliases: ['Mallets Bay', "Mallett's Bay"],
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.name).toBe('Malletts Bay');
    // The aliases have to be inside `searchText` or the search index can never reach them.
    expect(row?.searchText).toBe("Malletts Bay Mallets Bay Mallett's Bay");
    expect(row?.surfaceAreaSqM).toBeGreaterThan(0);
    expect(row?.minVisibleZoom).toBeGreaterThanOrEqual(6);

    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    expect(cells.length).toBeGreaterThan(0);
    // Theorem 2: an object at its own fit level never spans more than four cells.
    expect(cells.length).toBeLessThanOrEqual(4);

    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterBodySubArea').eq('targetId', id as string),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual(['create_sub_area']);
  });

  test('clips a shape that overhangs the lake rather than refusing it (Decision 10)', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    // ~25% of this draw is west of the shoreline — ordinary tracing, not a mistake.
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Northwest Bay',
      polygon: rect(-73.55, 44.2, -73.35, 44.4),
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    // What's stored is the clip, so nothing downstream ever sees the overhang.
    expect(row?.bbox.minLng).toBeCloseTo(-73.5, 6);
  });

  test('refuses a shape mostly outside the lake instead of saving the sliver', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.subAreas.create, {
        waterBodyId: body,
        name: 'Somewhere Else Bay',
        polygon: rect(-74.4, 44.2, -73.4, 44.4),
      }),
    ).rejects.toThrow();
  });

  test('refuses a second sub-area with the same name on one lake', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await expect(
      mod.as.mutation(api.subAreas.create, {
        waterBodyId: body,
        name: 'malletts bay',
        polygon: rect(-73.4, 44.6, -73.2, 44.8),
      }),
    ).rejects.toThrow(/already has a sub-area/i);
  });

  test('refuses to draw on a body that is not on the map', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run((ctx) => ctx.db.patch(body, { removedAt: Date.now() }));
    await expect(
      mod.as.mutation(api.subAreas.create, {
        waterBodyId: body,
        name: 'Malletts Bay',
        polygon: rect(-73.2, 44.2, -73.0, 44.4),
      }),
    ).rejects.toThrow(/not on the map/i);
  });
});

describe('the membership stamp', () => {
  test('a new bay claims the reports already inside it, and leaves the rest alone', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');

    const inside = await seedReport(t, body, author.id, { lat: 44.3, lng: -73.1 });
    const outside = await seedReport(t, body, author.id, { lat: 44.8, lng: -72.8 });

    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await settle(t);

    expect((await t.run((ctx) => ctx.db.get(inside)))?.subAreaName).toBe('Malletts Bay');
    expect((await t.run((ctx) => ctx.db.get(outside)))?.subAreaName).toBeUndefined();
  });

  test('a point in two overlapping bays takes the smaller one (Decision 9)', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const report = await seedReport(t, body, author.id, { lat: 44.3, lng: -73.1 });

    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Outer Malletts',
      polygon: rect(-73.3, 44.1, -72.9, 44.5),
    });
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Inner Malletts',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await settle(t);

    expect((await t.run((ctx) => ctx.db.get(report)))?.subAreaName).toBe('Inner Malletts');
  });

  test('a redraw releases reports it no longer contains, not just claims new ones', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const report = await seedReport(t, body, author.id, { lat: 44.38, lng: -73.05 });

    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(report)))?.subAreaName).toBe('Malletts Bay');

    // Shrink the bay south of the report. The stamp has to come *off*.
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: id,
      polygon: rect(-73.2, 44.2, -73.0, 44.3),
    });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(report)))?.subAreaId).toBeUndefined();
  });

  test('a rename reaches the denormalized copy on every report it labels', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const report = await seedReport(t, body, author.id, { lat: 44.3, lng: -73.1 });

    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Mallets Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await settle(t);
    await mod.as.mutation(api.subAreas.rename, { subAreaId: id, name: 'Malletts Bay' });
    await settle(t);

    expect((await t.run((ctx) => ctx.db.get(report)))?.subAreaName).toBe('Malletts Bay');
  });

  test('delisting a bay strips its name from the reports it labelled', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const report = await seedReport(t, body, author.id, { lat: 44.3, lng: -73.1 });

    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await settle(t);
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });
    await settle(t);

    expect((await t.run((ctx) => ctx.db.get(report)))?.subAreaName).toBeUndefined();
    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    expect(cells).toHaveLength(0);
  });

  test('the re-stamp pages past a single batch rather than capping (N1 round 2)', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');

    // More than one RESTAMP_BATCH (200), all inside the bay. A capped job would strand the tail;
    // a paging one reaches every row.
    const ids: Id<'reports'>[] = [];
    for (let i = 0; i < 250; i++) {
      ids.push(await seedReport(t, body, author.id, { lat: 44.3, lng: -73.1 }, 1000 + i));
    }
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await settle(t);

    const stamped = await t.run(async (ctx) => {
      let count = 0;
      for (const id of ids) {
        const row = await ctx.db.get(id);
        if (row?.subAreaName === 'Malletts Bay') count++;
      }
      return count;
    });
    expect(stamped).toBe(250);
  }, 30_000); // 5s default flakes on legitimately heavy work (see the repo's CI-timeout note). // convex-test replays 250 inserts plus two paged sweeps; CI runs ~8× slower than local, so the
});

describe('the stamp at create', () => {
  test('a new report lands already carrying its bay name, no re-stamp needed', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.3, lng: -73.1 },
      iceTypes: ['black_ice'],
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.subAreaName).toBe('Malletts Bay');
  });

  test('a report elsewhere on the lake carries no bay name', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.8, lng: -72.8 },
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.subAreaId).toBeUndefined();
  });

  test('moving the put-in pin moves the stamp with it', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.3, lng: -73.1 },
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.subAreaName).toBe('Malletts Bay');

    await author.as.mutation(api.reports.update, {
      reportId,
      skateEndTime: Date.now(),
      point: { lat: 44.8, lng: -72.8 },
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.subAreaName).toBeUndefined();
  });
});

describe('subAreas.rename', () => {
  test('an alias-only edit skips the re-stamp — nothing downstream carries the aliases', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await mod.as.mutation(api.subAreas.rename, { subAreaId: id, aliases: ['Inland Sea'] });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.aliases).toEqual(['Inland Sea']);
    expect(row?.searchText).toBe('Malletts Bay Inland Sea');
    expect(row?.name).toBe('Malletts Bay');
  });

  test('deduplicates aliases case-insensitively and drops blanks', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      aliases: ['Mallets Bay', 'mallets bay', '   ', 'Inland Sea'],
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.aliases).toEqual(['Mallets Bay', 'Inland Sea']);
  });
});

describe('subAreas.remove / restore', () => {
  test('restore is reversible and re-indexes, and a restore on a delisted lake stays dark', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });
    await mod.as.mutation(api.subAreas.restore, { subAreaId: id });
    let cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    expect(cells.length).toBeGreaterThan(0);

    // Now delist the lake and try again: Decision 11 is a conjunction, and restore isn't a bypass.
    await t.run((ctx) => ctx.db.patch(body, { removedAt: Date.now() }));
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });
    await mod.as.mutation(api.subAreas.restore, { subAreaId: id });
    cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    expect(cells).toHaveLength(0);
  });
});

/**
 * Decision 11, and the one hole the build found in the plan: sub-areas got their own soft-delist and
 * their own cell table with nothing connecting the two, so a takedown on the lake would have left the
 * bay labelled on a map that no longer had the lake.
 */
describe('the parent-listing cascade', () => {
  async function cellCount(t: ReturnType<typeof harness>, id: Id<'waterBodySubAreas'>) {
    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    return cells.length;
  }

  test('removing the lake takes its bays off the map, and restoring brings them back', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    expect(await cellCount(t, id)).toBeGreaterThan(0);

    await admin.as.mutation(api.waterBodies.remove, {
      waterBodyId: body,
      reason: 'landowner_request',
    });
    expect(await cellCount(t, id)).toBe(0);

    await admin.as.mutation(api.waterBodies.restore, { waterBodyId: body });
    expect(await cellCount(t, id)).toBeGreaterThan(0);
  });

  test('rejecting a user body takes its bays with it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Someone Pond',
        type: 'lake' as const,
        source: 'user' as const,
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        reviewStatus: 'pending' as const,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'North Arm',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await mod.as.mutation(api.waterBodies.reject, { waterBodyId: body });
    expect(await cellCount(t, id)).toBe(0);
  });

  test('a merge moves the bays to the survivor and re-stamps its reports', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const survivor = await seedBody(t, 'Lake Champlain');
    const loser = await seedBody(t, 'Champlain Lake');

    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: loser,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const report = await seedReport(t, loser, author.id, { lat: 44.3, lng: -73.1 });
    await settle(t);

    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    await settle(t);

    expect((await t.run((ctx) => ctx.db.get(id)))?.waterBodyId).toBe(survivor);
    // The bay is still on the map — it moved rather than being stranded on a tombstone.
    expect(await cellCount(t, id)).toBeGreaterThan(0);
    const moved = await t.run((ctx) => ctx.db.get(report));
    expect(moved?.waterBodyId).toBe(survivor);
    expect(moved?.subAreaName).toBe('Malletts Bay');
  });

  test('a merge delists a bay whose name the survivor already uses', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const survivor = await seedBody(t, 'Lake Champlain');
    const loser = await seedBody(t, 'Champlain Lake');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: survivor,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const dupe = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: loser,
      name: 'Malletts Bay',
      polygon: rect(-73.25, 44.15, -72.95, 44.45),
    });

    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    await settle(t);

    const row = await t.run((ctx) => ctx.db.get(dupe));
    expect(row?.waterBodyId).toBe(survivor);
    // Kept (never hard-deleted), but off the map — two same-named overlapping bays would compete for
    // the stamp deterministically, and therefore silently wrongly.
    expect(row?.removedAt).toBeDefined();
    expect(await cellCount(t, dupe)).toBe(0);
  });

  /** A canonical body with an `externalId`, so `importCanonical` upserts it rather than inserting. */
  async function seedCanonicalBody(t: ReturnType<typeof convexTest>) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Champlain',
        type: 'lake' as const,
        source: 'osm' as const,
        externalId: 'way/1',
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
  }

  /** Re-run the ETL upsert for `way/1` with a refined outline. */
  function reimport(
    t: ReturnType<typeof convexTest>,
    polygon: ReturnType<typeof rect>,
    maxLng: number,
  ) {
    return t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm' as const,
          externalId: 'way/1',
          name: 'Lake Champlain',
          type: 'lake' as const,
          polygon,
          bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng },
          centroid: { lat: 44.5, lng: -73.3 },
          surfaceAreaSqM: 3.4e9,
        },
      ],
    });
  }

  test('a re-import that moves the shoreline re-clips the bays under it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedCanonicalBody(t);
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    // The refined outline pulls the eastern shore slightly west, trimming a quarter off the bay.
    await reimport(t, rect(-73.5, 44.0, -73.05, 45.0), -73.05);

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.removedAt).toBeUndefined(); // still fits well enough to keep
    expect(row?.bbox.maxLng).toBeCloseTo(-73.05, 6); // and it was trimmed to the new shoreline
  });

  test('a re-import that guts a bay delists it rather than aborting the batch', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedCanonicalBody(t);
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    // This outline leaves only a quarter of the bay — past the refusal threshold. An ETL chunk
    // covering thousands of bodies must not throw because one hand-drawn bay stopped fitting.
    await expect(reimport(t, rect(-73.5, 44.0, -73.15, 45.0), -73.15)).resolves.toBeTruthy();

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.removedAt).toBeDefined(); // delisted, and still there for the operator to redraw
    expect(await cellCount(t, id)).toBe(0);
  });
});

/**
 * The half of targeting the plan didn't name. `attachReportToOpenBounties` is where fulfillment
 * begins — the requester's helpful thumb lands on an *attached* report — so leaving it body-wide
 * would have made a bay bounty a label with no mechanism behind it.
 */
describe('sub-area bounty targeting', () => {
  async function setup() {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    return { t, body, bay, mod };
  }

  test('a report elsewhere on the lake does not attach to a bay bounty', async () => {
    const { t, body, bay } = await setup();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');

    const bountyId = await requester.as.action(api.bounties.create, {
      waterBodyId: body,
      subAreaId: bay,
    });

    // Far end of the lake — real ice, wrong ask.
    await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.9, lng: -72.7 },
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toEqual([]);

    // In the bay — the ask, answered.
    const inBay = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.3, lng: -73.1 },
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toEqual([inBay]);
  });

  test('a body-wide bounty still takes any report on the body', async () => {
    const { t, body } = await setup();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId: body });

    const anywhere = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.9, lng: -72.7 },
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toEqual([anywhere]);
  });

  test('the freshness gate is scoped to the bay, not the lake', async () => {
    const { t, body, bay } = await setup();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');

    // Fresh eyes on the far end of the lake. That suppresses a *lake* bounty...
    await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.9, lng: -72.7 },
      iceTypes: ['black_ice'],
    });
    await expect(requester.as.action(api.bounties.create, { waterBodyId: body })).rejects.toThrow(
      /fresh eyes/i,
    );

    // ...and says nothing about Malletts Bay, 60 km away, which is the whole point of targeting.
    await expect(
      requester.as.action(api.bounties.create, { waterBodyId: body, subAreaId: bay }),
    ).resolves.toBeTruthy();
  });

  test('refuses a bay that belongs to a different lake', async () => {
    const { t, bay } = await setup();
    const other = await seedBody(t, 'Lake George');
    const requester = await seedUser(t, 'requester');
    await expect(
      requester.as.action(api.bounties.create, { waterBodyId: other, subAreaId: bay }),
    ).rejects.toThrow();
  });

  test('the detail read names the bay without denormalizing it onto the bounty', async () => {
    const { t, body, bay, mod } = await setup();
    const requester = await seedUser(t, 'requester');
    const bountyId = await requester.as.action(api.bounties.create, {
      waterBodyId: body,
      subAreaId: bay,
    });
    expect((await t.query(api.bounties.getDetail, { bountyId }))?.subArea?.name).toBe(
      'Malletts Bay',
    );

    // A rename reaches it for free — which is why the name isn't copied onto the bounty row.
    await mod.as.mutation(api.subAreas.rename, { subAreaId: bay, name: "Mallett's Bay" });
    await settle(t);
    expect((await t.query(api.bounties.getDetail, { bountyId }))?.subArea?.name).toBe(
      "Mallett's Bay",
    );
  });
});

describe('subAreas.listInViewport', () => {
  const VIEWPORT = { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 };

  async function drawBay(
    t: ReturnType<typeof harness>,
    body: Id<'waterBodies'>,
    name: string,
    box: [number, number, number, number],
  ) {
    const mod = t.withIdentity({ subject: 'mod' });
    return mod.mutation(api.subAreas.create, {
      waterBodyId: body,
      name,
      polygon: rect(...box),
    });
  }

  test('returns the bays in view, and nothing below the render-zoom floor', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedUser(t, 'mod', 'moderator');
    await drawBay(t, body, 'Malletts Bay', [-73.2, 44.2, -73.0, 44.4]);

    expect(
      await t.query(api.subAreas.listInViewport, { viewport: VIEWPORT, zoom: 12 }),
    ).toHaveLength(1);
    // Not a filter — a decision not to run the query. At z8 you're looking at three states and the
    // lake itself is two pixels wide.
    expect(await t.query(api.subAreas.listInViewport, { viewport: VIEWPORT, zoom: 8 })).toEqual([]);
  });

  test('a bay outside the viewport is not returned', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedUser(t, 'mod', 'moderator');
    await drawBay(t, body, 'Malletts Bay', [-73.2, 44.2, -73.0, 44.4]);

    const elsewhere = { minLat: 44.0, minLng: -72.9, maxLat: 44.1, maxLng: -72.6 };
    expect(await t.query(api.subAreas.listInViewport, { viewport: elsewhere, zoom: 12 })).toEqual(
      [],
    );
  });

  test('a delisted bay, and a bay on a delisted lake, both drop out of the layer', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'admin', 'admin');
    const a = await drawBay(t, body, 'Malletts Bay', [-73.2, 44.2, -73.0, 44.4]);
    await drawBay(t, body, 'Shelburne Bay', [-73.3, 44.5, -73.15, 44.7]);
    expect(
      await t.query(api.subAreas.listInViewport, { viewport: VIEWPORT, zoom: 12 }),
    ).toHaveLength(2);

    await mod.as.mutation(api.subAreas.remove, { subAreaId: a });
    expect(
      await t.query(api.subAreas.listInViewport, { viewport: VIEWPORT, zoom: 12 }),
    ).toHaveLength(1);

    await admin.as.mutation(api.waterBodies.remove, {
      waterBodyId: body,
      reason: 'landowner_request',
    });
    expect(await t.query(api.subAreas.listInViewport, { viewport: VIEWPORT, zoom: 12 })).toEqual(
      [],
    );
  });

  test('the read-stats sibling reports what the scan cost', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedUser(t, 'mod', 'moderator');
    await drawBay(t, body, 'Malletts Bay', [-73.2, 44.2, -73.0, 44.4]);

    // A *realistic* z12 window — about 11 km across. The 1° `VIEWPORT` the other cases use is a
    // coherence check, not a plausible screen: at z12 it would be ~250 cells of plan, which is what
    // the per-rung guard exists to notice rather than what a map actually asks for.
    const stats = await t.query(internal.subAreas.subAreaReadStats, {
      viewport: { minLat: 44.25, minLng: -73.15, maxLat: 44.35, maxLng: -73.05 },
      zoom: 12,
      names: true,
    });
    expect(stats.subAreas).toBe(1);
    expect(stats.names).toEqual(['Malletts Bay']);
    expect(stats.truncated).toBe(false);
    // The claim the budgets rest on: a real viewport costs a tiny fraction of a function's 4,096.
    expect(stats.approxDocumentReads).toBeGreaterThan(0);
    expect(stats.approxDocumentReads).toBeLessThan(60);
  });

  test('truncation is reported, and keeps the most prominent bays rather than the first scanned', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedUser(t, 'mod', 'moderator');
    // A big bay and a small one. With room for exactly one, the big one has to win — wherever in the
    // box it sits, and whichever cell the walk opened first.
    await drawBay(t, body, 'Broad Lake', [-73.45, 44.05, -72.6, 44.95]);
    await drawBay(t, body, 'Little Eagle Bay', [-73.2, 44.2, -73.19, 44.21]);

    const stats = await t.query(internal.subAreas.subAreaReadStats, {
      viewport: VIEWPORT,
      zoom: 14,
      limit: 1,
      names: true,
    });
    expect(stats.names).toEqual(['Broad Lake']);
    expect(stats.truncated).toBe(true);
  });
});

describe('the merged search box', () => {
  test('finds a bay by an alias that shares no token with its name', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Northeast Arm',
      aliases: ['Inland Sea'],
      polygon: rect(-73.2, 44.6, -73.0, 44.8),
    });

    // The point of aliases: "Inland Sea" is what people call it, and it shares no word with either
    // the bay's stored name or the lake's.
    const hits = await t.query(api.waterBodies.searchByName, { query: 'Inland Sea' });
    expect(hits.map((h) => h.name)).toContain('Northeast Arm');
    const hit = hits.find((h) => h.name === 'Northeast Arm');
    expect(hit?.kind).toBe('subArea');
    expect(hit?.parentName).toBe('Lake Champlain');
    // Selecting it opens the parent's page — a bay is a name on a lake, not a page of its own.
    expect(hit?.waterBodyId).toBe(body);
    // ...framed on the bay, not on 200 km of lake.
    expect(hit?.bbox.minLat).toBeCloseTo(44.6, 6);
  });

  test('a bay on a delisted lake is unreachable from search, as it is from the map', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'admin', 'admin');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    expect(
      (await t.query(api.waterBodies.searchByName, { query: 'Malletts' })).length,
    ).toBeGreaterThan(0);

    await admin.as.mutation(api.waterBodies.remove, {
      waterBodyId: body,
      reason: 'landowner_request',
    });
    // `isListed` is derived, so it can't be a search filterField on either table — the refine has to
    // happen in JS, and forgetting the *parent* half is the easy miss.
    expect(await t.query(api.waterBodies.searchByName, { query: 'Malletts' })).toEqual([]);
  });

  test('a delisted bay drops out of search while its lake stays', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });
    expect(await t.query(api.waterBodies.searchByName, { query: 'Malletts' })).toEqual([]);
    expect(
      (await t.query(api.waterBodies.searchByName, { query: 'Champlain' })).map((h) => h.kind),
    ).toEqual(['body']);
  });
});

describe('subAreas.setCuratedBoost', () => {
  test('a boost restamps the cell rows, not just the sub-area (the N1 by_cell-range trap)', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Little Cove',
      polygon: rect(-73.2, 44.2, -73.19, 44.21),
    });
    const before = (await t.run((ctx) => ctx.db.get(id)))?.minVisibleZoom ?? 0;

    await mod.as.mutation(api.subAreas.setCuratedBoost, { subAreaId: id, curatedBoost: 1 });
    const after = (await t.run((ctx) => ctx.db.get(id)))?.minVisibleZoom ?? 0;
    expect(after).toBeLessThan(before);

    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    for (const cell of cells) expect(cell.minVisibleZoom).toBe(after);
  });
});

/**
 * The Phase-10 escape hatch finally gets a writer (D56 §5). Its schema field and reader have shipped
 * since Phase 10 with zero mutations behind them.
 */
describe('waterBodies.setWeatherSamplePoints', () => {
  test('a member cannot place them', async () => {
    const t = harness();
    const body = await seedBody(t);
    const member = await seedUser(t, 'member');
    await expect(
      member.as.mutation(api.waterBodies.setWeatherSamplePoints, {
        waterBodyId: body,
        points: [{ lat: 44.5, lng: -73.0 }],
      }),
    ).rejects.toThrow(/moderator/i);
  });

  test('stores on-water points and audits the write', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setWeatherSamplePoints, {
      waterBodyId: body,
      points: [
        { lat: 44.2, lng: -73.2 },
        { lat: 44.8, lng: -72.8 },
      ],
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.weatherSamplePoints).toHaveLength(2);

    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterbody').eq('targetId', body as string),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual(['set_weather_sample_points']);
  });

  test('refuses a point on land, naming which one', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    // The one way this feature produces a *wrong* answer rather than no answer: a point on land
    // returns a real forecast for the wrong surface.
    await expect(
      mod.as.mutation(api.waterBodies.setWeatherSamplePoints, {
        waterBodyId: body,
        points: [
          { lat: 44.2, lng: -73.2 },
          { lat: 40.0, lng: -70.0 },
        ],
      }),
    ).rejects.toThrow(/point 2/i);
  });

  test('an empty array clears the field rather than storing []', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setWeatherSamplePoints, {
      waterBodyId: body,
      points: [{ lat: 44.2, lng: -73.2 }],
    });
    await mod.as.mutation(api.waterBodies.setWeatherSamplePoints, {
      waterBodyId: body,
      points: [],
    });
    // `nearestSamplePoint`'s "absent ⇒ centroid" default is then the one code path for a body that
    // doesn't need a grid — `[]` would be a second, silently-equivalent representation.
    expect((await t.run((ctx) => ctx.db.get(body)))?.weatherSamplePoints).toBeUndefined();
  });
});
