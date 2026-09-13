import { zonedHour } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { FLUSH_BATCH_CAP, FLUSH_READ_BUDGET } from './notifications';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  return t;
}

const BASE_PREFS = {
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

/** Covers the seeded body centroid (0.5, 0.5) — used as a viewer's 30-min band. */
const BAND30: Polygon = {
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
};

interface ProfileOpts {
  prefs?: Partial<typeof BASE_PREFS>;
  allRadiusMinutes?: number;
  greatRadiusMinutes?: number;
  inBand?: boolean;
}

async function seedProfile(
  t: ReturnType<typeof convexTest>,
  subject: string,
  opts: ProfileOpts = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      ...(opts.inBand
        ? {
            homeCoord: { lat: 0.5, lng: 0.5 },
            cachedIsochrones: { band30: BAND30 },
            outerRadiusMeters: 50_000,
          }
        : {}),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: { ...BASE_PREFS, ...opts.prefs },
      ...(opts.allRadiusMinutes !== undefined ? { allRadiusMinutes: opts.allRadiusMinutes } : {}),
      ...(opts.greatRadiusMinutes !== undefined
        ? { greatRadiusMinutes: opts.greatRadiusMinutes }
        : {}),
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id: id as Id<'profiles'>, as: t.withIdentity({ subject }) };
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

async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'osm/1') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: 'Lake Morey',
        type: 'lakePond',
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
  return body._id as Id<'waterBodies'>;
}

const SKATE_TIME = Date.UTC(2026, 0, 10);

/** Make every pending queue row due, then flush; returns the delivered `notifications` rows. */
async function flushAllDue(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('notificationQueue').collect()) {
      await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    }
  });
  await t.mutation(internal.notifications.flushNotificationQueue, {});
  return t.run((ctx) => ctx.db.query('notifications').collect());
}

/**
 * Take the flush's self-scheduled continuation off the table: count the pending
 * `flushNotificationQueue` jobs and cancel them, so the test drives the next batch by hand.
 *
 * convex-test backs `runAfter(0)` with a *real* `setTimeout(0)`. It stays dormant only while the
 * test does microtask work — the first yield to the event loop would run the continuation and drain
 * the queue underneath the assertions that follow (verified: one `setTimeout(0)` await flips the job
 * to `success`). Cancelling makes the ordering explicit instead of an accident of the event loop.
 */
async function cancelScheduledFlushes(t: ReturnType<typeof convexTest>): Promise<number> {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query('_scheduled_functions').collect();
    const pending = jobs.filter(
      (j) => j.name === 'notifications:flushNotificationQueue' && j.state.kind === 'pending',
    );
    for (const job of pending) await ctx.scheduler.cancel(job._id);
    return pending.length;
  });
}

/**
 * Create a report and run its distance fan-out, the way the scheduler does in production (N1).
 * `reports.create` schedules `fanOutNearbyNotifications` rather than walking every profile inline;
 * convex-test won't drive a `runAfter(0)` job without fake timers, so drive it explicitly here.
 * (That the scheduling *happens* is asserted separately, off `_scheduled_functions`.)
 */
async function createReport(
  t: ReturnType<typeof convexTest>,
  as: ReturnType<ReturnType<typeof convexTest>['withIdentity']>,
  args: { waterBodyId: Id<'waterBodies'>; skateEndTime: number; skateQuality?: string },
) {
  const reportId = await as.mutation(api.reports.create, args as never);
  await t.mutation(internal.notifications.fanOutNearbyNotifications, { reportId });
  return reportId;
}

