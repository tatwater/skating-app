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
    return { rob, mod, on, waterBodyId };
  });
  return { t, ...ids, viewer: t.withIdentity({ subject: 'mod' }) };
}
type W = Awaited<ReturnType<typeof world>>;
type List = 'personVerdicts' | 'personReversed' | 'personDeleted';
/** The kinds the model makes: the Deleted list's three cheapest, in its tie-break order. */
type Kind = 'report' | 'post' | 'comment';
const KINDS: readonly Kind[] = ['report', 'post', 'comment'];
/** What the web sends: one kind (the filter), or none — the default tab, every kind merged. */
type Scope = Kind | null;
const SCOPES: readonly Scope[] = [null, ...KINDS];
/** The merged Deleted list's tie-break between kinds at one withdrawal time (`DELETED_KINDS`). */
const KIND_ORDER: Record<Kind, number> = { report: 0, post: 1, comment: 2 };

/** One of rob's things: hidden under a decision (standing or ended), or withdrawn by him. */
async function item(w: W, list: List, kind: Kind, at: number): Promise<string> {
  return w.t.run(async (ctx) => {
    const deleted = list === 'personDeleted';
    const withdrawn = deleted ? { authorDeletedAt: at, eraseAt: at + 30 * 86_400_000 } : {};
    const status = deleted ? ('visible' as const) : ('hidden' as const);
    const id =
      kind === 'comment'
        ? await ctx.db.insert('comments', {
            reportId: w.on,
            authorId: w.rob,
            body: 'b',
            moderationStatus: status,
            source: 'native' as const,
            createdAt: at - 1,
            ...withdrawn,
          } as never)
        : kind === 'report'
          ? await ctx.db.insert('reports', {
              authorId: w.rob,
              waterBodyId: w.waterBodyId,
              point: { lat: 0.5, lng: 0.5 },
              skateEndTime: at,
              reportTime: at,
              source: 'native' as const,
              iceTypes: [],
              surfaceTags: [],
              photoIds: [],
              moderationStatus: status,
              hazardIdsCreated: [],
              createdAt: at - 1,
              updatedAt: at - 1,
              ...withdrawn,
            } as never)
          : await ctx.db.insert('posts', {
              authorId: w.rob,
              reportIds: [],
              photoIds: [],
              moderationStatus: status,
              latestSkateEndTime: at,
              createdAt: at - 1,
              updatedAt: at - 1,
              ...withdrawn,
            } as never);
    if (deleted) return id as string;
    const actionId = await ctx.db.insert('moderationActions', {
      actorId: w.mod,
      action: 'hide',
      targetType: kind,
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
          targetType: kind,
          targetId: id,
          reason: 'Restored',
          metadata: { priorStatus: 'hidden', newStatus: 'visible', reasonDefaulted: true },
          createdAt: at + 1,
        })
      : undefined;
    await ctx.db.insert('contentVerdicts', {
      subjectUserId: w.rob,
      targetType: kind,
      targetId: id,
      actionId,
      kind: 'hidden',
      at,
      standing: !ended,
      superseded: false,
      ...(endedBy ? { endedAt: at + 1, endedByActionId: endedBy } : {}),
    });
    return id as string;
  });
}

/** Take a row out of its list: its verdict gone (Standing, Reversed), or the thing erased away. */
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

/**
 * The list as the server holds it, in its order: what a whole chain must show. Standing and
 * Reversed: newest decision (or ending) first, then the newer row — one index, every kind in it.
 * Deleted, merged: newest withdrawal first, then the kind's place (`KIND_ORDER`), then the newer row.
 */
