/**
 * D258: one failing item never blocks a recurring job. For each queue-shaped job — the notification
 * flush, the recorder's prompt sweep, the map-card sweep — a property over any set of items and any
 * subset that always fails: every healthy item goes through in its first run; a failing one is tried
 * once a run, parked after exactly three failures in a row and not tried again by the walk; and once
 * it heals, the retry frees it with nobody releasing anything by hand. Then the notification
 * freshness rule, the coalescing that never lands in a parked row, and the Machinery read.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { linkActivityToReport, recordPromptFailure } from './gpsActivities';
import { MAX_ATTEMPTS } from './lib/attempts';
import * as notificationQueue from './lib/notificationQueue';
import { NOTIFICATION_FRESH_MS } from './lib/notificationQueue';
import * as recurringWork from './lib/recurringWork';
import { enqueueReportNotice, recordQueueFailure } from './notifications';
import schema from './schema';
import { recordCardFailure } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2027, 0, 14, 15);

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

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedUser(t: T, subject: string, role: 'member' | 'admin' = 'member') {
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

async function seedBody(t: T, externalId: string): Promise<Id<'waterBodies'>> {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm' as const,
        states: ['VT'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond' as const,
        polygon: {
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
        },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return body._id;
}

/** A minimal Report, for rows that must point at a real one. */
async function seedReport(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0 - DAY,
      reportTime: T0 - DAY,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0 - DAY,
      updatedAt: T0 - DAY,
    }),
  );
}

/** Make `asItem` fail for the keys in `poison` — the one seam every isolated item runs through. */
function poisonItems(poison: Set<string>) {
  const real = recurringWork.asItem;
  return vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
    if (poison.has(key)) throw new Error('poison');
    return real(key, work);
  });
}

/** The rule's model for one item over runs: failures in a row, parked at three, done on success. */
function model(failsThrough: number, runs: number) {
  const out: { attempted: boolean; failures: number; parked: boolean; done: boolean }[] = [];
  let failures = 0;
  let parked = false;
  let done = false;
  for (let run = 1; run <= runs; run++) {
    const attempted = !done && !parked;
    if (attempted && run <= failsThrough) {
      failures++;
      if (failures >= MAX_ATTEMPTS) parked = true;
    } else if (attempted) {
      done = true;
      failures = 0;
    }
    out.push({ attempted, failures, parked, done });
  }
  return out;
}

const RUNS = 5;

// ── The notification flush ─────────────────────────────────────────────────────────────────────

async function queueFavorite(t: T, userId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('notificationQueue', {
      userId,
      waterBodyId,
      kind: 'favorite' as const,
      type: 'favorite_report' as const,
      coalesceKey: `${userId}:${waterBodyId}:favorite`,
      count: 1,
      flushAfter: Date.now() - 1,
      createdAt: Date.now() - 1,
    }),
  );
}

const inbox = (t: T, userId: Id<'profiles'>) =>
  t.run((ctx) =>
    ctx.db
      .query('notifications')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
  );

describe('flush notification queue, under failure', () => {
  test('over any rows and any that keep failing: healthy rows land in the first run; a failing one is tried once a run, parked at its third, and the retry delivers it once it heals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: RUNS }), { minLength: 1, maxLength: 6 }),
        async (failsThrough) => {
          vi.restoreAllMocks();
          vi.setSystemTime(T0);
          const t = convexTest(schema, modules);
          const bodyId = await seedBody(t, 'osm/flush');
          const users: Id<'profiles'>[] = [];
          const rows: Id<'notificationQueue'>[] = [];
          for (const [i] of failsThrough.entries()) {
            const user = await seedUser(t, `u${i}`);
            users.push(user.id);
            rows.push(await queueFavorite(t, user.id, bodyId));
          }
          const expected = failsThrough.map((n) => model(n, RUNS));
          const poison = new Set<string>();
          const real = notificationQueue.isStaleQueueRow;
          const checks = vi
            .spyOn(notificationQueue, 'isStaleQueueRow')
            .mockImplementation((row, now) => {
              if (poison.has((row as unknown as { _id: string })._id)) throw new Error('poison');
              return real(row, now);
            });
          for (let run = 1; run <= RUNS; run++) {
            poison.clear();
            for (const [i, n] of failsThrough.entries())
              if (run <= n) poison.add(rows[i] as string);
            checks.mockClear();
            await t.mutation(internal.notifications.flushNotificationQueue, {});
            await t.finishAllScheduledFunctions(vi.runAllTimers, 50);
            for (const [i, id] of rows.entries()) {
              const want = expected[i]?.[run - 1];
              const row = await t.run((ctx) => ctx.db.get(id));
              const delivered = await inbox(t, users[i] as Id<'profiles'>);
              // Never twice: one inbox row at most, whatever the run did.
              expect(delivered.length).toBeLessThanOrEqual(1);
              if (want?.done) {
                expect(row).toBeNull();
                expect(delivered).toHaveLength(1);
              } else {
                expect(delivered).toHaveLength(0);
                expect(row?.attempts ?? 0).toBe(want?.failures ?? 0);
                expect(row?.parkedAt !== undefined).toBe(want?.parked ?? false);
                // A parked row is not looked at by the walk at all.
                if (want?.parked && !want.attempted) {
                  expect(
                    checks.mock.calls.some(([r]) => (r as unknown as { _id: string })._id === id),
                  ).toBe(false);
                }
              }
            }
            vi.setSystemTime(Date.now() + MINUTE);
          }
          // Everything heals inside the freshness window: the hourly retry delivers what was parked.
          poison.clear();
          await t.mutation(internal.notifications.retryParkedNotifications, {});
          await t.finishAllScheduledFunctions(vi.runAllTimers, 50);
          for (const [i, id] of rows.entries()) {
            expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
            expect(await inbox(t, users[i] as Id<'profiles'>)).toHaveLength(1);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 120_000);

  test('the freshness rule: a parked row past twelve hours from when it first fell due is expired by the retry, never delivered', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t, 'osm/stale');
    const user = await seedUser(t, 'late');
    const row = await queueFavorite(t, user.id, bodyId);
    const poison = new Set([row as string]);
    const real = notificationQueue.isStaleQueueRow;
    vi.spyOn(notificationQueue, 'isStaleQueueRow').mockImplementation((r, now) => {
      if (poison.has((r as unknown as { _id: string })._id)) throw new Error('poison');
      return real(r, now);
    });
    for (let run = 0; run < MAX_ATTEMPTS; run++) {
      await t.mutation(internal.notifications.flushNotificationQueue, {});
      vi.setSystemTime(Date.now() + MINUTE);
    }
    const parked = await t.run((ctx) => ctx.db.get(row));
    expect(parked?.parkedAt).toBeDefined();
    expect(parked?.firstDueAt).toBeLessThan(T0);
    poison.clear();
    vi.setSystemTime(T0 + NOTIFICATION_FRESH_MS + MINUTE);
    expect(await t.mutation(internal.notifications.retryParkedNotifications, {})).toMatchObject({
      delivered: 0,
      expired: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(row))).toBeNull();
    expect(await inbox(t, user.id)).toHaveLength(0);
  });

  test('the rule holds for any row: a backlog older than the window is expired, not sent as news', async () => {
    const t = convexTest(schema, modules);
    const bodyId = await seedBody(t, 'osm/backlog');
    const user = await seedUser(t, 'backlog');
    const row = await queueFavorite(t, user.id, bodyId);
    vi.setSystemTime(T0 + NOTIFICATION_FRESH_MS + MINUTE);
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 0,
      expired: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(row))).toBeNull();
    expect(await inbox(t, user.id)).toHaveLength(0);
  });

  test('a new event never coalesces into a parked row: it lands in a row of its own', async () => {
    const t = convexTest(schema, modules);
    const skater = await seedUser(t, 'skater');
    const activityId = await seedActivity(t, skater.id, 0);
    const enqueue = () =>
      t.run((ctx) =>
        notificationQueue.enqueueActorNotification(ctx, {
          recipientId: skater.id,
          targetId: activityId,
          trigger: { kind: 'activity', activityId },
          now: Date.now(),
          flushAfter: Date.now(),
        }),
      );
    await enqueue();
    const [first] = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    if (!first) throw new Error('expected a row');
    await t.run((ctx) =>
      ctx.db.patch(first._id, { attempts: 3, lastErrorClass: 'Error', parkedAt: Date.now() }),
    );
    await enqueue();
    const rows = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(rows).toHaveLength(2);
    // The parked row keeps only what it already held.
    expect(rows.find((r) => r._id === first._id)).toMatchObject({ count: first.count });
    expect(rows.find((r) => r._id !== first._id)?.parkedAt).toBeUndefined();
  });
});

