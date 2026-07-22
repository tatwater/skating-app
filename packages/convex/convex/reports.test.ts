import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

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

/** Seed a provisioned profile; `minor` true = an under-18 account (read-only — can't post, D41). */
async function seedUser(t: ReturnType<typeof convexTest>, subject: string, minor = false) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: minor ? ('private' as const) : ('public' as const),
      notificationPrefs: NOTIF_PREFS,
      // Adult by default; a minor gets a DOB ~16 years ago so `isMinor` is true at test time.
      dateOfBirth: minor ? Date.UTC(new Date().getUTCFullYear() - 16, 0, 1) : Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

const POLYGON = {
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

/** Seed a canonical water body and return its id + centroid. */
async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'osm/1') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        name: 'Lake Morey',
        type: 'lake',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return { id: body._id, centroid: body.centroid };
}

const SKATE_TIME = Date.UTC(2026, 0, 10);

describe('reports.create', () => {
  test('requires authentication', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    await expect(
      t.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('creates a native, visible report and defaults point to the body centroid', async () => {
    const t = convexTestWithGeo();
    const { id, centroid } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');

    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      iceTypes: ['black_ice'],
      notes: '  glassy  ',
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.source).toBe('native');
    expect(report?.moderationStatus).toBe('visible');
    expect(report?.point).toEqual(centroid); // no put-in pin → centroid
    expect(report?.notes).toBe('glassy'); // normalized (trimmed)
    expect(report?.reportTime).toBeGreaterThan(0);
  });

  test('stores a fully-populated report (all optional sections)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      iceTypes: ['black_ice'],
      surfaceTags: ['glass'],
      skateQuality: 'great',
      iceThickness: { readings: [{ valueCm: 12, method: 'measured' }] },
      snowCoverCm: 2,
      conditions: { airTempC: -6, sky: 'clear' },
      notes: 'perfect',
      point: { lat: 0.5, lng: 0.5 },
    });
    const r = await t.run((ctx) => ctx.db.get(reportId));
    expect(r?.skateQuality).toBe('great');
    expect(r?.iceThickness?.readings[0]?.valueCm).toBe(12);
    expect(r?.snowCoverCm).toBe(2);
    expect(r?.conditions?.source).toBe('user'); // defaulted (D19)
    expect(r?.conditions?.sky).toBe('clear');
  });

  test('honors a dropped put-in pin as the report point', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const point = { lat: 0.4, lng: 0.6 };
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      point,
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.point).toEqual(point);
  });

  test('a minor cannot create a report — read-only (D13/D41)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asMinor = await seedUser(t, 'clerk_minor', true);
    // All reports are public (D13), so an under-18 author is refused outright.
    await expect(
      asMinor.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME }),
    ).rejects.toThrow(/under 18/i);
  });

  test('rejects an invalid report at the server boundary (D37)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    await expect(
      asUser.mutation(api.reports.create, {
        waterBodyId: id,
        skateEndTime: SKATE_TIME + 400 * 24 * 60 * 60 * 1000, // absurdly future
      }),
    ).rejects.toThrow(/invalid_report/i);
  });

  test('attaches to the surviving body when the target was merged (D36)', async () => {
    const t = convexTestWithGeo();
    const loser = await seedBody(t, 'osm/loser');
    const survivor = await seedBody(t, 'osm/survivor');
    await t.run((ctx) =>
      ctx.db.patch(loser.id, { dedupStatus: 'merged', mergedIntoId: survivor.id }),
    );
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: loser.id,
      skateEndTime: SKATE_TIME,
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.waterBodyId).toEqual(survivor.id);
  });

  test('refuses a report on a removed (unlisted) body', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    await t.run((ctx) => ctx.db.patch(id, { removedAt: Date.now() }));
    const asUser = await seedUser(t, 'clerk_a');
    await expect(
      asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME }),
    ).rejects.toThrow(/not found/i);
  });

  test('rejects a photo the author does not own', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asOwner = await seedUser(t, 'clerk_owner');
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
    const photoId = await asOwner.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    const asOther = await seedUser(t, 'clerk_other');
    await expect(
      asOther.mutation(api.reports.create, {
        waterBodyId: id,
        skateEndTime: SKATE_TIME,
        photoIds: [photoId],
      }),
    ).rejects.toThrow(/not owned/i);
  });
});

