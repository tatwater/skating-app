/**
 * **Every content verb, by its two effects — on the content and on the person's record — and what its
 * undo restores** (B01-4h). A verb whose "before" state already equals its content effect can still
 * change the record: hiding what its Post's hide took down, with no decision of its own on it, puts a
 * decision on the person's record. Its undo takes that decision off and leaves the item as it was;
 * the undo is offered exactly when its write would land, and says so. One row per case: the content
 * before and after the verb, what it did to the record (`mints`, `ends`, `supersedes`, `none`,
 * `refused`), then the undo's state for the viewer and what the undo leaves.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { ALERT_ALREADY_PINNED } from './accessAlerts';
import { AUTHOR_DELETED_OVERTURN } from './lib/authorDeletion';
import { recordVerdict } from './lib/contentVerdicts';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { TAKEDOWN_ALREADY } from './lib/recordRules';
import { RESTORE_ENDED_ONLY, UNDO_HANDLERS } from './lib/undoHandlers';
import { UNDO_POLICY } from './lib/undoPolicy';
import { PREDATES } from './lib/undoTypes';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 16, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

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

type Kind = 'report' | 'post' | 'comment' | 'hazard';
type Status = 'visible' | 'hidden' | 'removed';

async function world() {
  const t = convexTest(schema, modules);
  const profile = (subject: string, role: 'member' | 'moderator') =>
    t.run(async (ctx) => {
      const id = await ctx.db.insert('profiles', {
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
        createdAt: T0 - 400 * 86_400_000,
      });
      await refreshPersonRow(ctx, id);
      return id;
    });
  const rob = await profile('rob', 'member');
  const matt = await profile('matt', 'moderator');
  await profile('sam', 'moderator');
  const ids = await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts'] as const) {
      await markReady(ctx, b);
    }
    const waterBodyId = await ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: T0,
    });
    const report = () =>
      ctx.db.insert('reports', {
        authorId: rob,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      });
    const r = await report();
    const m0 = await report();
    const m1 = await report();
    const p = await ctx.db.insert('posts', {
      authorId: rob,
      reportIds: [m0, m1],
      photoIds: [],
      latestSkateEndTime: T0,
      moderationStatus: 'visible',
      createdAt: T0,
      updatedAt: T0,
    });
    for (const id of [m0, m1]) await ctx.db.patch(id, { postId: p });
    await ctx.db.patch(rob, { reportCount: 3 });
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 0.5, lng: 0.5 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: T0,
    });
    return { r, m0, m1, p, putInId };
  });
  const mod = t.withIdentity({ subject: 'matt' });
  return {
    t,
    rob,
    matt,
    ...ids,
    mod,
    other: t.withIdentity({ subject: 'sam' }),
    author: t.withIdentity({ subject: 'rob' }),
  };
}
type W = Awaited<ReturnType<typeof world>>;

const set = (w: W, targetType: Kind, targetId: string, status: Status, reason?: string) =>
  w.mod.mutation(api.moderation.setModerationStatus, {
    targetType,
    targetId,
    status,
    ...(reason !== undefined ? { reason } : status !== 'visible' ? { reason: status } : {}),
  });

const statusOf = async (w: W, id: string) =>
  ((await w.t.run((ctx) => ctx.db.get(id as Id<'reports'>))) as Doc<'reports'> | null)
    ?.moderationStatus;

/** The decisions standing on an item, by kind (the writers keep at most one). */
const standingOn = (w: W, targetType: Kind, targetId: string) =>
  w.t.run(async (ctx) =>
    (
      await ctx.db
        .query('contentVerdicts')
        .withIndex('by_target_standing', (q) =>
          q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
        )
        .collect()
    ).map((v) => v.kind),
  );

const newestOn = (w: W, targetType: Kind | 'accessAlert', targetId: string) =>
  w.t.run(
    async (ctx) =>
      (await ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
        .order('desc')
        .first()) as Doc<'moderationActions'>,
  );

/** What a verb did to the record, read off the verdict rows its audit row minted and ended. */
async function recordEffect(w: W, actionId: Id<'moderationActions'> | null) {
  if (actionId === null) return 'refused';
  return w.t.run(async (ctx) => {
    const minted = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_action', (q) => q.eq('actionId', actionId))
      .first();
    const ended = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_ended_by', (q) => q.eq('endedByActionId', actionId))
      .first();
    if (minted && ended) return 'supersedes';
    if (minted) return 'mints';
    if (ended) return 'ends';
    return 'none';
  });
}

