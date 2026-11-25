/**
 * The Corpus tasks' backfill and drift repair (B01-6a): bounded on bytes as well as rows, resumable
 * from any cursor, idempotent, never wedged — a body that can't be done is recorded in `jobFailures`
 * and stepped past, and retried by the repair until it goes through; the repair finds and fixes each
 * kind of drift, and its dry run reports them and writes nothing.
 */

import type { ReviewReason } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { BODY_PHASES, ITEM_BYTES } from './corpusTaskJobs';
import { bodyTaskDrift, laneCountDrift } from './lib/corpusTaskRepair';
import { corpusTasksPending, countKeysOf } from './lib/corpusTasks';
import { ROW_MAX } from './lib/readBudget';
import * as recurringWork from './lib/recurringWork';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

afterEach(() => {
  vi.restoreAllMocks();
});

const square = (x: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
      [x, 0],
    ],
  ],
});

const PRIMARY: ReviewReason[] = [
  'duplicate-candidate',
  'same-source-duplicate',
  'bay-without-parent',
  'class-dissent',
  'class-conflict',
  'name-conflict',
];

/** A body written raw, as before the hooks: its reasons stored, no task filed. */
async function rawBody(
  t: T,
  i: number,
  reasons: ReviewReason[] | undefined,
  extra: Partial<Doc<'waterBodies'>> = {},
): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: `Pond ${i}`,
      searchText: `Pond ${i}`,
      type: 'lakePond',
      source: 'osm',
      externalId: `osm/${i}`,
      polygon: square(i * 2),
      bbox: { minLat: 0, minLng: i * 2, maxLat: 1, maxLng: i * 2 + 1 },
      centroid: { lat: 0.5, lng: i * 2 + 0.5 },
      surfaceAreaSqM: 1_000_000,
      dedupStatus: 'clean',
      createdAt: 1,
      displayScore: 0.1 * (i + 1),
      nameClaims: [
        { source: 'nhd', value: `Pond ${i}` },
        { source: 'osm', value: `Lake ${i}` },
      ],
      classClaims: [
        { source: 'nhd', value: 'wetland' },
        { source: 'osm', value: 'lakePond' },
      ],
      ...(reasons !== undefined
        ? { reviewReasons: reasons, reviewReason: PRIMARY.find((r) => reasons.includes(r)) }
        : {}),
      ...extra,
    }),
  );
}

/** A spread across every phase: each primary reason, with 6a reasons behind other ones. */
async function seedRaw(t: T) {
  return [
    await rawBody(t, 0, ['name-conflict']),
    await rawBody(t, 1, ['class-conflict', 'name-conflict']),
    await rawBody(t, 2, ['class-dissent', 'name-conflict']),
    await rawBody(t, 3, ['class-conflict', 'duplicate-candidate']),
    await rawBody(t, 4, ['class-dissent']),
    await rawBody(t, 5, ['name-conflict'], { removedAt: 1 }),
    await rawBody(t, 6, undefined),
  ];
}

async function runToDone(t: T, args: { pageCap?: number; budgetBytes?: number } = {}) {
  let passes = 0;
  for (;;) {
    const r = await t.mutation(internal.corpusTaskJobs.backfill, args);
    passes++;
    if (r.done) return passes;
    if (passes > 200) throw new Error('the backfill did not finish');
  }
}

/** The stored tasks and counts as comparable data, without ids or clocks. */
async function snapshot(t: T) {
  return t.run(async (ctx) => ({
    tasks: (await ctx.db.query('corpusTasks').collect())
      .map((x) => `${x.key}|${x.status}|${x.facet}|${x.rankKey}|${x.leftBecause ?? ''}`)
      .sort(),
    counts: (await ctx.db.query('corpusTaskCounts').collect())
      .map((c) => `${c.key}=${c.count}`)
      .sort(),
  }));
}

/** Every table the repair could write, whole: a dry run leaves it as it was. */
async function everything(t: T) {
  return t.run(async (ctx) => ({
    tasks: await ctx.db.query('corpusTasks').collect(),
    counts: await ctx.db.query('corpusTaskCounts').collect(),
    runs: await ctx.db.query('corpusTaskJobRuns').collect(),
    failures: await ctx.db.query('jobFailures').collect(),
  }));
}