// ── The prompt sweep ───────────────────────────────────────────────────────────────────────────

async function seedActivity(t: T, userId: Id<'profiles'>, i: number) {
  return t.run((ctx) =>
    ctx.db.insert('gpsActivities', {
      userId,
      provider: 'native' as const,
      providerActivityId: `session-${i}`,
      sportType: 'IceSkate',
      startTime: T0 - 10 * DAY + i * DAY,
      promptState: 'pending' as const,
      detectedAt: T0 - 5 * HOUR - i,
    }),
  );
}

describe('prompt unreported skates, under failure', () => {
  test('over any skaters and any that keep failing: healthy ones are asked in their first run; a failing one is tried once a run, parked at its third, and the daily retry asks once it heals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: RUNS }), { minLength: 1, maxLength: 5 }),
        async (failsThrough) => {
          vi.restoreAllMocks();
          vi.setSystemTime(T0);
          const t = convexTest(schema, modules);
          const users: Id<'profiles'>[] = [];
          const rows: Id<'gpsActivities'>[] = [];
          for (const [i] of failsThrough.entries()) {
            const user = await seedUser(t, `skater${i}`);
            users.push(user.id);
            rows.push(await seedActivity(t, user.id, i));
          }
          const expected = failsThrough.map((n) => model(n, RUNS));
          const poison = new Set<string>();
          const items = poisonItems(poison);
          for (let run = 1; run <= RUNS; run++) {
            poison.clear();
            for (const [i, n] of failsThrough.entries())
              if (run <= n) poison.add(users[i] as string);
            items.mockClear();
            await t.mutation(internal.gpsActivities.sweepUnpromptedActivities, {});
            await t.finishAllScheduledFunctions(vi.runAllTimers, 50);
            for (const [i, id] of rows.entries()) {
              const want = expected[i]?.[run - 1];
              const tries = items.mock.calls.filter(([key]) => key === users[i]).length;
              expect(tries).toBe(want?.attempted ? 1 : 0);
              const row = await t.run((ctx) => ctx.db.get(id));
              if (want?.done) expect(row?.promptState).toBe('prompted');
              else {
                expect(row?.promptState).toBe('pending');
                expect(row?.promptAttempts ?? 0).toBe(want?.failures ?? 0);
                expect(row?.promptParkedAt !== undefined).toBe(want?.parked ?? false);
              }
            }
            vi.setSystemTime(Date.now() + HOUR);
          }
          poison.clear();
          await t.mutation(internal.recurringJobs.retryParkedDaily, {});
          await t.finishAllScheduledFunctions(vi.runAllTimers, 50);
          for (const id of rows) {
            const row = await t.run((ctx) => ctx.db.get(id));
            expect(row?.promptState).toBe('prompted');
            expect(row?.promptParkedAt).toBeUndefined();
            expect(row?.promptAttempts).toBeUndefined();
          }
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

// ── The map-card sweep ─────────────────────────────────────────────────────────────────────────

describe('sweep body summaries (due mode), under failure', () => {
  test('over any cards and any that keep failing: healthy cards refresh in their first run; a failing one is tried once a run, parked at its third, left as it was, and the daily retry refreshes it once it heals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: RUNS }), { minLength: 1, maxLength: 5 }),
        async (failsThrough) => {
          vi.restoreAllMocks();
          vi.setSystemTime(T0);
          const t = convexTest(schema, modules);
          const bodies: Id<'waterBodies'>[] = [];
          for (const [i] of failsThrough.entries()) {
            const id = await seedBody(t, `osm/card-${i}`);
            bodies.push(id);
            await t.run(async (ctx) => {
              await ctx.db.patch(id, {
                summary: { recentReportCount: 7, topHazardTypes: ['open_water'], updatedAt: 0 },
              });
              await ctx.db.insert('bodySummaryRefreshes', {
                waterBodyId: id,
                refreshAt: T0 - i - 1,
              });
            });
          }
          const expected = failsThrough.map((n) => model(n, RUNS));
          const poison = new Set<string>();
          const items = poisonItems(poison);
          for (let run = 1; run <= RUNS; run++) {
            poison.clear();
            for (const [i, n] of failsThrough.entries())
              if (run <= n) poison.add(bodies[i] as string);
            items.mockClear();
            await t.mutation(internal.waterBodies.refreshDueBodySummaries, { cutoff: Date.now() });
            for (const [i, id] of bodies.entries()) {
              const want = expected[i]?.[run - 1];
              const tries = items.mock.calls.filter(([key]) => key === id).length;
              expect(tries).toBe(want?.attempted ? 1 : 0);
              const body = await t.run((ctx) => ctx.db.get(id));
              const refresh = await t.run((ctx) =>
                ctx.db
                  .query('bodySummaryRefreshes')
                  .withIndex('by_water_body', (q) => q.eq('waterBodyId', id))
                  .first(),
              );
              if (want?.done) expect(body?.summary?.recentReportCount).toBe(0);
              else {
                // Left exactly as it was — its hazards included — never cleared.
                expect(body?.summary).toMatchObject({
                  recentReportCount: 7,
                  topHazardTypes: ['open_water'],
                });
                expect(refresh?.attempts ?? 0).toBe(want?.failures ?? 0);
                expect(refresh?.parkedAt !== undefined).toBe(want?.parked ?? false);
              }
            }
            vi.setSystemTime(Date.now() + HOUR);
          }
          poison.clear();
          await t.mutation(internal.recurringJobs.retryParkedDaily, {});
          for (const id of bodies) {
            expect((await t.run((ctx) => ctx.db.get(id)))?.summary?.recentReportCount).toBe(0);
          }
          expect(
            (await t.run((ctx) => ctx.db.query('bodySummaryRefreshes').collect())).filter(
              (r) => r.parkedAt !== undefined || r.attempts !== undefined,
            ),
          ).toEqual([]);
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

// ── The Machinery read ─────────────────────────────────────────────────────────────────────────

describe('recurringJobs.health — one place to see it', () => {
  test('admin only', async () => {
    const t = convexTest(schema, modules);
    const member = await seedUser(t, 'member');
    await expect(member.as.query(api.recurringJobs.health, {})).rejects.toThrow();
  });

  test('per job: failing and parked counts, the oldest ages, the error classes — no content, names or ids', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const bodyId = await seedBody(t, 'osm/health');
    const user = await seedUser(t, 'someone');
    const row = await queueFavorite(t, user.id, bodyId);
    // Three failed deliveries, recorded the way the flush records them: parked, and mirrored.
    for (let i = 0; i < 3; i++) {
      await t.run(async (ctx) => {
        const r = await ctx.db.get(row);
        if (r) await recordQueueFailure(ctx, r, 'TypeError', T0 - HOUR, {});
      });
    }
    await t.run(async (ctx) => {
      await ctx.db.insert('jobFailures', {
        job: 'weatherGaps',
        key: 'filter:cell-1',
        attempts: 1,
        errorClass: 'Error',
        firstFailedAt: T0 - 3 * HOUR,
        lastFailedAt: T0 - 3 * HOUR,
      });
      await ctx.db.insert('jobFailures', {
        job: 'weatherGaps',
        key: 'filter:cell-2',
        attempts: 3,
        errorClass: 'OverBudget',
        firstFailedAt: T0 - 4 * HOUR,
        lastFailedAt: T0 - HOUR,
        parkedAt: T0 - HOUR,
      });
      // An account two days past its 30 days.
      await ctx.db.patch(user.id, { deletionRequestedAt: T0 - 32 * DAY, status: 'deleting' });
    });
    await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    const health = await admin.as.query(api.recurringJobs.health, { now: T0 });
    const job = (name: string) => health.jobs.find((j) => j.job === name);
    expect(job('flush notification queue')).toEqual({
      job: 'flush notification queue',
      failing: 0,
      parked: 1,
      oldestParkedAt: T0 - HOUR,
      oldestFailingSince: T0 - HOUR,
      errorClasses: { TypeError: 1 },
      capped: false,
    });
    expect(job('repair weather archive gaps')).toEqual({
      job: 'repair weather archive gaps',
      failing: 1,
      parked: 1,
      oldestParkedAt: T0 - HOUR,
      oldestFailingSince: T0 - 4 * HOUR,
      errorClasses: { Error: 1, OverBudget: 1 },
      capped: false,
    });
    expect(job('prompt unreported skates')).toMatchObject({ failing: 0, parked: 0 });
    expect(job('finalize account deletions')).toMatchObject({
      failing: 1,
      parked: 0,
      errorClasses: { Overdue: 1 },
    });
    // Counts only: nothing in the answer names an item.
    expect(JSON.stringify(health)).not.toContain(user.id);
    expect(JSON.stringify(health)).not.toContain('cell-1');
  });

  test('a count that hit its cap says so', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) {
        await ctx.db.insert('jobFailures', {
          job: 'orphanPhotos',
          key: `photo-${i}`,
          attempts: 1,
          errorClass: 'Error',
          firstFailedAt: T0,
          lastFailedAt: T0,
        });
      }
    });
    const health = await admin.as.query(api.recurringJobs.health, { now: T0 });
    expect(health.jobs.find((j) => j.job === 'sweep orphan photos')).toMatchObject({
      failing: 200,
      capped: true,
    });
  });
});

// ── The edges: a retry that fails again, a pass out of budget, what the read counts ─────────────

describe('the retries and passes at their edges', () => {
  test('the daily retry leaves what still fails parked — re-stamped as just tried, noted as retried', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const activity = await seedActivity(t, skater.id, 0);
    const bodyId = await seedBody(t, 'osm/edge');
    await t.run(async (ctx) => {
      await ctx.db.patch(activity, {
        promptAttempts: 3,
        promptErrorClass: 'Error',
        promptParkedAt: T0 - DAY,
      });
      await ctx.db.insert('bodySummaryRefreshes', {
        waterBodyId: bodyId,
        refreshAt: T0 - DAY,
        attempts: 3,
        lastErrorClass: 'Error',
        parkedAt: T0 - DAY,
      });
    });
    poisonItems(new Set([skater.id as string, bodyId as string]));
    expect(await t.mutation(internal.recurringJobs.retryParkedDaily, {})).toEqual({
      freed: 0,
      failed: 2,
      more: false,
    });
    const row = await t.run((ctx) => ctx.db.get(activity));
    expect(row).toMatchObject({ promptAttempts: 4, promptParkedAt: T0, promptRetriedAt: T0 });
    const card = await t.run((ctx) => ctx.db.query('bodySummaryRefreshes').first());
    expect(card).toMatchObject({ attempts: 4, parkedAt: T0, retriedAt: T0 });
    // Once a run: tried again in the same run's continuation, it is past the cutoff.
    expect(await t.mutation(internal.recurringJobs.retryParkedDaily, { cutoff: T0 })).toEqual({
      freed: 0,
      failed: 0,
      more: false,
    });
  });

  test('a retry out of budget continues itself from where it was', async () => {
    const t = harness();
    vi.spyOn(recurringWork, 'affords').mockResolvedValue(false);
    expect(await t.mutation(internal.recurringJobs.retryParkedDaily, {})).toEqual({
      freed: 0,
      failed: 0,
      more: true,
    });
    expect(await t.mutation(internal.notifications.retryParkedNotifications, {})).toMatchObject({
      more: true,
    });
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.map((j) => j.name).sort()).toEqual([
      'notifications:retryParkedNotifications',
      'recurringJobs:retryParkedDaily',
    ]);
    for (const job of jobs) await t.run((ctx) => ctx.scheduler.cancel(job._id));
  });

  test('a pass that cannot afford one item fails loudly rather than rescheduling for ever', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedActivity(t, user.id, 0);
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['p']));
      await ctx.db.insert('photos', {
        storageId,
        thumbStorageId: storageId,
        uploaderId: user.id,
        placeOnMap: false,
        createdAt: T0 - 40 * DAY,
      });
    });
    vi.spyOn(recurringWork, 'affords').mockResolvedValue(false);
    await expect(t.mutation(internal.storageHygiene.sweepOrphanPhotos, {})).rejects.toThrow(
      /no progress/,
    );
    await expect(t.mutation(internal.gpsActivities.sweepUnpromptedActivities, {})).rejects.toThrow(
      /no progress/,
    );
  });

  test("a skater's linked or superseded due rows are settled inside their own prompt", async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const linked = await seedActivity(t, user.id, 0);
    const loser = await seedActivity(t, user.id, 1);
    const reportId = await seedReport(t, user.id, await seedBody(t, 'osm/linked'));
    await t.run(async (ctx) => {
      await ctx.db.patch(linked, {
        linkedReportId: reportId,
        promptAttempts: 1,
        promptErrorClass: 'Error',
      });
      await ctx.db.patch(loser, { supersededByActivityId: linked });
    });
    expect(await t.mutation(internal.gpsActivities.sweepUnpromptedActivities, {})).toMatchObject({
      settled: 2,
      failed: 0,
    });
    expect(await t.run((ctx) => ctx.db.get(linked))).toMatchObject({ promptState: 'converted' });
    expect((await t.run((ctx) => ctx.db.get(linked)))?.promptAttempts).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(loser))).toMatchObject({ promptState: 'dismissed' });
  });

  test('a digest pulls only fresh rows: one past its window is expired, the rest sent as one', async () => {
    const t = harness();
    const fan = await seedUser(t, 'digest-fan');
    await t.run((ctx) =>
      ctx.db.patch(fan.id, { notificationPrefs: { ...NOTIF_PREFS, nearbyReportDigest: true } }),
    );
    const a = await seedBody(t, 'osm/digest-a');
    const b = await seedBody(t, 'osm/digest-b');
    const reportId = await seedReport(t, fan.id, a);
    const digest = (waterBodyId: Id<'waterBodies'>, extra: Record<string, number>) =>
      t.run((ctx) =>
        ctx.db.insert('notificationQueue', {
          userId: fan.id,
          waterBodyId,
          kind: 'digest' as const,
          type: 'nearby_report_digest' as const,
          coalesceKey: `${fan.id}:${waterBodyId}:digest`,
          latestReportId: reportId,
          count: 1,
          flushAfter: T0 - 1,
          createdAt: T0 - 1,
          ...extra,
        }),
      );
    await digest(a, {});
    // Failed earlier and moved on, but it first fell due long ago: past its window.
    await digest(b, { firstDueAt: T0 - NOTIFICATION_FRESH_MS - HOUR, attempts: 1 });
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 1,
      expired: 1,
    });
    const [sent] = await inbox(t, fan.id);
    expect(sent?.payload.bodies).toHaveLength(1);
  });

  test('the read counts parked prompts and cards too — from their mirrors, never the heavy rows', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const skater = await seedUser(t, 'skater');
    const activity = await seedActivity(t, skater.id, 0);
    const bodyId = await seedBody(t, 'osm/read');
    await t.run((ctx) =>
      ctx.db.insert('bodySummaryRefreshes', { waterBodyId: bodyId, refreshAt: T0 }),
    );
    for (let i = 0; i < 3; i++) {
      await t.run(async (ctx) => {
        const a = await ctx.db.get(activity);
        if (a) await recordPromptFailure(ctx, a, 'RangeError', T0 - HOUR, {});
        const card = await ctx.db.query('bodySummaryRefreshes').first();
        if (card) await recordCardFailure(ctx, card, 'OverBudget', T0 - 2 * HOUR, {});
      });
    }
    const health = await admin.as.query(api.recurringJobs.health, {});
    expect(health.jobs.find((j) => j.job === 'prompt unreported skates')).toMatchObject({
      parked: 1,
      oldestParkedAt: T0 - HOUR,
      errorClasses: { RangeError: 1 },
    });
    expect(health.jobs.find((j) => j.job === 'sweep body summaries')).toMatchObject({
      parked: 1,
      oldestParkedAt: T0 - 2 * HOUR,
      errorClasses: { OverBudget: 1 },
    });
    // Healed: the prompt and the card go through and take their mirrors with them.
    await t.mutation(internal.recurringJobs.retryParkedDaily, {});
    const after = await admin.as.query(api.recurringJobs.health, {});
    expect(after.jobs.find((j) => j.job === 'prompt unreported skates')?.parked).toBe(0);
    expect(after.jobs.find((j) => j.job === 'sweep body summaries')?.parked).toBe(0);
  });

  test('a failing queue row is counted while it fails, and its count goes with it when it is delivered', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const bodyId = await seedBody(t, 'osm/queue-read');
    const user = await seedUser(t, 'queued');
    const failing = await queueFavorite(t, user.id, bodyId);
    await t.run(async (ctx) => {
      const r = await ctx.db.get(failing);
      if (r) await recordQueueFailure(ctx, r, 'Error', T0, { cutoff: T0 - MINUTE });
    });
    const health = await admin.as.query(api.recurringJobs.health, {});
    expect(health.jobs.find((j) => j.job === 'flush notification queue')).toMatchObject({
      failing: 1,
      parked: 0,
      errorClasses: { Error: 1 },
      capped: false,
    });
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(await t.run((ctx) => ctx.db.get(failing))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });

  test('a mirror whose row went some other way is forgotten by the retry', async () => {
    const t = harness();
    const bodyId = await seedBody(t, 'osm/gone-row');
    const user = await seedUser(t, 'gone');
    const row = await queueFavorite(t, user.id, bodyId);
    await t.run(async (ctx) => {
      const r = await ctx.db.get(row);
      if (r) await recordQueueFailure(ctx, r, 'Error', T0, {});
      await ctx.db.delete(row); // erased with an account, say
    });
    await t.mutation(internal.notifications.retryParkedNotifications, {});
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });

  test('a card that heals with nothing left to age out takes its mirror with it, though its row goes', async () => {
    const t = harness();
    const bodyId = await seedBody(t, 'osm/heal-empty');
    await t.run(async (ctx) => {
      const id = await ctx.db.insert('bodySummaryRefreshes', {
        waterBodyId: bodyId,
        refreshAt: T0,
      });
      const card = await ctx.db.get(id);
      if (card) await recordCardFailure(ctx, card, 'Error', T0, {});
    });
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toHaveLength(1);
    // No Reports on the lake: the recompute goes through and there is nothing left to refresh.
    await t.mutation(internal.waterBodies.refreshOneBodySummary, { waterBodyId: bodyId, now: T0 });
    expect(await t.run((ctx) => ctx.db.query('bodySummaryRefreshes').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });

  test('a failing recording its owner answers, or a report takes, takes its mirror with it', async () => {
    const t = harness();
    const skater = await seedUser(t, 'answers');
    const bodyId = await seedBody(t, 'osm/answered');
    const answered = await seedActivity(t, skater.id, 0);
    const linked = await seedActivity(t, skater.id, 1);
    await t.run(async (ctx) => {
      for (const id of [answered, linked]) {
        const a = await ctx.db.get(id);
        if (a) await recordPromptFailure(ctx, a, 'Error', T0, {});
      }
    });
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toHaveLength(2);
    await skater.as.mutation(api.gpsActivities.setPromptState, {
      activityId: answered,
      promptState: 'dismissed',
    });
    const reportId = await seedReport(t, skater.id, bodyId);
    await t.run((ctx) => linkActivityToReport(ctx, linked, reportId, skater.id));
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });

  test('an event due earlier than a settling row starts its own row; one due later joins — neither row clock moves', async () => {
    const t = harness();
    const fan = await seedUser(t, 'zone-change');
    const bodyId = await seedBody(t, 'osm/zone-change');
    const reportId = await seedReport(t, fan.id, bodyId);
    const notice = (flushAfter: number) =>
      t.run((ctx) =>
        enqueueReportNotice(ctx, {
          userId: fan.id,
          waterBodyId: bodyId,
          reportId,
          kind: 'digest',
          type: 'nearby_report_digest',
          flushAfter,
          now: Date.now(),
          reportAt: Date.now(),
        }),
      );
    // Tonight's digest in the old zone, then a report stamped for an hour earlier in the new one: it
    // would be due before the row, so it is a row of its own.
    await notice(T0 + 5 * HOUR);
    await notice(T0 + 4 * HOUR);
    const rows = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(rows.map((r) => [r.count, r.flushAfter, r.firstDueAt]).sort()).toEqual(
      [
        [1, T0 + 4 * HOUR, T0 + 4 * HOUR],
        [1, T0 + 5 * HOUR, T0 + 5 * HOUR],
      ].sort(),
    );
    // A later-stamped one joins the first row it may (the earlier-due one) and moves nothing.
    await notice(T0 + 6 * HOUR);
    const after = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(after.reduce((n, r) => n + r.count, 0)).toBe(3);
    for (const r of after) expect(r.flushAfter).toBe(r.firstDueAt);
  });

  test('the daily retry clears a gone body and goes on to the next failing one', async () => {
    const t = harness();
    const live = await seedBody(t, 'osm/rollover-live');
    const gone = await seedBody(t, 'osm/rollover-gone');
    await t.run(async (ctx) => {
      // The gone body failed first, so it is the least recently failed — the one picked first.
      for (const [key, at] of [
        [gone, T0 - 2 * DAY],
        [live, T0 - DAY],
      ] as const) {
        await ctx.db.insert('jobFailures', {
          job: 'standingRollover',
          key,
          scope: '2027',
          attempts: 1,
          errorClass: 'Error',
          firstFailedAt: at,
          lastFailedAt: at,
        });
      }
      await ctx.db.delete(gone);
    });
    expect(await t.mutation(internal.recurringJobs.retryParkedDaily, {})).toEqual({
      freed: 2,
      failed: 0,
      more: false,
    });
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });

  test("a registry walk reads only its own tier's failures since it began, however many old ones there are", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 1005; i++) {
        await ctx.db.insert('jobFailures', {
          job: 'weatherCells',
          key: `cell:filter:old-${i}`,
          scope: 'filter',
          attempts: 1,
          errorClass: 'Error',
          firstFailedAt: T0 - DAY,
          lastFailedAt: T0 - DAY,
        });
      }
      await ctx.db.insert('jobFailures', {
        job: 'weatherCells',
        key: 'cell:browse:new',
        scope: 'browse',
        attempts: 1,
        errorClass: 'Error',
        firstFailedAt: T0,
        lastFailedAt: T0,
      });
    });
    const since = (scope: string) =>
      t.query(internal.recurringJobs.failedSince, { job: 'weatherCells', since: T0, scope });
    // The other tier's failure in this walk does not hold this one back, nor do a thousand old ones.
    expect(await since('filter')).toBe(false);
    expect(await since('browse')).toBe(true);
    // A complete walk forgets its own tier's old failures, oldest first, and leaves the other's.
    expect(
      await t.mutation(internal.recurringJobs.forgetBefore, {
        job: 'weatherCells',
        before: T0,
        scope: 'filter',
      }),
    ).toBe(1000);
    const left = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(left.filter((r) => r.scope === 'filter')).toHaveLength(5);
    expect(left.filter((r) => r.scope === 'browse')).toHaveLength(1);
  });
});

