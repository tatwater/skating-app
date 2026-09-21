import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { footprintMoved } from './waterBodies';

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
  bountyAnswered: true,
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
      searchText: name,
      type: 'lakePond' as const,
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

  test('delisting a bay strips its name from the reports it labeled', async () => {
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

  test('the re-stamp pages past a single batch rather than capping (A01 round 2)', async () => {
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

  /**
   * The one loophole in "inside its parent by construction" (Decision 10). `reclipSubAreasToParent`
   * skips delisted rows on purpose — re-clipping a retired bay would resurrect geometry the operator
   * put away — so a bay delisted *before* a shoreline refinement was never held to the new outline.
   * Restore is the door it comes back through, so restore is where containment gets re-established.
   */
  test('restore re-clips against the outline the lake has NOW, not the one it had then', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });

    // The lake's eastern shore moves west while the bay is retired, trimming a quarter off it —
    // enough to matter, not enough to refuse. Nothing re-clips a delisted row, so this sits stale.
    await t.run((ctx) =>
      ctx.db.patch(body, {
        polygon: rect(-73.5, 44.0, -73.05, 45.0),
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -73.05 },
      }),
    );

    await mod.as.mutation(api.subAreas.restore, { subAreaId: id });

    const row = await t.run((ctx) => ctx.db.get(id));
    // Trimmed to the new shoreline on the way back in — not restored as drawn.
    expect(row?.bbox.maxLng).toBeCloseTo(-73.05, 6);
    expect(row?.removedAt).toBeUndefined();
  });

  test('restore refuses a bay the lake no longer contains, and says to redraw', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });
    // This time the shoreline retreats past the bay entirely.
    await t.run((ctx) =>
      ctx.db.patch(body, {
        polygon: rect(-73.5, 44.0, -73.25, 45.0),
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -73.25 },
      }),
    );

    await expect(mod.as.mutation(api.subAreas.restore, { subAreaId: id })).rejects.toThrow();
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.removedAt).toBeDefined(); // still retired, still there to redraw
  });
});

/**
 * The gate that keeps a no-op ETL run a *cheap* no-op. A clip against Champlain's 10,755-vertex
 * polygon is comfortable once and blows a mutation's 1s budget at a dozen, and the lake carries nine
 * bays today with fourteen planned — so re-clipping on every import, changed or not, was a cost that
 * grew with the curation.
 */
describe('footprintMoved', () => {
  const bbox = { minLat: 44, minLng: -73.5, maxLat: 45, maxLng: -72.5 };
  const body = { bbox, surfaceAreaSqM: 8.7e9, polygon: LAKE };

  test('identical data is not a move — this is the whole point', () => {
    expect(footprintMoved(body, { bbox: { ...bbox }, surfaceAreaSqM: 8.7e9, polygon: LAKE })).toBe(
      false,
    );
  });

  test('a shifted bbox, a changed area, or a different vertex count all count as a move', () => {
    expect(
      footprintMoved(body, {
        bbox: { ...bbox, maxLng: -72.4 },
        surfaceAreaSqM: 8.7e9,
        polygon: LAKE,
      }),
    ).toBe(true);
    expect(footprintMoved(body, { bbox: { ...bbox }, surfaceAreaSqM: 8.8e9, polygon: LAKE })).toBe(
      true,
    );
    // Same bbox, same area, re-noded shoreline: the vertex count is what catches it.
    const denser = {
      type: 'Polygon' as const,
      coordinates: [[...(LAKE.coordinates[0] ?? []), [-73.5, 44.0] as [number, number]]],
    };
    expect(
      footprintMoved(body, { bbox: { ...bbox }, surfaceAreaSqM: 8.7e9, polygon: denser }),
    ).toBe(true);
  });
});

/**
 * A system delist is the one write to this table nobody clicked, which makes it the one an operator
 * is least likely to find out about. A `console.warn` is not a surface.
 */
describe('system delists are visible where they get fixed', () => {
  test('a re-import that guts a bay leaves the reason on the row for the editor', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Champlain',
        searchText: 'Lake Champlain',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/9',
        osmId: 'way/9',
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm' as const,
          externalId: 'way/9',
          osmId: 'way/9',
          name: 'Lake Champlain',
          type: 'lakePond' as const,
          polygon: rect(-73.5, 44.0, -73.15, 45.0),
          bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -73.15 },
          centroid: { lat: 44.5, lng: -73.3 },
          surfaceAreaSqM: 3.4e9,
        },
      ],
    });

    const rows = await mod.as.query(api.subAreas.listForBody, { waterBodyId: body });
    expect(rows[0]?.removed).toBe(true);
    // The editor gets the reason next to the row, not a line in a server log.
    expect(rows[0]?.systemDelistReason).toMatch(/no longer fits/i);
  });

  test('a merge-collision delist names the moderator who ran the merge', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const survivor = await seedBody(t, 'Lake Champlain');
    const loser = await seedBody(t, 'Champlain Lake');
    const bay = rect(-73.2, 44.2, -73.0, 44.4);
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: survivor,
      name: 'Malletts Bay',
      polygon: bay,
    });
    const loserBay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: loser,
      name: 'Malletts Bay',
      polygon: bay,
    });

    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    await settle(t);

    const row = await t.run((ctx) => ctx.db.get(loserBay));
    expect(row?.removedAt).toBeDefined();
    expect(row?.systemDelistReason).toMatch(/already has a bay called/i);
    expect(row?.removedByUserId).toBe(mod.id);
    // Decision 2: every write to this table lands an audit row, including the ones nobody clicked
    // directly. A merge is somebody's click, so the log can name them.
    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterBodySubArea').eq('targetId', loserBay),
        )
        .collect(),
    );
    expect(audits.some((a) => a.action === 'remove' && a.metadata?.automatic === true)).toBe(true);
  });
});

