/**
 * **The cron registry and its registration** (D343, D347, B01-8b). The move of every cron out of
 * `crons.ts` into `CRON_JOBS` must change nothing a cron does: the same 52 names, each on the same
 * schedule, each running the same function with the same arguments — pinned below against a literal
 * table taken from `crons.crons` before the move. The one intended change is called out in the table.
 *
 * Reads no repo file (it imports modules), so it stays in the cached convex suite. `crons.test.ts`
 * is the recorder's (S1's) guard file; this one is the registry's.
 */

import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import {
  CRON_JOBS,
  CRON_PIPELINES,
  CRON_RETENTION,
  type CronJobSchedule,
  cronJob,
  cronPeriodMs,
  cronScheduleOf,
  FREQUENT_CRON_RECORD,
  SEASON_CRON_RETENTION,
} from './cronJobs';
import { requireCronJob } from './cronRuns';
import crons from './crons';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** What `cronJobs()` keeps per registration. */
type Registration = { name: string; args: unknown[]; schedule: Record<string, unknown> };
const registered = (crons as unknown as { crons: Record<string, Registration> }).crons;

/**
 * Every cron as `crons.crons` held it before the backbone: name, the function it ran, its schedule
 * as Convex records it, its arguments. In registration order.
 *
 * ⚠ The one intended change: *watch for the imagery season to open* was `{ type: 'interval',
 * hours: 24 }`; it is now daily at 11:30 UTC (D346).
 */
