/**
 * Machinery › Corpus's reads (D341, B01-8a). What matters:
 *
 *  - **One verdict.** The sidebar's tail, the run list, the campaign page and the Overview's card all
 *    read core's `runLiveness`, so the same rows at the same `now` say the same thing everywhere.
 *  - **Nothing false before the backfill.** An old pass has no `listedIn` and no campaign row until
 *    `importRunJobs`' backfill runs: it isn't listed, and `indexed` says the history is incomplete.
 *  - **A reconstructed campaign is history**: never running, late or stalled; its flags and plan
 *    *Not recorded*.
 *  - **Every read is admin's** and bounded (the harness counts ranges and documents read).
 */
import { campaignLiveness, RUN_QUIET_MS, runLiveness } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { DRY_RUN_NOTE } from './importRuns';
import { lastCampaignRun } from './lib/campaignRuns';
import { importJobState } from './machinery';
import {
  CAMPAIGN_PASS_LIMIT,
  INDEXED_PROBE,
  isAppliedHandPass,
  isReconstructed,
  LIST_PAGE_SIZE,
  type RunRowView,
} from './machineryRuns';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 27, 14, 0);
const E_LOAD = RUN_QUIET_MS.canonical_water as number;

function must<V>(value: V | undefined | null): V {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
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
  moderatorDecision: false,
};

let seq = 0;
async function seedUser(t: T, role: 'member' | 'moderator' | 'admin', name: string = role) {
  const subject = `machinery-${role}-${seq++}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: name,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: NOW - 400 * DAY,
      profileImageUrl: `https://img/${subject}`,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedAction(
  t: T,
  by: Id<'profiles'>,
  action: 'wait_on_run' | 'mark_run_failed',
): Promise<Id<'moderationActions'>> {
  return await t.run((ctx) =>
    ctx.db.insert('moderationActions', {
      actorId: by,
      action,
      targetType: 'importRun',
      targetId: 'x',
      reason: 'seeded',
      createdAt: NOW,
    }),
  );
}

type RunFields = Partial<Omit<Doc<'importRuns'>, '_id' | '_creationTime'>>;

async function seedRun(t: T, over: RunFields = {}): Promise<Id<'importRuns'>> {
  return await t.run((ctx) =>
    ctx.db.insert('importRuns', {
      kind: 'canonical_water',
      label: 'run',
      deployment: 'dev',
      isProd: false,
      status: 'running',
      startedAt: NOW - 30 * MINUTE,
      progressAt: NOW,
      counts: [],
      stages: [],
      failures: [],
      failuresTotal: 0,
      listedIn: 'corpus',
      ...over,
    }),
  );
}

const PLAN = [
  { pass: 'build-region', by: 'script' as const },
  { pass: 'merge', by: 'script' as const },
  { pass: 'load', by: 'script' as const },
  { pass: 'load-sub-areas', by: 'script' as const, skipped: 'no actor given' },
  { pass: 'landmarks', by: 'script' as const },
  { pass: 'load-landmarks', by: 'script' as const },
  { pass: 'load-landmark-names', by: 'script' as const },
  { pass: 'prune-floor', by: 'hand' as const },
  { pass: 'seed-standing', by: 'hand' as const },
  { pass: 'retire-absorbed', by: 'hand' as const },
];

/** A campaign row opened by the script, with the two passes it has finished and the load running. */
async function seedCampaign(t: T, id = 'a07a-20261127', loadQuietMs = MINUTE) {
  const start = NOW - 74 * MINUTE;
  const campaign = await seedRun(t, {
    kind: 'corpus_campaign',
    label: `Corpus campaign ${id}`,
    campaignId: id,
    startedAt: start,
    progressAt: NOW - 46 * MINUTE,
    scope: { pass: 'full-canonical', states: ['VT', 'NH', 'ME', 'MA', 'NY'], complete: true },
    campaign: { flags: ['--states=all'], plan: PLAN },
  });
  const pass = (over: RunFields) =>
    seedRun(t, { campaignId: id, parentRunId: campaign, listedIn: undefined, ...over });
  const region = await pass({
    kind: 'region_masks',
    campaignPass: 'build-region',
    status: 'succeeded',
    startedAt: start,
    finishedAt: start + 4 * MINUTE,
    progressAt: start + 4 * MINUTE,
    counts: [{ name: 'maskFeatures', value: 12 }],
  });
  const merge = await pass({
    kind: 'corpus_merge',
    campaignPass: 'merge',
    status: 'succeeded',
    startedAt: start + 5 * MINUTE,
    finishedAt: start + 28 * MINUTE,
    progressAt: start + 28 * MINUTE,
    counts: [
      { name: 'emitted', value: 25_050 },
      { name: 'absorbedPairs', value: 96 },
    ],
    stages: [{ name: 'osm' }, { name: 'nhd' }],
  });
  const load = await pass({
    kind: 'canonical_water',
    campaignPass: 'load',
    startedAt: start + 28 * MINUTE,
    progressAt: NOW - loadQuietMs,
    counts: [
      { name: 'inserted', value: 0 },
      { name: 'updated', value: 9_412 },
      { name: 'batchesApplied', value: 66 },
      { name: 'batchesTotal', value: 170 },
    ],
    failures: [
      { stage: 'load', key: 'nhd/1', reason: 'self-intersects' },
      { stage: 'load', reason: 'no key' },
    ],
    failuresTotal: 3,
  });
  return { campaign, region, merge, load };
}