/**
 * Decision 11, and the one hole the build found in the plan: sub-areas got their own soft-delist and
 * their own cell table with nothing connecting the two, so a takedown on the lake would have left the
 * bay labeled on a map that no longer had the lake.
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
        searchText: 'Someone Pond',
        type: 'lakePond' as const,
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
        searchText: 'Lake Champlain',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/1',
        osmId: 'way/1',
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
          osmId: 'way/1',
          name: 'Lake Champlain',
          type: 'lakePond' as const,
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

  /**
   * Both halves of this were found live against the 116k corpus, not in a unit test — a two-row
   * fixture can't produce a full page of fuzzy body matches, which is exactly the condition that
   * broke it.
   */
  test('an exact bay match outranks fuzzy body matches, and survives a full page of them', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Inland Sea',
      polygon: rect(-73.2, 44.6, -73.0, 44.8),
    });
    // Enough same-token bodies to fill the page on their own. The first cut appended bays *after*
    // slicing to `max`, so live this returned Dead Sea, Billington Sea, Seabreeze Lagoon… and not
    // the arm of Lake Champlain actually named Inland Sea.
    for (const name of ['Dead Sea', 'Billington Sea', 'Seaver Reservoir', 'Searles Pond']) {
      await t.run((ctx) =>
        ctx.db.insert('waterBodies', {
          name,
          searchText: name,
          type: 'lakePond' as const,
          source: 'osm' as const,
          polygon: rect(-70, 42, -69.99, 42.01),
          bbox: { minLat: 42, minLng: -70, maxLat: 42.01, maxLng: -69.99 },
          centroid: { lat: 42.005, lng: -69.995 },
          surfaceAreaSqM: 10_000,
          dedupStatus: 'clean' as const,
          createdAt: Date.now(),
        }),
      );
    }

    const hits = await t.query(api.waterBodies.searchByName, { query: 'Inland Sea', limit: 4 });
    // An exact name match is an exact name match whichever table holds it.
    expect(hits[0]?.name).toBe('Inland Sea');
    expect(hits[0]?.kind).toBe('subArea');
  });

  test('a body still wins at equal relevance — the merge must not break that', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Champlain Narrows',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const hits = await t.query(api.waterBodies.searchByName, { query: 'Champlain' });
    expect(hits[0]?.name).toBe('Lake Champlain');
    expect(hits[0]?.kind).toBe('body');
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
  test('a boost restamps the cell rows, not just the sub-area (the A01 by_cell-range trap)', async () => {
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

describe('subAreas.listNamedForSeeding (A10 bay-matching addendum)', () => {
  test('a listed sub-area on an active parent comes back with the parent’s states and name', async () => {
    const t = harness();
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Champlain',
        searchText: 'Lake Champlain',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        states: ['VT', 'NY'],
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });

    const page = await t.query(internal.subAreas.listNamedForSeeding, {});
    expect(page.isDone).toBe(true);
    expect(page.subAreas).toEqual([
      expect.objectContaining({
        _id: id,
        name: 'Malletts Bay',
        parentId: body,
        parentName: 'Lake Champlain',
        states: ['VT', 'NY'],
      }),
    ]);
  });

  test('excludes a delisted bay and a bay whose parent is dormant, the same rule the search box uses', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const delisted = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Retired Cove',
      polygon: rect(-73.2, 44.2, -73.19, 44.21),
    });
    await mod.as.mutation(api.subAreas.remove, { subAreaId: delisted });

    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Quiet Cove',
      polygon: rect(-73.3, 44.3, -73.29, 44.31),
    });
    await t.run((ctx) =>
      ctx.db.patch(body, { dormant: { since: Date.now(), reason: 'inactive' } }),
    );

    const page = await t.query(internal.subAreas.listNamedForSeeding, {});
    expect(page.subAreas.map((s) => s.name)).not.toContain('Retired Cove');
    expect(page.subAreas.map((s) => s.name)).not.toContain('Quiet Cove');
  });

  test('pages rather than reading the whole table at once', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'First Cove',
      polygon: rect(-73.2, 44.2, -73.19, 44.21),
    });
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Second Cove',
      polygon: rect(-73.3, 44.3, -73.29, 44.31),
    });

    const first = await t.query(internal.subAreas.listNamedForSeeding, { batchSize: 1 });
    expect(first.subAreas).toHaveLength(1);
    expect(first.isDone).toBe(false);
    const second = await t.query(internal.subAreas.listNamedForSeeding, {
      batchSize: 1,
      cursor: first.cursor,
    });
    expect(second.subAreas).toHaveLength(1);
    expect(second.isDone).toBe(true);
    expect([first, second].flatMap((p) => p.subAreas.map((s) => s.name)).sort()).toEqual([
      'First Cove',
      'Second Cove',
    ]);
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

/**
 * **`importBaySubAreas` — the campaign's bay loader, and the one that actually broke** (A07a-3).
 *
 * `load-sub-areas` calls this, and on the 2026-08-07 campaign it aborted the whole pass on one bad
 * batch and left three `sub_area_seed` rows stuck in `running` — the exact D99 signature, produced
 * by the loader written to honor D99. It had no tests at all until this block.
 */