describe('reports.listByWaterBody (all public, D13)', () => {
  test('sorts by skate time desc and excludes moderation-hidden reports', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');

    // Two public reports (different skate times) + one hidden by moderation.
    const older = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME - 1000,
    });
    const newer = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    const hidden = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.patch(hidden, { moderationStatus: 'hidden' }));

    // Every viewer sees the same public, non-hidden reports, newest skate time first —
    // author, another member, and an unauthenticated caller alike (all reports are public, D13).
    const expected = [newer, older];
    const asViewer = await seedUser(t, 'clerk_viewer');
    const page = { numItems: 50, cursor: null };
    const listFor = async (caller: { query: typeof t.query }) =>
      (await caller.query(api.reports.listByWaterBody, { waterBodyId: id, paginationOpts: page }))
        .page;

    // Author, another member, and an unauthenticated caller alike see the same public feed (D13).
    expect((await listFor(asViewer)).map((r) => r._id)).toEqual(expected);
    expect((await listFor(asAuthor)).map((r) => r._id)).toEqual(expected);
    expect((await listFor(t)).map((r) => r._id)).toEqual(expected);
  });

  test('paginates a body feed across pages, newest skate-end first', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    // Five reports with ascending skate-end times; the feed returns them newest-first.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await asAuthor.mutation(api.reports.create, {
          waterBodyId: id,
          skateEndTime: SKATE_TIME + i,
        }),
      );
    }
    const first = await t.query(api.reports.listByWaterBody, {
      waterBodyId: id,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map((r) => r._id)).toEqual([ids[4], ids[3]]);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.reports.listByWaterBody, {
      waterBodyId: id,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r._id)).toEqual([ids[2], ids[1]]);
  });
});

describe('reports.get (single, moderation-checked)', () => {
  test('hides a moderation-hidden report from everyone', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    const asOther = await seedUser(t, 'clerk_other');
    expect(await asOther.query(api.reports.get, { reportId })).toBeNull();
    expect(await asAuthor.query(api.reports.get, { reportId })).toBeNull();
  });

  test('returns null for a missing report; shows a public report to an anon viewer', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.delete(reportId));
    expect(await t.query(api.reports.get, { reportId })).toBeNull(); // missing

    const live = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    expect((await t.query(api.reports.get, { reportId: live }))?._id).toEqual(live); // anon sees public
  });
});

describe('reports.update (author-only LWW, D25)', () => {
  async function seedReport(t: ReturnType<typeof convexTest>) {
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      skateQuality: 'good',
      notes: 'ok',
    });
    return { asAuthor, reportId };
  }

  test('a non-author cannot edit', async () => {
    const t = convexTestWithGeo();
    const { reportId } = await seedReport(t);
    const asOther = await seedUser(t, 'clerk_other');
    await expect(
      asOther.mutation(api.reports.update, { reportId, skateEndTime: SKATE_TIME, notes: 'hacked' }),
    ).rejects.toThrow(/only the author/i);
  });

  test('re-validates on edit (rejects an invalid change)', async () => {
    const t = convexTestWithGeo();
    const { asAuthor, reportId } = await seedReport(t);
    await expect(
      asAuthor.mutation(api.reports.update, {
        reportId,
        skateEndTime: SKATE_TIME,
        snowCoverCm: -5, // invalid
      }),
    ).rejects.toThrow(/invalid_report/i);
  });

  test('a missing report throws', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    // A well-formed report id created then deleted → a dangling reference.
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.delete(reportId));
    await expect(
      asAuthor.mutation(api.reports.update, { reportId, skateEndTime: SKATE_TIME }),
    ).rejects.toThrow(/not found/i);
  });

  test('the author edits, replacing content and bumping updatedAt', async () => {
    const t = convexTestWithGeo();
    const { asAuthor, reportId } = await seedReport(t);
    const before = await t.run((ctx) => ctx.db.get(reportId));
    await asAuthor.mutation(api.reports.update, {
      reportId,
      skateEndTime: SKATE_TIME,
      surfaceTags: ['glass'],
      // omit skateQuality + notes → LWW clears them
    });
    const after = await t.run((ctx) => ctx.db.get(reportId));
    expect(after?.surfaceTags).toEqual(['glass']);
    expect(after?.skateQuality).toBeUndefined();
    expect(after?.notes).toBeUndefined();
    expect(after?.updatedAt ?? 0).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
  });
});