// ── The freshness rule, by construction (D258) ──────────────────────────────────────────────────

describe('the freshness rule holds at enqueue and at flush, by construction', () => {
  const DEBOUNCE = 2 * MINUTE;

  async function freshnessSetup() {
    const t = harness();
    const fans = [await seedUser(t, 'fan0'), await seedUser(t, 'fan1')];
    const bodies = [await seedBody(t, 'osm/fresh-0'), await seedBody(t, 'osm/fresh-1')];
    const reportId = await seedReport(
      t,
      fans[0]?.id as Id<'profiles'>,
      bodies[0] as Id<'waterBodies'>,
    );
    const activities: Id<'gpsActivities'>[][] = [];
    for (const [u, fan] of fans.entries()) {
      activities.push([
        await seedActivity(t, fan.id, 10 * u),
        await seedActivity(t, fan.id, 10 * u + 1),
      ]);
    }
    const reportNotice = (u: number, b: number, early = false) =>
      t.run((ctx) =>
        enqueueReportNotice(ctx, {
          userId: fans[u]?.id as Id<'profiles'>,
          waterBodyId: bodies[b] as Id<'waterBodies'>,
          reportId,
          kind: 'favorite',
          type: 'favorite_report',
          // Some events are stamped due sooner than a row already settling (a zone change, say).
          flushAfter: Date.now() + (early ? DEBOUNCE / 4 : DEBOUNCE),
          now: Date.now(),
          reportAt: Date.now(),
        }),
      );
    const actorNotice = (u: number, a: number) =>
      t.run((ctx) =>
        notificationQueue.enqueueActorNotification(ctx, {
          recipientId: fans[u]?.id as Id<'profiles'>,
          targetId: activities[u]?.[a] as string,
          trigger: { kind: 'activity', activityId: activities[u]?.[a] as Id<'gpsActivities'> },
          now: Date.now(),
        }),
      );
    /** A row as the code before D258 wrote it, under the same key a new event would use. */
    const seedLegacy = (l: Legacy) =>
      t.run((ctx) => {
        const userId = fans[l.u]?.id as Id<'profiles'>;
        const base = {
          userId,
          count: 1,
          flushAfter: Date.now() + l.dueInMs,
          createdAt: Date.now() - l.ageMs,
        };
        if (l.k === 'report') {
          const waterBodyId = bodies[l.x] as Id<'waterBodies'>;
          return ctx.db.insert('notificationQueue', {
            ...base,
            waterBodyId,
            kind: 'favorite' as const,
            type: 'favorite_report' as const,
            coalesceKey: `${userId}:${waterBodyId}:favorite`,
            latestReportId: reportId,
          });
        }
        const activityId = activities[l.u]?.[l.x] as Id<'gpsActivities'>;
        return ctx.db.insert('notificationQueue', {
          ...base,
          kind: 'activity' as const,
          type: 'activity_detected' as const,
          coalesceKey: notificationQueue.actorCoalesceKey(userId, activityId, 'activity'),
          trigger: { kind: 'activity' as const, activityId },
        });
      });
    return { t, reportNotice, actorNotice, seedLegacy };
  }

  const rowsOf = (t: T) => t.run((ctx) => ctx.db.query('notificationQueue').collect());
  const inboxOf = (t: T) => t.run((ctx) => ctx.db.query('notifications').collect());

  type Cmd =
    | { k: 'report'; u: number; b: number; early: boolean }
    | { k: 'actor'; u: number; a: number }
    | { k: 'advance'; ms: number }
    | { k: 'flush' }
    | { k: 'poison'; u: number }
    | { k: 'heal' }
    | { k: 'retry' };

  /** A row written before D258: no clock of its own, any age, due any time around now. */
  type Legacy = { k: 'actor' | 'report'; u: number; x: number; ageMs: number; dueInMs: number };
  const legacy: fc.Arbitrary<Legacy> = fc.record({
    k: fc.constantFrom('actor' as const, 'report' as const),
    u: fc.nat(1),
    x: fc.nat(1),
    ageMs: fc.integer({ min: 0, max: 30 * HOUR }),
    dueInMs: fc.integer({ min: -2 * HOUR, max: 2 * HOUR }),
  });

  const cmd: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({
      k: fc.constant('report' as const),
      u: fc.nat(1),
      b: fc.nat(1),
      early: fc.boolean(),
    }),
    fc.record({ k: fc.constant('actor' as const), u: fc.nat(1), a: fc.nat(1) }),
    // Outages of any length, up to most of a day.
    fc.record({ k: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 20 * HOUR }) }),
    fc.constant({ k: 'flush' as const }),
    fc.record({ k: fc.constant('poison' as const), u: fc.nat(1) }),
    fc.constant({ k: 'heal' as const }),
    fc.constant({ k: 'retry' as const }),
  );

  test('over any interleaving of both enqueue paths, flushes, outages, parking and the retry: nothing past its window is sent, nothing fresh is lost to an older clock, no clock moves, nothing is sent twice', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(legacy, { maxLength: 3 }),
        fc.array(cmd, { minLength: 1, maxLength: 14 }),
        async (legacyRows, cmds) => {
          vi.restoreAllMocks();
          vi.setSystemTime(T0);
          const { t, reportNotice, actorNotice, seedLegacy } = await freshnessSetup();
          for (const l of legacyRows) await seedLegacy(l);
          const users = (await t.run((ctx) => ctx.db.query('profiles').collect())).map(
            (p) => p._id,
          );
          const poisoned = new Set<string>();
          const real = notificationQueue.isStaleQueueRow;
          vi.spyOn(notificationQueue, 'isStaleQueueRow').mockImplementation((row, now) => {
            if (poisoned.has((row as unknown as { userId: string }).userId))
              throw new Error('poison');
            return real(row, now);
          });
          // Every row ever written, with its clock — the pre-rule rows from the start, so one the first
          // flush sends is counted by (d) like any other.
          const clocks = new Map<string, number>();
          for (const r of await rowsOf(t)) clocks.set(r._id, notificationQueue.dueClockOf(r));
          for (const c of cmds) {
            const before = await rowsOf(t);
            const sentBefore = (await inboxOf(t)).length;
            const now = Date.now();
            if (c.k === 'report' || c.k === 'actor') {
              if (c.k === 'report') await reportNotice(c.u, c.b, c.early);
              else await actorNotice(c.u, c.a);
              const after = await rowsOf(t);
              // The event joined a row still settling, or a new one — never a row from before the rule
              // (it has no clock of its own): its clock never began before it.
              const touched = after.filter((r) => {
                const was = before.find((b) => b._id === r._id);
                return !was || JSON.stringify(was) !== JSON.stringify(r);
              });
              for (const r of touched) expect(r.firstDueAt).toBeGreaterThan(now);
            } else if (c.k === 'advance') vi.setSystemTime(now + c.ms);
            else if (c.k === 'poison') poisoned.add(users[c.u] as string);
            else if (c.k === 'heal') poisoned.clear();
            else {
              if (c.k === 'flush')
                await t.mutation(internal.notifications.flushNotificationQueue, {});
              else await t.mutation(internal.notifications.retryParkedNotifications, {});
              await t.finishInProgressScheduledFunctions();
              const after = await rowsOf(t);
              const gone = before.filter((b) => !after.some((a) => a._id === b._id));
              const sent = (await inboxOf(t)).slice(sentBefore);
              // (a) and (b): a row that left was sent exactly when it was inside its window.
              const freshGone = gone.filter(
                (g) => now - notificationQueue.dueClockOf(g) <= NOTIFICATION_FRESH_MS,
              );
              const keys = (rows: { coalesceKey?: string; payload?: { coalesceKey?: string } }[]) =>
                rows.map((r) => r.coalesceKey ?? r.payload?.coalesceKey).sort();
              expect(keys(sent)).toEqual(keys(freshGone));
            }
            // (c): every row's clock — its own, or a pre-rule row's earliest — never changes.
            for (const r of await rowsOf(t)) {
              const clock = notificationQueue.dueClockOf(r);
              const seen = clocks.get(r._id);
              if (seen !== undefined) expect(clock).toBe(seen);
              clocks.set(r._id, clock);
            }
          }
          // (d): never more inbox rows than rows ever written.
          expect((await inboxOf(t)).length).toBeLessThanOrEqual(clocks.size);
        },
      ),
      { numRuns: 30 },
    );
  }, 180_000);

  test('the report path (Greptile): after a long outage a new notice gets its own row and is sent; the expired row is not', async () => {
    const { t, reportNotice } = await freshnessSetup();
    await reportNotice(0, 0);
    vi.setSystemTime(T0 + NOTIFICATION_FRESH_MS + HOUR); // the flush was down
    await reportNotice(0, 0);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(2);
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 0,
      expired: 1,
    });
    vi.setSystemTime(Date.now() + DEBOUNCE + 1);
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 1,
    });
  });

  test('the actor path (Greptile): a new event never moves an old row on, so yesterday never passes for today', async () => {
    const { t, actorNotice } = await freshnessSetup();
    await actorNotice(0, 0);
    const [old] = await rowsOf(t);
    vi.setSystemTime(T0 + NOTIFICATION_FRESH_MS + HOUR);
    await actorNotice(0, 0);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r._id === old?._id)?.flushAfter).toBe(old?.flushAfter);
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(await t.run((ctx) => ctx.db.get(old?._id as Id<'notificationQueue'>))).toBeNull();
    expect(await inboxOf(t)).toHaveLength(0);
  });

  test('a pre-rule actor row, then a fresh actor event, then a flush (Greptile): the fresh event gets its own row and is sent; the old row expires', async () => {
    const { t, actorNotice, seedLegacy } = await freshnessSetup();
    // Created a day ago, its flush time pushed to a minute from now by the old moving-deadline rule.
    const legacyRow = await seedLegacy({ k: 'actor', u: 0, x: 0, ageMs: DAY, dueInMs: MINUTE });
    await actorNotice(0, 0);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r._id === legacyRow)?.count).toBe(1); // not joined
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 1,
      expired: 1,
    });
    expect(await rowsOf(t)).toEqual([]);
  });

  test('a row that failed is never joined, though its run moved it just past the moment the event lands — a pre-rule row stamped by that failure included', async () => {
    const { t, actorNotice, reportNotice, seedLegacy } = await freshnessSetup();
    // A pre-rule actor row an hour old, and a row of the rule's own that fell due a minute ago.
    const legacyRow = await seedLegacy({ k: 'actor', u: 0, x: 0, ageMs: HOUR, dueInMs: -1 });
    await reportNotice(1, 0);
    vi.setSystemTime(Date.now() + DEBOUNCE + MINUTE);
    const now = Date.now();
    // Both fail in a run whose cutoff is now: each is moved to just past it, its clock kept.
    for (const row of await rowsOf(t)) {
      await t.run((ctx) => recordQueueFailure(ctx, row, 'Error', now, { cutoff: now }));
    }
    const failed = await rowsOf(t);
    for (const r of failed) {
      expect(r.flushAfter).toBe(now + 1);
      expect(r.firstDueAt).toBeLessThan(now);
    }
    // An event in that same moment: each gets a row of its own, with a clock that starts after it.
    await actorNotice(0, 0);
    await reportNotice(1, 0);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(4);
    for (const was of failed) {
      expect(rows.find((r) => r._id === was._id)).toEqual(was);
    }
    // The pre-rule row's stamped clock is its `createdAt`, an hour before the setup's clock.
    expect(rows.find((r) => r._id === legacyRow)?.firstDueAt).toBe(T0 - HOUR);
    for (const r of rows.filter((r) => !failed.some((f) => f._id === r._id))) {
      expect(r.firstDueAt).toBeGreaterThan(now);
    }
  });

  test('a body is listed once in a digest, however many rows carry it — counts summed, the newest report kept', async () => {
    const t = harness();
    const fan = await seedUser(t, 'digest-twice');
    await t.run((ctx) =>
      ctx.db.patch(fan.id, { notificationPrefs: { ...NOTIF_PREFS, nearbyReportDigest: true } }),
    );
    const a = await seedBody(t, 'osm/digest-twice-a');
    const b = await seedBody(t, 'osm/digest-twice-b');
    const older = await seedReport(t, fan.id, a);
    const newer = await seedReport(t, fan.id, a);
    const tonight = T0 + 5 * HOUR;
    // Tonight's digest row for body a from before the rule, two reports in.
    await t.run((ctx) =>
      ctx.db.insert('notificationQueue', {
        userId: fan.id,
        waterBodyId: a,
        kind: 'digest' as const,
        type: 'nearby_report_digest' as const,
        coalesceKey: `${fan.id}:${a}:digest`,
        latestReportId: older,
        count: 2,
        flushAfter: tonight,
        createdAt: T0 - HOUR,
      }),
    );
    const notice = (waterBodyId: Id<'waterBodies'>, reportId: Id<'reports'>) =>
      t.run((ctx) =>
        enqueueReportNotice(ctx, {
          userId: fan.id,
          waterBodyId,
          reportId,
          kind: 'digest',
          type: 'nearby_report_digest',
          flushAfter: tonight,
          now: Date.now(),
          reportAt: Date.now(),
        }),
      );
    // A report on body a since the rule: never joined to the old row, so a row of its own.
    await notice(a, newer);
    await notice(b, older);
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toHaveLength(3);
    vi.setSystemTime(tonight);
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 1,
    });
    const [sent] = await inbox(t, fan.id);
    expect(sent?.payload).toMatchObject({
      bodies: [
        { waterBodyId: a, reportId: newer, count: 3 },
        { waterBodyId: b, reportId: older, count: 1 },
      ],
      totalCount: 4,
    });
  });

  test('a row written before the rule (no clock of its own) is read by its earliest clock, never as fresh', async () => {
    const { t } = await freshnessSetup();
    const [fan] = await t.run((ctx) => ctx.db.query('profiles').collect());
    const activityId = (await t.run((ctx) => ctx.db.query('gpsActivities').first()))?._id;
    // An actor row from before D258: created a day ago, its flush time pushed to now by later events.
    const row = await t.run((ctx) =>
      ctx.db.insert('notificationQueue', {
        userId: fan?._id as Id<'profiles'>,
        kind: 'activity' as const,
        type: 'activity_detected' as const,
        coalesceKey: 'legacy',
        count: 1,
        flushAfter: Date.now() - 1,
        createdAt: Date.now() - DAY,
        trigger: { kind: 'activity' as const, activityId: activityId as Id<'gpsActivities'> },
      }),
    );
    expect(await t.mutation(internal.notifications.flushNotificationQueue, {})).toMatchObject({
      delivered: 0,
      expired: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(row))).toBeNull();
  });
});

