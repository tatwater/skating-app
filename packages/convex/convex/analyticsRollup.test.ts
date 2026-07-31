/**
 * The analytics rollups (Phase 7b). The properties worth pinning are the ones that make the whole
 * pipeline trustworthy rather than merely present:
 *
 *  - **idempotence** — the 6-hourly job recomputes today and yesterday every run, and the backfill
 *    replays past days through the same code, so a re-run must land on the same number rather than
 *    doubling it.
 *  - **day attribution** — a report belongs to the day its *skate* ended, not the day it synced, or
 *    an offline flush would silently move activity between days.
 *  - **no invented data** — a bounty fulfilled before `fulfilledAt` shipped is absent from the
 *    time-to-fulfillment histogram, not guessed at.
 *  - **honest windows** — a photo uploaded minutes ago is mid-submission, not an orphan.
 */
import { HOUR_BUCKETS, metricDay } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function harness() {
  const t = convexTest(schema, modules);
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

async function seedProfile(
  t: ReturnType<typeof harness>,
  subject: string,
  extra: Record<string, unknown> = {},
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  );
}

let seq = 0;
async function seedBody(
  t: ReturnType<typeof harness>,
  extra: Record<string, unknown> = {},
): Promise<Id<'waterBodies'>> {
  const i = seq++;
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: `Pond ${i}`,
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [i, 0],
            [i, 1],
            [i + 1, 1],
            [i + 1, 0],
            [i, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: i, maxLat: 1, maxLng: i + 1 },
      centroid: { lat: 0.5, lng: i + 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  );
}

/** A report inserted directly — the rollup reads rows, so the create pipeline isn't under test here. */
async function seedReport(
  t: ReturnType<typeof harness>,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  createdAt = skateEndTime,
  extra: Record<string, unknown> = {},
): Promise<Id<'reports'>> {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime,
      reportTime: createdAt,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt,
      updatedAt: createdAt,
      ...extra,
    }),
  );
}

const snapshot = (t: ReturnType<typeof harness>, metric: string, date: string) =>
  t.run((ctx) =>
    ctx.db
      .query('metricSnapshots')
      .withIndex('by_metric_date', (q) => q.eq('metric', metric).eq('date', date))
      .unique(),
  );

// `runRollup`/`backfill` now fan out to scheduled per-transaction jobs (each stays inside Convex's read
// budget). Rather than drive the scheduler (which needs fake timers, at odds with the `Date.now()` these
// seeds use), the metric tests invoke each job as its own mutation — exactly how prod runs them, one
// transaction apiece. The fan-out/chain *wiring* of `runRollup`/`backfill` is asserted separately below.
async function doRollup(t: ReturnType<typeof harness>): Promise<void> {
  const now = Date.now();
  await t.mutation(internal.analyticsRollup.rollupDayJob, { date: metricDay(now - DAY) });
  await t.mutation(internal.analyticsRollup.rollupDayJob, { date: metricDay(now) });
  await t.mutation(internal.analyticsRollup.rollupDistributionsJob, {});
  await t.mutation(internal.analyticsRollup.rollupActivityJob, {});
  await t.mutation(internal.analyticsRollup.rollupOperationalJob, {});
}
async function doBackfill(t: ReturnType<typeof harness>, days: number): Promise<void> {
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: metricDay(now - i * DAY) });
  }
  await t.mutation(internal.analyticsRollup.rollupDistributionsJob, {});
  await t.mutation(internal.analyticsRollup.rollupActivityJob, {});
  await t.mutation(internal.analyticsRollup.rollupOperationalJob, {});
}

/** Pending (not-yet-run) scheduled functions, by the function they'll invoke. */
async function pendingJobs(t: ReturnType<typeof harness>): Promise<string[]> {
  const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  return scheduled.filter((f) => f.state.kind === 'pending').map((f) => f.name);
}

describe('runRollup — day attribution', () => {
  test('counts a report on the day its skate ended, not the day it synced', async () => {
    const t = harness();
    const author = await seedProfile(t, 'a');
    const body = await seedBody(t);
    const skate = Date.now() - 2 * DAY;
    // An offline report captured two days ago and flushed just now. Keyed on the skate, it belongs
    // to the day it describes — otherwise a reconnect would move a day's activity onto today.
    await seedReport(t, author, body, skate, Date.now());

    await doBackfill(t, 4);

    expect((await snapshot(t, 'reports_created', metricDay(skate)))?.scalar).toBe(1);
    expect((await snapshot(t, 'reports_created', metricDay(Date.now())))?.scalar).toBe(0);
  });

  test('excludes hidden reports from the activity count', async () => {
    const t = harness();
    const author = await seedProfile(t, 'a');
    const body = await seedBody(t);
    const skate = Date.now() - HOUR;
    await seedReport(t, author, body, skate);
    await seedReport(t, author, body, skate, skate, { moderationStatus: 'hidden' as const });

    await doRollup(t);
    expect((await snapshot(t, 'reports_created', metricDay(skate)))?.scalar).toBe(1);
  });
});