describe('reports.create idempotency (F2 offline flush, D30)', () => {
  test('reusing a key returns the same report — no duplicate (lost-ack retry)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const args = { waterBodyId: id, skateEndTime: SKATE_TIME, idempotencyKey: 'draft-abc' };
    const first = await asUser.mutation(api.reports.create, args);
    const second = await asUser.mutation(api.reports.create, args);
    expect(second).toBe(first);
    const all = await t.run((ctx) => ctx.db.query('reports').collect());
    expect(all).toHaveLength(1);
    expect(all[0]?.idempotencyKey).toBe('draft-abc');
  });

  test('a different author reusing a key is rejected (never hands back another user report)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asA = await seedUser(t, 'clerk_a');
    const asB = await seedUser(t, 'clerk_b');
    await asA.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      idempotencyKey: 'shared-key',
    });
    await expect(
      asB.mutation(api.reports.create, {
        waterBodyId: id,
        skateEndTime: SKATE_TIME,
        idempotencyKey: 'shared-key',
      }),
    ).rejects.toThrow(/idempotency key conflict/i);
  });

  test('no key → each call is a distinct report (online path unaffected)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const a = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    const b = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    expect(a).not.toBe(b);
  });
});

describe('reports.update / photos.create guards (review fixes)', () => {
  test('a moderated (hidden) report can no longer be edited', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    await expect(
      asUser.mutation(api.reports.update, { reportId, skateEndTime: SKATE_TIME, notes: 'edit' }),
    ).rejects.toThrow(/moderated/i);
  });

  test('photos.create rejects an out-of-range coord (range guard, D42)', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
    await expect(
      asUser.mutation(api.photos.create, {
        storageId,
        thumbStorageId: storageId,
        placeOnMap: true,
        coord: { lat: 200, lng: 0 },
      }),
    ).rejects.toThrow(/out of range/i);
  });
});

/** An axis-aligned square polygon over [west,east]×[south,north] (coords are [lng, lat]). */
function square(west: number, south: number, east: number, north: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** Seed nested VT town/county/state boundaries covering the seed body's centroid point {0.5, 0.5}. */
async function seedAdminAreas(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.adminAreas.importCanonical, {
    areas: [
      {
        externalId: 'relation/vt',
        name: 'Vermont',
        level: 'state' as const,
        state: 'VT',
        polygon: square(0, 0, 10, 10),
        bbox: { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 },
        centroid: { lat: 5, lng: 5 },
      },
      {
        externalId: 'relation/cc',
        name: 'Chittenden County',
        level: 'county' as const,
        state: 'VT',
        polygon: square(0, 0, 2, 2),
        bbox: { minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 },
        centroid: { lat: 1, lng: 1 },
      },
      {
        externalId: 'relation/burl',
        name: 'Burlington',
        level: 'town' as const,
        state: 'VT',
        polygon: square(0, 0, 1, 1),
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
      },
    ],
  });
}

const BURLINGTON_PLACE = { town: 'Burlington', county: 'Chittenden County', state: 'VT' };