describe('subAreas.importBaySubAreas (the A07a bay lane)', () => {
  /** A bay inside `LAKE`, which is what the merge emits after clipping to the parent. */
  const BAY = rect(-73.4, 44.1, -73.2, 44.3);

  async function seedParent(t: ReturnType<typeof convexTest>, over: Record<string, unknown> = {}) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Champlain',
        searchText: 'lake champlain',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/parent',
        osmId: 'way/parent',
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
        ...over,
      }),
    );
  }

  const bay = (over: Record<string, unknown> = {}) => ({
    name: 'Missisquoi Bay',
    polygon: BAY,
    parentIds: { osmId: 'way/parent' },
    ...over,
  });

  test('is a DRY RUN unless told otherwise — the default is the safe one', async () => {
    // `dryRun !== false`, so omitting the flag reports rather than writes. A campaign loader whose
    // default is "write" is one typo away from an unaudited insert.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay()],
    });
    expect(result).toMatchObject({ applied: false, created: 0 });
    expect(result.results[0]).toMatchObject({ ok: true, dryRun: true, parent: 'Lake Champlain' });
    expect(await t.run((ctx) => ctx.db.query('waterBodySubAreas').collect())).toHaveLength(0);
  });

  test('creates the sub-area, its cells and its audit row when applied', async () => {
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    const parent = await seedParent(t);

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay()],
      dryRun: false,
    });
    await settle(t);
    expect(result).toMatchObject({ applied: true, created: 1, refused: 0 });

    const rows = await t.run((ctx) => ctx.db.query('waterBodySubAreas').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Missisquoi Bay', waterBodyId: parent });
    // Every A02 sub-area is a rendered, searchable place, so it needs all three.
    expect(rows[0]?.searchText).toContain('Missisquoi');
    expect(rows[0]?.representativePoint).toBeDefined();
    expect(rows[0]?.minVisibleZoom).toBeDefined();

    // **Audited, per A02/D60.** A campaign that creates places without naming who ran it is the
    // thing the `--actor` flag exists to prevent.
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actorId: actor,
      action: 'create_sub_area',
      targetType: 'waterBodySubArea',
    });
    expect(actions[0]?.reason).toContain('Missisquoi Bay');

    const cells = await t.run((ctx) => ctx.db.query('waterBodySubAreaCells').collect());
    expect(cells.length).toBeGreaterThan(0);
  });

  test('is idempotent — a re-run creates nothing and reports why', async () => {
    // Every other pass in the campaign converges on a re-run; a loader that does not is one that
    // cannot safely be resumed after a failed batch, which is exactly what happened on 2026-08-07.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);
    const args = { actorUserId: actor, bays: [bay()], dryRun: false };

    await t.mutation(internal.subAreas.importBaySubAreas, args);
    await settle(t);
    const second = await t.mutation(internal.subAreas.importBaySubAreas, args);
    await settle(t);

    expect(second).toMatchObject({ created: 0, refused: 0 });
    expect(second.results[0]).toMatchObject({ ok: true, alreadyPresent: true });
    expect(await t.run((ctx) => ctx.db.query('waterBodySubAreas').collect())).toHaveLength(1);
  });

  test('matches an existing sub-area case-insensitively', async () => {
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);
    await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay()],
      dryRun: false,
    });
    await settle(t);

    const second = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay({ name: 'MISSISQUOI BAY' })],
      dryRun: false,
    });
    expect(second.results[0]).toMatchObject({ alreadyPresent: true });
  });

  test('names a bay whose parent is not there — the load-order error', async () => {
    // The ETL only emits a sub-area whose parent is in the same master list, so this can only mean
    // bodies were not loaded first. `run-corpus.sh` exists to enforce that order; this is what the
    // loader says when somebody bypasses it.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay()],
      dryRun: false,
    });
    expect(result).toMatchObject({ created: 0, refused: 1 });
    expect(result.results[0]).toMatchObject({ ok: false, reason: 'parent_unavailable' });
  });

  test('refuses a parent that has been de-listed rather than attaching to it', async () => {
    // A removed body is a landowner takedown (D48). Hanging a new public place off one would
    // re-publish the water under a different table.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t, { removedAt: Date.now(), removalReason: 'landowner_request' as const });

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay()],
      dryRun: false,
    });
    expect(result.results[0]).toMatchObject({ ok: false, reason: 'parent_unavailable' });
  });

  test('refuses an unnamed bay, which has nothing to be a place under', async () => {
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay({ name: '   ' })],
      dryRun: false,
    });
    expect(result).toMatchObject({ created: 0, refused: 1 });
    expect(result.results[0]).toMatchObject({ ok: false, reason: 'unnamed' });
  });

  test('refuses a bay that is mostly outside its parent, and says how much was retained', async () => {
    // The clip is what keeps a sub-area inside the lake it claims to be an arm of. A bay that
    // barely overlaps is a matching failure, not a bay, and the retained fraction is the number a
    // human needs to judge it.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay({ name: 'Elsewhere Bay', polygon: rect(-60.0, 30.0, -59.0, 31.0) })],
      dryRun: false,
    });
    expect(result).toMatchObject({ created: 0, refused: 1 });
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]).toHaveProperty('retained');
  });

  test('continues past a refusal instead of taking the batch down with it', async () => {
    // ⚠ The 2026-08-07 failure, as a test. The loader aborted the whole pass on one bad batch where
    // `load.ts` survives them — so a single unresolvable parent cost every bay behind it.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [
        bay({ name: '' }),
        bay({ name: 'Orphan Bay', parentIds: { osmId: 'way/nobody' } }),
        bay({ name: 'Missisquoi Bay' }),
        bay({ name: 'Keeler Bay', polygon: rect(-73.45, 44.4, -73.25, 44.6) }),
      ],
      dryRun: false,
    });
    await settle(t);
    expect(result).toMatchObject({ created: 2, refused: 2 });
    expect(
      (await t.run((ctx) => ctx.db.query('waterBodySubAreas').collect())).map((s) => s.name).sort(),
    ).toEqual(['Keeler Bay', 'Missisquoi Bay']);
  });

  test('resolves the parent by any of its catalog ids, not only OSM', async () => {
    // D93: identity is the ids on the record, and which catalog drew the outline is a separate
    // question. A bay whose parent is an NHD-drawn body must still find it.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t, { osmId: undefined, externalId: 'nhd-1', nhdId: '142978563' });

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays: [bay({ parentIds: { nhdId: '142978563' } })],
      dryRun: false,
    });
    await settle(t);
    expect(result).toMatchObject({ created: 1, refused: 0 });
  });

  test('caps the reported results without capping the work', async () => {
    // The row goes on `importRuns`, so the payload has to stay bounded — but `created` counts
    // everything. A cap that silently truncated the *work* would be the worst version of this.
    const t = harness();
    const { id: actor } = await seedUser(t, 'mod', 'moderator');
    await seedParent(t);
    const bays = Array.from({ length: 60 }, (_, i) => bay({ name: `Bay ${i}`, polygon: BAY }));

    const result = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: actor,
      bays,
      dryRun: false,
    });
    expect(result.results).toHaveLength(50);
    // One name, 60 times: the first lands and the other 59 are already present.
    expect(result.created + (result.refused ?? 0)).toBeGreaterThan(0);
    // 15s, not the 5s default. This seeds 60 bays and runs the whole import; it takes ~0.4s
    // locally and CI is comfortably 8x slower, so the default made it flake rather than fail.
    // See the repo note on heavy convex-test cases: give a legitimately slow test its own bound
    // instead of raising the global one, which would hide a genuine hang everywhere else.
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A09 (D175): a bay is a place — the re-derivation, the join, and the wider re-stamp
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A recorded track for `author` on `body`, straight along the given points (lng/lat pairs). */
async function seedTrack(
  t: ReturnType<typeof harness>,
  userId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  points: [number, number][],
) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('gpsActivities', {
      userId,
      provider: 'native' as const,
      providerActivityId: `track-${Math.random()}`,
      sportType: 'IceSkate',
      startTime: now - 60 * 60 * 1000,
      endTime: now,
      path: { type: 'LineString' as const, coordinates: points },
      waterBodyId,
      promptState: 'pending' as const,
      detectedAt: now,
    }),
  );
}

/**
 * The `reportSubAreas` rows for a report, as `[subAreaId, moderationStatus, skateEndTime]`, sorted
 * by bay id — the join has no order of its own, so neither does this.
 */
async function joinRows(t: ReturnType<typeof harness>, reportId: Id<'reports'>) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query('reportSubAreas')
      .withIndex('by_report', (q) => q.eq('reportId', reportId))
      .collect(),
  );
  return byBay(rows.map((r) => [r.subAreaId, r.moderationStatus, r.skateEndTime] as const));
}

