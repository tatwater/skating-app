/**
 * **The record sheet's lists hold a page they have read past** (B01-4j). Each of `personVerdicts`,
 * `personReversed` and `personDeleted` takes an `endCursor` — where the page ended when it was first
 * read — and then reads exactly `(cursor, endCursor]`, keeping that end as its `continueCursor`, as
 * `people.listPage` does; a range that grew past what one page returns says `SplitRequired` with a
 * `splitCursor` after the rows it returned.
 *
 * A model property: the client's chain (a page pinned when the next is asked for, a page to split
 * split, a page read past that is done ending the chain — the web's `pageChain`, restated here)
 * against random changes anywhere in the list while deeper pages are held. After each change the
 * chain is settled and its rows must be the list's own from its start — none twice, none lost, in
 * order — and `isDone` only when nothing follows. Pages are shrunk to three rows (`RECORD_PAGE_ROWS`)
 * so a handful of rows spans several. Pinned seeds plus one random seed, logged.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { RECORD_PAGE, RECORD_PAGE_ROWS } from './lib/recordReads';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
const ROWS = 3;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  RECORD_PAGE_ROWS.n = ROWS;
});
afterEach(() => {
  RECORD_PAGE_ROWS.n = RECORD_PAGE;
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
};

async function world() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts'] as const) {
      await markReady(ctx, b);
    }
    const profile = async (subject: string, role: 'member' | 'moderator') => {
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
        createdAt: T0,
      });
      await refreshPersonRow(ctx, id);
      return id;
    };
    const rob = await profile('rob', 'member');
    const kate = await profile('kate', 'member');
    const mod = await profile('mod', 'moderator');
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
    const on = await ctx.db.insert('reports', {
      authorId: kate,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0,
      updatedAt: T0,
    });
    return { rob, mod, on };
  });
  return { t, ...ids, viewer: t.withIdentity({ subject: 'mod' }) };
}
type W = Awaited<ReturnType<typeof world>>;
type List = 'personVerdicts' | 'personReversed' | 'personDeleted';

/** A comment of rob's: hidden under a decision (standing or ended), or deleted by him. */
async function comment(w: W, list: List, at: number): Promise<string> {
  return w.t.run(async (ctx) => {
    const id = await ctx.db.insert('comments', {
      reportId: w.on,
      authorId: w.rob,
      body: 'b',
      moderationStatus: list === 'personDeleted' ? ('visible' as const) : ('hidden' as const),
      source: 'native' as const,
      createdAt: at - 1,
      ...(list === 'personDeleted' ? { authorDeletedAt: at, eraseAt: at + 30 * 86_400_000 } : {}),
    } as never);
    if (list === 'personDeleted') return id;
    const actionId = await ctx.db.insert('moderationActions', {
      actorId: w.mod,
      action: 'hide',
      targetType: 'comment',
      targetId: id,
      reason: 'hidden',
      metadata: { priorStatus: 'visible', newStatus: 'hidden' },
      createdAt: at,
    });
    const ended = list === 'personReversed';
    const endedBy = ended
      ? await ctx.db.insert('moderationActions', {
          actorId: w.mod,
          action: 'restore',
          targetType: 'comment',
          targetId: id,
          reason: 'Restored',
          metadata: { priorStatus: 'hidden', newStatus: 'visible', reasonDefaulted: true },
          createdAt: at + 1,
        })
      : undefined;
    await ctx.db.insert('contentVerdicts', {
      subjectUserId: w.rob,
      targetType: 'comment',
      targetId: id,
      actionId,
      kind: 'hidden',
      at,
      standing: !ended,
      superseded: false,
      ...(endedBy ? { endedAt: at + 1, endedByActionId: endedBy } : {}),
    });
    return id;
  });
}

/** Take a row out of its list: its verdict gone (Standing, Reversed), or the comment erased away. */
async function remove(w: W, list: List, id: string) {
  await w.t.run(async (ctx) => {
    if (list === 'personDeleted') {
      await ctx.db.delete(id as Id<'comments'>);
      return;
    }
    const verdicts = await ctx.db.query('contentVerdicts').collect();
    for (const v of verdicts.filter((r) => r.targetId === id)) await ctx.db.delete(v._id);
  });
}