async function truth(w: W, list: List, scope: Scope): Promise<string[]> {
  return w.t.run(async (ctx) => {
    if (list === 'personDeleted') {
      const rows: { id: string; kind: Kind; at: number; ct: number }[] = [];
      const kept = (kind: Kind) => scope === null || scope === kind;
      for (const kind of KINDS) {
        if (!kept(kind)) continue;
        const table = kind === 'report' ? 'reports' : kind === 'post' ? 'posts' : 'comments';
        for (const d of (await ctx.db.query(table).collect()) as Array<{
          _id: string;
          _creationTime: number;
          authorId: string;
          authorDeletedAt?: number;
        }>) {
          if (d.authorId !== w.rob || d.authorDeletedAt === undefined) continue;
          rows.push({ id: d._id, kind, at: d.authorDeletedAt, ct: d._creationTime });
        }
      }
      rows.sort((a, b) => b.at - a.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.ct - a.ct);
      return rows.map((r) => r.id);
    }
    const rows = (await ctx.db.query('contentVerdicts').collect()).filter(
      (v) =>
        (scope === null || v.targetType === scope) &&
        (list === 'personVerdicts' ? v.standing : !v.superseded && (v.endedAt ?? 0) > 0),
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

async function readLink(w: W, list: List, scope: Scope, link: Link): Promise<Answer> {
  return (await w.viewer.query(api.contentRecord[list], {
    userId: w.rob,
    ...(scope !== null ? { targetType: scope } : {}),
    cursor: link.cursor,
    ...(link.end !== null ? { endCursor: link.end } : {}),
  })) as Answer;
}

/** Read every page until the chain holds still, as the client's effects do. */
async function settle(w: W, list: List, scope: Scope, chain: Link[]) {
  for (let i = 0; i < 60; i++) {
    const answers: Answer[] = [];
    for (const link of chain) answers.push(await readLink(w, list, scope, link));
    const next = settleChain(chain, answers);
    if (next === null) return { chain, answers };
    chain = next;
  }
  throw new Error('the chain never held still');
}

/** What the model checks after every step: the invariants, against the server's own list. */
function checker(w: W, list: List, scope: Scope) {
  let shown: string[] = [];
  return async (state: { chain: Link[]; answers: Answer[] }) => {
    const rows = state.answers.flatMap((a) => a.page.map((r) => r.targetId));
    const all = await truth(w, list, scope);
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
    // The chain shows the list from its start, in order across kinds, none missing — so no row is
    // placed before a row of another kind that sorts ahead of it.
    expect(rows, 'the list from its start').toEqual(all.slice(0, rows.length));
    const last = state.answers.at(-1) as Answer;
    if (last.isDone) expect(rows, 'done only when every kind is read to its end').toEqual(all);
  };
}

type Op =
  | { kind: 'add'; what: Kind; at: number }
  | { kind: 'remove'; pick: number }
  | { kind: 'more' };

/** Times from a small set, so rows of different kinds tie on the key as often as not. */
const atArb = fc.nat(12);
const kindArb = fc.constantFrom(...KINDS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('add' as const), what: kindArb, at: atArb }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), pick: fc.nat(99) }) },
  { weight: 3, arbitrary: fc.constant<Op>({ kind: 'more' }) },
);
const at = (n: number) => T0 - 10_000 + n * 10;

async function drive(list: List, scope: Scope, seeded: { what: Kind; at: number }[], ops: Op[]) {
  vi.setSystemTime(T0);
  const w = await world();
  for (const s of seeded) await item(w, list, s.what, at(s.at));
  const check = checker(w, list, scope);
  let state = await settle(w, list, scope, [{ cursor: null, end: null }]);
  await check(state);
  for (const op of ops) {
    if (op.kind === 'add') await item(w, list, op.what, at(op.at));
    if (op.kind === 'remove') {
      const all = await truth(w, list, scope);
      const id = all[op.pick % Math.max(1, all.length)];
      if (id !== undefined) await remove(w, list, id);
    }
    let chain = state.chain;
    if (op.kind === 'more') chain = extendChain(chain, state.answers.at(-1) as Answer);
    state = await settle(w, list, scope, chain);
    await check(state);
  }
  // Asked on to the end, the chain holds the whole list.
  for (let i = 0; i < 40 && !(state.answers.at(-1) as Answer).isDone; i++) {
    state = await settle(w, list, scope, extendChain(state.chain, state.answers.at(-1) as Answer));
    await check(state);
  }
  expect((state.answers.at(-1) as Answer).isDone).toBe(true);
  return state;
}

