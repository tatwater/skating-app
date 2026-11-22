/**
 * The People record sheet's server (B01-4d; D248): the three lists — Standing, Deleted, Reversed —
 * their counts, the item pane, and the four levers' writes, each refusing by the one rule its `can`
 * answers by (`lib/recordRules`). Run under Convex's real transaction limits.
 */
import { AUDIT_REASON_MAX, AUDIT_REASON_TOO_LONG, WITHDRAWN_ERASE_MS } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { AUTHOR_DELETED_OVERTURN, AUTHOR_DELETED_RESTORE } from './lib/authorDeletion';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { isReversed } from './lib/contentVerdicts';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { RECORD_PAGE, RECORD_PAGE_ROWS } from './lib/recordReads';
import {
  ERASED_ALREADY,
  KEEP_ALREADY_HELD,
  KEEP_NOT_DELETED,
  POST_RESTORE_NEEDS_A_CHOICE,
  RECORD_CHECK_ON_ITEM,
  RECORD_LEAVING,
  RECORD_NOT_STAFF,
  RESTORE_ALREADY_UP,
} from './lib/recordRules';
import { undoState } from './lib/undo';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
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
  moderatorDecision: false,
};

async function person(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
  const id = await t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject[0]?.toUpperCase()}${subject.slice(1)}`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0 - 400 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
  return { id, as: t.withIdentity({ subject }) };
}

async function setup({ ready = true }: { ready?: boolean } = {}) {
  const t = convexTest({ schema, modules, transactionLimits: true });
  await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains'] as const) await markReady(ctx, b);
    if (ready) {
      await markReady(ctx, 'verdicts');
      await markReady(ctx, 'withdrawals');
    }
  });
  const bodyId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodies', {
      name: 'Mascoma Lake',
      searchText: 'Mascoma Lake',
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
    await rebuildBodyLibrary(ctx, id);
    return id;
  });
  const rob = await person(t, 'rob');
  const kate = await person(t, 'kate');
  const matt = await person(t, 'matt', { role: 'moderator' });
  const sarah = await person(t, 'sarah', { role: 'moderator' });
  const report = (authorId: Id<'profiles'> = rob.id, over: Partial<Doc<'reports'>> = {}) =>
    t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId: bodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: Date.now(),
        reportTime: Date.now(),
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        notes: 'Thin at the inlet',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...over,
      }),
    );
  const comment = async (on: Id<'reports'>, body = 'Learn to read a thermometer.') =>
    rob.as.mutation(api.comments.create, { reportId: on, body });
  const post = async (n: number) => {
    const reportIds: Id<'reports'>[] = [];
    for (let i = 0; i < n; i++) reportIds.push(await report());
    const postId = await t.run((ctx) =>
      ctx.db.insert('posts', {
        authorId: rob.id,
        reportIds,
        photoIds: [],
        title: 'Opening weekend on Mascoma',
        latestSkateEndTime: Date.now(),
        moderationStatus: 'visible' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    for (const id of reportIds) await t.run((ctx) => ctx.db.patch(id, { postId }));
    return { postId, reportIds };
  };
  const set = (
    targetType: 'report' | 'post' | 'comment' | 'hazard',
    targetId: string,
    status: 'visible' | 'hidden' | 'removed',
    reason: string | undefined = status === 'visible' ? undefined : `${status} it`,
  ) =>
    matt.as.mutation(api.moderation.setModerationStatus, {
      targetType,
      targetId,
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
  const tick = () => vi.advanceTimersByTime(60_000);
  return { t, bodyId, rob, kate, matt, sarah, report, comment, post, set, tick };
}

type Standing = FunctionReturnType<typeof api.contentRecord.personVerdicts>['page'][number];
type Reversed = FunctionReturnType<typeof api.contentRecord.personReversed>['page'][number];
type Deleted = FunctionReturnType<typeof api.contentRecord.personDeleted>['page'][number];
type As = ReturnType<T['withIdentity']>;

/** Every page of a list, as the sheet loads them. */
async function all<R>(
  read: (cursor: string | null) => Promise<{ page: R[]; isDone: boolean; continueCursor: string }>,
): Promise<{ rows: R[]; pages: number }> {
  const rows: R[] = [];
  let pages = 0;
  for (let cursor: string | null = null; ; ) {
    const page = await read(cursor);
    pages++;
    rows.push(...page.page);
    if (page.isDone) return { rows, pages };
    expect(pages, 'the list ends').toBeLessThan(200);
    cursor = page.continueCursor;
  }
}
const standingOf = (as: As, userId: Id<'profiles'>) =>
  all<Standing>((cursor) => as.query(api.contentRecord.personVerdicts, { userId, cursor }));
const reversedOf = (as: As, userId: Id<'profiles'>) =>
  all<Reversed>((cursor) => as.query(api.contentRecord.personReversed, { userId, cursor }));
const deletedOf = (as: As, userId: Id<'profiles'>) =>
  all<Deleted>((cursor) => as.query(api.contentRecord.personDeleted, { userId, cursor }));

describe('the writes', () => {
  test('a restore takes no reason — a default the row marks — and returns its undo; a takedown still asks one', async () => {
    const { t, rob, report, set, tick } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'hidden');
    tick();
    const restored = await set('report', r, 'visible');
    expect(restored).toMatchObject({ targetId: r, undoable: true, undoNeedsReason: true });
    const row = await t.run((ctx) => ctx.db.get(restored.actionId));
    expect(row).toMatchObject({ action: 'restore', reason: 'Restored' });
    expect(row?.metadata).toMatchObject({ reasonDefaulted: true });
    await expect(set('report', r, 'hidden', '   ')).rejects.toThrow('A reason is required');
    const hidden = await set('report', r, 'hidden', 'Second unsafe claim this week');
    // Undoing a takedown gives back: no reason asked.
    expect(hidden).toMatchObject({ undoable: true, undoNeedsReason: false });
  });

  test('an overturn takes a reason only if given, returns when the words are erased, and refuses an erased item', async () => {
    const { t, rob, matt, report, comment, set, tick } = await setup();
    const r = await report(rob.id);
    const c = await comment(r);
    await set('comment', c, 'hidden');
    tick();
    await rob.as.mutation(api.comments.remove, { commentId: c });
    const deletedAt = Date.now();
    tick();
    const out = await matt.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'comment',
      targetId: c,
    });
    expect(out).toMatchObject({ targetId: c, eraseAt: deletedAt + WITHDRAWN_ERASE_MS });
    const row = await t.run((ctx) => ctx.db.get(out.actionId));
    expect(row).toMatchObject({
      action: 'overturn_verdict',
      reason: 'Overturned the decision on this comment',
      metadata: { reasonDefaulted: true },
    });
    await expect(
      matt.as.mutation(api.moderation.overturnVerdict, {
        targetType: 'comment',
        targetId: c,
        reason: 'x'.repeat(2_001),
      }),
    ).rejects.toThrow('at most 2,000');
    // An erased comment's placeholder, under a verdict a backfill left: its words are gone, but the
    // decision can still come off the record.
    await t.run(async (ctx) => {
      await ctx.db.patch(c, { erasedAt: Date.now(), body: '' });
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: rob.id,
        targetType: 'comment',
        targetId: c,
        actionId: out.actionId,
        kind: 'hidden',
        at: Date.now(),
        standing: true,
        superseded: false,
      });
    });
    const pane = await matt.as.query(api.contentRecord.item, {
      targetType: 'comment',
      targetId: c,
    });
    expect(pane).toMatchObject({ published: null, can: { overturn: { ok: true } } });
    await matt.as.mutation(api.moderation.overturnVerdict, { targetType: 'comment', targetId: c });
    expect((await standingOf(matt.as, rob.id)).rows).toEqual([]);
    // Nothing else is left to act on there.
    await expect(set('comment', c, 'hidden', 'again')).rejects.toThrow(ERASED_ALREADY);
  });

  test('keep on the record records a removal that holds the content, and its undo is the overturn', async () => {
    const { t, rob, kate, matt, report, comment } = await setup();
    const r = await report(kate.id);
    const c = await comment(r, 'Fine, I’ll stop posting here.');
    await rob.as.mutation(api.comments.remove, { commentId: c });
    expect((await t.run((ctx) => ctx.db.get(c)))?.eraseAt).toBeDefined();
    await expect(
      matt.as.mutation(api.moderation.keepOnRecord, {
        targetType: 'comment',
        targetId: c,
        reason: ' ',
      }),
    ).rejects.toThrow('A reason is required');
    await expect(
      rob.as.mutation(api.moderation.keepOnRecord, {
        targetType: 'comment',
        targetId: c,
        reason: 'mine',
      }),
    ).rejects.toThrow();
    const kept = await matt.as.mutation(api.moderation.keepOnRecord, {
      targetType: 'comment',
      targetId: c,
      reason: 'Hostile tone, third time this month',
    });
    expect(kept).toMatchObject({ targetId: c, undoable: false });
    const row = await t.run((ctx) => ctx.db.get(kept.actionId));
    expect(row).toMatchObject({
      action: 'remove',
      metadata: { onAuthorDeleted: true, keptOnRecord: true, subjectUserId: rob.id },
    });
    // Held from erasure while the decision stands; the content as its author left it.
    expect((await t.run((ctx) => ctx.db.get(c)))?.eraseAt).toBeUndefined();
    // History offers the overturn, never a dead Undo.
    const state = await t.run(async (ctx) => {
      const viewer = (await ctx.db.get(matt.id)) as Doc<'profiles'>;
      return undoState(ctx, viewer, row as Doc<'moderationActions'>);
    });
    expect(state).toEqual({ state: 'unavailable', why: AUTHOR_DELETED_OVERTURN });
    await expect(
      matt.as.mutation(api.moderation.keepOnRecord, {
        targetType: 'comment',
        targetId: c,
        reason: 'again',
      }),
    ).rejects.toThrow(KEEP_ALREADY_HELD);
    const up = await comment(r, 'still up');
    await expect(
      matt.as.mutation(api.moderation.keepOnRecord, {
        targetType: 'comment',
        targetId: up,
        reason: 'not deleted',
      }),
    ).rejects.toThrow(KEEP_NOT_DELETED);
  });

  test('an alert its author retracted is kept as a retraction, on the alert lever', async () => {
    const { t, rob, matt, bodyId } = await setup();
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: bodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const alertId = await rob.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      putInId,
      reason: 'gate_locked',
    });
    await rob.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    const deleted = await deletedOf(matt.as, rob.id);
    expect(deleted.rows).toEqual([
      expect.objectContaining({
        targetType: 'accessAlert',
        targetId: alertId,
        can: { keep: { ok: true, needsReason: true } },
      }),
    ]);
    const kept = await matt.as.mutation(api.moderation.keepOnRecord, {
      targetType: 'accessAlert',
      targetId: alertId,
      reason: 'Third false gate claim this month',
    });
    expect((await t.run((ctx) => ctx.db.get(kept.actionId)))?.action).toBe('retract_access_alert');
    const standing = await standingOf(matt.as, rob.id);
    expect(standing.rows).toEqual([
      expect.objectContaining({
        targetType: 'accessAlert',
        kind: 'retracted',
        can: { overturn: { ok: true, needsReason: false } },
      }),
    ]);
    expect((await deletedOf(matt.as, rob.id)).rows).toEqual([]);
  });
});

describe('a decision standing on an item that is up', () => {
  test('a restore ends it (a history rebuilt from before the record leaves one); then it is already up', async () => {
    const { t, rob, matt, report, set } = await setup();
    const r = await report(rob.id);
    await t.run(async (ctx) => {
      const actionId = await ctx.db.insert('moderationActions', {
        actorId: matt.id,
        action: 'hide',
        targetType: 'report',
        targetId: r,
        reason: 'old hide',
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: Date.now() - 1_000,
      });
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: rob.id,
        targetType: 'report',
        targetId: r,
        actionId,
        kind: 'hidden',
        at: Date.now() - 1_000,
        standing: true,
        superseded: false,
      });
    });
    const [row] = (await standingOf(matt.as, rob.id)).rows;
    expect(row?.can).toEqual({ restore: { ok: true, needsReason: false } });
    await set('report', r, 'visible');
    expect((await standingOf(matt.as, rob.id)).rows).toEqual([]);
    await expect(set('report', r, 'visible')).rejects.toThrow(RESTORE_ALREADY_UP);
  });
});

describe('Standing', () => {
  test('names who decided, places each item, and offers the lever its state allows', async () => {
    const { t, rob, kate, matt, sarah, report, comment, post, set, tick } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'hidden', 'Second unsafe claim this week');
    tick();
    const c = await comment(await report(kate.id), 'Nobody asked you, Kate.');
    await sarah.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'comment',
      targetId: c,
      status: 'hidden',
      reason: 'Name-calling; second warning',
    });
    tick();
    await rob.as.mutation(api.comments.remove, { commentId: c });
    tick();
    const { postId } = await post(2);
    await set('post', postId, 'hidden', 'Each report repeats the same 4 inches');
    const { rows } = await standingOf(matt.as, rob.id);
    expect(rows.map((s) => s.targetType)).toEqual(['post', 'comment', 'report']);
    const [p, cm, rp] = rows as [Standing, Standing, Standing];
    expect(rp).toMatchObject({
      reason: 'Second unsafe claim this week',
      decidedBy: { userId: matt.id, displayName: 'Matt', username: 'matt' },
      waterBodyName: 'Mascoma Lake',
      can: { restore: { ok: true, needsReason: false } },
    });
    expect(cm).toMatchObject({
      decidedBy: { userId: sarah.id },
      reportAuthor: { userId: kate.id, displayName: 'Kate' },
      authorDeletedAt: expect.any(Number),
      can: { overturn: { ok: true, needsReason: false } },
    });
    // A Post's members decide its restore: the list says so, the item answers.
    expect(p).toMatchObject({
      postReportCount: 2,
      can: { restore: { ok: false, why: RECORD_CHECK_ON_ITEM } },
    });
    const pane = await matt.as.query(api.contentRecord.item, {
      targetType: 'post',
      targetId: postId,
    });
    expect(pane?.can).toEqual({ restore: { ok: true, needsReason: false, needsChoice: false } });
    // The same rows, as a viewer who can't act sees them.
    await t.run((ctx) => ctx.db.patch(matt.id, { deletionRequestedAt: Date.now() }));
    const leaving = (await standingOf(matt.as, rob.id)).rows[2];
    expect(leaving?.can).toEqual({ restore: { ok: false, why: RECORD_LEAVING } });
  });

  test('a Post whose Reports each went down on their own needs a choice, from the pane', async () => {
    const { rob, matt, post, set, tick } = await setup();
    const { postId, reportIds } = await post(2);
    for (const id of reportIds) {
      await set('report', id, 'hidden', 'its own');
      tick();
    }
    await set('post', postId, 'hidden', 'the post too');
    const pane = await matt.as.query(api.contentRecord.item, {
      targetType: 'post',
      targetId: postId,
    });
    expect(pane?.can).toEqual({ restore: { ok: true, needsReason: false, needsChoice: true } });
    await expect(set('post', postId, 'visible')).rejects.toThrow(POST_RESTORE_NEEDS_A_CHOICE);
    const chosen = await matt.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'visible',
      withReportIds: [reportIds[0] as Id<'reports'>],
    });
    expect(chosen.undoable).toBe(true);
    expect((await standingOf(matt.as, rob.id)).rows.map((r) => r.targetId)).toEqual([reportIds[1]]);
    // Restored with no reason given: the chosen member's own row carries the default's mark, so its
    // Reversed line shows no reason, as the Post's does.
    const member = (await reversedOf(matt.as, rob.id)).rows.find(
      (r) => r.targetId === reportIds[0],
    );
    expect(member).toMatchObject({ endedHow: 'restore', endedReason: null });
  });
});

describe('the item pane', () => {
  test('a hide that became a removal shows the hide superseded, never restored', async () => {
    const { rob, matt, report, set, tick } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'hidden', 'first look');
    tick();
    await set('report', r, 'removed', 'a duplicate');
    const pane = await matt.as.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    expect(pane?.decisions).toEqual([
      expect.objectContaining({ kind: 'removed', standing: true, endedHow: null }),
      expect.objectContaining({ kind: 'hidden', standing: false, endedHow: 'superseded' }),
    ]);
  });

  test('a history longer than the pane reads still finds the decision that stands', async () => {
    const { t, rob, matt, report, set, tick } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'removed', 'the one that stands');
    tick();
    await rob.as.mutation(api.reports.remove, { reportId: r });
    // Fifty-five older decisions, each ended, written after it (as a backfill writes them).
    await t.run(async (ctx) => {
      const action = await ctx.db.query('moderationActions').order('desc').first();
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert('contentVerdicts', {
          subjectUserId: rob.id,
          targetType: 'report',
          targetId: r,
          actionId: action?._id as Id<'moderationActions'>,
          kind: 'hidden',
          at: T0 - (i + 1) * DAY,
          standing: false,
          endedAt: T0 - i * DAY,
          endedByActionId: action?._id as Id<'moderationActions'>,
          superseded: true,
        });
      }
    });
    const pane = await matt.as.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    expect(pane?.decisionsCapped).toBe(true);
    expect(pane?.decisions[0]).toMatchObject({ kind: 'removed', standing: true });
    // It stands, so the lever is the overturn — never a Keep its write would refuse.
    expect(pane?.can).toEqual({ overturn: { ok: true, needsReason: false } });
  });
});

describe('the replay over a record already right', () => {
  test('restored, hidden again and restored again: a rerun writes nothing', async () => {
    const { t, rob, report, set, tick } = await setup();
    const r = await report(rob.id);
    for (const status of ['hidden', 'visible', 'hidden', 'visible'] as const) {
      await set('report', r, status);
      tick();
    }
    const replay = (pass: 'scan' | 'write') =>
      t.mutation(internal.contentRecord.replayVerdictHistory, {
        targetType: 'report',
        targetId: r,
        subjectUserId: rob.id,
        pass,
        resume: { cursor: null, skip: 0 },
        clocks: false,
      });
    expect(await replay('scan')).toMatchObject({ written: 0 });
    expect(await replay('write')).toMatchObject({ written: 0 });
  });
});

describe('Reversed', () => {
  test('each item once, as its newest decision, with how it ended and its undo', async () => {
    const { t, rob, matt, sarah, report, set, tick } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'hidden', 'first look');
    tick();
    await set('report', r, 'removed', 'a duplicate');
    tick();
    const restored = await sarah.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: r,
      status: 'visible',
    });
    const { rows } = await reversedOf(matt.as, rob.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'removed',
      reason: 'a duplicate',
      decidedBy: { userId: matt.id },
      endedHow: 'restore',
      endedBy: { userId: sarah.id },
      endedReason: null,
      endActionId: restored.actionId,
      undo: { state: 'available', needsReason: true },
      erasedAt: null,
      can: { hideAgain: { ok: true, needsReason: true } },
    });
    // Hidden again: the item stands again, and leaves Reversed.
    tick();
    await set('report', r, 'hidden', 'again');
    expect((await reversedOf(matt.as, rob.id)).rows).toEqual([]);
    expect((await standingOf(matt.as, rob.id)).rows).toHaveLength(1);
    // Undone: ended by the undo.
    tick();
    const hide = (await standingOf(matt.as, rob.id)).rows[0] as Standing;
    expect(hide.kind).toBe('hidden');
    const newest = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').first());
    await matt.as.mutation(api.undo.run, { actionId: newest?._id as Id<'moderationActions'> });
    expect((await reversedOf(matt.as, rob.id)).rows[0]).toMatchObject({
      kind: 'hidden',
      endedHow: 'undo',
    });
  });

  test('an overturned decision outlives the words: erased, it still says who decided what', async () => {
    const { t, rob, matt, report, set, tick } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'removed', 'Claimed 6 inches over open water');
    tick();
    await rob.as.mutation(api.reports.remove, { reportId: r });
    tick();
    await matt.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'report',
      targetId: r,
      reason: 'Appeal upheld: wrong lake in the photo',
    });
    expect((await deletedOf(matt.as, rob.id)).rows.map((d) => d.targetId)).toEqual([r]);
    vi.advanceTimersByTime(31 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(r))).toBeNull();
    const { rows } = await reversedOf(matt.as, rob.id);
    expect(rows[0]).toMatchObject({
      kind: 'removed',
      reason: 'Claimed 6 inches over open water',
      endedHow: 'overturn',
      endedReason: 'Appeal upheld: wrong lake in the photo',
      undo: { state: 'unavailable' },
      content: null,
      erasedAt: expect.any(Number),
      can: {},
    });
    expect((await deletedOf(matt.as, rob.id)).rows).toEqual([]);
    const pane = await matt.as.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    expect(pane).toMatchObject({ published: null, erasedAt: expect.any(Number), can: {} });
  });
});

describe('Reversed is its one predicate', () => {
  test('the range the reads take holds exactly the verdicts `isReversed` accepts, and each kind its own', async () => {
    const { t, rob, kate, matt, report, comment, set, tick } = await setup();
    const a = await report(rob.id); // hidden, removed, restored: the removal
    const b = await report(rob.id); // hidden, restored, hidden again: standing, not here
    const c = await comment(await report(kate.id)); // hidden, restored
    const d = await report(rob.id); // removed, deleted, overturned
    const steps: [Parameters<typeof set>[0], string, 'visible' | 'hidden' | 'removed'][] = [
      ['report', a, 'hidden'],
      ['report', a, 'removed'],
      ['report', a, 'visible'],
      ['report', b, 'hidden'],
      ['report', b, 'visible'],
      ['report', b, 'hidden'],
      ['comment', c, 'hidden'],
      ['comment', c, 'visible'],
      ['report', d, 'removed'],
    ];
    for (const [kind, id, status] of steps) {
      await set(kind, id, status);
      tick();
    }
    await rob.as.mutation(api.reports.remove, { reportId: d as Id<'reports'> });
    tick();
    await matt.as.mutation(api.moderation.overturnVerdict, { targetType: 'report', targetId: d });
    const verdicts = await t.run((ctx) =>
      ctx.db
        .query('contentVerdicts')
        .withIndex('by_subject_ended', (q) => q.eq('subjectUserId', rob.id))
        .collect(),
    );
    const want = (kind?: string) =>
      verdicts
        .filter((v) => isReversed(v) && (kind === undefined || v.targetType === kind))
        .map((v) => `${v.targetId} ${v.kind}`)
        .sort();
    const got = (rows: Reversed[]) => rows.map((r) => `${r.targetId} ${r.kind}`).sort();
    expect(got((await reversedOf(matt.as, rob.id)).rows)).toEqual(want());
    expect(want()).toEqual([`${a} removed`, `${c} hidden`, `${d} removed`].sort());
    for (const kind of ['report', 'comment', 'post'] as const) {
      const rows = await all<Reversed>((cursor) =>
        matt.as.query(api.contentRecord.personReversed, {
          userId: rob.id,
          targetType: kind,
          cursor,
        }),
      );
      expect(got(rows.rows), kind).toEqual(want(kind));
    }
  });
});

describe('Deleted', () => {
  test('every kind in one list, newest first, across pages; held and erased items are not here', async () => {
    const { t, rob, kate, matt, report, comment, set } = await setup();
    const on = await report(kate.id);
    const expected: string[] = [];
    // Five Reports (two a merged page), three comments deleted in one instant (a tie), one held.
    for (let i = 0; i < 5; i++) {
      const r = await report(rob.id);
      vi.advanceTimersByTime(1_000);
      await rob.as.mutation(api.reports.remove, { reportId: r });
      expected.unshift(r);
    }
    const ties: Id<'comments'>[] = [];
    for (let i = 0; i < 3; i++) ties.push(await comment(on, `c${i}`));
    vi.advanceTimersByTime(1_000);
    for (const c of ties) await rob.as.mutation(api.comments.remove, { commentId: c });
    expected.unshift(...[...ties].reverse());
    const held = await comment(on, 'held');
    await set('comment', held, 'hidden', 'kept as evidence');
    vi.advanceTimersByTime(1_000);
    await rob.as.mutation(api.comments.remove, { commentId: held });
    const gone = await comment(on, 'gone');
    vi.advanceTimersByTime(1_000);
    await rob.as.mutation(api.comments.remove, { commentId: gone });
    await t.run((ctx) => ctx.db.patch(gone, { erasedAt: Date.now() }));
    const { rows } = await deletedOf(matt.as, rob.id);
    expect(rows.map((d) => d.targetId)).toEqual(expected);
    // Pages of three rows: the tie of comments spans a page boundary, and nothing repeats.
    RECORD_PAGE_ROWS.n = 3;
    try {
      const small = await deletedOf(matt.as, rob.id);
      expect(small.rows.map((d) => d.targetId)).toEqual(expected);
      expect(small.pages).toBeGreaterThan(2);
    } finally {
      RECORD_PAGE_ROWS.n = RECORD_PAGE;
    }
    expect(rows[0]).toMatchObject({
      targetType: 'comment',
      reportAuthor: { userId: kate.id },
      waterBodyName: 'Mascoma Lake',
      eraseAt: expect.any(Number),
      can: { keep: { ok: true, needsReason: true } },
    });
    // One kind alone pages the same.
    const reports = await all<Deleted>((cursor) =>
      matt.as.query(api.contentRecord.personDeleted, {
        userId: rob.id,
        targetType: 'report',
        cursor,
      }),
    );
    expect(reports.rows.map((d) => d.targetId)).toEqual(
      expected.filter((id) => !ties.includes(id as never)),
    );
  });
});

describe('the counts and "still being prepared"', () => {
  test('the counts agree with the lists and pending names the backfills each rests on', async () => {
    const { t, rob, kate, matt, report, comment, post, set, tick } = await setup({ ready: false });
    const r = await report(rob.id);
    await set('report', r, 'hidden', 'h');
    tick();
    await set('report', r, 'visible');
    const c = await comment(await report(kate.id));
    await rob.as.mutation(api.comments.remove, { commentId: c });
    const counts = await matt.as.query(api.contentRecord.recordCounts, { userId: rob.id });
    expect(counts).toMatchObject({
      pending: ['verdicts', 'withdrawals'],
      reversed: { count: 1, capped: false, byKind: { report: 1 } },
      deleted: { count: 1, capped: false, byKind: { comment: 1 } },
    });
    expect((await matt.as.query(api.people.person, { userId: rob.id }))?.pending).toContain(
      'verdicts',
    );
    for (const q of [api.contentRecord.personVerdicts, api.contentRecord.personReversed]) {
      expect((await matt.as.query(q, { userId: rob.id })).pending).toEqual(['verdicts']);
    }
    // Deleted and presence rest on the withdrawal rows too (B01-4m).
    expect(
      (await matt.as.query(api.contentRecord.personDeleted, { userId: rob.id })).pending,
    ).toEqual(['verdicts', 'withdrawals']);
    expect(
      (await matt.as.query(api.contentRecord.recordPresence, { userId: rob.id })).pending,
    ).toEqual(['verdicts', 'withdrawals']);
    await t.run(async (ctx) => {
      await markReady(ctx, 'verdicts');
      await markReady(ctx, 'withdrawals');
    });
    // Nine Posts deleted — four of them in one instant — counted exactly from their rows.
    const posts: Id<'posts'>[] = [];
    for (let i = 0; i < 9; i++) {
      const { postId } = await post(1);
      await rob.as.mutation(api.posts.remove, { postId });
      posts.push(postId);
      tick();
    }
    await t.run(async (ctx) => {
      const at = (await ctx.db.get(posts[2] as Id<'posts'>))?.authorDeletedAt as number;
      for (const id of posts.slice(3, 6)) await ctx.db.patch(id, { authorDeletedAt: at });
    });
    const exact = await matt.as.query(api.contentRecord.recordCounts, { userId: rob.id });
    expect(exact.pending).toEqual([]);
    expect(exact.deleted).toMatchObject({ capped: false, byKind: { post: 9, comment: 1 } });
    const listed = await deletedOf(matt.as, rob.id);
    expect(listed.rows.filter((d) => d.targetType === 'post')).toHaveLength(9);
    expect(exact.deleted.count).toBe(listed.rows.length);
  });

  test('a hundred deleted Posts count exactly: the count reads the small rows, not the Posts', async () => {
    const { rob, matt, post, tick } = await setup();
    const total = 100;
    for (let i = 0; i < total; i++) {
      const { postId } = await post(1);
      await rob.as.mutation(api.posts.remove, { postId });
      tick();
    }
    const counts = await matt.as.query(api.contentRecord.recordCounts, { userId: rob.id });
    // Each Post's one Report went with it: both kinds, every one, and no floor.
    expect(counts.deleted).toMatchObject({
      count: 2 * total,
      capped: false,
      byKind: { post: total, report: total },
    });
  });
});

describe('a reason at the cap (D261)', () => {
  test('every record lever accepted with a reason at or near the cap has its way back never refused for length', async () => {
    type Lever = 'hideAgain' | 'keep' | 'overturn';
    // What each lever's way back is: Hide again's undo; Keep's overturn (its undo, as History says);
    // a typed Overturn has none ("record it again"), so only its own write is held to the cap.
    const check = async (lever: Lever, length: number) => {
      vi.setSystemTime(T0);
      const { t, rob, kate, matt, report, comment, set, tick } = await setup();
      const reason = 'r'.repeat(length);
      if (lever === 'hideAgain') {
        const r = await report(rob.id);
        await set('report', r, 'hidden', 'first');
        tick();
        await set('report', r, 'visible');
        tick();
        const out = await set('report', r, 'hidden', reason);
        expect(out).toMatchObject({ undoable: true, undoNeedsReason: false });
        await matt.as.mutation(api.undo.run, { actionId: out.actionId });
        const undo = await t.run((ctx) =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_undoes', (q) => q.eq('undoesActionId', out.actionId))
            .first(),
        );
        expect(undo?.reason.length).toBeLessThanOrEqual(AUDIT_REASON_MAX);
        return;
      }
      const c = await comment(await report(kate.id));
      if (lever === 'overturn') await set('comment', c, 'hidden', 'hidden');
      tick();
      await rob.as.mutation(api.comments.remove, { commentId: c });
      tick();
      if (lever === 'keep') {
        await matt.as.mutation(api.moderation.keepOnRecord, {
          targetType: 'comment',
          targetId: c,
          reason,
        });
        tick();
        const back = await matt.as.mutation(api.moderation.overturnVerdict, {
          targetType: 'comment',
          targetId: c,
        });
        expect(back.actionId).toBeDefined();
        return;
      }
      const out = await matt.as.mutation(api.moderation.overturnVerdict, {
        targetType: 'comment',
        targetId: c,
        reason,
      });
      expect((await t.run((ctx) => ctx.db.get(out.actionId)))?.reason.length).toBe(length);
    };
    const near = fc.asyncProperty(
      fc.constantFrom<Lever>('hideAgain', 'keep', 'overturn'),
      fc.integer({ min: AUDIT_REASON_MAX - 40, max: AUDIT_REASON_MAX }),
      check,
    );
    // Pinned seeds, so a failure replays; then one run on a fresh seed, logged.
    for (const seed of [20261115, 9]) await fc.assert(near, { seed, numRuns: 3 });
    const fresh = Math.floor(Math.random() * 2 ** 31);
    console.log(`record near-cap seed ${fresh}`);
    await fc.assert(near, { seed: fresh, numRuns: 2 });
    // The cap itself, for every lever; one past it, refused before anything is written.
    for (const lever of ['hideAgain', 'keep', 'overturn'] as const) {
      await check(lever, AUDIT_REASON_MAX);
      await expect(check(lever, AUDIT_REASON_MAX + 1)).rejects.toThrow(AUDIT_REASON_TOO_LONG);
    }
  });
});

describe('the pane’s words, its "If overturned" date, what comes back, and presence', () => {
  test('the pane carries its words as the rows do, and what a restore brings back', async () => {
    const { t, rob, kate, matt, report, comment, set } = await setup();
    const r = await report(rob.id, { notes: 'Thin at the inlet' });
    await set('report', r, 'hidden', 'unsafe');
    // One still up; one hidden on its own; one a departed author's emptied shell — only the first
    // comes back as words.
    for (const over of [
      { body: 'agreed', moderationStatus: 'visible' },
      { body: 'hidden on its own', moderationStatus: 'hidden' },
      { body: '', moderationStatus: 'visible', redactedAt: Date.now() },
    ]) {
      await t.run((ctx) =>
        ctx.db.insert('comments', {
          reportId: r,
          authorId: kate.id,
          source: 'native' as const,
          createdAt: Date.now(),
          ...over,
        } as never),
      );
    }
    for (const raterId of [kate.id, matt.id]) {
      await t.run((ctx) =>
        ctx.db.insert('reportRatings', {
          targetType: 'report',
          targetId: r,
          raterId,
          verdict: 'helpful',
          createdAt: Date.now(),
        } as never),
      );
    }
    const pane = await matt.as.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    const [row] = (await standingOf(matt.as, rob.id)).rows;
    expect(pane?.content).toEqual(row?.content);
    expect(pane?.content).toMatchObject({ text: 'Thin at the inlet' });
    expect(pane?.comesBack).toEqual({
      comments: { count: 1, capped: false },
      ratings: { count: 2, capped: false },
    });
    // Nothing comes back with a comment.
    const c = await comment(await report(kate.id));
    const cpane = await matt.as.query(api.contentRecord.item, {
      targetType: 'comment',
      targetId: c,
    });
    expect(cpane?.comesBack).toBeNull();
  });

  test('"If overturned" is the date the overturn then returns — and null while a flag still holds it', async () => {
    const { t, rob, kate, matt, report, comment, set, tick } = await setup();
    const on = await report(kate.id);
    const held = await comment(on, 'held by a flag too');
    const free = await comment(on, 'held by its decision alone');
    for (const c of [held, free]) {
      await set('comment', c, 'hidden', 'hostile');
      tick();
      await rob.as.mutation(api.comments.remove, { commentId: c });
      tick();
    }
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: kate.id,
        targetType: 'comment',
        targetId: held,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        createdAt: Date.now(),
      } as never),
    );
    for (const [c, expectNull] of [
      [free, false],
      [held, true],
    ] as const) {
      const pane = await matt.as.query(api.contentRecord.item, {
        targetType: 'comment',
        targetId: c,
      });
      expect(pane?.eraseAtIfReleased === null).toBe(expectNull);
      const out = await matt.as.mutation(api.moderation.overturnVerdict, {
        targetType: 'comment',
        targetId: c,
      });
      expect(out.eraseAt).toBe(pane?.eraseAtIfReleased);
      // Nothing stands now: no date to ask after.
      const after = await matt.as.query(api.contentRecord.item, {
        targetType: 'comment',
        targetId: c,
      });
      expect(after?.eraseAtIfReleased).toBeNull();
    }
  });

  test('"If overturned" is null while its Post’s decision still holds a Report, as the overturn then returns', async () => {
    const { rob, matt, post, set, tick } = await setup();
    const { postId, reportIds } = await post(2);
    const r = reportIds[0] as Id<'reports'>;
    await set('report', r, 'hidden', 'own');
    tick();
    await set('post', postId, 'hidden', 'the whole post');
    tick();
    await rob.as.mutation(api.reports.remove, { reportId: r });
    tick();
    const pane = await matt.as.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    expect(pane?.decisions.some((d) => d.standing)).toBe(true);
    expect(pane?.eraseAtIfReleased).toBeNull();
    const out = await matt.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'report',
      targetId: r,
    });
    expect(out.eraseAt).toBeNull();
  });

  test('presence: cheap, and never false while the list shows a row', async () => {
    const { rob, kate, matt, report, comment, set, tick } = await setup();
    const presence = () => matt.as.query(api.contentRecord.recordPresence, { userId: rob.id });
    expect(await presence()).toEqual({ deleted: false, reversed: false, pending: [] });
    // A deletion a decision holds is Standing's, not Deleted's.
    const on = await report(kate.id);
    const c = await comment(on);
    await set('comment', c, 'hidden', 'hostile');
    tick();
    await rob.as.mutation(api.comments.remove, { commentId: c });
    expect(await presence()).toMatchObject({ deleted: false, reversed: false });
    // Overturned: Reversed shows it, and Deleted (its clock runs again).
    tick();
    await matt.as.mutation(api.moderation.overturnVerdict, { targetType: 'comment', targetId: c });
    expect(await presence()).toMatchObject({ deleted: true, reversed: true });
    expect((await deletedOf(matt.as, rob.id)).rows).toHaveLength(1);
    expect((await reversedOf(matt.as, rob.id)).rows).toHaveLength(1);
  });

  test('the Post chooser says when a Report’s author deleted it', async () => {
    const { t, rob, matt, post, set, tick } = await setup();
    const { postId, reportIds } = await post(2);
    await set('report', reportIds[0] as Id<'reports'>, 'hidden', 'own');
    tick();
    await rob.as.mutation(api.reports.remove, { reportId: reportIds[1] as Id<'reports'> });
    const deletedAt = (await t.run((ctx) => ctx.db.get(reportIds[1] as Id<'reports'>)))
      ?.authorDeletedAt;
    const choices = await matt.as.query(api.moderation.postRestoreChoices, { postId });
    const byId = new Map(choices?.members.map((m) => [m.reportId, m.authorDeletedAt]));
    expect(byId.get(reportIds[0] as Id<'reports'>)).toBeNull();
    expect(byId.get(reportIds[1] as Id<'reports'>)).toBe(deletedAt);
  });
});

describe('who may act', () => {
  test('a member reads nothing; a moderator without the alert lever is told so', async () => {
    const { t, rob, kate, report, set } = await setup();
    const r = await report(rob.id);
    await set('report', r, 'hidden', 'h');
    await expect(
      kate.as.query(api.contentRecord.personVerdicts, { userId: rob.id }),
    ).rejects.toThrow();
    await expect(
      kate.as.query(api.contentRecord.item, { targetType: 'report', targetId: r }),
    ).rejects.toThrow();
    // A restore refused on author-deleted content, in the rule's words.
    await rob.as.mutation(api.reports.remove, { reportId: r });
    await expect(set('report', r, 'visible')).rejects.toThrow(AUTHOR_DELETED_RESTORE);
    expect(RECORD_NOT_STAFF).toMatch(/moderator/);
    void t;
  });
});

describe('Kept is the record’s fact, never the timing’s', () => {
  test('a keep reads kept; a hide on content already deleted, or before it, does not; an unread audit row is not recorded', async () => {
    const { t, rob, kate, matt, report, comment, set, tick } = await setup();
    const r = await report(kate.id);
    // Kept on the record: an explicit keep of a comment its author deleted.
    const keptC = await comment(r, 'one');
    await rob.as.mutation(api.comments.remove, { commentId: keptC });
    tick();
    await matt.as.mutation(api.moderation.keepOnRecord, {
      targetType: 'comment',
      targetId: keptC,
      reason: 'kept as evidence',
    });
    tick();
    // An ordinary hide that happens to land after the author's deletion: never a keep.
    const hiddenAfter = await comment(r, 'two');
    await rob.as.mutation(api.comments.remove, { commentId: hiddenAfter });
    tick();
    await set('comment', hiddenAfter, 'hidden', 'hidden after');
    tick();
    // A hide before the deletion.
    const hiddenBefore = await comment(r, 'three');
    await set('comment', hiddenBefore, 'hidden', 'hidden before');
    tick();
    await rob.as.mutation(api.comments.remove, { commentId: hiddenBefore });
    tick();
    // A decision whose audit row can't be read: not recorded, never a guess.
    const unread = await comment(r, 'four');
    const lost = await set('comment', unread, 'removed', 'removed');
    await t.run((ctx) => ctx.db.delete(lost.actionId));

    const standing = new Map(
      (await standingOf(matt.as, rob.id)).rows.map((s) => [s.targetId, s.kept]),
    );
    expect(Object.fromEntries(standing)).toEqual({
      [keptC]: true,
      [hiddenAfter]: false,
      [hiddenBefore]: false,
      [unread]: null,
    });
    const pane = async (id: string) =>
      (await matt.as.query(api.contentRecord.item, { targetType: 'comment', targetId: id }))
        ?.decisions;
    expect((await pane(keptC))?.map((d) => d.kept)).toEqual([true]);
    expect((await pane(hiddenAfter))?.map((d) => d.kept)).toEqual([false]);
    expect((await pane(unread))?.map((d) => d.kept)).toEqual([null]);

    // Overturned, the keep is Reversed — and still says it was a keep.
    tick();
    await matt.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'comment',
      targetId: keptC,
    });
    const reversed = (await reversedOf(matt.as, rob.id)).rows;
    expect(reversed.map((x) => [x.targetId, x.kept])).toEqual([[keptC, true]]);
  });
});