describe('every read is admin’s', () => {
  test('a moderator and a member are refused each read; an admin is served', async () => {
    const t = harness();
    const runId = await seedRun(t);
    const page = { numItems: 10, cursor: null };
    const reads = (as: Awaited<ReturnType<typeof seedUser>>['as']) => [
      as.query(api.machineryRuns.lanes, {}),
      as.query(api.machineryRuns.listPage, { lane: 'corpus', paginationOpts: page }),
      as.query(api.machineryRuns.campaign, { runId }),
      as.query(api.machineryRuns.run, { runId }),
      as.query(api.machineryRuns.events, { runId, paginationOpts: page }),
    ];
    for (const role of ['moderator', 'member'] as const) {
      const { as } = await seedUser(t, role);
      for (const read of reads(as)) await expect(read).rejects.toThrow();
    }
    for (const read of reads(t)) await expect(read).rejects.toThrow();
    const { as } = await seedUser(t, 'admin');
    for (const read of reads(as)) await expect(read).resolves.toBeDefined();
  });
});

describe('lanes', () => {
  test('never with nothing listed; an unlisted run is not the tail', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    expect(await as.query(api.machineryRuns.lanes, {})).toEqual({
      corpus: { state: 'never', at: null },
    });
    await seedRun(t, { listedIn: undefined, kind: 'lake_depth' });
    expect((await as.query(api.machineryRuns.lanes, {})).corpus.state).toBe('never');
  });

  test('a pass on its own goes late past 2× its gap and stalled past 10×, on the caller’s clock', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedRun(t, { progressAt: NOW - 2 * E_LOAD - 2 * MINUTE });
    const tail = (await as.query(api.machineryRuns.lanes, { now: NOW })).corpus;
    expect(tail).toMatchObject({ state: 'late', at: NOW - 2 * E_LOAD - 2 * MINUTE, kind: 'pass' });
    // A live tail carries its inputs, which core's rule re-reads to the server's own verdicts.
    const self = must(tail.livenessInputs).self;
    expect(runLiveness(self, NOW).state).toBe('late');
    expect(runLiveness(self, NOW + 10 * E_LOAD).state).toBe('stalled');
    vi.setSystemTime(NOW + 10 * E_LOAD);
    expect((await as.query(api.machineryRuns.lanes, { now: NOW + 10 * E_LOAD })).corpus.state).toBe(
      'stalled',
    );
    // A client can't claim a clock more than a minute from the server's.
    vi.setSystemTime(NOW);
    expect((await as.query(api.machineryRuns.lanes, { now: NOW + DAY })).corpus.state).toBe('late');
  });

  test('a stored wait holds a stall as waiting only until its time', async () => {
    const t = harness();
    const { id: by, as } = await seedUser(t, 'admin');
    const actionId = await seedAction(t, by, 'wait_on_run');
    await seedRun(t, {
      progressAt: NOW - 40 * MINUTE,
      stallWait: { until: NOW + 30 * MINUTE, byUserId: by, at: NOW, actionId },
    });
    expect((await as.query(api.machineryRuns.lanes, {})).corpus.state).toBe('waiting');
    vi.setSystemTime(NOW + 30 * MINUTE);
    expect((await as.query(api.machineryRuns.lanes, {})).corpus.state).toBe('stalled');
  });

  test('finished: failed (a mark included) or ok, at its close', async () => {
    const t = harness();
    const { id: by, as } = await seedUser(t, 'admin');
    const actionId = await seedAction(t, by, 'mark_run_failed');
    const runId = await seedRun(t, { status: 'succeeded', finishedAt: NOW - MINUTE });
    expect((await as.query(api.machineryRuns.lanes, {})).corpus).toEqual({
      state: 'ok',
      at: NOW - MINUTE,
    });
    // Marked failed while running: never running again, whatever its heartbeat says.
    await t.run((ctx) =>
      ctx.db.patch(runId, {
        status: 'running',
        finishedAt: undefined,
        progressAt: NOW,
        markedFailed: { byUserId: by, at: NOW, reason: 'laptop slept', actionId },
      }),
    );
    expect((await as.query(api.machineryRuns.lanes, {})).corpus.state).toBe('failed');
  });

  test('a campaign reads its running pass; agrees with the Overview’s card at the same now', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { campaign, load } = await seedCampaign(t, 'c1', 41 * MINUTE);
    const lanes = await as.query(api.machineryRuns.lanes, { now: NOW });
    expect(lanes.corpus).toMatchObject({
      state: 'stalled',
      at: NOW - 46 * MINUTE,
      kind: 'campaign',
    });
    const inputs = must(lanes.corpus.livenessInputs);
    expect(campaignLiveness(inputs.self, inputs.passes, NOW).state).toBe('stalled');
    const card = await as.query(api.machinery.overviewJobs, { now: NOW });
    expect(card?.jobs.find((j) => j.id === 'import')).toEqual({
      id: 'import',
      name: 'Corpus campaign c1',
      state: 'stalled',
      at: NOW - 46 * MINUTE,
      runId: campaign,
    });
    // The load beats: running on both.
    await t.run((ctx) => ctx.db.patch(load, { progressAt: NOW }));
    expect((await as.query(api.machineryRuns.lanes, { now: NOW })).corpus.state).toBe('running');
    expect(
      (await as.query(api.machinery.overviewJobs, { now: NOW }))?.jobs.find(
        (j) => j.id === 'import',
      )?.state,
    ).toBe('running');
  });
});