const SEEDS = [20261116, 7, Math.floor(Math.random() * 2 ** 31)];

describe.each(['personVerdicts', 'personReversed', 'personDeleted'] as const)(
  '%s: a page read past holds its rows',
  (list) => {
    test.each(SEEDS)(
      'changes anywhere while deeper pages are held, every kind or one: none twice, none lost, in order (seed %i)',
      async (seed) => {
        console.log(`recordEndCursor ${list} seed ${seed}`);
        await fc.assert(
          fc.asyncProperty(
            // The parameter the web sends, generated: the default tab (every kind) or one kind.
            fc.constantFrom(...SCOPES),
            fc.array(fc.record({ what: kindArb, at: atArb }), { minLength: 4, maxLength: 9 }),
            fc.array(opArb, { maxLength: 8 }),
            (scope, seeded, ops) => drive(list, scope, seeded, ops).then(() => undefined),
          ),
          { seed, numRuns: 5 },
        );
      },
    );

    test('a pinned page that grew past a page splits after the rows it returned', async () => {
      const w = await world();
      for (let i = 0; i < 4; i++) await item(w, list, 'comment', at(i * 10));
      const first = await readLink(w, list, null, { cursor: null, end: null });
      expect(first.page).toHaveLength(ROWS);
      // Two rows land inside the first page's range.
      await item(w, list, 'comment', at(25));
      await item(w, list, 'comment', at(15));
      const pinned = await readLink(w, list, null, { cursor: null, end: first.continueCursor });
      expect(pinned).toMatchObject({
        isDone: false,
        pageStatus: 'SplitRequired',
        continueCursor: first.continueCursor,
      });
      expect(pinned.page).toHaveLength(ROWS);
      expect(pinned.page.map((r) => r.targetId)).toEqual(
        (await truth(w, list, null)).slice(0, ROWS),
      );
      // The halves: the rows it returned, then the rest of its range, which keeps its end.
      const tail = await readLink(w, list, null, {
        cursor: pinned.splitCursor as string,
        end: first.continueCursor,
      });
      expect(tail.pageStatus).toBeUndefined();
      expect(tail.continueCursor).toBe(first.continueCursor);
      expect(tail.page.map((r) => r.targetId)).toEqual((await truth(w, list, null)).slice(ROWS, 5));
    });

    test('a pinned page whose rows all left keeps its end, and is done only when nothing follows', async () => {
      const w = await world();
      for (let i = 0; i < 4; i++) await item(w, list, 'comment', at(i * 10));
      const first = await readLink(w, list, null, { cursor: null, end: null });
      for (const r of first.page) await remove(w, list, r.targetId);
      const pinned = await readLink(w, list, null, { cursor: null, end: first.continueCursor });
      expect(pinned).toMatchObject({
        page: [],
        isDone: false,
        continueCursor: first.continueCursor,
      });
      const last = (await truth(w, list, null))[0] as string;
      await remove(w, list, last);
      const empty = await readLink(w, list, null, { cursor: null, end: first.continueCursor });
      expect(empty).toMatchObject({ page: [], isDone: true, continueCursor: first.continueCursor });
    });
  },
);

// ── The merged Deleted list: several kinds' ranges, one order ──

