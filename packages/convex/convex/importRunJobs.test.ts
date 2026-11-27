/**
 * The run list's backfill (D341, B01-8a; the founder's ruling on fork 3): `listedIn` on the rows from
 * before it, and one reconstructed campaign row per campaign from before B01-8a, built only from what
 * its passes prove — idempotent, resumable, bounded, and never touching a campaign with its own row.
 */

import { CORPUS_RUN_KINDS } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { aggregateOfPasses, BACKFILL_CAMPAIGN_READ, BACKFILL_PAGE } from './importRunJobs';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 9, 12);

/** A row as a loader before B01-8a wrote it: no `listedIn`, no parent, no pass name. */
async function oldRun(
  t: T,
  fields: Partial<Omit<Doc<'importRuns'>, '_id' | '_creationTime'>> & { startedAt: number },
): Promise<Id<'importRuns'>> {
  return t.run((ctx) =>
    ctx.db.insert('importRuns', {
      kind: 'canonical_water',
      label: 'canonical water',
      deployment: 'dev:agile-bee-397',
      isProd: false,
      status: 'succeeded',
      finishedAt: fields.startedAt + HOUR / 2,
      counts: [],
      stages: [],
      failures: [],
      failuresTotal: 0,
      ...fields,
    }),
  );
}

const all = (t: T) => t.run((ctx) => ctx.db.query('importRuns').withIndex('by_started').collect());
const get = (t: T, id: Id<'importRuns'>) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<'importRuns'>);
const campaignsOf = async (t: T, campaignId: string) =>
  (await all(t)).filter((r) => r.kind === 'corpus_campaign' && r.campaignId === campaignId);

const step = (t: T, args: { cursor?: string | null; pageSize?: number; dryRun?: boolean } = {}) =>
  t.mutation(internal.importRunJobs.backfillListed, { chain: false, ...args });

/** Every pass to the end, `pageSize` rows a pass. */
async function walk(t: T, pageSize = 100, dryRun = false) {
  let cursor: string | null = null;
  const tallies = [];
  for (;;) {
    const r = await step(t, { cursor, pageSize, dryRun });
    tallies.push(r);
    if (r.isDone) return tallies;
    cursor = r.continueCursor;
  }
}

const sum = (tallies: Awaited<ReturnType<typeof step>>[], key: keyof (typeof tallies)[number]) =>
  tallies.reduce((n, r) => n + (r[key] as number), 0);

