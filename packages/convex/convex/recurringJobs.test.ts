/**
 * D257: one failing item never blocks a recurring job. For each queue-shaped job — the notification
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
import { MAX_ATTEMPTS } from './lib/attempts';
import * as notificationQueue from './lib/notificationQueue';
import { NOTIFICATION_FRESH_MS } from './lib/notificationQueue';
import * as recurringWork from './lib/recurringWork';
import schema from './schema';

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
    await t.run(async (ctx) => {
      await ctx.db.patch(row, {
        attempts: 3,
        lastErrorClass: 'TypeError',
        parkedAt: T0 - HOUR,
        firstDueAt: T0 - 2 * HOUR,
      });
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
    const health = await admin.as.query(api.recurringJobs.health, { now: T0 });
    const job = (name: string) => health.jobs.find((j) => j.job === name);
    expect(job('flush notification queue')).toEqual({
      job: 'flush notification queue',
      failing: 0,
      parked: 1,
      oldestParkedAt: T0 - HOUR,
      oldestFailingSince: T0 - 2 * HOUR,
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
    expect(health.overdue.find((o) => o.job === 'finalize account deletions')).toEqual({
      job: 'finalize account deletions',
      overdue: 1,
      oldestDueAt: T0 - 2 * DAY,
      capped: false,
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