describe('personDeleted, every kind merged (the default tab)', () => {
  test('Greptile’s case: a full Report range ends before the pinned end — the page splits, and every row stays, in order', async () => {
    const w = await world();
    // Reports at 100 and 90 (a page asks two: the range is full), comments between and after.
    await item(w, 'personDeleted', 'report', at(100));
    await item(w, 'personDeleted', 'comment', at(95));
    await item(w, 'personDeleted', 'report', at(90));
    await item(w, 'personDeleted', 'comment', at(85));
    await item(w, 'personDeleted', 'comment', at(75));
    const check = checker(w, 'personDeleted', null);
    let state = await settle(w, 'personDeleted', null, [{ cursor: null, end: null }]);
    expect(state.answers[0]?.page.map((r) => r.targetId)).toEqual(
      (await truth(w, 'personDeleted', null)).slice(0, ROWS),
    );
    // Read past: the first page is pinned to the second Report.
    state = await settle(
      w,
      'personDeleted',
      null,
      extendChain(state.chain, state.answers[0] as Answer),
    );
    await check(state);
    const end = state.chain[0]?.end as string;
    // Two Reports land inside the pinned page: its Report range is full and now ends at the
    // second of them, before the page's end — what lies past it can't be placed yet.
    await item(w, 'personDeleted', 'report', at(99));
    await item(w, 'personDeleted', 'report', at(98));
    const pinned = await readLink(w, 'personDeleted', null, { cursor: null, end });
    expect(pinned.pageStatus).toBe('SplitRequired');
    expect(pinned.continueCursor).toBe(end);
    expect(pinned.page.map((r) => r.targetId)).toEqual(
      (await truth(w, 'personDeleted', null)).slice(0, pinned.page.length),
    );
    // Settled, the chain holds every row in the merged order; asked on, every row once.
    state = await settle(w, 'personDeleted', null, state.chain);
    await check(state);
    for (let i = 0; i < 20 && !(state.answers.at(-1) as Answer).isDone; i++) {
      state = await settle(
        w,
        'personDeleted',
        null,
        extendChain(state.chain, state.answers.at(-1) as Answer),
      );
      await check(state);
    }
    expect(state.answers.flatMap((a) => a.page.map((r) => r.targetId))).toEqual(
      await truth(w, 'personDeleted', null),
    );
  });

  test('ties across kinds: one withdrawal time reads Report, Post, comment, and the newer first within a kind', async () => {
    const w = await world();
    const c1 = await item(w, 'personDeleted', 'comment', at(50));
    const p1 = await item(w, 'personDeleted', 'post', at(50));
    const r1 = await item(w, 'personDeleted', 'report', at(50));
    const r2 = await item(w, 'personDeleted', 'report', at(50));
    const c2 = await item(w, 'personDeleted', 'comment', at(50));
    const want = [r2, r1, p1, c2, c1];
    expect(await truth(w, 'personDeleted', null)).toEqual(want);
    let state = await settle(w, 'personDeleted', null, [{ cursor: null, end: null }]);
    for (let i = 0; i < 20 && !(state.answers.at(-1) as Answer).isDone; i++) {
      state = await settle(
        w,
        'personDeleted',
        null,
        extendChain(state.chain, state.answers.at(-1) as Answer),
      );
    }
    expect(state.answers.flatMap((a) => a.page.map((r) => r.targetId))).toEqual(want);
  });

  test.each(SEEDS)(
    'mixes where a full range ends before another kind’s rows, pinned pages split and held (seed %i)',
    async (seed) => {
      console.log(`recordEndCursor merged Deleted seed ${seed}`);
      await fc.assert(
        fc.asyncProperty(
          // Reports and Posts fill their few-a-page ranges; comments rarely do.
          fc.array(
            fc.record({
              what: fc.constantFrom<Kind>('report', 'report', 'post', 'comment'),
              at: atArb,
            }),
            { minLength: 5, maxLength: 10 },
          ),
          fc.array(opArb, { minLength: 2, maxLength: 8 }),
          (seeded, ops) => drive('personDeleted', null, seeded, ops).then(() => undefined),
        ),
        { seed, numRuns: 6 },
      );
    },
  );
});