async function expectCountsTally(t: T) {
  const { tasks, counts } = await everything(t);
  const tally = new Map<string, number>();
  for (const task of tasks) {
    for (const key of countKeysOf(task)) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const stored = new Map(counts.map((c) => [c.key, c.count]));
  for (const key of new Set([...tally.keys(), ...stored.keys()])) {
    expect(stored.get(key) ?? 0, key).toBe(tally.get(key) ?? 0);
  }
}

describe('the backfill', () => {
  test('files every 6a question on every body with a reason, and none on a removed one', async () => {
    const t = harness();
    const ids = await seedRaw(t);
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(true);
    await runToDone(t);
    const { tasks } = await snapshot(t);
    expect(tasks.map((x) => x.split('|')[0]).sort()).toEqual(
      [
        `reason:name-conflict:${ids[0]}`,
        `reason:class-conflict:${ids[1]}`,
        `reason:name-conflict:${ids[1]}`,
        `reason:name-conflict:${ids[2]}`,
        `reason:class-conflict:${ids[3]}`,
      ].sort(),
    );
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(false);
    await expectCountsTally(t);
  });

  test('resumable from any cursor and idempotent: a page at a time equals one pass, and a rerun changes nothing', async () => {
    const whole = harness();
    await seedRaw(whole);
    await runToDone(whole);
    const paged = harness();
    await seedRaw(paged);
    const passes = await runToDone(paged, { pageCap: 1 });
    expect(passes).toBeGreaterThan(BODY_PHASES.length);
    expect(await snapshot(paged)).toEqual(await snapshot(whole));
    const before = await snapshot(paged);
    await paged.mutation(internal.corpusTaskJobs.backfill, { restart: true });
    await runToDone(paged);
    expect(await snapshot(paged)).toEqual(before);
    // A run already done does nothing.
    expect(await paged.mutation(internal.corpusTaskJobs.backfill, {})).toMatchObject({
      read: 0,
      done: true,
    });
  });

  test('a run row on a phase it no longer knows starts from the first', async () => {
    const t = harness();
    await seedRaw(t);
    await t.run((ctx) =>
      ctx.db.insert('corpusTaskJobRuns', {
        job: 'backfill',
        phase: 'reason:gone',
        cursor: 'stale',
        done: false,
        startedAt: 1,
        updatedAt: 1,
      }),
    );
    await runToDone(t);
    expect((await snapshot(t)).tasks).toHaveLength(5);
  });

  test('bounded on bytes: a budget that holds one body and its work ends the pass and reschedules', async () => {
    const t = harness();
    await seedRaw(t);
    const budgetBytes = ROW_MAX.waterBody + ITEM_BYTES + 1;
    const pass = await t.mutation(internal.corpusTaskJobs.backfill, { budgetBytes });
    expect(pass).toMatchObject({ phase: BODY_PHASES[0], done: false });
    expect(pass.read).toBeLessThanOrEqual(1);
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.at(-1)?.name).toContain('corpusTaskJobs');
    expect(scheduled.at(-1)?.args[0]).toMatchObject({ budgetBytes });
  });

  test('a body that cannot be done is recorded and stepped past, pending holds, and the repair retries it', async () => {
    const t = harness();
    const ids = await seedRaw(t);
    const poisoned = ids[1] as string;
    const real = recurringWork.asItem;
    const spy = vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    await runToDone(t, { pageCap: 1 });
    const failures = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(failures.map((f) => [f.job, f.key])).toEqual([['corpusTaskBackfill', poisoned]]);
    // The rest went through, and the reads still say pending while a body is owed.
    expect((await snapshot(t)).tasks).toHaveLength(3);
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(true);
    // A retry that fails again is recorded again (one more attempt), never lost.
    expect(await t.mutation(internal.corpusTaskJobs.repair, {})).toMatchObject({ retried: 1 });
    const again = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(
      again.filter((f) => f.job === 'corpusTaskBackfill').map((f) => [f.key, f.attempts]),
    ).toEqual([[poisoned, 2]]);
    spy.mockRestore();
    const repaired = await t.mutation(internal.corpusTaskJobs.repair, {});
    expect(repaired.retried).toBe(1);
    // The backfill's failure is cleared; the repair's own (from the pass the spy failed) clears on
    // its next visit.
    const left = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(left.filter((f) => f.job === 'corpusTaskBackfill')).toEqual([]);
    expect((await snapshot(t)).tasks).toHaveLength(5);
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(false);
  });

  test('a recorded failure whose key names no body is cleared, not retried', async () => {
    const t = harness();
    await seedRaw(t);
    await runToDone(t);
    await t.run((ctx) =>
      ctx.db.insert('jobFailures', {
        job: 'corpusTaskBackfill',
        key: 'not-an-id',
        errorClass: 'Error',
        attempts: 1,
        firstFailedAt: 1,
        lastFailedAt: 1,
      }),
    );
    expect(await t.mutation(internal.corpusTaskJobs.repair, {})).toMatchObject({ retried: 0 });
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });
});