function byBay<T extends readonly [string, ...unknown[]]>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe('the re-derivation (A09)', () => {
  test('create mints a subAreaKey and a fetch profile; redraw keeps the key and recomputes the fetch', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const before = await t.run((ctx) => ctx.db.get(id));
    expect(before?.subAreaKey).toMatch(/^sa_[0-9a-f-]{36}$/);
    expect(before?.fetchProfileM).toHaveLength(16);
    // A 0.2° × 0.2° box: every sector's fetch is hundreds of meters at least, none is zero.
    expect(Math.min(...(before?.fetchProfileM ?? [0]))).toBeGreaterThan(500);

    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: id,
      polygon: rect(-73.2, 44.2, -72.9, 44.4),
    });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.subAreaKey).toBe(before?.subAreaKey);
    expect(after?.fetchProfileM).not.toEqual(before?.fetchProfileM);
  });

  test('a redraw that moves the outline clears the derived depth and dates the change; a rename does not', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const derivedAt = Date.now() - 1000;
    await t.run((ctx) =>
      ctx.db.patch(id, {
        maxDepthM: 18,
        maxDepthSource: 'state_agency',
        depthUnderstatesMax: true,
        depthDerivedAt: derivedAt,
      }),
    );

    await mod.as.mutation(api.subAreas.rename, { subAreaId: id, name: 'Mallett’s Bay' });
    const renamed = await t.run((ctx) => ctx.db.get(id));
    expect(renamed?.maxDepthM).toBe(18);
    expect(renamed?.geometryUpdatedAt).toBeUndefined();

    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: id,
      polygon: rect(-73.2, 44.2, -72.9, 44.4),
    });
    const redrawn = await t.run((ctx) => ctx.db.get(id));
    // The number, its source and its caveat go; the date it was derived stays, so the admin card
    // can say "derived <then> · geometry changed <now>".
    expect(redrawn?.maxDepthM).toBeUndefined();
    expect(redrawn?.maxDepthSource).toBeUndefined();
    expect(redrawn?.depthUnderstatesMax).toBeUndefined();
    expect(redrawn?.depthDerivedAt).toBe(derivedAt);
    expect(redrawn?.geometryUpdatedAt).toBeGreaterThan(derivedAt);
  });

  test('a restore whose re-clip changes nothing keeps the depth — nothing about it stopped being true', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    await t.run((ctx) => ctx.db.patch(id, { maxDepthM: 18, maxDepthSource: 'state_agency' }));
    await mod.as.mutation(api.subAreas.remove, { subAreaId: id });
    await mod.as.mutation(api.subAreas.restore, { subAreaId: id });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.maxDepthM).toBe(18);
    expect(row?.geometryUpdatedAt).toBeUndefined();
  });

  test('mintSubAreaKeys backfills a legacy row once and leaves keyed rows alone', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const keyed = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Keyed',
      polygon: rect(-73.2, 44.2, -73.0, 44.4),
    });
    const legacy = await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: body,
        name: 'Legacy',
        searchText: 'Legacy',
        polygon: rect(-72.9, 44.2, -72.7, 44.4),
        bbox: { minLat: 44.2, minLng: -72.9, maxLat: 44.4, maxLng: -72.7 },
        centroid: { lat: 44.3, lng: -72.8 },
        surfaceAreaSqM: 1e8,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: mod.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const keyBefore = (await t.run((ctx) => ctx.db.get(keyed)))?.subAreaKey;
    const first = await t.mutation(internal.subAreas.mintSubAreaKeys, {});
    expect(first).toMatchObject({ keyed: 1, fetched: 1, isDone: true });
    const second = await t.mutation(internal.subAreas.mintSubAreaKeys, {});
    expect(second).toMatchObject({ keyed: 0, fetched: 0 });
    const legacyRow = await t.run((ctx) => ctx.db.get(legacy));
    expect(legacyRow?.subAreaKey).toMatch(/^sa_/);
    expect(legacyRow?.fetchProfileM).toHaveLength(16);
    expect((await t.run((ctx) => ctx.db.get(keyed)))?.subAreaKey).toBe(keyBefore);
  });
});

describe('the two-bay skate and the reportSubAreas join (A09 / D175)', () => {
  /** Two bays on the west and east shores; open water between them. */
  async function setup() {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const west = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'West Bay',
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    const east = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'East Bay',
      polygon: rect(-72.8, 44.2, -72.5, 44.6),
    });
    await settle(t);
    const author = await seedUser(t, 'author');
    return { t, body, mod, west, east, author };
  }

  /** West bay → open water → east bay (most of the samples), starting at a west-shore put-in. */
  const TWO_BAY_TRACK: [number, number][] = [
    [-73.45, 44.4],
    [-73.4, 44.4],
    [-73.35, 44.4],
    [-73.1, 44.4],
    [-72.75, 44.4],
    [-72.7, 44.4],
    [-72.65, 44.4],
    [-72.6, 44.4],
    [-72.55, 44.4],
  ];

  test('an activity report is stamped from the track, not its start point, and lists both bays', async () => {
    const { t, body, west, east, author } = await setup();
    const activityId = await seedTrack(t, author.id, body, TWO_BAY_TRACK);
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      activityId,
      // The put-in — in the west bay. Before A09 this alone decided the stamp.
      point: { lat: 44.4, lng: -73.45 },
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.subAreaId).toBe(east);
    expect(report?.subAreaName).toBe('East Bay');
    expect(report?.subAreaIds).toEqual([east, west]);
    expect(report?.subAreaNames).toEqual(['East Bay', 'West Bay']);
    expect(await joinRows(t, reportId)).toEqual(
      byBay([
        [east, 'visible', report?.skateEndTime],
        [west, 'visible', report?.skateEndTime],
      ]),
    );
  });

  test('the bay feed serves a spanning report under both bays — once each, never twice in one', async () => {
    const { t, body, west, east, author } = await setup();
    const activityId = await seedTrack(t, author.id, body, TWO_BAY_TRACK);
    const spanning = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      activityId,
      point: { lat: 44.4, lng: -73.45 },
    });
    const westOnly = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now() - 1000,
      point: { lat: 44.3, lng: -73.4 },
    });
    const PAGE = { numItems: 50, cursor: null };
    const eastFeed = await t.query(api.reports.listByWaterBody, {
      waterBodyId: body,
      subAreaId: east,
      paginationOpts: PAGE,
    });
    expect(eastFeed.page.map((r) => r._id)).toEqual([spanning]);
    const westFeed = await t.query(api.reports.listByWaterBody, {
      waterBodyId: body,
      subAreaId: west,
      paginationOpts: PAGE,
    });
    expect(westFeed.page.map((r) => r._id)).toEqual([spanning, westOnly]);
    // And the lake's own feed is still one row per report.
    const lakeFeed = await t.query(api.reports.listByWaterBody, {
      waterBodyId: body,
      paginationOpts: PAGE,
    });
    expect(lakeFeed.page.map((r) => r._id)).toEqual([spanning, westOnly]);
  });

  test('a bounty on the second bay is satisfied by the spanning report', async () => {
    const { t, body, west, east, author } = await setup();
    const requester = await seedUser(t, 'requester');
    const bountyId = await requester.as.action(api.bounties.create, {
      waterBodyId: body,
      subAreaId: west,
    });
    const activityId = await seedTrack(t, author.id, body, TWO_BAY_TRACK);
    const spanning = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      activityId,
      point: { lat: 44.4, lng: -72.55 }, // launched from the *east* shore this time
      iceTypes: ['black_ice'],
    });
    expect((await t.run((ctx) => ctx.db.get(spanning)))?.subAreaId).toBe(east);
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toEqual([spanning]);
  });

  test('a moderation verdict and an edited skate time reach the join', async () => {
    const { t, body, west, mod, author } = await setup();
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.3, lng: -73.4 },
    });
    const later = Date.now() - 5 * 60 * 1000;
    await author.as.mutation(api.reports.update, { reportId, skateEndTime: later });
    expect(await joinRows(t, reportId)).toEqual([[west, 'visible', later]]);

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'test',
    });
    expect(await joinRows(t, reportId)).toEqual([[west, 'hidden', later]]);
    const feed = await t.query(api.reports.listByWaterBody, {
      waterBodyId: body,
      subAreaId: west,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(feed.page).toEqual([]);
  });

  test('editing the pin re-resolves membership without collapsing a track-stamped report', async () => {
    const { t, body, west, east, author } = await setup();
    const activityId = await seedTrack(t, author.id, body, TWO_BAY_TRACK);
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      activityId,
      point: { lat: 44.4, lng: -73.45 },
    });
    await author.as.mutation(api.reports.update, {
      reportId,
      skateEndTime: Date.now(),
      point: { lat: 44.4, lng: -73.1 }, // open water — irrelevant, the track decides
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.subAreaIds).toEqual([east, west]);
    expect((await joinRows(t, reportId)).map((r) => r[0])).toEqual([east, west].sort());
  });

  test('the backfill seeds the join from existing stamps and is idempotent', async () => {
    const { t, body, west, author } = await setup();
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      point: { lat: 44.3, lng: -73.4 },
    });
    // Simulate a pre-A09 row: stamped, but with no join.
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query('reportSubAreas')
        .withIndex('by_report', (q) => q.eq('reportId', reportId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
    });
    expect(await joinRows(t, reportId)).toEqual([]);
    const first = await t.mutation(internal.subAreas.backfillReportSubAreas, {});
    expect(first).toMatchObject({ withBay: 1, inserted: 1, isDone: true });
    const second = await t.mutation(internal.subAreas.backfillReportSubAreas, {});
    expect(second).toMatchObject({ withBay: 1, inserted: 0 });
    expect((await joinRows(t, reportId)).map((r) => r[0])).toEqual([west]);
  });
});