describe('runRollup — idempotence', () => {
  test('re-running the same day overwrites rather than doubling', async () => {
    const t = harness();
    const author = await seedProfile(t, 'a');
    const body = await seedBody(t);
    // A metric day is a **UTC** day, so "an hour ago" is not always today: run this suite between
    // 00:00 and 01:00 UTC and the report lands on yesterday's snapshot while the assertion reads
    // today's. `doRollup` covers both days, so the count was right and the question was wrong — it
    // failed for one hour out of every twenty-four, which is exactly long enough to look like a flake.
    // Each fixture is now asserted against the day it actually falls in.
    const skate = Date.now() - HOUR;
    await seedReport(t, author, body, skate);

    await doRollup(t);
    await doRollup(t);
    await doRollup(t);

    expect((await snapshot(t, 'reports_created', metricDay(skate)))?.scalar).toBe(1);
    // The profile is seeded with `createdAt: Date.now()`, so signups belong to today either way.
    // `.unique()` above would have thrown on a duplicate row for the (metric, date) pair.
    expect((await snapshot(t, 'signups', metricDay(Date.now())))?.scalar).toBe(1);
  });

  test('the backfill and the live job agree on a day they both cover', async () => {
    const t = harness();
    const author = await seedProfile(t, 'a');
    const body = await seedBody(t);
    // Same UTC-day care as the test above — read the day the fixture is in, not the day it is now.
    const skate = Date.now() - HOUR;
    await seedReport(t, author, body, skate);

    await doRollup(t);
    const live = (await snapshot(t, 'reports_created', metricDay(skate)))?.scalar;
    await doBackfill(t, 7);
    const replayed = (await snapshot(t, 'reports_created', metricDay(skate)))?.scalar;

    expect(replayed).toBe(live);
  });
});

describe('runRollup — bounty funnel', () => {
  const seedBounty = async (
    t: ReturnType<typeof harness>,
    requesterId: Id<'profiles'>,
    waterBodyId: Id<'waterBodies'>,
    extra: Record<string, unknown>,
  ) =>
    t.run((ctx) =>
      ctx.db.insert('bounties', {
        requesterId,
        waterBodyId,
        windowHours: 72,
        status: 'open' as const,
        rewardPoints: 10,
        fulfillingReportIds: [],
        createdAt: Date.now() - 3 * DAY,
        expiresAt: Date.now() + 27 * DAY,
        ...extra,
      }),
    );

  test('tallies the outcome mix and the time-to-fulfillment histogram', async () => {
    const t = harness();
    const user = await seedProfile(t, 'u');
    const body = await seedBody(t);
    const created = Date.now() - 3 * DAY;
    await seedBounty(t, user, body, { status: 'expired' as const });
    await seedBounty(t, user, body, {
      status: 'fulfilled' as const,
      createdAt: created,
      fulfilledAt: created + 8 * HOUR,
    });

    await doRollup(t);
    const today = metricDay(Date.now());

    expect((await snapshot(t, 'bounty_outcomes', today))?.meta).toEqual({
      expired: 1,
      fulfilled: 1,
    });
    // 8h lands in the [6, 12) bucket — index 1 of HOUR_BUCKETS.
    const buckets = (await snapshot(t, 'bounty_time_to_fulfillment_h', today))?.buckets;
    expect(buckets?.[1]).toBe(1);
    expect(buckets?.reduce((a, b) => a + b, 0)).toBe(1);
    expect(buckets).toHaveLength(HOUR_BUCKETS.length);
  });

  test('leaves a pre-instrumentation fulfillment out of the histogram instead of inventing a duration', async () => {
    const t = harness();
    const user = await seedProfile(t, 'u');
    const body = await seedBody(t);
    await seedBounty(t, user, body, { status: 'fulfilled' as const }); // no `fulfilledAt`

    await doRollup(t);
    const today = metricDay(Date.now());
    expect((await snapshot(t, 'bounty_outcomes', today))?.meta).toEqual({ fulfilled: 1 });
    expect((await snapshot(t, 'bounty_time_to_fulfillment_h', today))?.scalar).toBe(0);
  });
});