describe('the drift repair', () => {
  /** A filed corpus, then one of each drift written past the writer. */
  async function drifted() {
    const t = harness();
    const ids = await seedRaw(t);
    await runToDone(t);
    await t.run(async (ctx) => {
      // A task without its reason: the reason taken off raw.
      await ctx.db.patch(ids[0] as Id<'waterBodies'>, {
        reviewReasons: undefined,
        reviewReason: undefined,
      });
      // A reason without its task: added raw.
      await ctx.db.patch(ids[4] as Id<'waterBodies'>, {
        reviewReasons: ['class-dissent', 'class-conflict'],
      });
      // A stale tab: the class claims moved raw.
      await ctx.db.patch(ids[3] as Id<'waterBodies'>, {
        classClaims: [
          { source: 'nhd', value: 'lakePond' },
          { source: 'osm', value: 'bay' },
        ],
      });
      // A count off by one.
      const row = await ctx.db
        .query('corpusTaskCounts')
        .withIndex('by_key', (q) => q.eq('key', 'open:nameConflicts'))
        .first();
      if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    });
    return { t, ids };
  }

  /** The whole corpus repaired: passes until a lap completes, as the cron runs. */
  async function lapped(t: T, dryRun = false) {
    const totals = { fixed: 0, drift: {} as Record<string, number> };
    let lap: { phase: string; cursor: string | null } | undefined;
    for (let pass = 0; pass < 40; pass++) {
      const r = await t.mutation(internal.corpusTaskJobs.repair, {
        ...(dryRun ? { dryRun: true, ...(lap ? { lap } : {}) } : {}),
      });
      totals.fixed += r.fixed;
      for (const [k, n] of Object.entries(r.drift)) {
        // A dry run meets the same drift on every pass; count each kind once.
        totals.drift[k] = dryRun ? 1 : (totals.drift[k] ?? 0) + (n ?? 0);
      }
      lap = { phase: r.lap.phase, cursor: r.lap.cursor };
      if (r.lap.done) return totals;
    }
    throw new Error('the lap did not finish');
  }

  test('finds and fixes a task without its reason, a reason without its task, a stale tab and a count off by one', async () => {
    const { t, ids } = await drifted();
    const totals = await lapped(t);
    expect(Object.keys(totals.drift).sort()).toEqual([
      'counts',
      'question_without_task',
      'stale_facet',
      'task_without_question',
    ]);
    expect(totals.fixed).toBeGreaterThanOrEqual(4);
    await expectCountsTally(t);
    for (const id of ids) {
      expect(await t.run((ctx) => bodyTaskDrift(ctx, id))).toEqual([]);
    }
    for (const lane of ['nameConflicts', 'classConflicts'] as const) {
      expect(await t.run((ctx) => laneCountDrift(ctx, lane))).toEqual([]);
    }
    // A second lap finds nothing.
    expect((await lapped(t)).fixed).toBe(0);
  });

  test('its dry run reports the same drift and writes nothing', async () => {
    const { t } = await drifted();
    const before = await everything(t);
    const totals = await lapped(t, true);
    expect(Object.keys(totals.drift).sort()).toEqual([
      'counts',
      'question_without_task',
      'stale_facet',
      'task_without_question',
    ]);
    expect(totals.fixed).toBe(0);
    expect(await everything(t)).toEqual(before);
  });

  test('a count row with no tasks behind it, and a second row on a key, go to their tallies', async () => {
    const t = harness();
    await seedRaw(t);
    await runToDone(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('corpusTaskCounts', { key: 'open:nameConflicts:qualifier', count: 2 });
      await ctx.db.insert('corpusTaskCounts', { key: 'open:classConflicts', count: 5 });
      // A key in the lane's range that isn't the lane's: never touched.
      await ctx.db.insert('corpusTaskCounts', { key: 'open:nameConflicts0', count: 3 });
      // A tab's row gone: written back.
      const gone = await ctx.db
        .query('corpusTaskCounts')
        .withIndex('by_key', (q) => q.eq('key', 'open:nameConflicts:different'))
        .first();
      if (gone) await ctx.db.delete(gone._id);
    });
    await t.mutation(internal.corpusTaskJobs.repair, {});
    const rows = await t.run((ctx) => ctx.db.query('corpusTaskCounts').collect());
    expect(rows.find((r) => r.key === 'open:nameConflicts0')?.count).toBe(3);
    expect(rows.find((r) => r.key === 'open:nameConflicts:different')?.count).toBe(3);
    expect(rows.find((r) => r.key === 'open:nameConflicts:qualifier')?.count).toBe(0);
    expect(
      rows
        .filter((r) => r.key === 'open:classConflicts')
        .map((r) => r.count)
        .sort(),
    ).toEqual([0, 2]);
  });

  test('a body whose repair fails is recorded, its task moved to the back, and the walk goes on', async () => {
    const { t, ids } = await drifted();
    const poisoned = ids[3] as string;
    const real = recurringWork.asItem;
    vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    const r = await t.mutation(internal.corpusTaskJobs.repair, {});
    expect(r.failed).toBeGreaterThan(0);
    const failures = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(failures.map((f) => [f.job, f.key])).toContainEqual(['corpusTaskRepair', poisoned]);
    const task = (await t.run((ctx) => ctx.db.query('corpusTasks').collect())).find(
      (x) => x.waterBodyId === ids[3] && x.status === 'open',
    );
    expect(task?.refreshedAt).toBeGreaterThan(1);
    // A dry run meets the same failure and records nothing new.
    const recorded = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    const dry = await t.mutation(internal.corpusTaskJobs.repair, { dryRun: true });
    expect(dry.failed).toBeGreaterThan(0);
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual(recorded);
    // Its next visit, once it goes through, clears the failure.
    vi.restoreAllMocks();
    await lapped(t);
    const after = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(after.filter((f) => f.key === poisoned)).toEqual([]);
  });

  test('a lane count that fails is recorded under its lane', async () => {
    const t = harness();
    await seedRaw(t);
    await runToDone(t);
    const real = recurringWork.asItem;
    vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === 'counts:nameConflicts') throw new Error('too many');
      return real(key, work);
    });
    const r = await t.mutation(internal.corpusTaskJobs.repair, {});
    expect(r.failed).toBe(1);
    const failures = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(failures.map((f) => [f.job, f.key])).toEqual([
      ['corpusTaskRepair', 'counts:nameConflicts'],
    ]);
    // A dry run that fails records nothing.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.query('jobFailures').collect()) await ctx.db.delete(f._id);
    });
    const dry = await t.mutation(internal.corpusTaskJobs.repair, { dryRun: true });
    expect(dry.failed).toBe(1);
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });

  test('bounded on bytes: a budget for one body checks one and goes on next pass', async () => {
    const { t } = await drifted();
    const r = await t.mutation(internal.corpusTaskJobs.repair, {
      budgetBytes: ROW_MAX.waterBody + ITEM_BYTES + ROW_MAX.small * 4,
    });
    expect(r.lapped).toBeLessThanOrEqual(1);
    expect(r.lap.done).toBe(false);
  });

  test('its lap is gated on what the transaction has really left: past heavy bodies it waits a pass', async () => {
    const t = harness();
    // Sixteen bodies near the document limit (six rings of 8,000 points, about 0.92 MiB each): the
    // oldest open tasks' items read close to the whole transaction before the lap starts, which the
    // plan's budget can't see — a page sized by it alone read past Convex's 16 MiB.
    const heavy = (x: number): Polygon => ({
      type: 'Polygon',
      coordinates: Array.from({ length: 6 }, (_, r) => {
        const ring = Array.from({ length: 7_999 }, (_, i) => [
          x + (i % 100) * 1e-4 + r * 1e-6,
          Math.floor(i / 100) * 1e-4,
        ]);
        ring.push(ring[0] as number[]);
        return ring;
      }),
    });
    for (let i = 0; i < 16; i++) await rawBody(t, i, ['name-conflict'], { polygon: heavy(i * 2) });
    await runToDone(t);
    const lap = { phase: 'reason:name-conflict', cursor: null };

    const r = await t.mutation(internal.corpusTaskJobs.repair, { pageCap: 16, lap });
    expect(r.checked).toBeGreaterThan(0);
    expect(r).toMatchObject({ lapped: 0, failed: 0 });
    expect(r.lap).toEqual({ ...lap, done: false });
    const row = await t.run((ctx) => ctx.db.query('corpusTaskJobRuns').collect());
    expect(row.find((x) => x.job === 'repair')).toMatchObject(lap);

    // A pass whose items leave room reads the page, and the lap goes on.
    const next = await t.mutation(internal.corpusTaskJobs.repair, { pageCap: 2, lap });
    expect(next.lapped).toBeGreaterThan(0);
    expect(next.lap.cursor).not.toBeNull();
  });

  test('a pass that can’t afford an item starts none, and its lap stays where it was', async () => {
    const { t } = await drifted();
    vi.spyOn(recurringWork, 'affords').mockResolvedValue(false);
    const r = await t.mutation(internal.corpusTaskJobs.repair, {});
    expect(r).toMatchObject({ checked: 0, lapped: 0, fixed: 0, failed: 0, retried: 0 });
    expect(r.lap).toEqual({ phase: BODY_PHASES[0], cursor: null, done: false });
    const row = await t.run((ctx) => ctx.db.query('corpusTaskJobRuns').collect());
    expect(row.find((x) => x.job === 'repair')).toMatchObject({
      phase: BODY_PHASES[0],
      cursor: null,
    });
  });
});