describe('reports.create place stamp + skate window (Phase 5)', () => {
  test('stamps the point-derived place from the adminAreas resolver', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    await seedAdminAreas(t);
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.place).toEqual(BURLINGTON_PLACE);
  });

  test('omits place when the point resolves to no admin area', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t); // no admin areas seeded
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.place).toBeUndefined();
  });

  test('persists an optional skate start time', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const start = SKATE_TIME - 90 * 60 * 1000;
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      skateStartTime: start,
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.skateStartTime).toBe(start);
    expect(report?.skateEndTime).toBe(SKATE_TIME);
  });

  test('rejects a start after the end (contract re-enforced server-side)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    await expect(
      asUser.mutation(api.reports.create, {
        waterBodyId: id,
        skateEndTime: SKATE_TIME,
        skateStartTime: SKATE_TIME + 1000,
      }),
    ).rejects.toThrow(/invalid_report/i);
  });
});

describe('reports.listFeed (global newsfeed, Phase 5)', () => {
  const ALL = { paginationOpts: { numItems: 50, cursor: null } };

  test('orders by skate-end time desc across bodies; excludes hidden/removed (D28/D32)', async () => {
    const t = convexTestWithGeo();
    const { id: a } = await seedBody(t, 'osm/a');
    const { id: b } = await seedBody(t, 'osm/b');
    const asUser = await seedUser(t, 'clerk_a');
    const older = await asUser.mutation(api.reports.create, {
      waterBodyId: a,
      skateEndTime: SKATE_TIME - 5000,
    });
    const newer = await asUser.mutation(api.reports.create, {
      waterBodyId: b,
      skateEndTime: SKATE_TIME,
    });
    const hidden = await asUser.mutation(api.reports.create, {
      waterBodyId: a,
      skateEndTime: SKATE_TIME + 1000,
    });
    await t.run((ctx) => ctx.db.patch(hidden, { moderationStatus: 'hidden' }));

    const res = await t.query(api.reports.listFeed, ALL);
    expect(res.page.map((c) => c.reportId)).toEqual([newer, older]);
  });

  test('hidden reports never consume page slots — a small page stays full of visible ones', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    // Interleave hidden and visible so a naive filter-after-paginate would yield a short/empty page.
    const created: { reportId: string; hidden: boolean }[] = [];
    for (let i = 0; i < 6; i++) {
      const reportId = await asUser.mutation(api.reports.create, {
        waterBodyId: id,
        skateEndTime: SKATE_TIME + i,
      });
      const hidden = i % 2 === 0;
      if (hidden) await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
      created.push({ reportId, hidden });
    }
    const visibleIds = new Set(created.filter((c) => !c.hidden).map((c) => c.reportId));

    // A page of 2 must come back full — hidden rows are gated in-index, not after paginate.
    const first = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.page.every((c) => visibleIds.has(c.reportId))).toBe(true);

    const second = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);
  });

  test("a blocked author's report is STILL returned, carrying blocked: true (D3)", async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const asViewer = await seedUser(t, 'clerk_viewer');
    await asAuthor.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    await t.run(async (ctx) => {
      const profs = await ctx.db.query('profiles').collect();
      const author = profs.find((p) => p.clerkUserId === 'clerk_author');
      const viewer = profs.find((p) => p.clerkUserId === 'clerk_viewer');
      if (!author || !viewer) throw new Error('seed failed');
      await ctx.db.insert('blocks', {
        blockerId: viewer._id,
        blockedId: author._id,
        createdAt: Date.now(),
      });
    });

    const blocked = await asViewer.query(api.reports.listFeed, ALL);
    expect(blocked.page).toHaveLength(1);
    expect(blocked.page[0]?.blocked).toBe(true);

    // An unrelated viewer (and anon) sees the same report, not de-emphasized.
    const anon = await t.query(api.reports.listFeed, ALL);
    expect(anon.page[0]?.blocked).toBe(false);
  });

  test('enriches with body name, point-derived place, author, and photo thumbnails', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    await seedAdminAreas(t);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['full'])));
    const thumbStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['thumb'])));
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      placeOnMap: false,
    });
    await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      iceTypes: ['black_ice'],
      skateQuality: 'great',
      photoIds: [photoId],
    });

    const res = await t.query(api.reports.listFeed, ALL);
    const card = res.page[0];
    expect(card?.bodyName).toBe('Lake Morey');
    expect(card?.place).toEqual(BURLINGTON_PLACE);
    // A freshly-seeded author (0 points, createdAt = now) derives the cosmetic `new` trust class (D50).
    expect(card?.author).toEqual({
      displayName: 'clerk_a',
      username: 'clerk_a',
      trustClass: 'new',
    });
    expect(card?.skateQuality).toBe('great');
    expect(card?.iceTypes).toEqual(['black_ice']);
    expect(card?.photoThumbUrls).toHaveLength(1);
    expect(card?.photoThumbUrls[0]).toBeTruthy();
  });

  test('paginates via the cursor', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    for (let i = 0; i < 3; i++) {
      await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME + i });
    }
    const first = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
  });

  test('degrades gracefully when the author profile is gone (anonymized/deleted)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_gone');
    await asAuthor.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    // Hard-delete the author row (a raw teardown the app never does — deletion anonymizes, D33).
    await t.run(async (ctx) => {
      const author = (await ctx.db.query('profiles').collect()).find(
        (p) => p.clerkUserId === 'clerk_gone',
      );
      if (author) await ctx.db.delete(author._id);
    });
    const res = await t.query(api.reports.listFeed, ALL);
    expect(res.page[0]?.author).toEqual({
      displayName: 'Unknown',
      username: '',
      trustClass: null,
    });
  });

  test('resolves a merged body to its survivor name (D36)', async () => {
    const t = convexTestWithGeo();
    const { id: loser } = await seedBody(t, 'osm/loser');
    const { id: survivor } = await seedBody(t, 'osm/survivor');
    await t.run((ctx) => ctx.db.patch(survivor, { name: 'Survivor Lake' }));
    const asUser = await seedUser(t, 'clerk_a');
    // Report attaches to the loser; then the loser is merged into the survivor.
    await asUser.mutation(api.reports.create, { waterBodyId: loser, skateEndTime: SKATE_TIME });
    await t.run((ctx) => ctx.db.patch(loser, { mergedIntoId: survivor, dedupStatus: 'merged' }));

    const res = await t.query(api.reports.listFeed, ALL);
    expect(res.page[0]?.bodyName).toBe('Survivor Lake');
  });
});