describe('the wider re-stamp (A09)', () => {
  test('a redraw re-tags put-ins by distance, tracks by majority, and features by center', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'West Bay',
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    await settle(t);

    // A launch on the lake's west shore, a track that runs the width of the bay-to-be, a feature
    // in the middle of the lake: none of them is in the bay yet.
    const putIn = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.8, lng: -73.5 },
        source: 'official' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const track = await seedTrack(t, author.id, body, [
      [-73.2, 44.8],
      [-73.1, 44.8],
      [-73.0, 44.8],
    ]);
    const feature = await t.run((ctx) =>
      ctx.db.insert('bodyFeatures', {
        waterBodyId: body,
        type: 'spring_current' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [-73.1, 44.8] },
        radiusMeters: 50,
        bbox: { minLat: 44.79, minLng: -73.11, maxLat: 44.81, maxLng: -73.09 },
        addedByUserId: mod.id,
        active: true,
        createdAt: Date.now(),
      }),
    );
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.subAreaId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(track)))?.subAreaId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(feature)))?.subAreaId).toBeUndefined();

    // Redraw the bay to take in the north-west of the lake, where all three sit.
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: bay,
      polygon: rect(-73.5, 44.2, -73.05, 44.9),
    });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.subAreaId).toBe(bay);
    const stampedTrack = await t.run((ctx) => ctx.db.get(track));
    expect(stampedTrack?.subAreaId).toBe(bay);
    expect(stampedTrack?.subAreaIds).toBeUndefined();
    // Its last sample (−73.0) is on the lake outside the bay: the mouth-line flag.
    expect(stampedTrack?.leftSubArea).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(feature)))?.subAreaId).toBe(bay);

    // And shrinking it back releases them all.
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: bay,
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.subAreaId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(track)))?.subAreaId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(track)))?.leftSubArea).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(feature)))?.subAreaId).toBeUndefined();
  });
});

describe('the stamps at write (A09)', () => {
  async function setup() {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const west = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'West Bay',
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    const east = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'East Bay',
      polygon: rect(-72.8, 44.2, -72.5, 44.6),
    });
    await settle(t);
    return { t, body, mod, west, east };
  }

  test('an official put-in on a bay shore is tagged with the bay; one on open shore is not', async () => {
    const { t, body, mod, west } = await setup();
    // The lake's west shore, inside the bay's latitude band — snapped onto the outline both share.
    const inBay = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId: body,
      coord: { lat: 44.4, lng: -73.5005 },
    });
    expect((await t.run((ctx) => ctx.db.get(inBay)))?.subAreaId).toBe(west);
    const openShore = await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId: body,
      coord: { lat: 44.9, lng: -73.5005 },
    });
    expect((await t.run((ctx) => ctx.db.get(openShore)))?.subAreaId).toBeUndefined();
    // A hide row is tagged too.
    const hidden = await mod.as.mutation(api.putIns.hide, {
      waterBodyId: body,
      coord: { lat: 44.3, lng: -73.5 },
      reason: 'private',
    });
    expect((await t.run((ctx) => ctx.db.get(hidden)))?.subAreaId).toBe(west);
  });

  test('a recorded track is stamped at ingest: majority bay, every bay, and the mouth-line flag', async () => {
    const { t, body, west, east } = await setup();
    const skater = await seedUser(t, 'skater');
    const now = Date.now();
    const activityId = await skater.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'two-bay',
      path: {
        type: 'LineString',
        coordinates: [
          [-73.45, 44.4],
          [-73.4, 44.4],
          [-73.1, 44.4],
          [-72.7, 44.4],
          [-72.65, 44.4],
          [-72.6, 44.4],
        ],
      },
      startTime: now - 3_600_000,
      endTime: now,
      waterBodyId: body,
    });
    const row = await t.run((ctx) => ctx.db.get(activityId));
    expect(row?.waterBodyId).toBe(body);
    expect(row?.subAreaId).toBe(east);
    expect(row?.subAreaIds).toEqual([east, west]);
    expect(row?.leftSubArea).toBe(true);
  });

  test('a known feature is stamped by its footprint center', async () => {
    const { t, body, mod, west } = await setup();
    const id = await mod.as.mutation(api.bodyFeatures.create, {
      waterBodyId: body,
      type: 'spring_current',
      geometry: { type: 'Point', coordinates: [-73.4, 44.4] },
      radiusMeters: 30,
      reason: 'known spring',
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.subAreaId).toBe(west);
  });
});