/** The list as the server holds it, in its order: what a whole chain must show. */
async function truth(w: W, list: List): Promise<string[]> {
  return w.t.run(async (ctx) => {
    if (list === 'personDeleted') {
      const rows = (await ctx.db.query('comments').collect()).filter(
        (c: Doc<'comments'>) => c.authorDeletedAt !== undefined,
      );
      rows.sort(
        (a, b) =>
          (b.authorDeletedAt as number) - (a.authorDeletedAt as number) ||
          b._creationTime - a._creationTime,
      );
      return rows.map((r) => r._id as string);
    }
    const rows = (await ctx.db.query('contentVerdicts').collect()).filter((v) =>
      list === 'personVerdicts' ? v.standing : !v.superseded && (v.endedAt ?? 0) > 0,
    );
    const key = (v: Doc<'contentVerdicts'>) =>
      list === 'personVerdicts' ? v.at : (v.endedAt ?? 0);
    rows.sort((a, b) => key(b) - key(a) || b._creationTime - a._creationTime);
    return rows.map((r) => r.targetId);
  });
}

// ── The client's chain, as the web's `pageChain` reads it ──

type Link = { cursor: string | null; end: string | null };
type Answer = {
  page: { targetId: string }[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string;
  pageStatus?: 'SplitRequired';
};

function settleChain(chain: Link[], answers: Answer[]): Link[] | null {
  for (const [i, link] of chain.entries()) {
    const answer = answers[i] as Answer;
    if (answer.pageStatus === 'SplitRequired') {
      const split = answer.splitCursor;
      if (link.end !== null && typeof split === 'string' && split !== '') {
        return [
          ...chain.slice(0, i),
          { cursor: link.cursor, end: split },
          { cursor: split, end: link.end },
          ...chain.slice(i + 1),
        ];
      }
      return [...chain.slice(0, i), { cursor: link.cursor, end: null }];
    }
    const next = chain[i + 1];
    if (next === undefined) return null;
    if (answer.isDone) return chain.slice(0, i + 1);
    if (answer.continueCursor !== next.cursor) {
      return [...chain.slice(0, i + 1), { cursor: answer.continueCursor, end: null }];
    }
  }
  return null;
}

function extendChain(chain: Link[], last: Answer): Link[] {
  const link = chain.at(-1) as Link;
  if (last.isDone || last.pageStatus === 'SplitRequired') return chain;
  return [
    ...chain.slice(0, -1),
    { cursor: link.cursor, end: link.end ?? last.continueCursor },
    { cursor: last.continueCursor, end: null },
  ];
}

async function readLink(w: W, list: List, link: Link): Promise<Answer> {
  return (await w.viewer.query(api.contentRecord[list], {
    userId: w.rob,
    ...(list === 'personDeleted' ? { targetType: 'comment' as const } : {}),
    cursor: link.cursor,
    ...(link.end !== null ? { endCursor: link.end } : {}),
  })) as Answer;
}

/** Read every page until the chain holds still, as the client's effects do. */
async function settle(w: W, list: List, chain: Link[]) {
  for (let i = 0; i < 40; i++) {
    const answers: Answer[] = [];
    for (const link of chain) answers.push(await readLink(w, list, link));
    const next = settleChain(chain, answers);
    if (next === null) return { chain, answers };
    chain = next;
  }
  throw new Error('the chain never held still');
}

type Op = { kind: 'add'; at: number } | { kind: 'remove'; pick: number } | { kind: 'more' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('add' as const), at: fc.nat(40) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), pick: fc.nat(99) }) },
  { weight: 3, arbitrary: fc.constant<Op>({ kind: 'more' }) },
);