const BEFORE: readonly [string, string, Record<string, unknown>, Record<string, unknown>][] = [
  [
    'flush notification queue',
    'notifications:flushNotificationQueue',
    { type: 'interval', minutes: 1 },
    {},
  ],
  ['expire bounties', 'bounties:expireBounties', { type: 'interval', hours: 6 }, {}],
  [
    'refresh hazard weather',
    'hazardWeather:refreshHazardWeather',
    { type: 'interval', hours: 1 },
    {},
  ],
  ['roll up operator metrics', 'analyticsRollup:runRollup', { type: 'interval', hours: 6 }, {}],
  [
    'sweep water-body coverage',
    'analyticsRollup:sweepCorpus',
    { type: 'interval', hours: 168 },
    {},
  ],
  [
    'prune bounty gate events',
    'analyticsRollup:pruneGateEvents',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'prune client signal events',
    'analyticsRollup:pruneClientSignals',
    { type: 'interval', hours: 24 },
    {},
  ],
  ['prune oauth states', 'strava:pruneOAuthStates', { type: 'interval', hours: 6 }, {}],
  ['prune photo picker sessions', 'googlePhotos:pruneSessions', { type: 'interval', hours: 1 }, {}],
  [
    'finalize account deletions',
    'accountDeletion:finalizeDueDeletions',
    { type: 'interval', hours: 1 },
    {},
  ],
  ['erase withdrawn content', 'erasure:eraseDue', { type: 'interval', hours: 1 }, {}],
  ['settle photos erasure let go of', 'erasure:settleOwed', { type: 'interval', hours: 1 }, {}],
  [
    'retry parked erasure work',
    'erasure:retryParkedDaily',
    { type: 'daily', hourUTC: 9, minuteUTC: 40 },
    {},
  ],
  [
    'retry parked notifications',
    'notifications:retryParkedNotifications',
    { type: 'interval', hours: 1 },
    {},
  ],
  [
    'retry parked recurring work',
    'recurringJobs:retryParkedDaily',
    { type: 'daily', hourUTC: 9, minuteUTC: 50 },
    {},
  ],
  [
    'purge last season notifications',
    'storageHygiene:purgeLastSeasonNotifications',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'prompt unreported skates',
    'gpsActivities:sweepUnpromptedActivities',
    { type: 'interval', hours: 1 },
    {},
  ],
  ['prune weather cache', 'storageHygiene:pruneWeatherCache', { type: 'interval', hours: 6 }, {}],
  ['prune forecast cache', 'storageHygiene:pruneForecastCache', { type: 'interval', hours: 6 }, {}],
  [
    'reconcile weather cell registry',
    'weatherArchive:maybeSyncWeatherCells',
    { type: 'interval', hours: 168 },
    {},
  ],
  [
    'append daily weather archive',
    'weatherArchive:maybeRefreshFilterTier',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'append daily bay weather archive',
    'weatherArchive:maybeRefreshBayTier',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'repair weather archive gaps',
    'weatherArchive:maybeSweepGaps',
    { type: 'interval', hours: 24 },
    {},
  ],
  ['sweep orphan photos', 'storageHygiene:sweepOrphanPhotos', { type: 'interval', hours: 24 }, {}],
  ['purge removed photos', 'photoPurge:purgeDuePhotos', { type: 'interval', hours: 24 }, {}],
  ['sweep photo files', 'photoPurge:sweepPhotoFiles', { type: 'interval', hours: 24 }, {}],
  ['expire access alerts', 'accessAlerts:expireLapsedAlerts', { type: 'interval', hours: 6 }, {}],
  [
    'expire departed skaters photos',
    'storageHygiene:sweepDepartedPhotos',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'sweep expired exports',
    'storageHygiene:sweepExpiredExports',
    { type: 'interval', hours: 1 },
    {},
  ],
  [
    'recompute hazard recurrence at the rollover',
    'recurrence:maybeRunRollover',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'demote inactive bodies at the rollover',
    'standing:maybeRunStandingRollover',
    { type: 'interval', hours: 24 },
    {},
  ],
  [
    'watch for the imagery season to open',
    'imageryIngest:maybeCheckSeasonOpen',
    { type: 'daily', hourUTC: 11, minuteUTC: 30 },
    {},
  ],
  ['poll for new satellite imagery', 'imageryLive:poll', { type: 'interval', hours: 6 }, {}],
  ['pump live satellite imagery', 'imageryLive:pump', { type: 'interval', minutes: 3 }, {}],
  [
    'rebuild the live imagery index',
    'imageryLive:buildIndex',
    { type: 'interval', minutes: 10 },
    {},
  ],
  ['refresh nws alerts', 'weatherAlerts:refreshAlerts', { type: 'interval', minutes: 15 }, {}],
  ['sweep body summaries', 'waterBodies:sweepDueBodySummaries', { type: 'interval', hours: 1 }, {}],
  [
    'drain the bodies library queue',
    'bodyLibrary:drainQueue',
    { type: 'interval', minutes: 1 },
    {},
  ],
  ['turn the bodies library season', 'bodyLibrary:turnSeason', { type: 'interval', hours: 1 }, {}],
  ['repair bodies library drift', 'bodyLibrary:repairDrift', { type: 'interval', minutes: 2 }, {}],
  ['repair inbox items drift', 'inboxItems:repair', { type: 'interval', minutes: 3 }, {}],
  ['repair corpus tasks drift', 'corpusTaskJobs:repair', { type: 'interval', minutes: 3 }, {}],
  [
    'reset lapsed suspensions',
    'peopleJobs:sweepLapsedSuspensions',
    { type: 'interval', minutes: 15 },
    {},
  ],
  [
    'retry parked suspension resets',
    'peopleJobs:retryLapsedDaily',
    { type: 'daily', hourUTC: 9, minuteUTC: 50 },
    {},
  ],
  ['repair people rows drift', 'peopleJobs:repairDrift', { type: 'interval', minutes: 10 }, {}],
  [
    'reconcile clerk ban locks',
    'clerkReconcile:run',
    { type: 'daily', hourUTC: 10, minuteUTC: 20 },
    {},
  ],
  [
    'prune terms readings',
    'consent:pruneReadings',
    { type: 'daily', hourUTC: 10, minuteUTC: 30 },
    {},
  ],
  [
    'purge due consent records',
    'consent:purgeDue',
    { type: 'daily', hourUTC: 10, minuteUTC: 40 },
    {},
  ],
  ['compute body geometry facts', 'bodyGeo:computeDue', { type: 'interval', minutes: 5 }, {}],
  [
    'retry parked body geometry',
    'bodyGeo:computeDue',
    { type: 'interval', hours: 24 },
    { parked: true },
  ],
  ['repair body geometry drift', 'bodyGeo:repairDrift', { type: 'interval', minutes: 30 }, {}],
  ['find bodies missing geometry', 'bodyGeo:repairMissing', { type: 'interval', hours: 168 }, {}],
];

const MUTATION_DISPATCHER = getFunctionName(internal.cronRuns.tickMutation);
const ACTION_DISPATCHER = getFunctionName(internal.cronRuns.tickAction);

