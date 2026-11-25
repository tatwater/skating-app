/**
 * **The Corpus tasks' hooks** (B01-6a): each write that changes a body's questions calls the one
 * writer — the import (with the honoring rule, D305), the merge and its unmerge, the remove and its
 * restore, and both duplicate resolutions' hard deletes — and the counts equal their tallies after
 * each.
 */

import { UNRECORDED_EVIDENCE } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { countKeysOf, settleReason } from './lib/corpusTasks';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

afterEach(() => {
  vi.useRealTimers();
});

const PREFS = {
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

async function person(t: T, subject: string, role: 'moderator' | 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

type Rec = {
  externalId: string;
  x?: number;
  reviewReasons?: Doc<'waterBodies'>['reviewReasons'];
  nameClaims?: { source: 'osm' | 'nhd'; value: string; sources?: ('osm' | 'nhd')[] }[];
  classClaims?: {
    source: 'osm' | 'nhd';
    value: Doc<'waterBodies'>['type'];
    token?: string;
    areaSqM?: number;
  }[];
  classRefusals?: { source: 'osm' | 'nhd'; token: string; areaSqM?: number }[];
  osmId?: string;
  campaignId?: string;
};

const NAMES = [
  { source: 'nhd' as const, value: 'The Basin' },
  { source: 'osm' as const, value: 'Lake Auburn' },
];
const CLASSES = [
  { source: 'nhd' as const, value: 'wetland' as const, token: 'nhd:fcode=46600', areaSqM: 9e5 },
  { source: 'osm' as const, value: 'lakePond' as const, token: 'osm:water=pond', areaSqM: 8e5 },
];

function record(r: Rec) {
  const x = r.x ?? 0;
  return {
    source: 'osm' as const,
    states: ['VT'],
    externalId: r.externalId,
    osmId: r.osmId ?? r.externalId,
    name: 'The Basin',
    type: 'lakePond' as const,
    polygon: square(x),
    bbox: { minLat: 0, minLng: x, maxLat: 1, maxLng: x + 1 },
    centroid: { lat: 0.5, lng: x + 0.5 },
    surfaceAreaSqM: 1_000_000,
    ...(r.reviewReasons !== undefined ? { reviewReasons: r.reviewReasons } : {}),
    ...(r.nameClaims !== undefined ? { nameClaims: r.nameClaims } : {}),
    ...(r.classClaims !== undefined ? { classClaims: r.classClaims } : {}),
    ...(r.classRefusals !== undefined ? { classRefusals: r.classRefusals } : {}),
  };
}

const BOTH: Rec = {
  externalId: 'osm/A',
  reviewReasons: ['class-conflict', 'name-conflict', 'class-dissent'],
  nameClaims: NAMES,
  classClaims: CLASSES,
  classRefusals: [{ source: 'osm', token: 'osm:natural=water', areaSqM: 7e5 }],
};

async function load(t: T, recs: Rec[], campaignId?: string) {
  return t.mutation(internal.waterBodies.importCanonical, {
    bodies: recs.map(record),
    ...(campaignId !== undefined ? { campaignId } : {}),
  });
}

async function bodyOf(t: T, externalId: string): Promise<Doc<'waterBodies'>> {
  const body = await t.run((ctx) =>
    ctx.db
      .query('waterBodies')
      .withIndex('by_external_id', (q) => q.eq('source', 'osm').eq('externalId', externalId))
      .first(),
  );
  if (!body) throw new Error(`no body ${externalId}`);
  return body;
}

const tasksOf = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('corpusTasks')
      .withIndex('by_body_status', (q) => q.eq('waterBodyId', id))
      .collect(),
  );

const openOf = async (t: T, id: Id<'waterBodies'>) =>
  (await tasksOf(t, id)).filter((task) => task.status === 'open');

/** Every count row equals its tally over the stored tasks. */
async function expectCountsTally(t: T) {
  const { tasks, counts } = await t.run(async (ctx) => ({
    tasks: await ctx.db.query('corpusTasks').collect(),
    counts: await ctx.db.query('corpusTaskCounts').collect(),
  }));
  const tally = new Map<string, number>();
  for (const task of tasks) {
    for (const key of countKeysOf(task)) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const stored = new Map(counts.map((c) => [c.key, c.count]));
  for (const key of new Set([...tally.keys(), ...stored.keys()])) {
    expect(stored.get(key) ?? 0, key).toBe(tally.get(key) ?? 0);
  }
}

/** A moderator settles the body's open task of `lane`, as S2's mutations will. */
async function settle(
  t: T,
  modId: Id<'profiles'>,
  id: Id<'waterBodies'>,
  lane: 'nameConflicts' | 'classConflicts',
  decision: 'kept' | 'renamed' | 'reclassed' = 'kept',
) {
  return t.run(async (ctx) => {
    const task = (
      await ctx.db
        .query('corpusTasks')
        .withIndex('by_body_status', (q) => q.eq('waterBodyId', id).eq('status', 'open'))
        .collect()
    ).find((x) => x.lane === lane) as Doc<'corpusTasks'>;
    const actionId = await ctx.db.insert('moderationActions', {
      actorId: modId,
      action: 'settle_review_reason',
      targetType: 'waterbody',
      targetId: id,
      reason: 'Settled',
      createdAt: Date.now(),
    });
    await settleReason(ctx, { task, decision, actionId, actorId: modId });
    return { task, actionId };
  });
}

describe('the import', () => {
  test('files a task per 6a reason and none for a class dissent, its refusals and claim facts stored', async () => {
    const t = harness();
    const result = await load(t, [BOTH]);
    expect(result).toMatchObject({ inserted: 1, settledHeld: 0, raisedAgain: 0 });
    const body = await bodyOf(t, 'osm/A');
    expect((await openOf(t, body._id)).map((x) => x.lane).sort()).toEqual([
      'classConflicts',
      'nameConflicts',
    ]);
    expect(body.reviewReasons).toEqual(['class-conflict', 'name-conflict', 'class-dissent']);
    expect(body.classRefusals).toEqual([
      { source: 'osm', token: 'osm:natural=water', areaSqM: 7e5 },
    ]);
    expect(body.classClaims).toEqual(CLASSES);
    await expectCountsTally(t);
  });

  test('a patch files too, and a reason the campaign drops leaves its task notAsserted', async () => {
    const t = harness();
    await load(t, [{ ...BOTH, reviewReasons: undefined }]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    expect(await openOf(t, id)).toEqual([]);
    expect(await load(t, [BOTH])).toMatchObject({ updated: 1 });
    expect(await openOf(t, id)).toHaveLength(2);
    await load(t, [{ ...BOTH, reviewReasons: ['class-conflict'] }]);
    const tasks = await tasksOf(t, id);
    expect(tasks.find((x) => x.lane === 'nameConflicts')).toMatchObject({
      status: 'left',
      leftBecause: 'notAsserted',
    });
    expect(tasks.find((x) => x.lane === 'classConflicts')?.status).toBe('open');
    await expectCountsTally(t);
  });

  test('the refusals: a list replaces, [] clears, absent keeps', async () => {
    const t = harness();
    await load(t, [BOTH]);
    await load(t, [{ ...BOTH, classRefusals: undefined }]);
    expect((await bodyOf(t, 'osm/A')).classRefusals).toHaveLength(1);
    await load(t, [{ ...BOTH, classRefusals: [{ source: 'nhd', token: 'nhd:fcode=39004' }] }]);
    expect((await bodyOf(t, 'osm/A')).classRefusals).toEqual([
      { source: 'nhd', token: 'nhd:fcode=39004' },
    ]);
    await load(t, [{ ...BOTH, classRefusals: [] }]);
    expect((await bodyOf(t, 'osm/A')).classRefusals).toBeUndefined();
  });

  test('holds a settled reason whose evidence is unchanged: no task, settledHeld', async () => {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    await load(t, [BOTH]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    const { actionId } = await settle(t, mod.id, id, 'classConflicts');
    expect(await load(t, [BOTH])).toMatchObject({ settledHeld: 1, raisedAgain: 0 });
    const body = await bodyOf(t, 'osm/A');
    expect(body.reviewReasons).toEqual(['name-conflict', 'class-dissent']);
    expect(body.reviewReason).toBe('class-dissent');
    expect(body.reviewSettled?.map((s) => [s.reason, s.actionId])).toEqual([
      ['class-conflict', actionId],
    ]);
    expect((await openOf(t, id)).map((x) => x.lane)).toEqual(['nameConflicts']);
    await expectCountsTally(t);
  });

  test('asks again on changed evidence: a new open task, raisedAgain, the decided one kept', async () => {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    await load(t, [BOTH]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    const { task } = await settle(t, mod.id, id, 'classConflicts', 'reclassed');
    const changed = [
      CLASSES[0],
      { ...CLASSES[1], token: 'osm:natural=wetland' },
    ] as Rec['classClaims'];
    expect(await load(t, [{ ...BOTH, classClaims: changed }])).toMatchObject({
      settledHeld: 0,
      raisedAgain: 1,
    });
    const body = await bodyOf(t, 'osm/A');
    expect(body.reviewReasons).toContain('class-conflict');
    expect(body.reviewSettled).toBeUndefined();
    const tasks = await tasksOf(t, id);
    expect(tasks.find((x) => x._id === task._id)).toMatchObject({
      status: 'decided',
      decision: 'reclassed',
    });
    expect(tasks.filter((x) => x.lane === 'classConflicts' && x.status === 'open')).toHaveLength(1);
    await expectCountsTally(t);
  });

  test('a settled name conflict: other sources stay settled, a new spelling is raised again', async () => {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    await load(t, [BOTH]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    await settle(t, mod.id, id, 'nameConflicts', 'renamed');
    const withSources = NAMES.map((n, i) => ({
      ...n,
      sources: i === 0 ? (['nhd', 'osm'] as ('osm' | 'nhd')[]) : (['osm'] as ('osm' | 'nhd')[]),
    }));
    expect(await load(t, [{ ...BOTH, nameClaims: withSources }])).toMatchObject({
      settledHeld: 1,
      raisedAgain: 0,
    });
    expect((await openOf(t, id)).map((x) => x.lane)).toEqual(['classConflicts']);
    const spelled = [...NAMES, { source: 'nhd' as const, value: 'Auburn Basin' }];
    expect(await load(t, [{ ...BOTH, nameClaims: spelled }])).toMatchObject({ raisedAgain: 1 });
    expect((await openOf(t, id)).map((x) => x.lane).sort()).toEqual([
      'classConflicts',
      'nameConflicts',
    ]);
    await expectCountsTally(t);
  });

  test('a settle on unrecorded evidence is asked again once, by the first campaign that records it', async () => {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    await load(t, [{ ...BOTH, classClaims: undefined }]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    await settle(t, mod.id, id, 'classConflicts');
    expect((await bodyOf(t, 'osm/A')).reviewSettled?.[0]?.evidence).toBe(UNRECORDED_EVIDENCE);
    // An older loader's record (no claims again): still unrecorded, held.
    expect(await load(t, [{ ...BOTH, classClaims: undefined }])).toMatchObject({ settledHeld: 1 });
    // The first campaign carrying the claims asks it again…
    expect(await load(t, [BOTH])).toMatchObject({ raisedAgain: 1 });
    await settle(t, mod.id, id, 'classConflicts');
    // …and once settled on them, the same claims hold.
    expect(await load(t, [BOTH])).toMatchObject({ settledHeld: 1, raisedAgain: 0 });
    await expectCountsTally(t);
  });

  test('an older loader that sends no class claims is held to the stored ones', async () => {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    await load(t, [BOTH]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    await settle(t, mod.id, id, 'classConflicts');
    expect(await load(t, [{ ...BOTH, classClaims: undefined }])).toMatchObject({
      settledHeld: 1,
      raisedAgain: 0,
    });
    expect((await bodyOf(t, 'osm/A')).classClaims).toEqual(CLASSES);
  });

  test('a settle whose reason the record no longer raises is kept for a later campaign', async () => {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    await load(t, [BOTH]);
    const id = (await bodyOf(t, 'osm/A'))._id;
    await settle(t, mod.id, id, 'classConflicts');
    await load(t, [{ ...BOTH, reviewReasons: ['name-conflict'] }]);
    expect((await bodyOf(t, 'osm/A')).reviewSettled).toHaveLength(1);
    expect(await load(t, [{ ...BOTH, reviewReasons: undefined }])).toMatchObject({
      settledHeld: 0,
    });
    expect((await bodyOf(t, 'osm/A')).reviewSettled).toHaveLength(1);
    expect(await load(t, [BOTH])).toMatchObject({ settledHeld: 1 });
  });

  test('one batch moves each count row once, however many bodies it files', async () => {
    const t = harness();
    const recs = Array.from({ length: 5 }, (_, i) => ({
      ...BOTH,
      externalId: `osm/B${i}`,
      x: i * 2,
    }));
    await load(t, recs);
    const counts = await t.run((ctx) => ctx.db.query('corpusTaskCounts').collect());
    expect(Object.fromEntries(counts.map((c) => [c.key, c.count]))).toEqual({
      'open:nameConflicts': 5,
      'open:nameConflicts:different': 5,
      'open:classConflicts': 5,
      'open:classConflicts:wetlandOrLake': 5,
    });
    // One row per key: a batch that wrote per task would still tally, but a row per move would not.
    expect(counts).toHaveLength(4);
  });
});

describe('the body’s other writers', () => {
  async function two() {
    const t = harness();
    const mod = await person(t, 'user_m', 'moderator');
    const admin = await person(t, 'user_a', 'admin');
    await load(t, [BOTH, { ...BOTH, externalId: 'osm/L', x: 3 }]);
    const survivor = (await bodyOf(t, 'osm/A'))._id;
    const loser = (await bodyOf(t, 'osm/L'))._id;
    return { t, mod, admin, survivor, loser };
  }

  test('the merge leaves the loser’s tasks merged; its unmerge files them again', async () => {
    const { t, mod, survivor, loser } = await two();
    const merged = await mod.as.mutation(api.waterBodies.merge, {
      survivorId: survivor,
      loserId: loser,
    });
    for (const task of await tasksOf(t, loser)) {
      expect(task).toMatchObject({ status: 'left', leftBecause: 'merged' });
    }
    expect(await openOf(t, survivor)).toHaveLength(2);
    await expectCountsTally(t);
    vi.useFakeTimers();
    await mod.as.mutation(api.undo.run, { actionId: merged.actionId, reason: 'Not the same lake' });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await openOf(t, loser)).map((x) => x.lane).sort()).toEqual([
      'classConflicts',
      'nameConflicts',
    ]);
    await expectCountsTally(t);
  });

  test('the remove leaves its tasks removed; the restore files them again', async () => {
    const { t, admin, loser } = await two();
    await admin.as.mutation(api.waterBodies.remove, { waterBodyId: loser, reason: 'junk' });
    for (const task of await tasksOf(t, loser)) {
      expect(task).toMatchObject({ status: 'left', leftBecause: 'removed' });
    }
    await expectCountsTally(t);
    await admin.as.mutation(api.waterBodies.restore, { waterBodyId: loser });
    expect(await openOf(t, loser)).toHaveLength(2);
    await expectCountsTally(t);
  });

  test('the incoming-merge resolution’s delete leaves the loser’s tasks deleted', async () => {
    const t = harness();
    await load(t, [BOTH]);
    // A second row on the same OSM id, as a reconciliation miss leaves one.
    await load(t, [{ ...BOTH, externalId: 'osm/L', osmId: 'osm/L', x: 3 }]);
    const loser = (await bodyOf(t, 'osm/L'))._id;
    await t.run((ctx) => ctx.db.patch(loser, { osmId: 'osm/A' }));
    const out = await t.mutation(internal.waterBodies.resolveIncomingMergeDuplicates, {
      records: [{ externalId: 'osm/A', osmId: 'osm/A' }],
      apply: true,
    });
    expect(out.deleted).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(loser))).toBeNull();
    for (const task of await tasksOf(t, loser)) {
      expect(task).toMatchObject({ status: 'left', leftBecause: 'deleted' });
    }
    await expectCountsTally(t);
  });

  test('the campaign duplicate resolution’s delete leaves the body’s tasks deleted', async () => {
    const { t, survivor, loser } = await two();
    await t.run(async (ctx) => {
      await ctx.db.patch(survivor, {
        dedupStatus: 'near_certain',
        duplicateCandidateIds: [loser],
        lastCampaignId: 'c2',
      });
      await ctx.db.patch(loser, {
        dedupStatus: 'near_certain',
        duplicateCandidateIds: [survivor],
        lastCampaignId: 'c1',
      });
    });
    const out = await t.mutation(internal.waterBodies.resolveCampaignDuplicates, {
      campaignId: 'c2',
      apply: true,
    });
    expect(out.deleted).toBe(1);
    for (const task of await tasksOf(t, loser)) {
      expect(task).toMatchObject({ status: 'left', leftBecause: 'deleted' });
    }
    expect(await openOf(t, survivor)).toHaveLength(2);
    await expectCountsTally(t);
  });
});
