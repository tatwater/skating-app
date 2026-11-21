/**
 * **The record sheet's lists, held to their rules over any history** (B01-4d). For any sequence of
 * hide, remove, restore, undo, overturn, the author's deletion, keep and erasure on a person's items,
 * every item appears in exactly the lists the rules say — Standing: a decision stands on it; Reversed:
 * its newest decision was ended (read here from the raw verdict rows' order, never from the stored
 * flag the lists read); Deleted: they took it back, it isn't erased, and no decision holds it — at
 * most once per list; the counts agree with the pages; a list row's `can` is the item pane's; and a
 * lever offered is a write that succeeds, a lever refused a write that fails (`act`, interleaved).
 *
 * Pinned seeds, plus one random seed, logged.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import type { RecordAction, RecordLevers } from './lib/recordRules';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12);

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

type Kind = 'report' | 'comment' | 'hazard';
interface Item {
  kind: Kind;
  id: string;
}

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
        createdAt: T0 - 400 * DAY,
      });
      await refreshPersonRow(ctx, id);
      return id;
    });
  const rob = await profile('rob', 'member');
  const kate = await profile('kate', 'member');
  await profile('matt', 'moderator');
  const items = await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts', 'withdrawals'] as const) {
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
    const report = (authorId: Id<'profiles'>) =>
      ctx.db.insert('reports', {
        authorId,
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
    const r0 = await report(rob);
    const r1 = await report(rob);
    const on = await report(kate);
    const c0 = await ctx.db.insert('comments', {
      reportId: on,
      authorId: rob,
      body: 'Learn to read a thermometer.',
      moderationStatus: 'visible' as const,
      source: 'native' as const,
      createdAt: T0,
    } as never);
    const h0 = await ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
      createdByUserId: rob,
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: T0,
      lastConfirmedAt: T0,
      confirmCount: 0,
      goneCount: 0,
      createdAt: T0,
    });
    return [
      { kind: 'report', id: r0 },
      { kind: 'report', id: r1 },
      { kind: 'comment', id: c0 },
      { kind: 'hazard', id: h0 },
    ] as Item[];
  });
  return {
    t,
    rob,
    items,
    mod: t.withIdentity({ subject: 'matt' }),
    author: t.withIdentity({ subject: 'rob' }),
  };
}

type W = Awaited<ReturnType<typeof world>>;

type Op =
  | { op: 'hide' | 'remove' | 'restore' | 'overturn' | 'delete' | 'keep' | 'act'; i: number }
  | { op: 'undo' }
  | { op: 'erase' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      op: fc.constantFrom(
        'hide' as const,
        'remove' as const,
        'restore' as const,
        'overturn' as const,
        'delete' as const,
        'keep' as const,
        'act' as const,
      ),
      i: fc.integer({ min: 0, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant<Op>({ op: 'undo' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ op: 'erase' }) },
);

/** Run a write the history may ask for even where it is refused: the refusal is the history's. */
async function attempt(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

/** The write a lever runs, as the sheet calls it. */
function lever(w: W, item: Item, action: RecordAction): Promise<unknown> {
  const target = { targetType: item.kind, targetId: item.id };
  switch (action) {
    case 'restore':
      return w.mod.mutation(api.moderation.setModerationStatus, { ...target, status: 'visible' });
    case 'hideAgain':
      return w.mod.mutation(api.moderation.setModerationStatus, {
        ...target,
        status: 'hidden',
        reason: 'again',
      });
    case 'overturn':
      return w.mod.mutation(api.moderation.overturnVerdict, target);
    case 'keep':
      return w.mod.mutation(api.moderation.keepOnRecord, { ...target, reason: 'kept' });
  }
}

async function step(w: W, op: Op): Promise<void> {
  vi.advanceTimersByTime(1_000);
  if (op.op === 'erase') {
    vi.advanceTimersByTime(31 * DAY);
    await w.t.mutation(internal.erasure.eraseDue, {});
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    return;
  }
  if (op.op === 'undo') {
    const newest = await w.t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .order('desc')
        .collect()
        .then((rows) => rows.find((r) => r.actorId !== undefined && r.action !== 'author_delete')),
    );
    if (newest) await attempt(w.mod.mutation(api.undo.run, { actionId: newest._id }));
    return;
  }
  const item = w.items[op.i] as Item;
  const target = { targetType: item.kind, targetId: item.id };
  switch (op.op) {
    case 'hide':
    case 'remove':
      await attempt(
        w.mod.mutation(api.moderation.setModerationStatus, {
          ...target,
          status: op.op === 'hide' ? 'hidden' : 'removed',
          reason: op.op,
        }),
      );
      return;
    case 'restore':
      await attempt(lever(w, item, 'restore'));
      return;
    case 'overturn':
      await attempt(lever(w, item, 'overturn'));
      return;
    case 'keep':
      await attempt(lever(w, item, 'keep'));
      return;
    case 'delete':
      await attempt(
        item.kind === 'report'
          ? w.author.mutation(api.reports.remove, { reportId: item.id as Id<'reports'> })
          : item.kind === 'comment'
            ? w.author.mutation(api.comments.remove, { commentId: item.id as Id<'comments'> })
            : w.author.mutation(api.hazardWithdrawal.withdraw, {
                hazardId: item.id as Id<'hazards'>,
              }),
      );
      return;
    case 'act': {
      // A lever the pane offers succeeds; one it refuses fails.
      const pane = await w.mod.query(api.contentRecord.item, target);
      if (pane === null) return;
      for (const [action, can] of Object.entries(pane.can as RecordLevers)) {
        const done = await attempt(lever(w, item, action as RecordAction));
        expect(
          { item: item.kind, action, can, done },
          'a lever offered succeeds; refused, it fails',
        ).toMatchObject({ done: can?.ok === true });
      }
      return;
    }
  }
}