/** The undo state History shows the moderator for a row. */
async function undoStateOf(w: W, row: Doc<'moderationActions'>) {
  const rows = await w.mod.query(api.moderation.listActions, {
    targetType: row.targetType,
    targetId: row.targetId,
  });
  return rows.find((r) => r.id === row._id)?.undo;
}

/**
 * The record rebuilt from the audit log alone (the verdict backfill's replay) lands where the live
 * writers did — flag for flag, `superseded` included — so an undo that moved only the record replays.
 */
async function rebuildAgrees(w: W) {
  const snapshot = async () =>
    (await w.t.run((ctx) => ctx.db.query('contentVerdicts').collect()))
      .map(
        (v) =>
          `${v.actionId} ${v.kind} ${v.standing} ${v.endedByActionId ?? '-'} ${v.superseded ?? '-'}`,
      )
      .sort();
  const live = await snapshot();
  await w.t.run(async (ctx) => {
    for (const v of await ctx.db.query('contentVerdicts').collect()) await ctx.db.delete(v._id);
  });
  vi.useFakeTimers({ now: Date.now() });
  try {
    await w.t.mutation(internal.contentRecord.backfillVerdicts, { clocks: false });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
  } finally {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  }
  expect(await snapshot()).toEqual(live);
}

interface Case {
  name: string;
  /** The item and the state the verb finds, written through the real writes. */
  arrange: (w: W) => Promise<{ targetType: Kind; targetId: string }>;
  /** The verb; `null` when it is refused (and must write nothing). */
  act: (w: W, on: { targetType: Kind; targetId: string }) => Promise<unknown>;
  content: [Status, Status];
  record: 'mints' | 'ends' | 'supersedes' | 'none' | 'refused';
  /** Offered (and whether it asks a reason), or the sentence it is refused with. */
  undo: { needsReason: boolean } | { refused: string | RegExp } | null;
  /** What the undo leaves: the item's status and the decisions standing on it. */
  after?: { content: Status; standing: string[] };
  /** Anything else the case holds, after the undo. */
  holds?: (w: W) => Promise<void>;
}