async function drive(list: List, seeded: number[], ops: Op[]) {
  vi.setSystemTime(T0);
  const w = await world();
  for (const at of seeded) await comment(w, list, T0 - 10_000 + at * 10);
  let chain: Link[] = [{ cursor: null, end: null }];
  let state = await settle(w, list, chain);
  let shown: string[] = [];
  const check = async () => {
    const rows = state.answers.flatMap((a) => a.page.map((r) => r.targetId));
    const all = await truth(w, list);
    // A row a held page showed stays shown while the list still holds it.
    const still = new Set(all);
    for (const id of shown)
      if (still.has(id)) expect(rows, 'a row read past is kept').toContain(id);
    // Only a page read past is held; the last page is unbounded, and its rows move with the list.
    shown = state.chain.flatMap((link, i) =>
      link.end === null ? [] : (state.answers[i] as Answer).page.map((r) => r.targetId),
    );
    for (const a of state.answers) expect(a.page.length).toBeLessThanOrEqual(ROWS);
    expect(new Set(rows).size, 'no row twice').toBe(rows.length);
    // The chain shows the list from its start, in order, none missing.
    expect(rows, 'the list from its start').toEqual(all.slice(0, rows.length));
    const last = state.answers.at(-1) as Answer;
    if (last.isDone) expect(rows, 'done only when nothing follows').toEqual(all);
  };
  await check();
  for (const op of ops) {
    if (op.kind === 'add') await comment(w, list, T0 - 10_000 + op.at * 10 + 3);
    if (op.kind === 'remove') {
      const all = await truth(w, list);
      const id = all[op.pick % Math.max(1, all.length)];
      if (id !== undefined) await remove(w, list, id);
    }
    chain = state.chain;
    if (op.kind === 'more') chain = extendChain(chain, state.answers.at(-1) as Answer);
    state = await settle(w, list, chain);
    await check();
  }
  // Asked on to the end, the chain holds the whole list.
  for (let i = 0; i < 40 && !(state.answers.at(-1) as Answer).isDone; i++) {
    state = await settle(w, list, extendChain(state.chain, state.answers.at(-1) as Answer));
    await check();
  }
  expect((state.answers.at(-1) as Answer).isDone).toBe(true);
  return state;
}

describe.each(['personVerdicts', 'personReversed', 'personDeleted'] as const)(
  '%s: a page read past holds its rows',
  (list) => {
    test.each([20261116, 7, Math.floor(Math.random() * 2 ** 31)])(
      'changes anywhere while deeper pages are held: none twice, none lost, in order (seed %i)',
      async (seed) => {
        console.log(`recordEndCursor ${list} seed ${seed}`);
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.nat(40), { minLength: 4, maxLength: 9 }),
            fc.array(opArb, { maxLength: 8 }),
            (seeded, ops) => drive(list, seeded, ops).then(() => undefined),
          ),
          { seed, numRuns: 4 },
        );
      },
    );

    test('a pinned page that grew past a page splits after the rows it returned', async () => {
      const w = await world();
      for (let i = 0; i < 4; i++) await comment(w, list, T0 - 10_000 + i * 100);
      const first = await readLink(w, list, { cursor: null, end: null });
      expect(first.page).toHaveLength(ROWS);
      // Two rows land inside the first page's range.
      await comment(w, list, T0 - 10_000 + 250);
      await comment(w, list, T0 - 10_000 + 150);
      const pinned = await readLink(w, list, { cursor: null, end: first.continueCursor });
      expect(pinned).toMatchObject({
        isDone: false,
        pageStatus: 'SplitRequired',
        continueCursor: first.continueCursor,
      });
      expect(pinned.page).toHaveLength(ROWS);
      const at = (await truth(w, list)).slice(0, ROWS);
      expect(pinned.page.map((r) => r.targetId)).toEqual(at);
      // The halves: the rows it returned, then the rest of its range, which keeps its end.
      const tail = await readLink(w, list, {
        cursor: pinned.splitCursor as string,
        end: first.continueCursor,
      });
      expect(tail.pageStatus).toBeUndefined();
      expect(tail.continueCursor).toBe(first.continueCursor);
      expect(tail.page.map((r) => r.targetId)).toEqual((await truth(w, list)).slice(ROWS, 5));
    });

    test('a pinned page whose rows all left keeps its end, and is done only when nothing follows', async () => {
      const w = await world();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await comment(w, list, T0 - 10_000 + i * 100));
      const first = await readLink(w, list, { cursor: null, end: null });
      for (const r of first.page) await remove(w, list, r.targetId);
      const pinned = await readLink(w, list, { cursor: null, end: first.continueCursor });
      expect(pinned).toMatchObject({
        page: [],
        isDone: false,
        continueCursor: first.continueCursor,
      });
      const last = (await truth(w, list))[0] as string;
      await remove(w, list, last);
      const empty = await readLink(w, list, { cursor: null, end: first.continueCursor });
      expect(empty).toMatchObject({ page: [], isDone: true, continueCursor: first.continueCursor });
    });
  },
);