async function every<R>(
  read: (cursor: string | null) => Promise<{ page: R[]; isDone: boolean; continueCursor: string }>,
): Promise<R[]> {
  const rows: R[] = [];
  for (let cursor: string | null = null, n = 0; ; n++) {
    expect(n).toBeLessThan(50);
    const page = await read(cursor);
    rows.push(...page.page);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

/** What the rules say each list holds, from the raw rows. */
async function expected(w: W) {
  return w.t.run(async (ctx) => {
    const verdicts = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_subject_ended', (q) => q.eq('subjectUserId', w.rob))
      .collect();
    const byTarget = new Map<string, Doc<'contentVerdicts'>[]>();
    for (const v of verdicts) byTarget.set(v.targetId, [...(byTarget.get(v.targetId) ?? []), v]);
    const standing: string[] = [];
    const reversed: string[] = [];
    for (const [id, vs] of byTarget) {
      if (vs.some((v) => v.standing)) standing.push(id);
      const newest = [...vs].sort((a, b) => b.at - a.at || b._creationTime - a._creationTime)[0];
      if (newest && !newest.standing) reversed.push(id);
    }
    const deleted: string[] = [];
    for (const item of w.items) {
      const doc = (await ctx.db.get(item.id as Id<'reports'>)) as
        | (Doc<'reports'> & { erasedAt?: number })
        | null;
      if (!doc || doc.authorDeletedAt === undefined || doc.erasedAt !== undefined) continue;
      if (!standing.includes(item.id)) deleted.push(item.id);
    }
    return { standing: standing.sort(), reversed: reversed.sort(), deleted: deleted.sort() };
  });
}

async function holds(w: W) {
  const want = await expected(w);
  const userId = w.rob;
  const standing = await every((cursor) =>
    w.mod.query(api.contentRecord.personVerdicts, { userId, cursor }),
  );
  const reversed = await every((cursor) =>
    w.mod.query(api.contentRecord.personReversed, { userId, cursor }),
  );
  const deleted = await every((cursor) =>
    w.mod.query(api.contentRecord.personDeleted, { userId, cursor }),
  );
  const ids = (rows: { targetId: string }[]) => rows.map((r) => r.targetId).sort();
  expect({
    standing: ids(standing),
    reversed: ids(reversed),
    deleted: ids(deleted),
  }).toEqual(want);
  // Presence is never false while its list shows a row (true over an empty list is allowed).
  const presence = await w.mod.query(api.contentRecord.recordPresence, { userId });
  if (deleted.length > 0) expect(presence.deleted, 'presence: deleted').toBe(true);
  if (reversed.length > 0) expect(presence.reversed, 'presence: reversed').toBe(true);
  const counts = await w.mod.query(api.contentRecord.recordCounts, { userId });
  expect(counts.reversed).toMatchObject({ count: reversed.length, capped: false });
  expect(counts.deleted).toMatchObject({ count: deleted.length, capped: false });
  const person = await w.mod.query(api.people.person, { userId });
  expect(person?.hidden.total).toBe(standing.length);
  // One rule, one answer: a list row's levers are the pane's.
  for (const row of [...standing, ...reversed, ...deleted]) {
    const pane = await w.mod.query(api.contentRecord.item, {
      targetType: row.targetType,
      targetId: row.targetId,
    });
    expect(row.can, `${row.targetType} on its list and in its pane`).toEqual(pane?.can);
  }
}

const SEEDS = [1, 42, 20261115, Math.floor(Math.random() * 2 ** 31)];

/** One history from a fresh world, then the lists held to their rules. */
async function history(ops: Op[]): Promise<void> {
  vi.setSystemTime(T0);
  const w = await world();
  for (const op of ops) await step(w, op);
  await holds(w);
}

/**
 * The histories the build and its review found, run first, once each (they don't depend on a seed):
 * an earlier reversal a later hide must supersede, an undo between, a deletion beside another item's
 * hide, and a keep, overturn and erasure in turn.
 */
const PINNED: Op[][] = [
  [{ op: 'hide', i: 0 }, { op: 'undo' }, { op: 'hide', i: 0 }],
  [{ op: 'hide', i: 2 }, { op: 'undo' }, { op: 'hide', i: 2 }, { op: 'undo' }],
  [
    { op: 'delete', i: 3 },
    { op: 'hide', i: 0 },
  ],
  [
    { op: 'delete', i: 1 },
    { op: 'keep', i: 1 },
    { op: 'act', i: 1 },
    { op: 'erase' },
    { op: 'act', i: 1 },
  ],
];

describe('the record sheet’s lists over any history', () => {
  test.each(PINNED.map((ops, i): [number, Op[]] => [i, ops]))('pinned history %i', (_, ops) =>
    history(ops),
  );
  test.each(SEEDS)('seed %i', async (seed) => {
    console.log(`recordModel seed ${seed}`);
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 7 }), history), {
      seed,
      numRuns: 3,
    });
  });
});