describe('the bay view reads (A09)', () => {
  async function setup() {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const west = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'West Bay',
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    await settle(t);
    return { t, body, mod, west };
  }

  test('hazards narrow to the bay by footprint center', async () => {
    const { t, body, west } = await setup();
    const author = await seedUser(t, 'author');
    const inBay = await author.as.mutation(api.hazards.create, {
      waterBodyId: body,
      type: 'pressure_ridge',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [-73.4, 44.4] },
      radiusMeters: 25,
    });
    await author.as.mutation(api.hazards.create, {
      waterBodyId: body,
      type: 'pressure_ridge',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [-72.7, 44.8] },
      radiusMeters: 25,
    });
    const all = await t.query(api.hazards.listForBody, { waterBodyId: body });
    expect(all).toHaveLength(2);
    const bay = await t.query(api.hazards.listForBody, { waterBodyId: body, subAreaId: west });
    expect(bay.map((h) => h._id)).toEqual([inBay]);
  });

  // ⚠ The review found this one: the bay view narrowed its hazards but still listed every known
  // feature on the lake, so a spring in the far bay showed up as safety context for this one.
  test('known features narrow to the bay by the same footprint-center stamp', async () => {
    const { t, body, mod, west } = await setup();
    const inBay = await mod.as.mutation(api.bodyFeatures.create, {
      waterBodyId: body,
      type: 'spring_current',
      geometry: { type: 'Point', coordinates: [-73.4, 44.4] },
      radiusMeters: 30,
      reason: 'known spring',
    });
    await mod.as.mutation(api.bodyFeatures.create, {
      waterBodyId: body,
      type: 'gas_hole',
      geometry: { type: 'Point', coordinates: [-72.7, 44.8] },
      radiusMeters: 30,
      reason: 'marsh gas, other end of the lake',
    });
    const all = await t.query(api.bodyFeatures.listForBody, { waterBodyId: body });
    expect(all).toHaveLength(2);
    const bay = await t.query(api.bodyFeatures.listForBody, { waterBodyId: body, subAreaId: west });
    expect(bay.map((f) => f._id)).toEqual([inBay]);
  });

  test('bounties narrow to the bay plus the lake-wide asks a bay report can answer', async () => {
    const { t, body, west, mod } = await setup();
    const east = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'East Bay',
      polygon: rect(-72.8, 44.2, -72.5, 44.6),
    });
    await settle(t);
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const c = await seedUser(t, 'c');
    const onWest = await a.as.action(api.bounties.create, { waterBodyId: body, subAreaId: west });
    await b.as.action(api.bounties.create, { waterBodyId: body, subAreaId: east });
    const lakeWide = await c.as.action(api.bounties.create, { waterBodyId: body });
    const listed = await t.query(api.bounties.listForBody, { waterBodyId: body, subAreaId: west });
    expect(listed.map((x) => x._id).sort()).toEqual([onWest, lakeWide].sort());
    expect((await t.query(api.bounties.listForBody, { waterBodyId: body })).length).toBe(3);
  });

  test('access narrows to the bay’s launches, the lots they serve, and lots within reach of its shore', async () => {
    const { t, body, west } = await setup();
    const insertLot = (lng: number, lat: number) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert('parkingAreas', {
          coord: { lat, lng },
          source: 'osm' as const,
          status: 'visible' as const,
          amenities: [],
          createdAt: Date.now(),
        });
        await ctx.db.insert('parkingAreaBodies', {
          parkingAreaId: id,
          waterBodyId: body,
          inferred: true,
          createdAt: Date.now(),
        });
        return id;
      });
    // A lot far up the lake, served by the open-shore launch; a lot just west of the bay's shore
    // that no launch references; and a lot served by the bay's launch.
    const farLot = await insertLot(-73.52, 44.9);
    const nearBayLot = await insertLot(-73.5015, 44.3); // ~120 m west of the bay's shore
    const bayLot = await insertLot(-73.52, 44.4);
    const insertPutIn = (lng: number, lat: number, parkingAreaId: Id<'parkingAreas'>) =>
      t.run((ctx) =>
        ctx.db.insert('putIns', {
          waterBodyId: body,
          coord: { lat, lng },
          source: 'osm' as const,
          status: 'visible' as const,
          parkingAreaId,
          createdAt: Date.now(),
        }),
      );
    const openLaunch = await insertPutIn(-73.5, 44.9, farLot);
    const bayLaunch = await insertPutIn(-73.5, 44.4, bayLot);
    // Tag them the way a redraw would (the rows were inserted raw).
    await t.run((ctx) => ctx.db.patch(bayLaunch, { subAreaId: west }));

    const lake = await t.query(api.accessPoints.accessForBody, { waterBodyId: body });
    expect(lake.putIns.map((p) => p.id).sort()).toEqual([openLaunch, bayLaunch].sort());
    expect(lake.parking).toHaveLength(3);

    const bay = await t.query(api.accessPoints.accessForBody, {
      waterBodyId: body,
      subAreaId: west,
    });
    expect(bay.putIns.map((p) => p.id)).toEqual([bayLaunch]);
    expect(bay.parking.map((p) => p.id).sort()).toEqual([bayLot, nearBayLot].sort());
  });

  test('the admin card counts this season’s skates past the mouth line and dates the depth', async () => {
    const { t, body, west, mod } = await setup();
    const skater = await seedUser(t, 'skater');
    const now = Date.now();
    const track = async (key: string, points: [number, number][]) =>
      skater.as.mutation(api.gpsActivities.ingestTrack, {
        idempotencyKey: key,
        path: { type: 'LineString', coordinates: points },
        startTime: now - 3_600_000,
        endTime: now,
        waterBodyId: body,
      });
    await track('stayed', [
      [-73.45, 44.4],
      [-73.4, 44.4],
      [-73.35, 44.4],
    ]);
    await track('left', [
      [-73.45, 44.4],
      [-73.4, 44.4],
      [-73.1, 44.4],
    ]);
    await expect(
      skater.as.query(api.subAreas.adminStatsForBody, { waterBodyId: body }),
    ).rejects.toThrow(/moderator/i);
    const derivedAt = now - 10_000;
    await t.run((ctx) =>
      ctx.db.patch(west, {
        maxDepthM: 12,
        maxDepthSource: 'state_agency',
        depthDerivedAt: derivedAt,
      }),
    );
    const before = await mod.as.query(api.subAreas.adminStatsForBody, { waterBodyId: body });
    expect(before[west]).toMatchObject({
      skatesCount: 2,
      leftSubAreaCount: 1,
      leftSubAreaTruncated: false,
      maxDepthM: 12,
      depthDerivedAt: derivedAt,
    });
    expect(before[west]?.fetchProfileM).toHaveLength(16);
    // A redraw clears the depth and dates the change; the card can now say the re-run is owed.
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: west,
      polygon: rect(-73.5, 44.2, -73.25, 44.6),
    });
    const after = await mod.as.query(api.subAreas.adminStatsForBody, { waterBodyId: body });
    expect(after[west]?.maxDepthM).toBeUndefined();
    expect(after[west]?.depthDerivedAt).toBe(derivedAt);
    expect(after[west]?.geometryUpdatedAt).toBeGreaterThan(derivedAt);
  });
});