describe('the daily retry', () => {
  /** A failure row written raw: parked at `parkedAt` unless that is omitted. */
  async function failure(
    t: T,
    job: 'corpusTaskBackfill' | 'corpusTaskRepair',
    key: string,
    parkedAt?: number,
  ) {
    await t.run((ctx) =>
      ctx.db.insert('jobFailures', {
        job,
        key,
        errorClass: 'Error',
        attempts: 3,
        firstFailedAt: 1,
        lastFailedAt: 1,
        ...(parkedAt !== undefined ? { parkedAt } : {}),
      }),
    );
  }
  const failures = (t: T) => t.run((ctx) => ctx.db.query('jobFailures').collect());
  const pending = (t: T) => t.run((ctx) => corpusTasksPending(ctx));
  /**
   * One daily run. Its cutoff is past every row written so far, or — for a row that fails again, and
   * is re-stamped by the run's own clock — the raw rows' clock (`RAW`), so it is tried once a run.
   */
  const RAW = 1000;
  const retryDaily = (t: T, cutoff = Date.now() + 1) =>
    t.mutation(internal.recurringJobs.retryParkedDaily, { cutoff });

  test('a body the backfill parked is synced and cleared, and the lanes stop saying pending', async () => {
    const t = harness();
    const ids = await seedRaw(t);
    const poisoned = ids[1] as string;
    const real = recurringWork.asItem;
    const spy = vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    await runToDone(t);
    // Two more failed retries park it; the repair's retry then steps past it.
    await t.mutation(internal.corpusTaskJobs.repair, {});
    await t.mutation(internal.corpusTaskJobs.repair, {});
    const parked = (await failures(t)).filter((f) => f.job === 'corpusTaskBackfill');
    expect(parked.map((f) => [f.key, f.parkedAt !== undefined])).toEqual([[poisoned, true]]);
    expect((await t.mutation(internal.corpusTaskJobs.repair, {})).retried).toBe(0);
    expect(await pending(t)).toBe(true);
    // A fix deployed: the daily retry files its questions, and nothing is owed.
    spy.mockRestore();
    expect((await retryDaily(t)).freed).toBeGreaterThanOrEqual(1);
    expect((await failures(t)).filter((f) => f.job === 'corpusTaskBackfill')).toEqual([]);
    expect((await snapshot(t)).tasks).toHaveLength(5);
    expect(await pending(t)).toBe(false);
    await expectCountsTally(t);
  });

  test('a parked body since deleted, or a key that names no body, is cleared', async () => {
    const t = harness();
    const ids = await seedRaw(t);
    await runToDone(t);
    const gone = ids[0] as Id<'waterBodies'>;
    await t.run((ctx) => ctx.db.delete(gone));
    await failure(t, 'corpusTaskBackfill', gone, 1);
    await failure(t, 'corpusTaskBackfill', 'not-an-id', 2);
    expect(await pending(t)).toBe(true);
    expect(await retryDaily(t)).toMatchObject({ freed: 2, failed: 0, more: false });
    expect(await failures(t)).toEqual([]);
    expect(await pending(t)).toBe(false);
    // The deleted body's open task left with it.
    const tasks = await t.run((ctx) => ctx.db.query('corpusTasks').collect());
    expect(tasks.filter((x) => x.waterBodyId === gone).map((x) => x.status)).toEqual(['left']);
    await expectCountsTally(t);
  });

  test('a body that still fails stays parked — re-stamped as just tried — and the lanes stay pending', async () => {
    const t = harness();
    const ids = await seedRaw(t);
    await runToDone(t);
    const poisoned = ids[2] as string;
    await failure(t, 'corpusTaskBackfill', poisoned, 1);
    const real = recurringWork.asItem;
    vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    expect(await retryDaily(t, RAW)).toMatchObject({ freed: 0, failed: 1, more: false });
    const [row] = await failures(t);
    expect(row).toMatchObject({ job: 'corpusTaskBackfill', key: poisoned, attempts: 4 });
    expect(row?.parkedAt).toBeGreaterThan(1);
    expect(row?.retriedAt).toBe(row?.parkedAt);
    expect(await pending(t)).toBe(true);
  });

  test("the repair's failures are retried too: a body that lost its question, a lane's counts, and an unknown key are cleared", async () => {
    const t = harness();
    const ids = await seedRaw(t);
    await runToDone(t);
    // A body whose repair failed, then whose question went: the walk never meets it again.
    const answered = ids[4] as Id<'waterBodies'>;
    await t.run((ctx) =>
      ctx.db.patch(answered, { reviewReasons: undefined, reviewReason: undefined }),
    );
    await failure(t, 'corpusTaskRepair', answered);
    await failure(t, 'corpusTaskRepair', 'counts:nameConflicts', 1);
    await failure(t, 'corpusTaskRepair', 'counts:noSuchLane', 2);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('corpusTaskCounts')
        .withIndex('by_key', (q) => q.eq('key', 'open:nameConflicts'))
        .first();
      if (row) await ctx.db.patch(row._id, { count: row.count + 7 });
    });
    expect(await retryDaily(t)).toMatchObject({ freed: 3, failed: 0, more: false });
    expect(await failures(t)).toEqual([]);
    await expectCountsTally(t);
  });

  test("a repair failure that fails again parks by the rule; a lane's counts wait for a fresh transaction", async () => {
    const t = harness();
    const ids = await seedRaw(t);
    await runToDone(t);
    const poisoned = ids[3] as string;
    await failure(t, 'corpusTaskRepair', poisoned);
    const real = recurringWork.asItem;
    vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    expect(await retryDaily(t, RAW)).toMatchObject({ freed: 0, failed: 1 });
    const [row] = await failures(t);
    expect(row).toMatchObject({ key: poisoned, attempts: 4 });
    expect(row?.parkedAt).toBeGreaterThan(1);
    vi.restoreAllMocks();
    // A lane's counts the transaction can't afford: the run hands itself on, at the same place.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.query('jobFailures').collect()) await ctx.db.delete(f._id);
    });
    await failure(t, 'corpusTaskRepair', 'counts:classConflicts', 1);
    const realAffords = recurringWork.affords;
    vi.spyOn(recurringWork, 'affords').mockImplementation(async (ctx, budget) =>
      budget.limits.documentsRead > 5000 ? false : realAffords(ctx, budget),
    );
    expect(await retryDaily(t, RAW)).toEqual({ freed: 0, failed: 0, more: true });
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.at(-1)?.name).toContain('retryParkedDaily');
    expect(scheduled.at(-1)?.args[0]).toMatchObject({ at: 5, tried: 0 });
    expect(await failures(t)).toHaveLength(1);
  });
});