const CASES: Case[] = [
  {
    name: 'hide · up, undecided',
    arrange: async (w) => ({ targetType: 'report', targetId: w.r }),
    act: (w, on) => set(w, on.targetType, on.targetId, 'hidden'),
    content: ['visible', 'hidden'],
    record: 'mints',
    undo: { needsReason: false },
    after: { content: 'visible', standing: [] },
  },
  {
    name: 'hide · down by its Post’s hide, undecided — the decision is new, the content is not',
    arrange: async (w) => {
      await set(w, 'post', w.p, 'hidden');
      return { targetType: 'report', targetId: w.m0 };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'hidden', 'its own call'),
    content: ['hidden', 'hidden'],
    record: 'mints',
    undo: { needsReason: false },
    // The member's own decision comes off; it stays hidden by the Post's, which still stands.
    after: { content: 'hidden', standing: [] },
    holds: async (w) => {
      expect(await standingOn(w, 'post', w.p)).toEqual(['hidden']);
      // Undone, it is Reversed — once, as its newest decision — like any undone hide.
      const page = await w.mod.query(api.contentRecord.personReversed, { userId: w.rob });
      expect(page.page.filter((r) => r.targetId === w.m0)).toMatchObject([{ endedHow: 'undo' }]);
    },
  },
  {
    name: 'hide · a Post down because its Reports are, undecided',
    arrange: async (w) => {
      await set(w, 'report', w.m0, 'hidden');
      await set(w, 'report', w.m1, 'hidden');
      return { targetType: 'post', targetId: w.p };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'hidden', 'the whole post'),
    content: ['hidden', 'hidden'],
    record: 'mints',
    undo: { needsReason: false },
    after: { content: 'hidden', standing: [] },
    // Put back down the way it was: a member restored later brings the Post back with it.
    holds: async (w) => {
      await set(w, 'report', w.m0, 'visible');
      expect(await statusOf(w, w.p)).toBe('visible');
    },
  },
  {
    name: 'hide · hidden, a hide of its own holds it — nothing would change',
    arrange: async (w) => {
      await set(w, 'report', w.r, 'hidden');
      return { targetType: 'report', targetId: w.r };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'hidden', 'again'),
    content: ['hidden', 'hidden'],
    record: 'refused',
    undo: null,
  },
  {
    name: 'remove · down by its Post’s removal, undecided',
    arrange: async (w) => {
      await set(w, 'post', w.p, 'removed');
      return { targetType: 'report', targetId: w.m1 };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'removed', 'its own call'),
    content: ['removed', 'removed'],
    record: 'mints',
    undo: { needsReason: false },
    after: { content: 'removed', standing: [] },
  },
  {
    name: 'hide · removed, a removal holds it — the content and the decision move',
    arrange: async (w) => {
      await set(w, 'report', w.r, 'removed');
      return { targetType: 'report', targetId: w.r };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'hidden', 'softer'),
    content: ['removed', 'hidden'],
    record: 'supersedes',
    undo: { needsReason: true },
    after: { content: 'removed', standing: ['removed'] },
  },
  {
    name: 'hide · content its author deleted, undecided — kept as evidence; the overturn reverses it',
    arrange: async (w) => {
      await w.author.mutation(api.reports.remove, { reportId: w.r });
      return { targetType: 'report', targetId: w.r };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'hidden', 'evidence'),
    content: ['removed', 'removed'],
    record: 'mints',
    undo: { refused: AUTHOR_DELETED_OVERTURN },
  },
  {
    name: 'keep on the record · content its author deleted',
    arrange: async (w) => {
      await w.author.mutation(api.reports.remove, { reportId: w.r });
      return { targetType: 'report', targetId: w.r };
    },
    act: (w, on) =>
      w.mod.mutation(api.moderation.keepOnRecord, { ...on, reason: 'kept as evidence' }),
    content: ['removed', 'removed'],
    record: 'mints',
    undo: { refused: AUTHOR_DELETED_OVERTURN },
  },
  {
    name: 'overturn · a decision on content its author deleted since',
    arrange: async (w) => {
      await set(w, 'report', w.r, 'hidden');
      await w.author.mutation(api.reports.remove, { reportId: w.r });
      return { targetType: 'report', targetId: w.r };
    },
    act: (w, on) => w.mod.mutation(api.moderation.overturnVerdict, on),
    content: ['removed', 'removed'],
    record: 'ends',
    undo: {
      refused: (UNDO_POLICY.overturn_verdict.undo as { why: string }).why,
    },
  },
  {
    name: 'restore · up, with a decision still standing (a history from before the record)',
    arrange: async (w) => {
      await w.t.run(async (ctx) => {
        const actionId = await ctx.db.insert('moderationActions', {
          actorId: w.matt,
          action: 'hide',
          targetType: 'report',
          targetId: w.r,
          reason: 'long ago',
          metadata: { priorStatus: 'visible', newStatus: 'hidden' },
          createdAt: T0 - 1_000,
        });
        await recordVerdict(ctx, {
          subjectUserId: w.rob,
          targetType: 'report',
          targetId: w.r,
          actionId,
          kind: 'hidden',
          at: T0 - 1_000,
        });
      });
      return { targetType: 'report', targetId: w.r };
    },
    act: (w, on) => set(w, on.targetType, on.targetId, 'visible'),
    content: ['visible', 'visible'],
    record: 'ends',
    undo: { refused: RESTORE_ENDED_ONLY },
  },
];

describe('a content verb’s two effects, and what its undo restores', () => {
  test.each(CASES.map((c): [string, Case] => [c.name, c]))('%s', async (_, c) => {
    const w = await world();
    const on = await c.arrange(w);
    vi.setSystemTime(T0 + 60_000);
    const before = await newestOn(w, on.targetType, on.targetId);
    expect(await statusOf(w, on.targetId)).toBe(c.content[0]);
    const landed = await c.act(w, on).then(
      () => true,
      (e: Error) => {
        if (c.record !== 'refused') throw e;
        expect(e.message).toContain(TAKEDOWN_ALREADY.hidden);
        return false;
      },
    );
    const row = await newestOn(w, on.targetType, on.targetId);
    expect(row?._id === before?._id, 'a refused verb writes no row').toBe(!landed);
    expect(await statusOf(w, on.targetId)).toBe(c.content[1]);
    expect(await recordEffect(w, landed ? row._id : null)).toBe(c.record);
    if (!landed || c.undo === null) return;

    const state = await undoStateOf(w, row);
    if ('refused' in c.undo) {
      expect(state).toMatchObject({ state: 'unavailable' });
      expect((state as { why: string }).why).toMatch(c.undo.refused);
      // The write refuses in the same words: never offered, never landed.
      await expect(w.mod.mutation(api.undo.run, { actionId: row._id })).rejects.toThrow(
        (state as { why: string }).why,
      );
      return;
    }
    expect(state).toEqual({ state: 'available', needsReason: c.undo.needsReason });
    await w.mod.mutation(api.undo.run, {
      actionId: row._id,
      ...(c.undo.needsReason ? { reason: 'put it back' } : {}),
    });
    expect(await statusOf(w, on.targetId)).toBe(c.after?.content);
    expect(await standingOn(w, on.targetType, on.targetId)).toEqual(c.after?.standing);
    await c.holds?.(w);
    await rebuildAgrees(w);
  });
});