describe('reports.listFeed filters + favorite boost (Phase 4)', () => {
  const ALL = { paginationOpts: { numItems: 50, cursor: null } };

  test('quality floor narrows the feed but keeps reports missing a quality (include-unknown)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const great = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME + 2,
      skateQuality: 'great',
    });
    const poor = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME + 1,
      skateQuality: 'poor',
    });
    const unrated = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });

    const res = await asUser.query(api.reports.listFeed, {
      ...ALL,
      filters: { qualityFloor: 'good' },
    });
    const ids = res.page.map((c) => c.reportId);
    expect(ids).toContain(great);
    expect(ids).toContain(unrated); // missing quality ⇒ included
    expect(ids).not.toContain(poor);
  });

  test('distance filter drops out-of-band lakes but exempts favorites', async () => {
    const t = convexTestWithGeo();
    // Two bodies: one near the home (in the 30 band), one far (out of all bands).
    const near = await seedBody(t, 'osm/near');
    const far = await seedBody(t, 'osm/far');
    // Move the far body's centroid far away so it's beyond the outer radius.
    await t.run((ctx) => ctx.db.patch(far.id, { centroid: { lat: 40, lng: -100 } }));
    const asUser = await seedUser(t, 'clerk_a');
    const nearReport = await asUser.mutation(api.reports.create, {
      waterBodyId: near.id,
      skateEndTime: SKATE_TIME + 1,
    });
    const farReport = await asUser.mutation(api.reports.create, {
      waterBodyId: far.id,
      skateEndTime: SKATE_TIME,
    });

    // Give the viewer a 30-band polygon covering the near body (centroid 0.5,0.5) + a small outer radius.
    await t.run(async (ctx) => {
      const p = (await ctx.db.query('profiles').collect())[0];
      if (!p) throw new Error('no profile');
      await ctx.db.patch(p._id, {
        homeCoord: { lat: 0.5, lng: 0.5 },
        cachedIsochrones: {
          band30: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
        outerRadiusMeters: 50_000,
      });
    });

    // Radius filter at 30 keeps only the near body.
    const filtered = await asUser.query(api.reports.listFeed, {
      ...ALL,
      filters: { radiusMinutes: 30 },
    });
    expect(filtered.page.map((c) => c.reportId)).toEqual([nearReport]);

    // Favorite the far body → it's exempt from the distance filter and comes back (boosted).
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: far.id });
    const withFav = await asUser.query(api.reports.listFeed, {
      ...ALL,
      filters: { radiusMinutes: 30 },
    });
    const ids = withFav.page.map((c) => c.reportId);
    expect(ids).toContain(nearReport);
    expect(ids).toContain(farReport);
    // The favorite is boosted to the top of the page and flagged.
    expect(withFav.page[0]?.reportId).toBe(farReport);
    expect(withFav.page[0]?.isFavorite).toBe(true);
  });

  test('favorites boost to the top of the page without changing the unfiltered set', async () => {
    const t = convexTestWithGeo();
    const a = await seedBody(t, 'osm/a');
    const b = await seedBody(t, 'osm/b');
    const asUser = await seedUser(t, 'clerk_a');
    const newest = await asUser.mutation(api.reports.create, {
      waterBodyId: a.id,
      skateEndTime: SKATE_TIME + 10,
    });
    const oldestFav = await asUser.mutation(api.reports.create, {
      waterBodyId: b.id,
      skateEndTime: SKATE_TIME,
    });
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: b.id });

    const res = await asUser.query(api.reports.listFeed, ALL);
    // Both present; the favorited (older) report is boosted above the newer non-favorite.
    expect(res.page.map((c) => c.reportId)).toEqual([oldestFav, newest]);
    expect(res.page[0]?.isFavorite).toBe(true);
  });

  test('unfiltered feed for a viewer with no home/favorites is exactly Phase 5', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const r = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    const res = await asUser.query(api.reports.listFeed, ALL);
    expect(res.page.map((c) => c.reportId)).toEqual([r]);
    expect(res.page[0]?.isFavorite).toBe(false);
  });
});