/** The five crons that tick every one to three minutes, recorded sparsely (fork 1, option c). */
const FREQUENT = [
  'flush notification queue',
  'drain the bodies library queue',
  'repair bodies library drift',
  'repair inbox items drift',
  'repair corpus tasks drift',
];

describe('the registry is the crons as they were', () => {
  test('the same 52 names, in the same order', () => {
    expect(BEFORE).toHaveLength(52);
    expect(Object.keys(registered)).toEqual(BEFORE.map(([name]) => name));
    expect(CRON_JOBS.map((j) => j.name)).toEqual(BEFORE.map(([name]) => name));
  });

  test.each(BEFORE)('%s: same schedule, function and arguments', (name, fn, schedule, args) => {
    const entry = cronJob(name);
    expect(entry).not.toBeNull();
    expect(getFunctionName(entry?.fn as never)).toBe(fn);
    expect(entry?.args).toEqual(args);
    expect(registered[name]?.schedule).toEqual(schedule);
  });
});

describe('every registration is an entry, and every entry is registered once', () => {
  test('names are unique', () => {
    expect(new Set(CRON_JOBS.map((j) => j.name)).size).toBe(CRON_JOBS.length);
  });

  test('every registration names its dispatcher with { job } equal to its own name', () => {
    for (const [name, reg] of Object.entries(registered)) {
      const entry = cronJob(name);
      expect(entry, `${name} is registered but is not an entry`).not.toBeNull();
      expect(reg.name).toBe(entry?.kind === 'mutation' ? MUTATION_DISPATCHER : ACTION_DISPATCHER);
      expect(reg.args).toEqual([{ job: name }]);
    }
    expect(Object.keys(registered)).toHaveLength(CRON_JOBS.length);
  });

  test("each entry's kind is its function's", async () => {
    for (const entry of CRON_JOBS) {
      const [file, name] = getFunctionName(entry.fn).split(':') as [string, string];
      const load = modules[`./${file}.ts`];
      expect(load, `${entry.name}: ./${file}.ts is a module`).toBeDefined();
      const mod = (await load?.()) as Record<string, Record<string, unknown>>;
      const fn = mod[name];
      expect(fn, `${entry.name}: ${file}:${name} exists`).toBeDefined();
      expect(fn?.isInternal, entry.name).toBe(true);
      if (entry.kind === 'mutation') expect(fn?.isMutation, entry.name).toBe(true);
      else expect(fn?.isAction, entry.name).toBe(true);
    }
  });
});

describe('what each entry carries', () => {
  test('a pipeline from the list, and a retention', () => {
    for (const entry of CRON_JOBS) {
      expect(CRON_PIPELINES).toContain(entry.pipeline);
      expect([CRON_RETENTION, SEASON_CRON_RETENTION]).toContain(entry.retention);
    }
  });

  test('only the three imagery jobs keep their runs a season', () => {
    const season = CRON_JOBS.filter((j) => j.retention === SEASON_CRON_RETENTION).map(
      (j) => j.name,
    );
    expect(season).toEqual([
      'poll for new satellite imagery',
      'pump live satellite imagery',
      'rebuild the live imagery index',
    ]);
  });

  test('the five frequent crons record sparsely; every other cron records every tick', () => {
    expect(FREQUENT_CRON_RECORD).toBe('sparse');
    for (const entry of CRON_JOBS) {
      expect(entry.record, entry.name).toBe(FREQUENT.includes(entry.name) ? 'sparse' : 'every');
    }
  });

  test('the long actions announce', () => {
    const announcing = CRON_JOBS.filter((j) => j.kind === 'action' && j.announces).map(
      (j) => j.name,
    );
    expect(announcing).toEqual([
      'refresh hazard weather',
      'reconcile weather cell registry',
      'append daily weather archive',
      'append daily bay weather archive',
      'repair weather archive gaps',
      'poll for new satellite imagery',
      'pump live satellite imagery',
      'rebuild the live imagery index',
      'compute body geometry facts',
      'retry parked body geometry',
    ]);
  });
});