/**
 * Auto-merge is the one mechanism in the app that changes a safety row with no human in the loop, and
 * §14 says to watch the unmerge rate through the first winter. That makes this rollup the empirical
 * half of the merge bar: if it miscounts, the only evidence `AUTOMERGE_MIN_FOOTPRINT_IOU` is set right
 * is wrong too.
 */
describe('runRollup — hazard merges', () => {
  const seedAction = (
    t: ReturnType<typeof harness>,
    action: 'merge_hazards' | 'unmerge_hazards',
    extra: Record<string, unknown> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action,
        targetType: 'hazard' as const,
        targetId: 'h1',
        reason: 'Footprints overlap above the automatic-merge bar (D80).',
        createdAt: Date.now(),
        ...extra,
      }),
    );

  test('separates the machine’s merges from a moderator’s, and counts what was undone', async () => {
    const t = harness();
    const mod = await seedProfile(t, 'mod');
    await seedAction(t, 'merge_hazards'); // no actor ⇒ the machine did it
    await seedAction(t, 'merge_hazards');
    await seedAction(t, 'merge_hazards', { actorId: mod });
    await seedAction(t, 'unmerge_hazards', { actorId: mod });

    await doRollup(t);
    // A moderator merging two pins by hand is a healthy signal; an *automatic* merge they later undo
    // is the one that says the bar is too low, so the three can never be added up into one number.
    expect((await snapshot(t, 'hazard_merges', metricDay(Date.now())))?.meta).toEqual({
      'merged:automatic': 2,
      'merged:moderator': 1,
      unmerged: 1,
    });
  });

  test('writes a snapshot on a quiet day rather than leaving a hole in the series', async () => {
    const t = harness();
    await doRollup(t);
    // A missing point and a zero read very differently on a chart, and only one of them is true.
    expect((await snapshot(t, 'hazard_merges', metricDay(Date.now())))?.meta).toEqual({});
  });

  test('ignores moderation actions that are not merges', async () => {
    const t = harness();
    const mod = await seedProfile(t, 'mod');
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod,
        action: 'hide' as const,
        targetType: 'hazard' as const,
        targetId: 'h2',
        reason: 'Not a real hazard.',
        createdAt: Date.now(),
      }),
    );
    await doRollup(t);
    expect((await snapshot(t, 'hazard_merges', metricDay(Date.now())))?.meta).toEqual({});
  });

  test('re-running the day overwrites rather than doubling', async () => {
    const t = harness();
    await seedAction(t, 'merge_hazards');
    await doRollup(t);
    await doRollup(t);
    expect((await snapshot(t, 'hazard_merges', metricDay(Date.now())))?.meta).toEqual({
      'merged:automatic': 1,
    });
  });
});

describe('runRollup — photo orphans', () => {
  const seedPhoto = (
    t: ReturnType<typeof harness>,
    uploaderId: Id<'profiles'>,
    createdAt: number,
  ) =>
    t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId: `s${createdAt}`,
        thumbStorageId: `th${createdAt}`,
        uploaderId,
        placeOnMap: false,
        createdAt,
      }),
    );

  test('counts an unreferenced photo but not one still being submitted', async () => {
    const t = harness();
    const user = await seedProfile(t, 'u');
    const orphan = await seedPhoto(t, user, Date.now() - 5 * DAY);
    void orphan;
    await seedPhoto(t, user, Date.now() - 5 * 60 * 1000); // uploaded 5 minutes ago — mid-form

    await doRollup(t);
    expect((await snapshot(t, 'photo_orphans', metricDay(Date.now())))?.scalar).toBe(1);
  });

  test('does not count a photo a report references', async () => {
    const t = harness();
    const user = await seedProfile(t, 'u');
    const body = await seedBody(t);
    const photoId = await seedPhoto(t, user, Date.now() - 5 * DAY);
    await seedReport(t, user, body, Date.now() - 5 * DAY, Date.now() - 5 * DAY, {
      photoIds: [photoId],
    });

    await doRollup(t);
    expect((await snapshot(t, 'photo_orphans', metricDay(Date.now())))?.scalar).toBe(0);
  });
});