describe('the Overview’s import row', () => {
  test('maps each verdict as Machinery does, and falls back to the last finished import unlisted', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const importRow = async () =>
      (await as.query(api.machinery.overviewJobs, { now: NOW }))?.jobs.find(
        (j) => j.id === 'import',
      );
    // Nothing listed yet (before the backfill): the newest finished import, as before.
    const old = await seedRun(t, {
      listedIn: undefined,
      kind: 'lake_depth',
      label: 'depths',
      status: 'failed',
      startedAt: NOW - DAY,
      finishedAt: NOW - DAY + MINUTE,
    });
    await seedRun(t, { listedIn: undefined, kind: 'lake_depth', label: 'live' });
    expect(await importRow()).toEqual({
      id: 'import',
      name: 'depths',
      state: 'failed',
      at: NOW - DAY + MINUTE,
      runId: old,
    });
    const listed = await seedRun(t, { label: 'VT canonical water', progressAt: NOW - 7 * MINUTE });
    expect(await importRow()).toMatchObject({ state: 'late', runId: listed });
    await t.run((ctx) => ctx.db.patch(listed, { progressAt: undefined }));
    expect((await importRow())?.state).toBe('late');
    await t.run((ctx) => ctx.db.patch(listed, { status: 'succeeded', finishedAt: NOW }));
    expect(await importRow()).toMatchObject({ state: 'ok', at: NOW });
    // A running import is shown, and shown before the quiet jobs.
    await t.run((ctx) =>
      ctx.db.patch(listed, { status: 'running', finishedAt: undefined, progressAt: NOW }),
    );
    expect((await importRow())?.state).toBe('running');
  });
});

describe('importJobState', () => {
  test('every verdict to the card’s word: a held stall and a missing heartbeat read late', () => {
    const live = (state: 'running' | 'late' | 'stalled' | 'waiting') =>
      ({ state, quietMs: 0, expectedMs: null, waitUntil: null }) as const;
    const running = { status: 'running' as const, markedFailed: undefined };
    expect(importJobState(running, live('running'))).toBe('running');
    expect(importJobState(running, live('late'))).toBe('late');
    expect(importJobState(running, live('stalled'))).toBe('stalled');
    expect(importJobState(running, live('waiting'))).toBe('late');
    expect(importJobState(running, { state: 'notRecorded' })).toBe('late');
    const done = { state: 'finished' } as const;
    expect(importJobState({ status: 'succeeded', markedFailed: undefined }, done)).toBe('ok');
    expect(importJobState({ status: 'failed', markedFailed: undefined }, done)).toBe('failed');
    expect(importJobState({ status: 'running', markedFailed: {} as never }, done)).toBe('failed');
  });
});

describe('listPage', () => {
  test('lists listed runs newest first, a campaign with its facts and a pass with its headline', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const vt = await seedRun(t, {
      label: 'VT canonical water',
      status: 'succeeded',
      startedAt: NOW - 30 * DAY,
      finishedAt: NOW - 30 * DAY,
      counts: [{ name: 'inserted', value: 8_214 }],
    });
    await seedRun(t, {
      kind: 'floor_prune',
      label: 'prune',
      status: 'succeeded',
      campaignId: 'c1',
      startedAt: NOW - 2 * DAY,
      finishedAt: NOW - 2 * DAY,
      notes: [DRY_RUN_NOTE],
      counts: [{ name: 'scanned', value: 40 }],
    });
    const { campaign } = await seedCampaign(t, 'c1');
    const res = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: NOW,
    });
    expect(res.isDone).toBe(true);
    expect(res.indexed).toBe(true);
    expect(res.page.map((r) => r.title)).toEqual(['c1', 'prune-floor', 'VT canonical water']);
    const [c, prune, load] = res.page as [RunRowView, RunRowView, RunRowView];
    expect(c).toMatchObject({
      id: campaign,
      kind: 'campaign',
      campaignId: 'c1',
      status: 'running',
      liveness: { state: 'running', expectedMs: E_LOAD },
      dryRun: false,
      marked: false,
      scope: { pass: 'full-canonical', complete: true },
      finishedAt: null,
      line: {
        kind: 'campaign',
        passesDone: 2,
        passesPlanned: 10,
        current: 'load',
        stoppedAt: null,
        bodiesLoaded: 9_412,
        recorded: true,
      },
    });
    expect(prune).toMatchObject({
      kind: 'pass',
      dryRun: true,
      scope: null,
      liveness: { state: 'finished' },
      line: { kind: 'pass', headline: { name: 'scanned', value: 40 } },
    });
    expect(load).toMatchObject({
      id: vt,
      line: { kind: 'pass', headline: { name: 'inserted', value: 8_214 } },
    });
  });

  test('a failed campaign says where it stopped', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedRun(t, {
      kind: 'corpus_campaign',
      campaignId: 'c2',
      status: 'failed',
      finishedAt: NOW,
      campaign: { flags: [], plan: [], exitCode: 1, lastPass: 'load-sub-areas' },
    });
    const [row] = (
      await as.query(api.machineryRuns.listPage, {
        lane: 'corpus',
        paginationOpts: { numItems: 25, cursor: null },
      })
    ).page;
    expect(row?.line).toEqual({
      kind: 'campaign',
      passesDone: 0,
      passesPlanned: null,
      current: null,
      stoppedAt: 'load-sub-areas',
      bodiesLoaded: null,
      recorded: true,
    });
  });

  test('before the backfill an old pass is simply not listed, and the list says it is incomplete', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // An August campaign's merge and load, from before B01-8a: no listedIn, no parent, no campaign row.
    for (const kind of ['corpus_merge', 'canonical_water'] as const) {
      await seedRun(t, {
        kind,
        listedIn: undefined,
        campaignId: 'a07a-20260807',
        status: 'succeeded',
        startedAt: NOW - 100 * DAY,
        finishedAt: NOW - 100 * DAY,
        progressAt: undefined,
      });
    }
    // An enrichment run is never listed under Corpus, and doesn't hold `indexed` down.
    await seedRun(t, { kind: 'lake_depth', listedIn: undefined, status: 'succeeded' });
    const read = () =>
      as.query(api.machineryRuns.listPage, {
        lane: 'corpus',
        paginationOpts: { numItems: 25, cursor: null },
      });
    expect(await read()).toMatchObject({ page: [], isDone: true, indexed: false });
    // A run started after the deploy lists at once; the old ones still don't, and still say so.
    await seedRun(t, { kind: 'floor_prune', label: 'new prune', status: 'succeeded' });
    const after = await read();
    expect(after.page.map((r) => r.title)).toEqual(['prune-floor']);
    expect(after.indexed).toBe(false);
    // The backfill lists (or parents) them: the list is complete.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query('importRuns').collect()) {
        if (r.kind !== 'lake_depth' && r.listedIn === undefined) {
          await ctx.db.patch(r._id, { listedIn: 'corpus' });
        }
      }
    });
    expect((await read()).indexed).toBe(true);
    // A campaign's own passes (with a parent) never hold it down, and are never listed singly.
    await seedCampaign(t, 'c3');
    const withCampaign = await read();
    expect(withCampaign.indexed).toBe(true);
    expect(withCampaign.page.filter((r) => r.kind === 'campaign').map((r) => r.title)).toEqual([
      'c3',
    ]);
  });

  test('history waiting for the backfill reads unindexed though newer unlisted runs are others', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedRun(t, {
      kind: 'corpus_merge',
      listedIn: undefined,
      campaignId: 'a07a-20260807',
      status: 'succeeded',
      startedAt: NOW - 100 * DAY,
      finishedAt: NOW - 100 * DAY,
    });
    // More of another pipeline's runs, never listed under Corpus, than the newest-first probe reads.
    for (let n = 0; n <= INDEXED_PROBE; n++) {
      await seedRun(t, {
        kind: 'lake_depth',
        listedIn: undefined,
        status: 'succeeded',
        startedAt: NOW - n * MINUTE,
      });
    }
    const read = () =>
      as.query(api.machineryRuns.listPage, {
        lane: 'corpus',
        paginationOpts: { numItems: 25, cursor: null },
      });
    expect((await read()).indexed).toBe(false);
  });

  test('pages 25 at a time over many campaigns, inside the backend’s limits', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    for (let i = 0; i < 30; i++) {
      const c = await seedRun(t, {
        kind: 'corpus_campaign',
        campaignId: `c-${i}`,
        status: 'succeeded',
        startedAt: NOW - (i + 1) * DAY,
        finishedAt: NOW - (i + 1) * DAY,
        campaign: { flags: [], plan: PLAN },
      });
      for (let p = 0; p < CAMPAIGN_PASS_LIMIT + 2; p++) {
        await seedRun(t, {
          kind: 'landmark_seed',
          parentRunId: c,
          listedIn: undefined,
          status: 'succeeded',
          startedAt: NOW - (i + 1) * DAY + p,
        });
      }
    }
    const first = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 500, cursor: null },
    });
    expect(first.page).toHaveLength(LIST_PAGE_SIZE);
    expect(first.page[0]?.title).toBe('c-0');
    expect(first.page[0]?.line).toMatchObject({ passesDone: CAMPAIGN_PASS_LIMIT });
    const second = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r.title)).toEqual(['c-25', 'c-26', 'c-27', 'c-28', 'c-29']);
    expect(second.isDone).toBe(true);
  });
});