describe('notifications — favorites', () => {
  test('a favorited-body report enqueues for the favoriter, not the author, and coalesces', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const fan = await seedProfile(t, 'fan');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME + 1 });

    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1); // coalesced into one row
    expect(queue[0]?.userId).toBe(fan.id);
    expect(queue[0]?.kind).toBe('favorite');
    expect(queue[0]?.count).toBe(2);
  });

  test('the author is never notified about their own favorited body', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await author.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });
    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test('flush delivers an in-app notification carrying the coalesced count + key', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const fan = await seedProfile(t, 'fan');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });
    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const delivered = await flushAllDue(t);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.type).toBe('favorite_report');
    expect(delivered[0]?.userId).toBe(fan.id);
    expect(delivered[0]?.payload.count).toBe(1);
    expect(delivered[0]?.payload.coalesceKey).toContain('favorite');
    // Queue row consumed.
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });
});

describe('notifications — nearby digest (X₁)', () => {
  test('enqueues an in-band digest with a future (8pm) flush time', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await seedProfile(t, 'nearby', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('digest');
    // Batched to the next 8pm rather than sent now. The margin used to be `now + 1 hour`, which was a
    // proxy for "batched" that quietly depended on the wall clock: the next 8pm is less than an hour
    // away for the whole 7–8pm window in `DIGEST_TIMEZONE`, so the suite failed for one hour a day and
    // passed the other twenty-three. What the test actually means is asserted here and on the two lines
    // below — it isn't due yet, and the immediate flush doesn't deliver it.
    expect(queue[0]?.flushAfter).toBeGreaterThan(Date.now());

    // The immediate cron flush does NOT deliver it (not due yet).
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toEqual([]);
  });

  test('rolls all of a user’s due digest rows into ONE consolidated notification, grouped by body', async () => {
    const t = convexTestWithGeo();
    const bodyA = await seedBody(t, 'osm/1');
    const bodyB = await seedBody(t, 'osm/2');
    const author = await seedProfile(t, 'author');
    const nearby = await seedProfile(t, 'nearby', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });

    // Two reports on body A (coalesce into one queue row) + one on body B → two digest queue rows.
    await createReport(t, author.as, { waterBodyId: bodyA, skateEndTime: SKATE_TIME });
    await createReport(t, author.as, {
      waterBodyId: bodyA,
      skateEndTime: SKATE_TIME + 1,
    });
    await createReport(t, author.as, {
      waterBodyId: bodyB,
      skateEndTime: SKATE_TIME + 2,
    });

    const delivered = await flushAllDue(t);
    // ONE digest for the user, enumerating both bodies — not one notification per lake.
    expect(delivered).toHaveLength(1);
    const digest = delivered[0];
    expect(digest?.type).toBe('nearby_report_digest');
    expect(digest?.userId).toBe(nearby.id);
    expect(digest?.payload.bodies).toHaveLength(2);
    expect(digest?.payload.totalCount).toBe(3); // 2 on A + 1 on B
    expect(digest?.payload.coalesceKey).toBe(`${nearby.id}:digest`);
    // Queue fully drained.
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test('the digest lands at 8pm in the recipient’s own zone, defaulting to the pilot zone (N8/C)', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const east = await seedProfile(t, 'east', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });
    const west = await seedProfile(t, 'west', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });
    await west.as.mutation(api.profiles.setTimezone, { timezone: 'America/Los_Angeles' });
    await expect(
      west.as.mutation(api.profiles.setTimezone, { timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toThrow(/timezone/i);

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    const eastRow = queue.find((q) => q.userId === east.id);
    const westRow = queue.find((q) => q.userId === west.id);
    expect(zonedHour(eastRow?.flushAfter ?? 0, 'America/New_York')).toBe(20);
    expect(zonedHour(westRow?.flushAfter ?? 0, 'America/Los_Angeles')).toBe(20);
    // Same hour on the clock, three hours apart in absolute time (modulo the day boundary).
    const gap = (westRow?.flushAfter ?? 0) - (eastRow?.flushAfter ?? 0);
    expect(((gap % (24 * 60 * 60 * 1000)) + 24 * 60 * 60 * 1000) % (24 * 60 * 60 * 1000)).toBe(
      3 * 60 * 60 * 1000,
    );
  });

  test('a digest whose rows straddle the batch cap is still ONE digest, complete, and the batch continues', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const reportId = await createReport(t, (await seedProfile(t, 'author')).as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
    });
    const nearby = await seedProfile(t, 'nearby', { prefs: { nearbyReportDigest: true } });
    const fan = await seedProfile(t, 'fan');
    const due = Date.now() - 1;
    // Insert straight into the queue, in an order that puts two of `nearby`'s three digest rows
    // inside the first batch and the third past the cap — `by_flush` ties on `flushAfter` and falls
    // back to creation order, which is exactly how one day's reports interleave users.
    const digestRow = (n: number) =>
      t.run((ctx) =>
        ctx.db.insert('notificationQueue', {
          userId: nearby.id,
          waterBodyId: bodyId,
          kind: 'digest' as const,
          type: 'nearby_report_digest' as const,
          coalesceKey: `${nearby.id}:body${n}:digest`,
          latestReportId: reportId,
          count: 1,
          flushAfter: due,
          createdAt: due,
        }),
      );
    await digestRow(1);
    await digestRow(2);
    await t.run(async (ctx) => {
      for (let i = 0; i < FLUSH_BATCH_CAP + 10; i++) {
        await ctx.db.insert('notificationQueue', {
          userId: fan.id,
          waterBodyId: bodyId,
          kind: 'favorite',
          type: 'favorite_report',
          coalesceKey: `${fan.id}:body${i}:favorite`,
          latestReportId: reportId,
          count: 1,
          flushAfter: due,
          createdAt: due,
        });
      }
    });
    await digestRow(3);

    const first = await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(first.continued).toBe(true);
    expect(await cancelScheduledFlushes(t)).toBe(1); // it really did queue its own next batch
    // The third row sat past the cap and was delivered anyway — pulled through `by_user`, not the
    // batch slice — so the digest is whole and there is nothing left of it for the next batch.
    let digests = await t.run((ctx) =>
      ctx.db
        .query('notifications')
        .withIndex('by_user', (q) => q.eq('userId', nearby.id))
        .collect(),
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]?.payload.bodies).toHaveLength(3);
    expect(digests[0]?.payload.totalCount).toBe(3);
    const left = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(left.every((r) => r.kind === 'favorite')).toBe(true);
    expect(left.length).toBe(FLUSH_BATCH_CAP + 10 - (FLUSH_BATCH_CAP - 2));

    // The continuation drains the rest and stops continuing; still exactly one digest.
    const second = await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(second.continued).toBe(false);
    expect(await cancelScheduledFlushes(t)).toBe(0);
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
    digests = await t.run((ctx) =>
      ctx.db
        .query('notifications')
        .withIndex('by_user', (q) => q.eq('userId', nearby.id))
        .collect(),
    );
    expect(digests).toHaveLength(1);
  });

  test('the read budget stops a batch between rows and the continuation finishes it (nothing partial)', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const rater = await seedProfile(t, 'rater');
    const reportId = await createReport(t, author.as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
    });
    // A hidden target: the settle short-circuits after one read, but the tally charges the row what
    // it *could* have cost — one read per coalesced id — which is how a burst is priced.
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    const due = Date.now() - 1;
    const perRow = 100;
    const rows = 40; // 40 × (1 + 100) ≫ the budget, but well under the batch cap
    await t.run(async (ctx) => {
      for (let i = 0; i < rows; i++) {
        await ctx.db.insert('notificationQueue', {
          userId: author.id,
          kind: 'thumb',
          type: 'report_rated',
          coalesceKey: `${author.id}:${reportId}:thumb:${i}`,
          count: perRow,
          flushAfter: due,
          createdAt: due,
          trigger: {
            kind: 'thumb',
            targetType: 'report',
            targetId: reportId,
            actorIds: Array.from({ length: perRow }, () => rater.id),
          },
        });
      }
    });

    const first = await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(first.continued).toBe(true);
    expect(await cancelScheduledFlushes(t)).toBe(1);
    expect(first.reads).toBeGreaterThanOrEqual(FLUSH_READ_BUDGET);
    // Stopped short of the cap: the rows after the stop are untouched, not half-processed.
    expect(first.dropped).toBeGreaterThan(0);
    expect(first.dropped).toBeLessThan(rows);
    const left = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(left).toHaveLength(rows - first.dropped);

    const second = await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(second.continued).toBe(false);
    expect(await cancelScheduledFlushes(t)).toBe(0);
    expect(first.dropped + second.dropped).toBe(rows);
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test("a body out of the viewer's band produces no digest", async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    // Digest on + radius set, but no home/bands → band is null → out of range.
    await seedProfile(t, 'faraway', { prefs: { nearbyReportDigest: true }, allRadiusMinutes: 30 });
    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });
});