describe('an undo that only moved the record', () => {
  test.each([
    ['its undo', 'undo'],
    ['its restore', 'restore'],
  ] as const)('a Report put back under its Post comes back with the Post — %s', async (_, how) => {
    const w = await world();
    await set(w, 'post', w.p, 'hidden');
    const postHide = await newestOn(w, 'post', w.p);
    // The member's own decision, taken off again: it is the Post's again, as it was.
    await set(w, 'report', w.m0, 'hidden', 'its own call');
    await w.mod.mutation(api.undo.run, { actionId: (await newestOn(w, 'report', w.m0))._id });
    // …and a second round, a redo between: still the Post's.
    await w.mod.mutation(api.undo.run, {
      actionId: (await newestOn(w, 'report', w.m0))._id,
      reason: 'it was right',
    });
    await w.mod.mutation(api.undo.run, { actionId: (await newestOn(w, 'report', w.m0))._id });
    if (how === 'undo') await w.mod.mutation(api.undo.run, { actionId: postHide._id });
    else await set(w, 'post', w.p, 'visible');
    expect(await statusOf(w, w.p)).toBe('visible');
    expect(await statusOf(w, w.m0)).toBe('visible');
    expect(await statusOf(w, w.m1)).toBe('visible');
    await rebuildAgrees(w);
  });

  test('a Report hidden on its own call again stays down when its Post comes back', async () => {
    const w = await world();
    await set(w, 'post', w.p, 'hidden');
    const postHide = await newestOn(w, 'post', w.p);
    await set(w, 'report', w.m0, 'hidden', 'its own call');
    await w.mod.mutation(api.undo.run, { actionId: postHide._id });
    expect(await statusOf(w, w.m0)).toBe('hidden');
    expect(await standingOn(w, 'report', w.m0)).toEqual(['hidden']);
  });

  test('its redo puts the decision back — a takeaway, so it asks a reason — and the chain goes on', async () => {
    const w = await world();
    await set(w, 'post', w.p, 'hidden');
    await set(w, 'report', w.m0, 'hidden', 'its own call');
    const hide = await newestOn(w, 'report', w.m0);
    await w.mod.mutation(api.undo.run, { actionId: hide._id });
    const undo = await newestOn(w, 'report', w.m0);
    expect(undo.metadata).toMatchObject({ priorStatus: 'hidden', newStatus: 'hidden' });
    expect(await recordEffect(w, undo._id)).toBe('ends');
    expect(await undoStateOf(w, undo)).toEqual({ state: 'available', needsReason: true });
    await w.mod.mutation(api.undo.run, { actionId: undo._id, reason: 'it was right' });
    const redo = await newestOn(w, 'report', w.m0);
    expect(await recordEffect(w, redo._id)).toBe('mints');
    expect(await standingOn(w, 'report', w.m0)).toEqual(['hidden']);
    expect(await statusOf(w, w.m0)).toBe('hidden');
    // …and its undo takes the decision off again.
    expect(await undoStateOf(w, redo)).toEqual({ state: 'available', needsReason: false });
    await w.mod.mutation(api.undo.run, { actionId: redo._id });
    expect(await standingOn(w, 'report', w.m0)).toEqual([]);
    await rebuildAgrees(w);
  });

  test('a repeat from before D270 — a decision replaced by one of the same kind — has nothing to undo', async () => {
    const w = await world();
    await set(w, 'report', w.r, 'hidden', 'first');
    vi.setSystemTime(T0 + 1_000);
    // Written the way the writer wrote a repeat then: a row, and a verdict superseding the first.
    const repeat = await w.t.run(async (ctx) => {
      const actionId = await ctx.db.insert('moderationActions', {
        actorId: w.matt,
        action: 'hide',
        targetType: 'report',
        targetId: w.r,
        reason: 'again',
        metadata: { priorStatus: 'hidden', newStatus: 'hidden' },
        createdAt: T0 + 1_000,
      });
      await recordVerdict(ctx, {
        subjectUserId: w.rob,
        targetType: 'report',
        targetId: w.r,
        actionId,
        kind: 'hidden',
        at: T0 + 1_000,
      });
      return (await ctx.db.get(actionId)) as Doc<'moderationActions'>;
    });
    expect(await recordEffect(w, repeat._id)).toBe('supersedes');
    expect(await undoStateOf(w, repeat)).toEqual({
      state: 'unavailable',
      why: 'Nothing changed: it was already hidden.',
    });
  });

  test('a row that moved neither the content nor the record has nothing to undo', async () => {
    const w = await world();
    await set(w, 'report', w.r, 'hidden', 'first');
    vi.setSystemTime(T0 + 1_000);
    const id = await w.t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: w.matt,
        action: 'hide',
        targetType: 'report',
        targetId: w.r,
        reason: 'again',
        metadata: { priorStatus: 'hidden', newStatus: 'hidden' },
        createdAt: T0 + 1_000,
      }),
    );
    const row = (await w.t.run((ctx) => ctx.db.get(id))) as Doc<'moderationActions'>;
    expect(await recordEffect(w, id)).toBe('none');
    expect(await undoStateOf(w, row)).toMatchObject({ state: 'unavailable' });
    await expect(w.mod.mutation(api.undo.run, { actionId: id })).rejects.toThrow(/already hidden/);
    // The first hide's decision still stands: the undo never reached it.
    expect(await standingOn(w, 'report', w.r)).toEqual(['hidden']);
  });

  test('a Post’s row from before it listed its members can’t say it moved none, so it is not undone', async () => {
    const w = await world();
    await set(w, 'post', w.p, 'hidden');
    vi.setSystemTime(T0 + 1_000);
    // A hide of the hidden Post written before `cascaded` was recorded: it may have taken a Report
    // down (one restored on its own since), which an undo on the record alone would leave down.
    const id = await w.t.run(async (ctx) => {
      const actionId = await ctx.db.insert('moderationActions', {
        actorId: w.matt,
        action: 'hide',
        targetType: 'post',
        targetId: w.p,
        reason: 'again',
        metadata: { priorStatus: 'hidden', newStatus: 'hidden' },
        createdAt: T0 + 1_000,
      });
      await recordVerdict(ctx, {
        subjectUserId: w.rob,
        targetType: 'post',
        targetId: w.p,
        actionId,
        kind: 'hidden',
        at: T0 + 1_000,
      });
      return actionId;
    });
    const row = (await w.t.run((ctx) => ctx.db.get(id))) as Doc<'moderationActions'>;
    expect(await undoStateOf(w, row)).toEqual({ state: 'unavailable', why: PREDATES });
    await expect(w.mod.mutation(api.undo.run, { actionId: id })).rejects.toThrow(PREDATES);
  });

  test('History never queues a check for a row with nothing to check', async () => {
    const w = await world();
    // A hide that moved the content: its undo reads nothing, so it costs the page nothing.
    await set(w, 'report', w.r, 'hidden');
    const hide = await newestOn(w, 'report', w.r);
    expect(UNDO_HANDLERS.hide?.refusalCost?.('list', hide)).toBeNull();
    expect(await undoStateOf(w, hide)).toEqual({ state: 'available', needsReason: false });
    // One that left the item as it found it reserves the record's two reads.
    await set(w, 'post', w.p, 'hidden');
    await set(w, 'report', w.m0, 'hidden', 'its own call');
    const recordOnly = await newestOn(w, 'report', w.m0);
    expect(UNDO_HANDLERS.hide?.refusalCost?.('list', recordOnly)).toMatchObject({ reads: 2 });
  });
});