describe('campaign', () => {
  test('merges the plan with its passes, the by-hand ones after', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { campaign, region, merge, load } = await seedCampaign(t, 'c1', 41 * MINUTE);
    const prune = await seedRun(t, {
      kind: 'floor_prune',
      campaignId: 'c1',
      status: 'succeeded',
      startedAt: NOW - MINUTE,
      finishedAt: NOW,
      notes: [DRY_RUN_NOTE],
    });
    await t.run((ctx) =>
      ctx.db.insert('runEvents', {
        runId: load,
        seq: 0,
        at: NOW - 41 * MINUTE,
        loggedAt: NOW - 37 * MINUTE,
        kind: 'flush',
        text: 'batchesApplied=66',
      }),
    );
    const view = await as.query(api.machineryRuns.campaign, { runId: campaign, now: NOW });
    expect(view).not.toBeNull();
    if (view === null) return;
    expect(await as.query(api.machineryRuns.campaign, { campaignId: 'c1', now: NOW })).toEqual(
      view,
    );
    expect(view.recorded).toBe(true);
    expect(view.flags).toEqual(['--states=all']);
    expect(view.liveness).toMatchObject({ state: 'stalled', quietMs: 41 * MINUTE });
    expect(view.row.liveness).toEqual(view.liveness);
    expect(view.passes.map((p) => [p.pass, p.by, p.state, p.skipped])).toEqual([
      ['build-region', 'script', 'done', null],
      ['merge', 'script', 'done', null],
      ['load', 'script', 'stalled', null],
      ['load-sub-areas', 'script', 'skipped', 'no actor given'],
      ['landmarks', 'script', 'waiting', null],
      ['load-landmarks', 'script', 'waiting', null],
      ['load-landmark-names', 'script', 'waiting', null],
      ['prune-floor', 'hand', 'dryRun', null],
      ['seed-standing', 'hand', 'notRun', null],
      // The merge absorbed pairs, and no applied retire has run.
      ['retire-absorbed', 'hand', 'required', null],
    ]);
    expect(view.passes[0]).toMatchObject({
      does: 'Region masks',
      run: { id: region, inUp: null, failed: 0 },
    });
    expect(view.passes[2]?.run).toMatchObject({ id: load, inUp: { in: 0, up: 9_412 }, failed: 3 });
    expect(view.passes[7]?.run?.id).toBe(prune);
    expect(view.current).toEqual({
      runId: load,
      pass: 'load',
      counts: expect.any(Array),
      progressAt: NOW - 41 * MINUTE,
      batches: { applied: 66, total: 170 },
      failures: { stored: 2, total: 3, keys: ['nhd/1'] },
    });
    expect(view.path.map((s) => s.name)).toEqual(['osm', 'nhd']);
    expect(view.marked).toBeNull();
    expect(view.waiting).toBeNull();
    expect(view.clockSkewMs).toBe(4 * MINUTE);
    void merge;
  });

  test('a retire applied clears required; a finished campaign’s unstarted passes are not run', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { campaign, load } = await seedCampaign(t, 'c1');
    await t.run(async (ctx) => {
      await ctx.db.patch(load, { status: 'failed', finishedAt: NOW });
      await ctx.db.patch(campaign, {
        status: 'failed',
        finishedAt: NOW,
        campaign: { flags: [], plan: PLAN, exitCode: 1, lastPass: 'load' },
      });
    });
    await seedRun(t, {
      kind: 'absorbed_retire',
      campaignId: 'c1',
      status: 'succeeded',
      finishedAt: NOW,
    });
    const view = await as.query(api.machineryRuns.campaign, { runId: campaign });
    expect(view?.liveness).toEqual({ state: 'finished' });
    expect(view?.passes.map((p) => p.state)).toEqual([
      'done',
      'done',
      'failed',
      'skipped',
      'notRun',
      'notRun',
      'notRun',
      'notRun',
      'notRun',
      'done',
    ]);
    // Nothing running: the page shows the last pass that ran.
    expect(view?.current?.runId).toBe(load);
    expect(view?.clockSkewMs).toBeNull();
    expect(view?.row.line).toMatchObject({ stoppedAt: 'load' });
  });

  test('a wait on the running pass and a mark on the campaign, with the people', async () => {
    const t = harness();
    const { id: by, as } = await seedUser(t, 'admin', 'Avery');
    const actionId = await seedAction(t, by, 'wait_on_run');
    const { campaign, load } = await seedCampaign(t, 'c1', 41 * MINUTE);
    await t.run((ctx) =>
      ctx.db.patch(load, {
        stallWait: { until: NOW + 30 * MINUTE, byUserId: by, at: NOW, actionId },
      }),
    );
    const waited = await as.query(api.machineryRuns.campaign, { runId: campaign, now: NOW });
    expect(waited?.liveness.state).toBe('waiting');
    expect(waited?.passes[2]?.state).toBe('stalled');
    expect(waited?.waiting).toEqual({
      by: { id: by, name: 'Avery', avatarUrl: expect.stringMatching(/^https:\/\/img\//) },
      at: NOW,
      until: NOW + 30 * MINUTE,
    });
    await t.run((ctx) =>
      ctx.db.patch(campaign, {
        markedFailed: { byUserId: by, at: NOW, reason: 'laptop slept', actionId },
        loaderFinish: { status: 'succeeded', at: NOW + MINUTE },
      }),
    );
    const marked = await as.query(api.machineryRuns.campaign, { runId: campaign, now: NOW });
    expect(marked?.liveness).toEqual({ state: 'finished' });
    expect(marked?.row.marked).toBe(true);
    expect(marked?.marked).toMatchObject({
      by: { id: by, name: 'Avery' },
      reason: 'laptop slept',
      loaderFinish: { status: 'succeeded', at: NOW + MINUTE },
    });
    // The wait, expired, is no longer shown.
    vi.setSystemTime(NOW + 31 * MINUTE);
    expect(
      (await as.query(api.machineryRuns.campaign, { runId: campaign, now: NOW + 31 * MINUTE }))
        ?.waiting,
    ).toBeNull();
  });

  test('the edges: no campaign id, a pass with no heartbeat, a mark by a deleted account', async () => {
    const t = harness();
    const { id: by } = await seedUser(t, 'admin');
    const { as } = await seedUser(t, 'admin');
    const actionId = await seedAction(t, by, 'mark_run_failed');
    const row = await seedRun(t, { kind: 'corpus_campaign', campaign: { flags: [], plan: [] } });
    const bare = await as.query(api.machineryRuns.campaign, { runId: row, now: NOW });
    expect(bare).toMatchObject({
      row: { title: 'run', campaignId: null, liveness: { state: 'running' } },
      flags: [],
      current: null,
      path: [],
      clockSkewMs: null,
    });
    // The script's passes from the stored plan (none): only the by-hand ones, not run.
    expect(bare?.passes.map((p) => [p.pass, p.state])).toEqual([
      ['prune-floor', 'notRun'],
      ['seed-standing', 'notRun'],
      ['retire-absorbed', 'notRun'],
    ]);
    await seedRun(t, {
      kind: 'corpus_merge',
      parentRunId: row,
      listedIn: undefined,
      progressAt: undefined,
    });
    const unbeaten = await as.query(api.machineryRuns.campaign, { runId: row, now: NOW });
    expect(unbeaten?.liveness).toEqual({ state: 'notRecorded' });
    expect(unbeaten?.passes[0]).toMatchObject({ pass: 'merge', state: 'late' });
    expect(unbeaten?.current).toMatchObject({ pass: 'merge', progressAt: null, batches: null });
    await t.run(async (ctx) => {
      await ctx.db.patch(by, { status: 'deleted' });
      await ctx.db.patch(row, { markedFailed: { byUserId: by, at: NOW, reason: 'r', actionId } });
    });
    expect((await as.query(api.machineryRuns.campaign, { runId: row }))?.marked).toEqual({
      by: { id: by, name: 'admin', avatarUrl: null },
      at: NOW,
      reason: 'r',
      loaderFinish: null,
    });
  });

  test('null for a pass, a missing run, or a campaign id with no campaign row', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { load } = await seedCampaign(t, 'c1');
    expect(await as.query(api.machineryRuns.campaign, { runId: load })).toBeNull();
    expect(await as.query(api.machineryRuns.campaign, { campaignId: 'nope' })).toBeNull();
    expect(await as.query(api.machineryRuns.campaign, {})).toBeNull();
    // An old campaign with no row isn't assembled from its runs.
    await seedRun(t, { kind: 'corpus_merge', campaignId: 'old', listedIn: undefined });
    expect(await as.query(api.machineryRuns.campaign, { campaignId: 'old' })).toBeNull();
    const gone = await seedRun(t);
    await t.run((ctx) => ctx.db.delete(gone));
    expect(await as.query(api.machineryRuns.campaign, { runId: gone })).toBeNull();
  });

  test('a campaign id run again and again opens its newest campaign', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // Eight runs of one id, eight rows each: the newest is past the oldest 50 rows the id holds.
    let newest: Id<'importRuns'> | null = null;
    for (let n = 0; n < 8; n++) {
      const startedAt = NOW - (8 - n) * DAY;
      newest = await seedRun(t, {
        kind: 'corpus_campaign',
        campaignId: 'again',
        status: 'succeeded',
        startedAt,
        finishedAt: startedAt + MINUTE,
        campaign: { flags: [], plan: PLAN },
      });
      for (let p = 0; p < 7; p++) {
        await seedRun(t, {
          kind: 'corpus_merge',
          campaignId: 'again',
          parentRunId: newest,
          listedIn: undefined,
          status: 'succeeded',
          startedAt: startedAt + p + 1,
          finishedAt: startedAt + MINUTE,
        });
      }
    }
    const view = await as.query(api.machineryRuns.campaign, { campaignId: 'again', now: NOW });
    expect(view?.row.id).toBe(newest);
  });

  test('a campaign id run again keeps each campaign’s by-hand passes its own', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // An earlier campaign under the same id, which ran an applied retire after its merge.
    const earlier = await seedRun(t, {
      kind: 'corpus_campaign',
      campaignId: 'c1',
      status: 'succeeded',
      startedAt: NOW - 20 * DAY,
      finishedAt: NOW - 20 * DAY + 60 * MINUTE,
      campaign: { flags: [], plan: PLAN },
    });
    const oldRetire = await seedRun(t, {
      kind: 'absorbed_retire',
      campaignId: 'c1',
      status: 'succeeded',
      startedAt: NOW - 19 * DAY,
      finishedAt: NOW - 19 * DAY + MINUTE,
    });
    const { campaign } = await seedCampaign(t, 'c1');
    const prune = await seedRun(t, {
      kind: 'floor_prune',
      campaignId: 'c1',
      status: 'succeeded',
      startedAt: NOW - MINUTE,
      finishedAt: NOW,
    });
    const passOf = (
      view: { passes: { pass: string; state: string; run: { id: unknown } | null }[] } | null,
      pass: string,
    ) => view?.passes.find((p) => p.pass === pass);
    const now = await as.query(api.machineryRuns.campaign, { runId: campaign, now: NOW });
    // The earlier campaign's retire is not this one's: its merge's absorbed pairs still want one.
    expect(passOf(now, 'retire-absorbed')).toMatchObject({ state: 'required', run: null });
    expect(passOf(now, 'prune-floor')?.run?.id).toBe(prune);
    const then = await as.query(api.machineryRuns.campaign, { runId: earlier, now: NOW });
    expect(passOf(then, 'retire-absorbed')?.run?.id).toBe(oldRetire);
    // The later campaign's prune is not the earlier one's.
    expect(passOf(then, 'prune-floor')).toMatchObject({ state: 'notRun', run: null });
  });

  test('a recorded campaign is judged by the passes under it, as its list row is', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { campaign, load } = await seedCampaign(t, 'c1');
    // A row left running under the same id with no parent: no heartbeat, from an earlier campaign.
    await seedRun(t, {
      kind: 'canonical_water',
      campaignId: 'c1',
      listedIn: 'corpus',
      startedAt: NOW - 20 * DAY,
      progressAt: undefined,
    });
    const view = await as.query(api.machineryRuns.campaign, { runId: campaign, now: NOW });
    const listed = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: NOW,
    });
    const row = listed.page.find((r) => r.id === campaign);
    expect(view?.liveness).toEqual(row?.liveness);
    expect(view?.liveness.state).toBe('running');
    expect(view?.row.line).toEqual(row?.line);
    expect(view?.current?.runId).toBe(load);
  });

  test('a reconstructed campaign is finished history; its flags and plan not recorded', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // Left `running` by a killed loader in August, with no heartbeat — and its pass too.
    const row = await seedRun(t, {
      kind: 'corpus_campaign',
      campaignId: 'a07a-20260809',
      startedAt: NOW - 100 * DAY,
      progressAt: NOW - 100 * DAY,
      campaign: { flags: [], plan: [], reconstructed: true } as never,
    });
    await seedRun(t, {
      kind: 'corpus_merge',
      campaignId: 'a07a-20260809',
      listedIn: undefined,
      status: 'succeeded',
      startedAt: NOW - 100 * DAY,
      progressAt: undefined,
    });
    await seedRun(t, {
      kind: 'canonical_water',
      campaignId: 'a07a-20260809',
      listedIn: undefined,
      startedAt: NOW - 100 * DAY + 1,
      progressAt: NOW - 100 * DAY,
    });
    const view = await as.query(api.machineryRuns.campaign, { runId: row });
    expect(view?.recorded).toBe(false);
    expect(view?.flags).toBeNull();
    expect(view?.liveness).toEqual({ state: 'finished' });
    expect(view?.row.liveness).toEqual({ state: 'finished' });
    expect(view?.row.line).toMatchObject({ recorded: false, passesPlanned: null, current: null });
    expect(view?.passes.slice(0, 2).map((p) => [p.pass, p.state])).toEqual([
      ['merge', 'done'],
      ['load', 'stalled'],
    ]);
    const listed = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(listed.page[0]?.liveness).toEqual({ state: 'finished' });
    expect((await as.query(api.machineryRuns.lanes, {})).corpus.state).not.toMatch(
      /running|late|stalled/,
    );
  });
});

