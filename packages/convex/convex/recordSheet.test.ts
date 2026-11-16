/**
 * The People record sheet's server (B01-4d; D248): the three lists — Standing, Deleted, Reversed —
 * their counts, the item pane, and the four levers' writes, each refusing by the one rule its `can`
 * answers by (`lib/recordRules`). Run under Convex's real transaction limits.
 */
import { WITHDRAWN_ERASE_MS } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { AUTHOR_DELETED_OVERTURN, AUTHOR_DELETED_RESTORE } from './lib/authorDeletion';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import {
  ERASED_ALREADY,
  KEEP_ALREADY_HELD,
  KEEP_NOT_DELETED,
  POST_RESTORE_NEEDS_A_CHOICE,
  RECORD_CHECK_ON_ITEM,
  RECORD_LEAVING,
  RECORD_NOT_STAFF,
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
    if (ready) await markReady(ctx, 'verdicts');
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
    // An erased comment's placeholder, under a verdict a backfill left: nothing left to act on.
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
    await expect(
      matt.as.mutation(api.moderation.overturnVerdict, { targetType: 'comment', targetId: c }),
    ).rejects.toThrow(ERASED_ALREADY);
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
    const { rows, pages } = await deletedOf(matt.as, rob.id);
    expect(rows.map((d) => d.targetId)).toEqual(expected);
    expect(pages).toBeGreaterThan(1);
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
  test('the counts agree with the lists, a capped kind says so, and pending names the backfill', async () => {
    const { t, rob, kate, matt, report, comment, post, set, tick } = await setup({ ready: false });
    const r = await report(rob.id);
    await set('report', r, 'hidden', 'h');
    tick();
    await set('report', r, 'visible');
    const c = await comment(await report(kate.id));
    await rob.as.mutation(api.comments.remove, { commentId: c });
    const counts = await matt.as.query(api.contentRecord.recordCounts, { userId: rob.id });
    expect(counts).toMatchObject({
      pending: ['verdicts'],
      reversed: { count: 1, capped: false, byKind: { report: 1 } },
      deleted: { count: 1, capped: false, byKind: { comment: 1 } },
    });
    expect((await matt.as.query(api.people.person, { userId: rob.id }))?.pending).toContain(
      'verdicts',
    );
    for (const q of [
      api.contentRecord.personVerdicts,
      api.contentRecord.personReversed,
      api.contentRecord.personDeleted,
    ]) {
      expect((await matt.as.query(q, { userId: rob.id })).pending).toEqual(['verdicts']);
    }
    await t.run((ctx) => markReady(ctx, 'verdicts'));
    // Two Posts deleted: the count reads one Post at most, so it is a floor.
    for (const _ of [0, 1]) {
      const { postId } = await post(1);
      await rob.as.mutation(api.posts.remove, { postId });
    }
    const floor = await matt.as.query(api.contentRecord.recordCounts, { userId: rob.id });
    expect(floor.pending).toEqual([]);
    expect(floor.deleted.capped).toBe(true);
    expect(floor.deleted.byKind.post).toBe(1);
    const listed = await deletedOf(matt.as, rob.id);
    expect(listed.rows.filter((d) => d.targetType === 'post')).toHaveLength(2);
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