describe('an access alert’s pin moves the alert, never the record', () => {
  async function alert(w: W) {
    return w.author.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      putInId: w.putInId,
      reason: 'gate_locked',
    });
  }

  test('pin · a live alert: pinned, nothing on the record; its undo releases it', async () => {
    const w = await world();
    const id = await alert(w);
    await w.mod.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: id,
      official: true,
      reason: 'confirmed',
    });
    const pin = await newestOn(w, 'accessAlert', id);
    expect(await recordEffect(w, pin._id)).toBe('none');
    expect((await w.t.run((ctx) => ctx.db.get(id)))?.status).toBe('official');
    await w.mod.mutation(api.undo.run, { actionId: pin._id });
    expect((await w.t.run((ctx) => ctx.db.get(id)))?.status).not.toBe('official');
  });

  test('pin · already pinned: refused, nothing written (a row from before says so)', async () => {
    const w = await world();
    const id = await alert(w);
    const pin = () =>
      w.mod.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: id,
        official: true,
        reason: 'x',
      });
    await pin();
    const first = await newestOn(w, 'accessAlert', id);
    await expect(pin()).rejects.toThrow(ALERT_ALREADY_PINNED);
    expect((await newestOn(w, 'accessAlert', id))._id).toBe(first._id);
  });
});