describe('isReconstructed', () => {
  test('reads the flag narrowly: only a stored true', () => {
    expect(isReconstructed({ campaign: undefined })).toBe(false);
    expect(isReconstructed({ campaign: { flags: [], plan: [] } })).toBe(false);
    expect(
      isReconstructed({ campaign: { flags: [], plan: [], reconstructed: true } as never }),
    ).toBe(true);
    expect(
      isReconstructed({ campaign: { flags: [], plan: [], reconstructed: 'yes' } as never }),
    ).toBe(false);
  });
});

describe('run', () => {
  test('one run whole, with its liveness, parent and people; a campaign row reads its passes', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { campaign, load } = await seedCampaign(t, 'c1', 7 * MINUTE);
    const pass = await as.query(api.machineryRuns.run, { runId: load, now: NOW });
    expect(pass).toMatchObject({
      doc: { _id: load, campaignPass: 'load' },
      liveness: { state: 'late' },
      parent: { id: campaign, title: 'c1' },
      marked: null,
      waiting: null,
    });
    const own = await as.query(api.machineryRuns.run, { runId: campaign, now: NOW });
    expect(own?.liveness.state).toBe('late');
    expect(own?.parent).toBeNull();
    const gone = await seedRun(t);
    await t.run((ctx) => ctx.db.delete(gone));
    expect(await as.query(api.machineryRuns.run, { runId: gone })).toBeNull();
  });
});