describe('notifications — great nearby (X₂)', () => {
  test('fires only for a great report within the great radius', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await seedProfile(t, 'greatfan', {
      prefs: { greatReportNearby: true },
      greatRadiusMinutes: 30,
      inBand: true,
    });

    // A non-great report → nothing.
    await createReport(t, author.as, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      skateQuality: 'good',
    });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);

    // A great report → one great queue row.
    await createReport(t, author.as, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME + 1,
      skateQuality: 'great',
    });
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('great');
  });
});

describe('notifications — the fan-out is scheduled, not inline (N1)', () => {
  test('reports.create schedules the fan-out instead of walking every profile in the transaction', async () => {
    // The write path used to `collect()` the whole profiles table on every report — an unbounded
    // read inside the app's most important mutation. Now create schedules a paged job.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.map((s) => s.name)).toContain('notifications:fanOutNearbyNotifications');
  });

  test('pages, and schedules its own continuation rather than stopping at the page boundary', async () => {
    // A cap here would mean silently not telling someone about ice near them — the one failure
    // worse than a slow one — so the job continues itself instead. Seed past one page to prove it.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert('profiles', {
          clerkUserId: `bulk${i}`,
          displayName: `bulk${i}`,
          username: `bulk${i}`,
          homeCoord: { lat: 0.5, lng: 0.5 },
          cachedIsochrones: { band30: BAND30 },
          allRadiusMinutes: 30,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: { ...BASE_PREFS, nearbyReportDigest: true },
          dateOfBirth: Date.parse('1990-01-01'),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: Date.now(),
        });
      }
    });
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });

    const first: { isDone?: boolean; scanned?: number } = await t.mutation(
      internal.notifications.fanOutNearbyNotifications,
      { reportId },
    );
    expect(first.isDone).toBe(false); // more profiles than one page holds
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(
      scheduled.filter((f) => f.name === 'notifications:fanOutNearbyNotifications').length,
    ).toBeGreaterThan(0); // it queued its own next page

    // Drain the rest the way the scheduler would, then assert nobody was dropped.
    let cursor = (first as { cursor?: string }).cursor;
    for (let i = 0; i < 10; i++) {
      const page: { isDone?: boolean; cursor?: string } = await t.mutation(
        internal.notifications.fanOutNearbyNotifications,
        { reportId, cursor },
      );
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue.filter((q) => q.kind === 'digest')).toHaveLength(210);
  }, 30_000);

  test('stops early when the report is hidden mid-fan-out', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await seedProfile(t, 'nearby', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));

    const result: { stopped?: string } = await t.mutation(
      internal.notifications.fanOutNearbyNotifications,
      { reportId },
    );
    expect(result.stopped).toBe('report_gone');
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });
});