describe('restampAllParents — the one-off for rows that predate A09', () => {
  test('schedules one sweep per parent, and the sweep tags the untagged rows', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'West Bay',
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'East Bay',
      polygon: rect(-72.8, 44.2, -72.5, 44.6),
    });
    await settle(t);
    // A pre-A09 launch: on the bay's shore, never tagged.
    const putIn = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.4, lng: -73.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    expect(await t.mutation(internal.subAreas.restampAllParents, {})).toEqual({ parents: 1 });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.subAreaId).toBe(bay);
  });
});

describe('the depth lane’s two ends (A09 PR 2)', () => {
  test('setDerivedDepth writes by key, refuses a bay whose outline is not the one exported, and dryRun writes nothing', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'West Bay',
      polygon: rect(-73.5, 44.2, -73.3, 44.6),
    });
    await settle(t);
    const exported = await t.query(internal.subAreas.exportForDepths, {});
    expect(exported.map((b) => b.subAreaId)).toEqual([bay]);
    const key = exported[0]?.subAreaKey as string;
    const snapshotAt = Date.now();
    // Never redrawn: no stamp, and the row echoes that back.
    expect(exported[0]?.geometryUpdatedAt).toBeUndefined();

    const dry = await t.mutation(internal.subAreas.setDerivedDepth, {
      rows: [{ subAreaKey: key, maxDepthM: 18.3, understatesMax: true }],
      dryRun: true,
    });
    expect(dry).toMatchObject({ written: 1, dryRun: true });
    expect((await t.run((ctx) => ctx.db.get(bay)))?.maxDepthM).toBeUndefined();

    const wet = await t.mutation(internal.subAreas.setDerivedDepth, {
      rows: [
        { subAreaKey: key, maxDepthM: 18.3, understatesMax: true },
        { subAreaKey: 'sa_nope', maxDepthM: 5, understatesMax: false },
      ],
    });
    expect(wet.written).toBe(1);
    expect(wet.refused).toEqual([{ subAreaKey: 'sa_nope', reason: 'not_found' }]);
    // The persistence boundary's own cap, whatever the caller applied.
    const deep = await t.mutation(internal.subAreas.setDerivedDepth, {
      rows: [{ subAreaKey: key, maxDepthM: 401, understatesMax: false }],
    });
    expect(deep.refused).toEqual([{ subAreaKey: key, reason: 'implausible' }]);
    const row = await t.run((ctx) => ctx.db.get(bay));
    expect(row).toMatchObject({
      maxDepthM: 18.3,
      maxDepthSource: 'state_agency',
      depthUnderstatesMax: true,
    });
    expect(row?.depthDerivedAt).toBeGreaterThanOrEqual(snapshotAt);

    // A redraw after the export: the export's number is about an outline that no longer exists.
    // A version check, not a clock comparison — the same millisecond, or a host clock running ahead
    // of the server's, changes nothing.
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: bay,
      polygon: rect(-73.5, 44.2, -73.25, 44.6),
    });
    const stale = await t.mutation(internal.subAreas.setDerivedDepth, {
      rows: [{ subAreaKey: key, maxDepthM: 20, understatesMax: false }],
    });
    expect(stale.refused).toEqual([{ subAreaKey: key, reason: 'geometry_moved' }]);
    expect((await t.run((ctx) => ctx.db.get(bay)))?.maxDepthM).toBeUndefined();
    // Re-exported after the redraw, the row carries the new stamp and lands.
    const again = await t.query(internal.subAreas.exportForDepths, {});
    const fresh = await t.mutation(internal.subAreas.setDerivedDepth, {
      rows: [
        {
          subAreaKey: key,
          maxDepthM: 20,
          understatesMax: false,
          geometryUpdatedAt: again[0]?.geometryUpdatedAt,
        },
      ],
    });
    expect(fresh).toMatchObject({ written: 1, refused: [] });
    expect(snapshotAt).toBeLessThanOrEqual(Date.now());
  });
});

/**
 * Sub-areas by chord (D201): the server derives the polygon from the mouth against the stored
 * parent, the mouth rides the row, a free-draw redraw clears it, and a re-import re-derives from it.
 */