describe('events', () => {
  test('newest first, at most 200 a page, paging back', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const runId = await seedRun(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert('runEvents', {
          runId,
          seq: i,
          at: NOW + i,
          loggedAt: NOW + i,
          kind: i === 229 ? 'cap' : 'flush',
          text: `line ${i}`,
          ...(i === 229 ? { dropped: 12 } : {}),
        });
      }
    });
    const first = await as.query(api.machineryRuns.events, {
      runId,
      paginationOpts: { numItems: 1_000, cursor: null },
    });
    expect(first.page).toHaveLength(200);
    expect(first.page[0]).toEqual({
      seq: 229,
      loggedAt: NOW + 229,
      kind: 'cap',
      text: 'line 229',
      dropped: 12,
    });
    expect(first.page[1]?.dropped).toBeNull();
    const rest = await as.query(api.machineryRuns.events, {
      runId,
      paginationOpts: { numItems: 200, cursor: first.continueCursor },
    });
    expect(rest.page.map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 29 - i));
    expect(rest.isDone).toBe(true);
  });
});

describe('lastCampaignRun', () => {
  test('names the newest succeeded merge or load: never a running, failed or marked one', async () => {
    const t = harness();
    const { id: by } = await seedUser(t, 'admin');
    const actionId = await seedAction(t, by, 'mark_run_failed');
    const last = () => t.run(async (ctx) => (await lastCampaignRun(ctx))?._id ?? null);
    expect(await last()).toBeNull();
    const ok = await seedRun(t, {
      kind: 'corpus_merge',
      status: 'succeeded',
      startedAt: NOW - 10 * DAY,
    });
    expect(await last()).toBe(ok);
    await seedRun(t, { kind: 'corpus_merge', startedAt: NOW - DAY });
    await seedRun(t, { kind: 'canonical_water', status: 'failed', startedAt: NOW - DAY });
    await seedRun(t, {
      kind: 'canonical_water',
      status: 'succeeded',
      startedAt: NOW - 2 * DAY,
      markedFailed: { byUserId: by, at: NOW, reason: 'x', actionId },
    });
    expect(await last()).toBe(ok);
    const newer = await seedRun(t, {
      kind: 'canonical_water',
      status: 'succeeded',
      startedAt: NOW - 3 * DAY,
    });
    expect(await last()).toBe(newer);
  });
});