/** Like `convexTestWithGeo`, but with schema validation OFF — mirrors the Phase-3/5 migration dance
 *  (temporarily `schemaValidation: false` on a deployment with drift), so a legacy `skateTime`-shaped
 *  report can be seeded to exercise the rename migration. */
function convexTestNoValidation() {
  const t = convexTest({ ...schema, schemaValidation: false }, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

describe('reports.renameSkateTimeToSkateEndTime (Phase 5 migration)', () => {
  test('copies legacy skateTime → skateEndTime, drops the old field, and stamps place', async () => {
    const t = convexTestNoValidation();
    const { id } = await seedBody(t);
    await seedAdminAreas(t);
    await seedUser(t, 'clerk_a');
    const authorId = (await t.run((ctx) => ctx.db.query('profiles').collect()))[0]?._id;
    if (!authorId) throw new Error('seed failed');

    // A legacy report as it existed before the rename: `skateTime`, no `skateEndTime`, no `place`.
    // The field is off the current schema, so the value is cast past the typed insert (validation is
    // off on this instance, matching the production migration window).
    const legacyReport: Record<string, unknown> = {
      authorId,
      waterBodyId: id,
      point: { lat: 0.5, lng: 0.5 },
      skateTime: SKATE_TIME,
      reportTime: SKATE_TIME,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: SKATE_TIME,
      updatedAt: SKATE_TIME,
    };
    const legacyId = await t.run((ctx) => ctx.db.insert('reports', legacyReport as never));

    const result = await t.mutation(internal.reports.renameSkateTimeToSkateEndTime, {});
    expect(result.renamed).toBeGreaterThanOrEqual(1);
    expect(result.placed).toBeGreaterThanOrEqual(1);

    const migrated = await t.run((ctx) => ctx.db.get(legacyId));
    expect(migrated?.skateEndTime).toBe(SKATE_TIME);
    expect((migrated as { skateTime?: number }).skateTime).toBeUndefined();
    expect(migrated?.place).toEqual(BURLINGTON_PLACE);
  });

  test('is idempotent — a second run renames nothing and re-stamps nothing new', async () => {
    const t = convexTestNoValidation();
    const { id } = await seedBody(t);
    await seedAdminAreas(t);
    const asUser = await seedUser(t, 'clerk_a');
    // A modern report (already has skateEndTime + place) is untouched by the migration.
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    const result = await t.mutation(internal.reports.renameSkateTimeToSkateEndTime, {});
    expect(result).toEqual({ total: 1, renamed: 0, placed: 0 });
  });

  test('a cleanup-only patch (dangling skateTime, skateEndTime already set) is not counted as a rename', async () => {
    const t = convexTestNoValidation();
    const { id } = await seedBody(t);
    await seedAdminAreas(t);
    const asUser = await seedUser(t, 'clerk_a');
    // A report already migrated (has skateEndTime + place) but still carrying a dangling legacy
    // `skateTime` — a half-applied earlier run. The migration should drop the stray field without
    // reporting a rename that didn't happen.
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.patch(reportId, { skateTime: SKATE_TIME - 1 } as never));

    const result = await t.mutation(internal.reports.renameSkateTimeToSkateEndTime, {});
    expect(result.renamed).toBe(0);

    const cleaned = await t.run((ctx) => ctx.db.get(reportId));
    expect(cleaned?.skateEndTime).toBe(SKATE_TIME);
    expect((cleaned as { skateTime?: number }).skateTime).toBeUndefined();
  });
});

describe('reports counters + offline read-cache', () => {
  test('create increments the author’s reportCount (the profile total)', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    await asAuthor.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    await asAuthor.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME + 1 });
    const author = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'clerk_author'))
        .unique(),
    );
    expect(author?.reportCount).toBe(2);
  });

  test('recentCardsForBodies returns the freshest ≤5 cards per body within 72h, newest first', async () => {
    const t = convexTestWithGeo();
    const { id } = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const now = Date.now();
    // Six recent reports + one older than the 72h window.
    for (let i = 0; i < 6; i++) {
      await asAuthor.mutation(api.reports.create, {
        waterBodyId: id,
        skateEndTime: now - i * 1000,
      });
    }
    await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: now - 100 * 60 * 60 * 1000, // ~100h ago — outside the window
    });

    const cards = await t.query(api.reports.recentCardsForBodies, { waterBodyIds: [id] });
    expect(cards).toHaveLength(5); // capped at 5, the stale one excluded
    expect(cards.every((c) => c.waterBodyId === id)).toBe(true);
    // Newest-first within the window.
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i - 1]?.skateEndTime).toBeGreaterThan(cards[i]?.skateEndTime ?? 0);
    }
  });

  test('recentCardsForBodies is empty for no ids', async () => {
    const t = convexTestWithGeo();
    expect(await t.query(api.reports.recentCardsForBodies, { waterBodyIds: [] })).toEqual([]);
  });
});