describe('sub-areas by chord (D201)', () => {
  /** A chord across the lake's south-west corner: the east-going shore from `a`, the chord back. */
  const CORNER = {
    a: { lat: 44.2, lng: -73.5 }, // on the west shore
    b: { lat: 44.0, lng: -73.3 }, // on the south shore
    side: { lat: 44.05, lng: -73.45 }, // inside the corner triangle
    sagittaM: 0,
  };

  async function seedCanonicalBody(t: ReturnType<typeof convexTest>) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Champlain',
        searchText: 'Lake Champlain',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/1',
        osmId: 'way/1',
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
  }

  async function bayRequest(
    t: ReturnType<typeof convexTest>,
    requesterId: Id<'profiles'>,
    waterBodyId: Id<'waterBodies'>,
    name: string,
  ) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay' as const,
        status: 'open' as const,
        requesterId,
        coord: CORNER.side,
        waterBodyId,
        name,
        createdAt: Date.now(),
      }),
    );
  }

  test('stores the mouth beside the derived polygon, on the lake’s own shore, and audits the chord', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    const id = await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: body,
      name: 'Corner Bay',
      aliases: ['SW Corner'],
      mouth: CORNER,
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.mouth).toEqual(CORNER);
    // The polygon is the walked shoreline plus the chord: its extent is the corner, exactly.
    expect(row?.bbox).toEqual({ minLat: 44.0, minLng: -73.5, maxLat: 44.2, maxLng: -73.3 });
    expect(row?.subAreaKey).toMatch(/^sa_/);
    expect(row?.fetchProfileM?.length).toBe(16);

    const listed = await mod.as.query(api.subAreas.listForBody, { waterBodyId: body });
    expect(listed[0]?.mouth).toEqual(CORNER);

    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterBodySubArea').eq('targetId', id as string),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual(['create_sub_area']);
    expect(audits[0]?.metadata).toMatchObject({ via: 'chord', sagittaM: 0 });
  });

  test('a bay drawn from a request approves it — and every open ask for the same bay', async () => {
    const t = harness();
    const body = await seedCanonicalBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const two = await seedUser(t, 'two');
    const requestId = await bayRequest(t, one.id, body, 'Corner Bay');
    const sibling = await bayRequest(t, two.id, body, 'corner bay');
    const unrelated = await bayRequest(t, two.id, body, 'Other Bay');
    // The decision closes the asks that existed when it was made: under fake timers every insert
    // lands a hair after the frozen clock, so let the clock pass them first.
    vi.advanceTimersByTime(1_000);

    const id = await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: body,
      name: 'Corner Bay',
      mouth: CORNER,
      requestId,
    });

    const rows = await t.run((ctx) =>
      Promise.all([requestId, sibling, unrelated].map((r) => ctx.db.get(r))),
    );
    expect(rows.map((r) => r?.status)).toEqual(['approved', 'approved', 'open']);
    const audit = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterBodyRequest').eq('targetId', requestId as string),
        )
        .first(),
    );
    expect(audit?.action).toBe('approve_request');
    expect(audit?.metadata).toMatchObject({ kind: 'name_bay', subAreaId: id });
  });

  test('refuses a request that is not a bay ask on this lake, and draws nothing', async () => {
    const t = harness();
    const here = await seedCanonicalBody(t);
    const there = await seedBody(t, 'Lake George');
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const elsewhere = await bayRequest(t, one.id, there, 'Corner Bay');

    await expect(
      mod.as.mutation(api.subAreas.createFromChord, {
        waterBodyId: here,
        name: 'Corner Bay',
        mouth: CORNER,
        requestId: elsewhere,
      }),
    ).rejects.toThrow(/not a bay request on this lake/);
    expect(await t.run((ctx) => ctx.db.query('waterBodySubAreas').collect())).toHaveLength(0);
  });

  test('a refused construction is a ConvexError the editor can render, by code', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.subAreas.createFromChord, {
        waterBodyId: body,
        name: 'Nothing Bay',
        mouth: { ...CORNER, b: CORNER.a },
      }),
    ).rejects.toMatchObject({
      data: { code: 'sub_area_coincident', message: expect.stringMatching(/same spot/) },
    });
  });

  test('a free-drawn bay can be redrawn by chord, and a chord bay redrawn freehand loses its mouth', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Corner Bay',
      polygon: rect(-73.5, 44.0, -73.4, 44.1),
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.mouth).toBeUndefined();

    await mod.as.mutation(api.subAreas.updateChord, { subAreaId: id, mouth: CORNER });
    let row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.mouth).toEqual(CORNER);
    expect(row?.bbox.maxLng).toBe(-73.3);
    // A geometry change: the derived depth is owed again (A09), as after any redraw.
    expect(row?.geometryUpdatedAt).toBeDefined();

    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: id,
      polygon: rect(-73.5, 44.0, -73.4, 44.1),
    });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.mouth).toBeUndefined();
    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterBodySubArea').eq('targetId', id as string),
        )
        .collect(),
    );
    expect(audits.at(-1)?.metadata).toMatchObject({ mouthCleared: true });
  });

  test('a re-import that moves the shore re-derives a chord bay from its mouth, not from its old shape', async () => {
    const t = harness();
    const body = await seedCanonicalBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    // Across the south-east corner: `a` on the east shore, `b` on the south shore.
    const mouth = {
      a: { lat: 44.2, lng: -72.5 },
      b: { lat: 44.0, lng: -72.7 },
      side: { lat: 44.05, lng: -72.65 },
      sagittaM: 0,
    };
    const id = await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: body,
      name: 'Corner Bay',
      mouth,
    });

    // The refined outline pulls the east shore 0.1° west. `a` re-snaps to the new shore and the
    // bay's hypotenuse now runs from (−72.6, 44.2) — a vertex a plain clip of the old triangle
    // could never produce (the clip would cut the old hypotenuse at (−72.6, 44.1)).
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm' as const,
          externalId: 'way/1',
          osmId: 'way/1',
          name: 'Lake Champlain',
          type: 'lakePond' as const,
          polygon: rect(-73.5, 44.0, -72.6, 45.0),
          bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.6 },
          centroid: { lat: 44.5, lng: -73.05 },
          surfaceAreaSqM: 7.8e9,
        },
      ],
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.removedAt).toBeUndefined();
    expect(row?.mouth).toEqual(mouth); // the fact is kept; the shape follows it
    const ring = (row?.polygon as { coordinates: number[][][] } | undefined)?.coordinates[0] ?? [];
    expect(ring.some(([lng, lat]) => lng === -72.6 && lat === 44.2)).toBe(true);
    expect(ring.some(([lng, lat]) => lng === -72.6 && Math.abs((lat ?? 0) - 44.1) < 1e-6)).toBe(
      false,
    );
  });

  test('a re-import that leaves the mouth’s shore alone leaves the chord bay alone', async () => {
    const t = harness();
    const body = await seedCanonicalBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: body,
      name: 'Corner Bay',
      mouth: CORNER,
    });
    const before = await t.run((ctx) => ctx.db.get(id));

    // Only the north shore moves; the south-west corner is untouched.
    await reimportLake(t, rect(-73.5, 44.0, -72.5, 44.9), { maxLat: 44.9 });

    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.polygon).toEqual(before?.polygon);
    expect(after?.geometryUpdatedAt).toBe(before?.geometryUpdatedAt);
    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_sub_area', (q) => q.eq('subAreaId', id))
        .collect(),
    );
    expect(cells.length).toBeGreaterThan(0);
  });

  test('when the mouth no longer works on the new outline, the bay is re-clipped and the mouth kept for the editor', async () => {
    const t = harness();
    const body = await seedCanonicalBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    // The side point sits just inside the corner.
    const mouth = { ...CORNER, side: { lat: 44.01, lng: -73.49 } };
    const id = await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: body,
      name: 'Corner Bay',
      mouth,
    });

    // The south shore moves north past the side point: it is on land now, in neither candidate,
    // and the construction refuses. The plain re-clip still trims the stored shape to the new
    // outline (Decision 10 survives), and the mouth stays on the row as the editor's starting point.
    await reimportLake(t, rect(-73.5, 44.02, -72.5, 45.0), { minLat: 44.02 });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.removedAt).toBeUndefined();
    expect(row?.mouth).toEqual(mouth);
    expect(row?.bbox.minLat).toBeCloseTo(44.02, 6);
  });

  function reimportLake(
    t: ReturnType<typeof convexTest>,
    polygon: ReturnType<typeof rect>,
    box: Partial<{ minLat: number; minLng: number; maxLat: number; maxLng: number }>,
  ) {
    return t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm' as const,
          externalId: 'way/1',
          osmId: 'way/1',
          name: 'Lake Champlain',
          type: 'lakePond' as const,
          polygon,
          bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5, ...box },
          centroid: { lat: 44.5, lng: -73.0 },
          surfaceAreaSqM: 7.8e9,
        },
      ],
    });
  }
});