describe('where a run was written, and whether it wrote', () => {
  const doc = (over: Partial<Doc<'importRuns'>>) =>
    ({
      kind: 'floor_prune',
      label: 'prune',
      status: 'succeeded',
      notes: [],
      ...over,
    }) as Doc<'importRuns'>;

  test('applied: a by-hand pass that ran to its end, wrote, and was not marked', () => {
    expect(isAppliedHandPass(doc({}))).toBe(true);
    expect(isAppliedHandPass(doc({ notes: [DRY_RUN_NOTE] }))).toBe(false);
    expect(isAppliedHandPass(doc({ status: 'failed' }))).toBe(false);
    expect(isAppliedHandPass(doc({ status: 'running' }))).toBe(false);
    expect(isAppliedHandPass(doc({ markedFailed: {} as Doc<'importRuns'>['markedFailed'] }))).toBe(
      false,
    );
    // A script pass that wrote is *succeeded*, never *applied*; a campaign row neither.
    expect(isAppliedHandPass(doc({ kind: 'canonical_water' }))).toBe(false);
    expect(isAppliedHandPass(doc({ kind: 'corpus_campaign', campaignId: 'c1' }))).toBe(false);
  });

  test('the list row says applied; the run page says dry run; the campaign page its deployment', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const wrote = await seedRun(t, {
      kind: 'floor_prune',
      label: 'prune',
      status: 'succeeded',
      finishedAt: NOW - MINUTE,
    });
    const dry = await seedRun(t, {
      kind: 'floor_prune',
      label: 'prune',
      status: 'succeeded',
      startedAt: NOW - 40 * MINUTE,
      finishedAt: NOW - 2 * MINUTE,
      notes: [DRY_RUN_NOTE],
    });
    const list = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: NOW,
    });
    expect(list.page.map((r) => [r.id, r.applied, r.dryRun])).toEqual([
      [wrote, true, false],
      [dry, false, true],
    ]);
    expect((await as.query(api.machineryRuns.run, { runId: dry, now: NOW }))?.dryRun).toBe(true);
    expect((await as.query(api.machineryRuns.run, { runId: wrote, now: NOW }))?.dryRun).toBe(false);

    const { campaign } = await seedCampaign(t, 'c2');
    await t.run((ctx) =>
      ctx.db.patch(campaign, { deployment: 'dev:agile-bee-397', isProd: false }),
    );
    const page = await as.query(api.machineryRuns.campaign, { campaignId: 'c2', now: NOW });
    expect(page).toMatchObject({ deployment: 'dev:agile-bee-397', isProd: false });
  });
});