describe('rollup orchestration (fan-out + chain wiring)', () => {
  test('runRollup schedules the five per-transaction jobs, not one fat mutation', async () => {
    const t = harness();
    await t.mutation(internal.analyticsRollup.runRollup, {});
    const jobs = await pendingJobs(t);
    // Two day rollups + the three point-in-time chunks — each its own transaction (the read-budget fix).
    expect(jobs.filter((n) => n.includes('rollupDayJob'))).toHaveLength(2);
    expect(jobs.some((n) => n.includes('rollupDistributionsJob'))).toBe(true);
    expect(jobs.some((n) => n.includes('rollupActivityJob'))).toBe(true);
    expect(jobs.some((n) => n.includes('rollupOperationalJob'))).toBe(true);
  });

  test('backfill self-chains one day per transaction rather than looping in one', async () => {
    const t = harness();
    await t.mutation(internal.analyticsRollup.backfill, { days: 5 });
    // Kicks a single `backfillStep` — each step does one day then schedules the next, so at no point is
    // more than one day's read load in a transaction (the fix for a long backfill blowing the budget).
    const jobs = await pendingJobs(t);
    expect(jobs.filter((n) => n.includes('backfillStep'))).toHaveLength(1);
    expect(jobs.some((n) => n.includes('rollupDayJob'))).toBe(false);
  });

  test('backfill clamps the window to [1, 365] days', async () => {
    const t = harness();
    expect((await t.mutation(internal.analyticsRollup.backfill, { days: 10_000 })).days).toBe(365);
    expect((await t.mutation(internal.analyticsRollup.backfill, { days: 0 })).days).toBe(1);
  });
});

describe('sweepCorpus', () => {
  test('counts listed bodies per state and per zoom band, skipping delisted ones', async () => {
    const t = harness();
    await seedBody(t, { states: ['VT'], minVisibleZoom: 9 });
    await seedBody(t, { states: ['VT'], minVisibleZoom: 9 });
    await seedBody(t, { states: ['NY', 'VT'], minVisibleZoom: 7 }); // a border-spanning body counts in both
    await seedBody(t, { states: ['NH'], minVisibleZoom: 12, removedAt: Date.now() }); // delisted

    await t.mutation(internal.analyticsRollup.sweepCorpus, {});
    const today = metricDay(Date.now());

    const coverage = (await snapshot(t, 'state_coverage', today))?.meta as Record<string, number>;
    expect(coverage['VT:bodies']).toBe(3);
    expect(coverage['NY:bodies']).toBe(1);
    expect(coverage['NH:bodies']).toBeUndefined();

    const bands = (await snapshot(t, 'zoom_band_distribution', today))?.meta as Record<
      string,
      number
    >;
    expect(bands).toEqual({ z9: 2, z7: 1 });
  });

  test('buckets a body with no computed zoom as `always` rather than dropping it', async () => {
    const t = harness();
    await seedBody(t, { states: ['VT'] }); // pre-D49 row, no minVisibleZoom

    await t.mutation(internal.analyticsRollup.sweepCorpus, {});
    const bands = (await snapshot(t, 'zoom_band_distribution', metricDay(Date.now())))?.meta;
    expect(bands).toEqual({ always: 1 });
  });
});

describe('pruneGateEvents', () => {
  test('drops rows past the retention window and keeps the rest', async () => {
    const t = harness();
    const user = await seedProfile(t, 'u');
    const body = await seedBody(t);
    const insert = (createdAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('bountyGateEvents', {
          waterBodyId: body,
          requesterId: user,
          decision: 'allowed' as const,
          weatherReopened: false,
          createdAt,
        }),
      );
    await insert(Date.now() - 200 * DAY);
    await insert(Date.now() - DAY);

    const result = await t.mutation(internal.analyticsRollup.pruneGateEvents, {});
    expect(result.deleted).toBe(1);
    const left = await t.run((ctx) => ctx.db.query('bountyGateEvents').collect());
    expect(left).toHaveLength(1);
  });
});

describe('pruneClientSignals', () => {
  test('drops rate-limit rows past their short window and keeps recent ones', async () => {
    const t = harness();
    const user = await seedProfile(t, 'u');
    const insert = (createdAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('clientSignalEvents', {
          userId: user,
          signal: 'report_rejected_future_skate',
          createdAt,
        }),
      );
    await insert(Date.now() - 5 * DAY); // past the 2-day retention
    await insert(Date.now() - HOUR); // still fresh

    const result = await t.mutation(internal.analyticsRollup.pruneClientSignals, {});
    expect(result.deleted).toBe(1);
    const left = await t.run((ctx) => ctx.db.query('clientSignalEvents').collect());
    expect(left).toHaveLength(1);
  });
});