/** August's campaign: four script passes (the load failed), one by hand, and the rest of the table. */
async function august(t: T) {
  const c = 'corpus-2026-08-09';
  const ids = {
    region: await oldRun(t, { kind: 'region_masks', campaignId: c, startedAt: T0 }),
    merge: await oldRun(t, { kind: 'corpus_merge', campaignId: c, startedAt: T0 + HOUR }),
    load: await oldRun(t, {
      kind: 'canonical_water',
      campaignId: c,
      startedAt: T0 + 2 * HOUR,
      status: 'failed',
      finishedAt: T0 + 3 * HOUR,
    }),
    landmarks: await oldRun(t, {
      kind: 'landmark_seed',
      label: 'landmark names',
      campaignId: c,
      startedAt: T0 + 4 * HOUR,
      finishedAt: T0 + 5 * HOUR,
    }),
    prune: await oldRun(t, { kind: 'floor_prune', campaignId: c, startedAt: T0 + 6 * HOUR }),
    depth: await oldRun(t, { kind: 'lake_depth', startedAt: T0 + 7 * HOUR }),
    single: await oldRun(t, { kind: 'canonical_water', startedAt: T0 + 8 * HOUR }),
  };
  return { c, ids };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 100 * HOUR);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('backfillListed', () => {
  test('writes one reconstructed campaign from what its passes prove, and lists the rest', async () => {
    const t = convexTest(schema, modules);
    const { c, ids } = await august(t);
    const [tally] = await walk(t);
    expect(tally).toMatchObject({
      scanned: 7,
      campaignsCreated: 1,
      passesLinked: 4,
      campaignsKept: 0,
      isDone: true,
    });

    const [campaign] = await campaignsOf(t, c);
    expect(campaign).toMatchObject({
      label: `Corpus campaign ${c}`,
      status: 'failed', // a pass failed
      startedAt: T0, // the earliest pass
      finishedAt: T0 + 5 * HOUR, // the latest finish
      deployment: 'dev:agile-bee-397',
      isProd: false,
      listedIn: 'corpus',
      counts: [],
      failuresTotal: 0,
      campaign: { flags: [], plan: [], reconstructed: true },
    });
    // Nothing the old campaigns never recorded is invented: no heartbeat, no exit, no scope.
    expect(campaign?.progressAt).toBeUndefined();
    expect(campaign?.campaign?.exitCode).toBeUndefined();
    expect(campaign?.campaign?.lastPass).toBeUndefined();
    expect(campaign?.scope).toBeUndefined();

    for (const pass of [ids.region, ids.merge, ids.load, ids.landmarks]) {
      const row = await get(t, pass);
      expect(row.parentRunId).toBe(campaign?._id);
      expect(row.listedIn).toBeUndefined();
      expect(row.campaignPass).toBeUndefined();
    }
    // A pass by hand keeps its own row in the list, matched to its campaign by id.
    expect(await get(t, ids.prune)).toMatchObject({ listedIn: 'corpus', campaignId: c });
    expect((await get(t, ids.prune)).parentRunId).toBeUndefined();
    expect((await get(t, ids.single)).listedIn).toBe('corpus');
    expect((await get(t, ids.depth)).listedIn).toBeUndefined();
  });

  test('after a full walk no corpus row is left with neither a listing nor a parent', async () => {
    const t = convexTest(schema, modules);
    await august(t);
    await oldRun(t, { kind: 'corpus_merge', campaignId: 'solo', startedAt: T0 + 9 * HOUR });
    await oldRun(t, {
      kind: 'corpus_campaign',
      campaignId: 'live',
      startedAt: T0 + 10 * HOUR,
      campaign: { flags: [], plan: [] },
    });
    await oldRun(t, { kind: 'corpus_merge', campaignId: 'live', startedAt: T0 + 11 * HOUR });
    for (let i = 0; i <= BACKFILL_CAMPAIGN_READ; i++) {
      await oldRun(t, {
        kind: 'canonical_water',
        campaignId: 'huge',
        startedAt: T0 + 12 * HOUR + i,
      });
    }
    for (const pageSize of [1, 3]) {
      await walk(t, pageSize);
      const unindexed = (await all(t)).filter(
        (r) =>
          CORPUS_RUN_KINDS.includes(r.kind) &&
          r.listedIn === undefined &&
          r.parentRunId === undefined,
      );
      expect(unindexed).toEqual([]);
    }
  });

  test('a second run writes nothing', async () => {
    const t = convexTest(schema, modules);
    await august(t);
    await walk(t);
    const before = await all(t);
    const [again] = await walk(t);
    expect(again).toMatchObject({
      listed: 0,
      campaignsCreated: 0,
      campaignsUpdated: 0,
      passesLinked: 0,
    });
    expect(await all(t)).toEqual(before);
  });

  test('a campaign with a single pass is a campaign of one', async () => {
    const t = convexTest(schema, modules);
    const only = await oldRun(t, {
      kind: 'canonical_water',
      campaignId: 'vt-only',
      startedAt: T0,
      finishedAt: T0 + HOUR,
    });
    await walk(t);
    const [campaign] = await campaignsOf(t, 'vt-only');
    expect(campaign).toMatchObject({ status: 'succeeded', startedAt: T0, finishedAt: T0 + HOUR });
    expect((await get(t, only)).parentRunId).toBe(campaign?._id);
  });

  test('a retire-absorbed row from before its own kind stays a by-hand row, out of the campaign', async () => {
    const t = convexTest(schema, modules);
    const merge = await oldRun(t, {
      kind: 'corpus_merge',
      campaignId: 'c',
      startedAt: T0,
      finishedAt: T0 + HOUR,
    });
    // `canonical_water`, as `retire-absorbed` was logged before B01-7a, and later than the merge.
    const retire = await oldRun(t, {
      kind: 'canonical_water',
      label: 'retire absorbed duplicates',
      campaignId: 'c',
      startedAt: T0 + 5 * HOUR,
      status: 'failed',
      finishedAt: T0 + 6 * HOUR,
    });
    await walk(t);
    const [campaign] = await campaignsOf(t, 'c');
    // Its aggregate is the merge's alone: the retire's failure and its finish are not the campaign's.
    expect(campaign).toMatchObject({ status: 'succeeded', finishedAt: T0 + HOUR });
    expect((await get(t, merge)).parentRunId).toBe(campaign?._id);
    expect(await get(t, retire)).toMatchObject({ listedIn: 'corpus', campaignId: 'c' });
    expect((await get(t, retire)).parentRunId).toBeUndefined();
  });

  test('a campaign still running has no finish, and reads running', async () => {
    const t = convexTest(schema, modules);
    await oldRun(t, { kind: 'corpus_merge', campaignId: 'c', startedAt: T0 });
    await oldRun(t, {
      kind: 'canonical_water',
      campaignId: 'c',
      startedAt: T0 + HOUR,
      status: 'running',
      finishedAt: undefined,
    });
    await walk(t);
    const [campaign] = await campaignsOf(t, 'c');
    expect(campaign?.status).toBe('running');
    expect(campaign?.finishedAt).toBeUndefined();
  });

  test('never touches a campaign that has its own row', async () => {
    const t = convexTest(schema, modules);
    const own = await oldRun(t, {
      kind: 'corpus_campaign',
      campaignId: 'live',
      startedAt: T0,
      status: 'running',
      finishedAt: undefined,
      listedIn: 'corpus',
      campaign: { flags: ['--states=VT'], plan: [{ pass: 'merge', by: 'script' }] },
    });
    // A pass whose parent link was lost (the campaign CLI failed at its start).
    const stray = await oldRun(t, {
      kind: 'corpus_merge',
      campaignId: 'live',
      startedAt: T0 + HOUR,
      status: 'failed',
    });
    const before = await get(t, own);
    const [tally] = await walk(t);
    expect(tally).toMatchObject({ campaignsKept: 1, campaignsCreated: 0, passesLinked: 0 });
    expect(await get(t, own)).toEqual(before);
    expect(await campaignsOf(t, 'live')).toHaveLength(1);
    expect((await get(t, stray)).parentRunId).toBeUndefined();
    expect((await get(t, stray)).listedIn).toBe('corpus');
  });

  test('a kept campaign’s linked passes and by-hand rows are left as they are, run after run', async () => {
    const t = convexTest(schema, modules);
    const own = await oldRun(t, {
      kind: 'corpus_campaign',
      campaignId: 'live',
      startedAt: T0,
      listedIn: 'corpus',
      campaign: { flags: [], plan: [] },
    });
    await oldRun(t, {
      kind: 'corpus_merge',
      campaignId: 'live',
      startedAt: T0 + 1,
      parentRunId: own,
    });
    await oldRun(t, { kind: 'floor_prune', campaignId: 'live', startedAt: T0 + 2 });
    await oldRun(t, { kind: 'canonical_water', campaignId: 'live', startedAt: T0 + 3 });
    await walk(t);
    const before = await all(t);
    const [dry] = await walk(t, 100, true);
    const [again] = await walk(t);
    expect(dry).toMatchObject({ listed: 0, passesLinked: 0, campaignsKept: 1 });
    expect(again).toMatchObject({ listed: 0, passesLinked: 0, campaignsKept: 1 });
    expect(await all(t)).toEqual(before);
  });

  test('resumes mid-way: a walk stopped part-way and started again ends where one walk does', async () => {
    const one = convexTest(schema, modules);
    await august(one);
    await walk(one);

    const t = convexTest(schema, modules);
    await august(t);
    // Two rows a pass: the campaign's passes straddle three pages.
    const first = await step(t, { pageSize: 2 });
    expect(first).toMatchObject({ isDone: false, campaignsCreated: 1 });
    await step(t, { pageSize: 2, cursor: first.continueCursor });
    // Interrupted; run again from the very start, small pages.
    const tallies = await walk(t, 2);
    const strip = (rows: Doc<'importRuns'>[]) =>
      rows.map(({ _id, _creationTime, parentRunId, ...rest }) => ({
        ...rest,
        hasParent: parentRunId !== undefined,
      }));
    expect(strip(await all(t))).toEqual(strip(await all(one)));
    expect(await campaignsOf(t, 'corpus-2026-08-09')).toHaveLength(1);
    expect(sum(tallies, 'campaignsCreated')).toBe(0);
  });

  test('a campaign whose passes straddle two pages is one row, built whole on the first', async () => {
    const t = convexTest(schema, modules);
    await oldRun(t, { kind: 'corpus_merge', campaignId: 'c', startedAt: T0 });
    // A row of another kind between them, so the second pass is on the second page.
    await oldRun(t, { kind: 'lake_depth', startedAt: T0 + HOUR });
    await oldRun(t, {
      kind: 'canonical_water',
      campaignId: 'c',
      startedAt: T0 + 2 * HOUR,
      status: 'failed',
      finishedAt: T0 + 3 * HOUR,
    });
    const page1 = await step(t, { pageSize: 2 });
    const [campaign] = await campaignsOf(t, 'c');
    // The first page rebuilds it from every row of the campaign, the one it hasn't reached too.
    expect(campaign?.status).toBe('failed');
    expect(page1).toMatchObject({ campaignsCreated: 1, passesLinked: 2 });
    // The second page reaches the later pass, already linked: nothing left to write.
    const page2 = await step(t, { pageSize: 2, cursor: page1.continueCursor });
    expect(page2).toMatchObject({ campaignsUpdated: 0, passesLinked: 0, campaignsCreated: 0 });
    expect(await get(t, campaign?._id as Id<'importRuns'>)).toMatchObject({
      _id: campaign?._id,
      status: 'failed',
      finishedAt: T0 + 3 * HOUR,
    });
  });

  test('a pass that turns up after the backfill moves its reconstructed row’s aggregate', async () => {
    const t = convexTest(schema, modules);
    await oldRun(t, { kind: 'corpus_merge', campaignId: 'c', startedAt: T0 });
    await walk(t);
    const [campaign] = await campaignsOf(t, 'c');
    const late = await oldRun(t, {
      kind: 'canonical_water',
      campaignId: 'c',
      startedAt: T0 + 2 * HOUR,
      status: 'failed',
      finishedAt: T0 + 3 * HOUR,
    });
    const [again] = await walk(t);
    expect(again).toMatchObject({ campaignsUpdated: 1, passesLinked: 1, campaignsCreated: 0 });
    expect(await get(t, campaign?._id as Id<'importRuns'>)).toMatchObject({
      status: 'failed',
      finishedAt: T0 + 3 * HOUR,
    });
    expect((await get(t, late)).parentRunId).toBe(campaign?._id);
  });

  test('a late pass inside what its campaign already proves links, and moves nothing', async () => {
    const t = convexTest(schema, modules);
    await oldRun(t, {
      kind: 'corpus_merge',
      campaignId: 'c',
      startedAt: T0,
      finishedAt: T0 + 3 * HOUR,
    });
    await walk(t);
    await oldRun(t, { kind: 'canonical_water', campaignId: 'c', startedAt: T0 + HOUR });
    const [again] = await walk(t);
    expect(again).toMatchObject({ campaignsUpdated: 0, passesLinked: 1 });
  });

  test('a dry run tallies what it would write, counts each campaign once, and writes nothing', async () => {
    const t = convexTest(schema, modules);
    await august(t);
    const before = await all(t);
    const tallies = await walk(t, 2, true);
    expect(sum(tallies, 'campaignsCreated')).toBe(1);
    expect(sum(tallies, 'passesLinked')).toBeGreaterThanOrEqual(4);
    expect(sum(tallies, 'listed')).toBe(2);
    expect(await all(t)).toEqual(before);
  });

  test('a campaign past the read bound is left alone, its passes listed singly', async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i <= BACKFILL_CAMPAIGN_READ; i++) {
      await oldRun(t, { kind: 'canonical_water', campaignId: 'huge', startedAt: T0 + i });
    }
    const tallies = await walk(t);
    expect(sum(tallies, 'campaignsTooLarge')).toBeGreaterThan(0);
    expect(await campaignsOf(t, 'huge')).toHaveLength(0);
    expect((await all(t)).every((r) => r.listedIn === 'corpus')).toBe(true);
  });

  test('chained, it walks the whole table by itself', async () => {
    const t = convexTest(schema, modules);
    await august(t);
    await t.mutation(internal.importRunJobs.backfillListed, { pageSize: 2 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await campaignsOf(t, 'corpus-2026-08-09')).toHaveLength(1);
    expect((await all(t)).filter((r) => r.kind === 'region_masks')[0]?.parentRunId).toBeDefined();
  });
});