describe('the lookups', () => {
  test('cronJob finds own entries only', () => {
    expect(cronJob('expire bounties')?.name).toBe('expire bounties');
    expect(cronJob('nope')).toBeNull();
    expect(cronJob('toString')).toBeNull();
  });

  test.each<[CronJobSchedule, ReturnType<typeof cronScheduleOf>, number]>([
    [{ every: { seconds: 30 } }, { every: 30_000 }, 30_000],
    [{ every: { minutes: 3 } }, { every: 180_000 }, 180_000],
    [{ every: { hours: 168 } }, { every: 604_800_000 }, 604_800_000],
    [
      { daily: { hourUTC: 11, minuteUTC: 30 } },
      { daily: { hourUTC: 11, minuteUTC: 30 } },
      86_400_000,
    ],
    [
      { weekly: { dayOfWeek: 'monday', hourUTC: 4, minuteUTC: 5 } },
      { weekly: { dayOfWeek: 1, hourUTC: 4, minuteUTC: 5 } },
      604_800_000,
    ],
  ])('cronScheduleOf(%j)', (schedule, core, period) => {
    expect(cronScheduleOf(schedule)).toEqual(core);
    expect(cronPeriodMs(schedule)).toBe(period);
  });

  test('requireCronJob refuses an unknown name and the wrong kind', () => {
    expect(requireCronJob('expire bounties', 'mutation').name).toBe('expire bounties');
    expect(requireCronJob('pump live satellite imagery', 'action').kind).toBe('action');
    expect(() => requireCronJob('nope', 'mutation')).toThrow(/no cron named "nope"/);
    expect(() => requireCronJob('expire bounties', 'action')).toThrow(/is a mutation job/);
    expect(() => requireCronJob('pump live satellite imagery', 'mutation')).toThrow(
      /is an action job/,
    );
  });
});

describe('the dispatchers (placeholders until the recorder lands) run their job', () => {
  test('tickMutation runs a mutation job', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.cronRuns.tickMutation, { job: 'expire bounties' }),
    ).resolves.toBeNull();
  });

  test('tickAction runs an action job', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(internal.cronRuns.tickAction, { job: 'pump live satellite imagery' }),
    ).resolves.toBeNull();
  });

  test('the backbone jobs answer empty', async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.cronRunJobs.prune, {})).resolves.toEqual({
      deleted: 0,
      more: false,
    });
    await expect(
      t.mutation(internal.cronRunJobs.copyImageryRuns, { dryRun: true }),
    ).resolves.toEqual({ dryRun: true, copied: 0, alreadyCopied: 0, more: false });
    await expect(t.mutation(internal.cronRunJobs.copyImageryRuns, {})).resolves.toMatchObject({
      dryRun: false,
    });
  });
});

describe('the crons reads (placeholders until the reads land) are gated and answer empty', () => {
  async function asRole(t: ReturnType<typeof convexTest>, role: 'moderator' | 'admin') {
    const subject = `cron-reads-${role}`;
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: role,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: {
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
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: Date.UTC(2025, 0, 1),
      }),
    );
    return t.withIdentity({ subject });
  }

  test('an admin reads the empty answers', async () => {
    const t = convexTest(schema, modules);
    const admin = await asRole(t, 'admin');
    const runId = await t.run((ctx) =>
      ctx.db.insert('cronRuns', {
        job: 'expire bounties',
        startedAt: 1,
        finishedAt: 2,
        outcome: 'ok',
        trigger: 'cron',
        keepUntil: 3,
      }),
    );
    const page = { numItems: 25, cursor: null };
    await expect(
      admin.query(api.machineryCrons.jobs, { names: ['expire bounties'] }),
    ).resolves.toEqual([]);
    await expect(
      admin.query(api.machineryCrons.strip, { job: 'expire bounties', from: 0, to: 1 }),
    ).resolves.toEqual({ ticks: [], truncated: false });
    await expect(
      admin.query(api.machineryCrons.runsPage, {
        job: 'expire bounties',
        filter: 'failed',
        paginationOpts: page,
      }),
    ).resolves.toMatchObject({ page: [], isDone: true });
    await expect(
      admin.query(api.machineryCrons.runLog, { runId, paginationOpts: page }),
    ).resolves.toMatchObject({ page: [], isDone: true });
  });

  test('a moderator is refused', async () => {
    const t = convexTest(schema, modules);
    const mod = await asRole(t, 'moderator');
    await expect(mod.query(api.machineryCrons.jobs, { names: [] })).rejects.toThrow();
  });
});