describe('the inputs a page re-reads a row by', () => {
  const reread = (row: Pick<RunRowView, 'kind' | 'liveness' | 'livenessInputs'>, now: number) => {
    const inputs = row.livenessInputs;
    if (inputs == null) return row.liveness;
    return row.kind === 'campaign'
      ? campaignLiveness(inputs.self, inputs.passes, now)
      : runLiveness(inputs.self, now);
  };

  test('re-read at the same clock, every row says what the server said; later, it moves on', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedCampaign(t, 'c1', 41 * MINUTE);
    const lone = await seedRun(t, { startedAt: NOW - 5 * MINUTE, progressAt: NOW - MINUTE });
    await seedRun(t, { status: 'succeeded', startedAt: NOW - 90 * MINUTE, finishedAt: NOW - DAY });
    const list = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: NOW,
    });
    expect(list.page.length).toBeGreaterThanOrEqual(3);
    for (const row of list.page) expect(reread(row, NOW)).toEqual(row.liveness);
    const campaignRow = list.page.find((r) => r.kind === 'campaign') as RunRowView;
    expect(campaignRow.livenessInputs?.passes.length).toBeGreaterThan(0);
    expect(list.page.find((r) => r.status === 'succeeded')?.livenessInputs).toBeNull();

    const later = NOW + 60 * MINUTE;
    vi.setSystemTime(later);
    const laterList = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: later,
    });
    for (const row of laterList.page) {
      const before = list.page.find((r) => r.id === row.id) as RunRowView;
      expect(reread(before, later)).toEqual(row.liveness);
    }

    vi.setSystemTime(NOW);
    const page = await as.query(api.machineryRuns.campaign, { campaignId: 'c1', now: NOW });
    expect(reread(page?.row as RunRowView, NOW)).toEqual(page?.liveness);
    const run = await as.query(api.machineryRuns.run, { runId: lone, now: NOW });
    expect(
      reread(
        {
          kind: 'pass',
          liveness: run?.liveness as RunRowView['liveness'],
          livenessInputs: run?.livenessInputs ?? null,
        },
        NOW,
      ),
    ).toEqual(run?.liveness);
  });

  test('a mark is sent as its presence, never its record', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const { load } = await seedCampaign(t, 'c1', 41 * MINUTE);
    await as.mutation(api.machineryWrites.markRunFailed, { runId: load, reason: 'secret words' });
    const page = await as.query(api.machineryRuns.campaign, { campaignId: 'c1', now: NOW });
    expect(JSON.stringify(page?.row.livenessInputs)).not.toContain('secret words');
    expect(page?.row.livenessInputs?.passes.some((p) => p.markedFailed === true)).toBe(true);
  });
});

describe('the summer aerial’s runs (B05)', () => {
  test('list in no lane, get no pace, and read plainly when the Overview’s card opens one', async () => {
    // `aerial_select`, `aerial_tiles` and `aerial_assemble` are a build's stages, hours long and
    // silent between their own reports, with no Machinery page yet: none is a corpus kind, and none
    // has a gap in `RUN_QUIET_MS`, so a quiet one is never called late or stalled.
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const tiles = await seedRun(t, {
      listedIn: undefined,
      kind: 'aerial_tiles',
      label: 'naip-20261212 tiles',
      campaignId: 'naip-20261212',
      startedAt: NOW - 6 * 60 * MINUTE,
      progressAt: NOW - 5 * 60 * MINUTE,
    });
    const assemble = await seedRun(t, {
      listedIn: undefined,
      kind: 'aerial_assemble',
      label: 'naip-20261211 assemble',
      status: 'succeeded',
      startedAt: NOW - DAY,
      finishedAt: NOW - DAY + 30 * MINUTE,
    });
    await seedRun(t, { listedIn: undefined, kind: 'aerial_select', label: 'naip-20261212 select' });
    const listed = await as.query(api.machineryRuns.listPage, {
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: NOW,
    });
    expect(listed.page).toEqual([]);
    expect(listed.indexed).toBe(true);
    const view = must(await as.query(api.machineryRuns.run, { runId: tiles, now: NOW }));
    expect(view.liveness).toEqual({
      state: 'running',
      quietMs: 5 * 60 * MINUTE,
      expectedMs: null,
      waitUntil: null,
    });
    expect(view.parent).toBeNull();
    // With no corpus run listed, the card's row is the newest finished import: the aerial's.
    const card = await as.query(api.machinery.overviewJobs, { now: NOW });
    expect(card?.jobs.find((j) => j.id === 'import')).toEqual({
      id: 'import',
      name: 'naip-20261211 assemble',
      state: 'ok',
      at: NOW - DAY + 30 * MINUTE,
      runId: assemble,
    });
  });
});