// ── "Latest" follows the content, never a row's creation time (D258, Greptile P2) ───────────────

describe('a digest links the newest report it counts', () => {
  async function digestSetup() {
    const t = harness();
    const fan = await seedUser(t, 'tz-fan');
    await t.run((ctx) =>
      ctx.db.patch(fan.id, { notificationPrefs: { ...NOTIF_PREFS, nearbyReportDigest: true } }),
    );
    const bodyId = await seedBody(t, 'osm/tz');
    /** One report's notice, arriving now; the report itself created at `reportAt`. */
    const notice = async (flushAfter: number, reportAt = Date.now()) => {
      const reportId = await seedReport(t, fan.id, bodyId);
      await t.run((ctx) =>
        enqueueReportNotice(ctx, {
          userId: fan.id,
          waterBodyId: bodyId,
          reportId,
          kind: 'digest',
          type: 'nearby_report_digest',
          flushAfter,
          now: Date.now(),
          reportAt,
        }),
      );
      return reportId;
    };
    return { t, fan, bodyId, notice };
  }

  test('a late-arriving older report is counted but never linked over a newer one — on a join, or from a row of its own', async () => {
    const { t, fan, bodyId, notice } = await digestSetup();
    // Fan-out pages can land out of order: the newer report's first.
    const newest = await notice(T0 + 5 * HOUR, T0 - MINUTE);
    vi.setSystemTime(Date.now() + MINUTE);
    await notice(T0 + 5 * HOUR, T0 - 2 * MINUTE); // older, joins the row
    const [row] = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(row).toMatchObject({ count: 2, latestReportId: newest, latestAt: T0 - MINUTE });
    vi.setSystemTime(Date.now() + MINUTE);
    await notice(T0 + 4 * HOUR, T0 - 3 * MINUTE); // older still, due earlier: a row of its own
    vi.setSystemTime(T0 + 5 * HOUR + MINUTE);
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    const [digest] = await inbox(t, fan.id);
    expect(digest?.payload.bodies).toEqual([{ waterBodyId: bodyId, reportId: newest, count: 3 }]);
  });

  test('in any arrival order over any zone changes, the digest links the report created last', async () => {
    const events = fc
      .array(fc.integer({ min: -2, max: 2 }), { minLength: 1, maxLength: 6 })
      .chain((zones) =>
        fc.tuple(
          fc.constant(zones),
          fc.shuffledSubarray(
            zones.map((_, i) => i),
            { minLength: zones.length, maxLength: zones.length },
          ),
        ),
      );
    await fc.assert(
      fc.asyncProperty(events, async ([zones, arrival]) => {
        vi.setSystemTime(T0);
        const { t, fan, notice } = await digestSetup();
        // Report `i` was created `i` minutes past an hour ago; their notices arrive in `arrival`.
        const ids = new Map<number, Id<'reports'>>();
        for (const i of arrival) {
          ids.set(i, await notice(T0 + (5 + (zones[i] ?? 0)) * HOUR, T0 - HOUR + i * MINUTE));
          vi.setSystemTime(Date.now() + MINUTE);
        }
        vi.setSystemTime(T0 + 8 * HOUR);
        await t.mutation(internal.notifications.flushNotificationQueue, {});
        const sent = await inbox(t, fan.id);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.payload.bodies).toEqual([
          expect.objectContaining({ reportId: ids.get(zones.length - 1), count: zones.length }),
        ]);
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  test('the timezone sequence (Greptile): tonight in the old zone, an earlier-due report after a zone change, then a later one after switching back — both rows flush together and the digest links the newest', async () => {
    const { t, fan, bodyId, notice } = await digestSetup();
    await notice(T0 + 5 * HOUR); // the old zone's 8 pm
    vi.setSystemTime(Date.now() + MINUTE);
    await notice(T0 + 4 * HOUR); // a zone an hour east: due earlier, a row of its own
    vi.setSystemTime(Date.now() + MINUTE);
    const newest = await notice(T0 + 5 * HOUR); // back again: joins the first row
    vi.setSystemTime(T0 + 5 * HOUR + MINUTE);
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    const [digest] = await inbox(t, fan.id);
    expect(digest?.payload.bodies).toEqual([{ waterBodyId: bodyId, reportId: newest, count: 3 }]);
  });

  test('over any sequence of zone changes, the one digest counts every event and links the newest report', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -2, max: 2 }), { minLength: 1, maxLength: 6 }),
        async (zones) => {
          vi.setSystemTime(T0);
          const { t, fan, notice } = await digestSetup();
          let newest: Id<'reports'> | undefined;
          for (const z of zones) {
            newest = await notice(T0 + (5 + z) * HOUR);
            vi.setSystemTime(Date.now() + MINUTE);
          }
          vi.setSystemTime(T0 + 8 * HOUR);
          await t.mutation(internal.notifications.flushNotificationQueue, {});
          const sent = await inbox(t, fan.id);
          expect(sent).toHaveLength(1);
          expect(sent[0]?.payload.bodies).toHaveLength(1);
          expect(sent[0]?.payload.bodies[0]).toMatchObject({
            reportId: newest,
            count: zones.length,
          });
          expect(sent[0]?.payload.totalCount).toBe(zones.length);
        },
      ),
      { numRuns: 15 },
    );
  }, 60_000);
});