test('the worst page fits one transaction: every row a different campaign at its full size', async () => {
  const t = convexTest(schema, modules);
  // Interleaved by start, so the oldest page holds one pass of every campaign: each campaign is read
  // whole and every one of its passes linked, on that page.
  await t.run(async (ctx) => {
    for (let k = 0; k < BACKFILL_CAMPAIGN_READ; k++) {
      for (let c = 0; c < BACKFILL_PAGE; c++) {
        await ctx.db.insert('importRuns', {
          kind: 'canonical_water',
          label: 'canonical water',
          campaignId: `worst-${c}`,
          deployment: 'dev:agile-bee-397',
          isProd: false,
          status: 'succeeded',
          startedAt: T0 + (k * BACKFILL_PAGE + c) * 1_000,
          finishedAt: T0 + (k * BACKFILL_PAGE + c) * 1_000 + 500,
          counts: [],
          stages: [],
          failures: [],
          failuresTotal: 0,
        });
      }
    }
  });
  const first = await step(t, { pageSize: BACKFILL_PAGE });
  expect(first).toMatchObject({
    scanned: BACKFILL_PAGE,
    campaignsCreated: BACKFILL_PAGE,
    passesLinked: BACKFILL_PAGE * BACKFILL_CAMPAIGN_READ,
  });
}, 60_000);

test('aggregateOfPasses: failed beats running beats succeeded', () => {
  const pass = (status: Doc<'importRuns'>['status'], startedAt: number, finishedAt?: number) =>
    ({ status, startedAt, finishedAt, deployment: 'd', isProd: false }) as Doc<'importRuns'>;
  expect(aggregateOfPasses([pass('succeeded', 1, 2), pass('running', 3)]).status).toBe('running');
  expect(aggregateOfPasses([pass('running', 1), pass('failed', 3, 4)]).status).toBe('failed');
  expect(aggregateOfPasses([pass('succeeded', 5, 6), pass('succeeded', 1)])).toMatchObject({
    status: 'succeeded',
    startedAt: 1,
    finishedAt: 6,
  });
});