// ── The inbox (N8 / A1 + A2) ─────────────────────────────────────────────────────────────────────

describe('notifications — the inbox read path', () => {
  async function inbox(as: ReturnType<ReturnType<typeof convexTest>['withIdentity']>) {
    return as.query(api.notifications.list, { paginationOpts: { numItems: 20, cursor: null } });
  }

  test('list is owner-scoped, newest first, and unreadCount + markRead agree with it', async () => {
    const t = convexTestWithGeo();
    const author = await seedProfile(t, 'author');
    const rater = await seedProfile(t, 'rater');
    const stranger = await seedProfile(t, 'stranger');
    const bodyId = await seedBody(t);
    const r1 = await createReport(t, author.as, { waterBodyId: bodyId, skateEndTime: SKATE_TIME });
    const r2 = await createReport(t, author.as, { waterBodyId: bodyId, skateEndTime: SKATE_TIME });
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: r1,
      verdict: 'helpful',
    });
    await flushAllDue(t);
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: r2,
      verdict: 'helpful',
    });
    await flushAllDue(t);

    expect(await author.as.query(api.notifications.unreadCount, {})).toBe(2);
    expect(await stranger.as.query(api.notifications.unreadCount, {})).toBe(0);
    expect((await inbox(stranger.as)).page).toHaveLength(0);

    const page = (await inbox(author.as)).page;
    expect(page).toHaveLength(2);
    expect(
      page.map((n) => (n.type === 'report_rated' && n.kind === 'thumb' ? n.target.id : null)),
    ).toEqual([r2, r1]);
    expect(page[0]).toMatchObject({
      type: 'report_rated',
      kind: 'thumb',
      targetType: 'report',
      target: { id: r2, available: true },
      body: { id: bodyId, name: 'Lake Morey' },
      actors: { names: ['rater'], count: 1 },
    });
    expect(page[0]?.readAt).toBeUndefined();

    // Mark one, then everything up to the newest shown. Each call answers with what it stamped —
    // the clients keep that set so the "new since last visit" dot survives the reactive re-render.
    expect(
      await author.as.mutation(api.notifications.markRead, {
        notificationId: page[1]?.id as Id<'notifications'>,
      }),
    ).toEqual([page[1]?.id]);
    expect(await author.as.query(api.notifications.unreadCount, {})).toBe(1);
    expect(
      await author.as.mutation(api.notifications.markRead, { before: page[0]?.createdAt }),
    ).toEqual([page[0]?.id]);
    expect(await author.as.query(api.notifications.unreadCount, {})).toBe(0);
    expect((await inbox(author.as)).page.every((n) => n.readAt !== undefined)).toBe(true);
    // Nothing left to stamp: an empty answer, not an error.
    expect(await author.as.mutation(api.notifications.markRead, {})).toEqual([]);

    // Someone else's id is a no-op, not an error.
    expect(
      await stranger.as.mutation(api.notifications.markRead, {
        notificationId: page[0]?.id as Id<'notifications'>,
      }),
    ).toEqual([]);
  });

  test('a hidden target renders degraded and stays in the list; a blocked actor drops the row', async () => {
    const t = convexTestWithGeo();
    const author = await seedProfile(t, 'author');
    const rater = await seedProfile(t, 'rater');
    const other = await seedProfile(t, 'other');
    const bodyId = await seedBody(t);
    const reportId = await createReport(t, author.as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
    });
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    await flushAllDue(t);
    // A second, separate notification from `other`, so there's something left after the block.
    await other.as.mutation(api.comments.create, { reportId, body: 'nice one' });
    await flushAllDue(t);

    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    let page = (await inbox(author.as)).page;
    expect(page).toHaveLength(2);
    for (const n of page) {
      expect(n.type === 'report_rated' || n.type === 'report_commented').toBe(true);
      if (n.type === 'report_rated' || n.type === 'report_commented') {
        expect(n.target).toEqual({ id: reportId, available: false });
      }
    }

    await author.as.mutation(api.blocks.block, { targetUserId: rater.id });
    page = (await inbox(author.as)).page;
    expect(page).toHaveLength(1);
    expect(page[0]?.type).toBe('report_commented');

    // The badge still counts the row the list now omits. Opening the inbox — `markRead` with no
    // bound, the server's now — must clear it too, or the bell stays lit for a row nobody can see.
    expect(await author.as.query(api.notifications.unreadCount, {})).toBe(2);
    await author.as.mutation(api.notifications.markRead, {});
    expect(await author.as.query(api.notifications.unreadCount, {})).toBe(0);
  });

  test('a departed actor is named as their tombstone; an unparseable payload is the unknown row', async () => {
    const t = convexTestWithGeo();
    const author = await seedProfile(t, 'author');
    const rater = await seedProfile(t, 'rater');
    const bodyId = await seedBody(t);
    const reportId = await createReport(t, author.as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
    });
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    await flushAllDue(t);
    // The D62 tombstone shape: scrubbed name, status deleted.
    await t.run((ctx) =>
      ctx.db.patch(rater.id, { displayName: 'Deleted skater', status: 'deleted' as const }),
    );
    // …and a pre-N8 row whose payload nothing writes any more.
    await t.run((ctx) =>
      ctx.db.insert('notifications', {
        userId: author.id,
        type: 'report_rated',
        payload: { targetType: 'report', targetId: reportId, raterId: rater.id },
        createdAt: Date.now() + 1,
      }),
    );

    const page = (await inbox(author.as)).page;
    expect(page).toHaveLength(2);
    expect(page[0]?.type).toBe('unknown');
    expect(page[1]).toMatchObject({
      type: 'report_rated',
      actors: { names: ['Deleted skater'], count: 1 },
    });
  });

  test('a corroboration re-checks the corroborating report at flush', async () => {
    const t = convexTestWithGeo();
    const author = await seedProfile(t, 'author');
    const second = await seedProfile(t, 'second');
    const bodyId = await seedBody(t);
    const priorId = await createReport(t, author.as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
      skateQuality: 'good',
    });
    const byId = await createReport(t, second.as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
      skateQuality: 'good',
    });
    const queued = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queued.some((q) => q.trigger?.kind === 'corroboration')).toBe(true);

    await t.run((ctx) => ctx.db.patch(byId, { moderationStatus: 'removed' }));
    const notes = await flushAllDue(t);
    expect(notes.filter((n) => n.userId === author.id && n.type === 'report_rated')).toHaveLength(
      0,
    );
    // The prior report is untouched; only the notification about the vanished corroboration is gone.
    expect((await t.run((ctx) => ctx.db.get(priorId)))?.moderationStatus).toBe('visible');
  });

  test('a fresh action merging into a due-but-unflushed row gets its own settle window (PR #52 review)', async () => {
    const t = convexTestWithGeo();
    const author = await seedProfile(t, 'author');
    const first = await seedProfile(t, 'first');
    const second = await seedProfile(t, 'second');
    const bodyId = await seedBody(t);
    const reportId = await createReport(t, author.as, {
      waterBodyId: bodyId,
      skateEndTime: SKATE_TIME,
    });
    await first.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    const queued = () =>
      t.run((ctx) =>
        ctx.db
          .query('notificationQueue')
          .filter((q) => q.eq(q.field('kind'), 'thumb'))
          .collect(),
      );
    const [row] = await queued();
    expect(row).toBeDefined();
    if (!row) throw new Error('unreachable');
    const settling = row.flushAfter;
    expect(settling).toBeGreaterThan(Date.now());

    // While the row is still settling, a second thumb keeps the earlier deadline (a burst settles
    // from its first event).
    await second.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    expect((await queued())[0]?.flushAfter).toBe(settling);

    // The window passes without a flush tick. A retraction and re-thumb now must not ride the
    // expired deadline: the row takes a fresh window, so the next tick leaves it alone.
    await t.run((ctx) => ctx.db.patch(row._id, { flushAfter: Date.now() - 1 }));
    await second.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'unhelpful',
    });
    await second.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flushAfter).toBeGreaterThan(Date.now());
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toHaveLength(0);
  });

  test('unreadCount never exceeds its documented cap', async () => {
    const t = convexTestWithGeo();
    const author = await seedProfile(t, 'author');
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert('notifications', {
          userId: author.id,
          type: 'report_rated',
          payload: {},
          createdAt: i,
        });
      }
    });
    expect(await author.as.query(api.notifications.unreadCount, {})).toBe(99);
  });
});
