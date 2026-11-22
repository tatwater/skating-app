/**
 * **The heavy-rows matrix** (B01-5, PR #170): every source row the Inbox touches made as large as the
 * schema and its writers allow — an admit ask carrying a catalog polygon near the document limit, a
 * drawn body with an outline near it, a flag with its longest note, a ticket with its longest body —
 * and every Inbox read, write and undo run against them under Convex's real limits (the harness
 * enforces them on every transaction). Each must end in exactly one of three ways: it **completes**,
 * it answers **honestly capped or pending**, or it **refuses with a sentence**. Never a throw past a
 * limit, never a page that can't advance.
 *
 * Heavy rows stress by count × size against the 16 MiB read limit, so their counts here (20 asks of
 * ~900 KiB, 18 MiB together) already pass it at a fraction of the member bound; the member bound's
 * own arithmetic, at 500, is asserted beside the closers' costs (`inboxBatch.test.ts`) and the undos'
 * reservations (`undoOfferVsRun.test.ts`).
 */

import { requestNameKeyFor } from '@skating/core';
import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { fileMember, flagSource, requestSource, ticketSource } from './lib/inboxItems';
import { ALONGSIDE_UNCHECKED } from './lib/inboxRules';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

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
  // On, so every decision here also queues its askers' messages (D285): the heavy paths carry them.
  moderatorDecision: true,
};

/** A ring of `n` points around (0.5, 0.5) — about 18 bytes a point as Convex weighs it. */
function ring(n: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([0.5 + 0.4 * Math.cos(a), 0.5 + 0.4 * Math.sin(a)]);
  }
  pts.push(pts[0] as number[]);
  return pts;
}
/**
 * About 900 KiB, near the 1 MiB document limit with room for the row: the catalog's name for the
 * water, which the resolver copies uncapped (a polygon of the same weight reads the same against the
 * limits, and costs the test far more to build).
 */
const HEAVY_NAME = 'W'.repeat(900 * 1024);
const SQUARE = { type: 'Polygon' as const, coordinates: [ring(4)] };

/** A note at its cap, in four-byte characters (the writer counts characters). */
const maxText = (chars: number) => '\u{1F9CA}'.repeat(chars);

type Outcome = { kind: 'completed' } | { kind: 'capped' } | { kind: 'refused'; why: string };

/** Run `op`; a `ConvexError` is a refusal with its sentence; anything else thrown fails the test. */
async function outcomeOf(op: () => Promise<unknown>): Promise<Outcome> {
  try {
    const out = await op();
    const o = out as { capped?: boolean; pending?: boolean; filedCapped?: boolean } | null;
    return o && (o.capped === true || o.filedCapped === true || o.pending === true)
      ? { kind: 'capped' }
      : { kind: 'completed' };
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === 'string' && data.length > 0) return { kind: 'refused', why: data };
    throw err;
  }
}

async function person(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: 1,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/**
 * `n` admit asks for one catalog feature, each carrying the heavy name (or, given `polygon`, a heavy
 * outline under an ordinary name — the weight an approval can admit), each filed.
 */
async function heavyAdmits(
  t: T,
  askers: Id<'profiles'>[],
  externalId: string,
  heavy: { polygon?: { type: 'Polygon'; coordinates: number[][][] } } = {},
) {
  const ids: Id<'waterBodyRequests'>[] = [];
  // A few a transaction: each is ~900 KiB, and a transaction writes at most 16 MiB.
  for (let start = 0; start < askers.length; start += 4) {
    ids.push(
      ...(await t.run(async (ctx) => {
        const out: Id<'waterBodyRequests'>[] = [];
        for (const requesterId of askers.slice(start, start + 4)) {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'admit',
            status: 'open',
            requesterId,
            coord: { lat: 0.5, lng: 0.5 },
            note: maxText(280),
            candidate: {
              source: '3dhp',
              externalId,
              name: heavy.polygon ? 'Big Pond' : HEAVY_NAME,
              featureType: 390,
              cls: 'lakePond',
              polygon: (heavy.polygon ?? SQUARE) as never,
              bbox: { minLat: 0.1, minLng: 0.1, maxLat: 0.9, maxLng: 0.9 },
              centroid: { lat: 0.5, lng: 0.5 },
              surfaceAreaSqM: 5_000_000,
              serviceUrl: 'https://example.invalid/3dhp',
              fetchedAt: NOW - 1000,
            },
            candidateExternalId: externalId,
            resolvedAt: NOW - 1000,
            createdAt: NOW - 10_000,
          });
          await fileMember(ctx, requestSource(id));
          out.push(id);
        }
        return out;
      })),
    );
  }
  return ids;
}

/** The world: staff, people, a lake, and heavy rows of every kind the Inbox holds. */
async function heavyWorld() {
  const t = harness();
  const mod = await person(t, 'mod', 'moderator');
  const admin = await person(t, 'admin', 'admin');
  const people: Id<'profiles'>[] = [];
  for (let i = 0; i < 20; i++) people.push((await person(t, `p${i}`)).id);
  const lake = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Pond',
      searchText: 'Pond',
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: SQUARE,
      centroid: { lat: 0.5, lng: 0.5 },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      createdAt: NOW,
    } as never),
  );
  // Twenty people asking for one big lake the catalog knows — 18 MiB of asks.
  const asks = await heavyAdmits(t, people, 'catalog/big');
  // The moderator's own heavy asks, for other water.
  for (let i = 0; i < 6; i++) await heavyAdmits(t, [mod.id], `catalog/mine${i}`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { t, mod, admin, people, lake, asks };
}

/** Every continuation a decision or undo scheduled, run to its end — each its own execution. */
async function drainAll(t: T) {
  const seen = new Set<string>();
  for (let pages = 0; pages < 400; pages++) {
    const next = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).find(
      (s) => !seen.has(s._id) && s.state.kind === 'pending' && CONTINUATIONS.has(s.name),
    );
    if (!next) return pages;
    seen.add(next._id);
    await t.mutation(makeFunctionReference<'mutation'>(next.name), next.args[0] as never);
  }
  throw new Error('a continuation never ended');
}
const CONTINUATIONS = new Set([
  'corpusRequests:closeSiblings',
  'inboxWrites:closeFlagsRest',
  'inboxWrites:reopenRequestsRest',
  'inboxWrites:closeRequestsRest',
  'inboxWrites:reopenFlagsRest',
]);

/** The Inbox ready: the backfill done, nothing owed. */
const markReady = (t: T) =>
  t.run((ctx) =>
    ctx.db.insert('inboxJobRuns', {
      job: 'backfill',
      phase: 'done',
      cursor: null,
      done: true,
      startedAt: 1,
      updatedAt: 1,
    }),
  );

/** Every Inbox read a staffer makes, for `ref`'s item and its lane. */
const READS = (w: { mod: { as: ReturnType<T['withIdentity']> } }, ref: string, lane: string) => ({
  item: () => w.mod.as.query(api.inbox.item, { ref }),
  itemMap: () => w.mod.as.query(api.inbox.itemMap, { ref }),
  listLane: () => w.mod.as.query(api.inbox.listPage, { lane: lane as never, pageSize: 100 }),
  listAll: () => w.mod.as.query(api.inbox.listPage, { lane: 'all', pageSize: 100 }),
  lanes: () => w.mod.as.query(api.inbox.lanes, { dayStart: NOW - 3_600_000 }),
  today: () => w.mod.as.query(api.inbox.today, { dayStart: NOW - 3_600_000 }),
  tail: () => w.mod.as.query(api.inbox.tail, { lane: lane as never }),
  overview: () => w.mod.as.query(api.console.overview, {}),
});

/** Each named operation's outcome; any non-refusal throw fails the test with its name. */
async function matrix(ops: Record<string, () => Promise<unknown>>) {
  const out: Record<string, Outcome['kind']> = {};
  for (const [name, op] of Object.entries(ops)) {
    try {
      out[name] = (await outcomeOf(op)).kind;
    } catch (err) {
      throw new Error(`${name} threw: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Each heavy ask's status, one per transaction: twenty of them weigh more than one may read. */
const statusesOf = async (t: T, ids: Id<'waterBodyRequests'>[]) => {
  const out: string[] = [];
  for (const id of ids) out.push((await t.run((ctx) => ctx.db.get(id)))?.status ?? 'gone');
  return out;
};

describe.each(['pending', 'ready'] as const)(
  'heavy rows: an admit question twenty asks deep, each near the document limit — the Inbox %s',
  (mode) => {
    test('every read answers; the decision, its undo and the undo of that each complete', async () => {
      const w = await heavyWorld();
      if (mode === 'ready') await markReady(w.t);
      const ref = `request:${w.asks[0]}`;
      const reads = await matrix(READS(w, ref, 'requests'));
      expect(Object.values(reads).every((k) => k !== 'refused')).toBe(true);
      // The moderator's own heavy asks never stop the item opening: its levers say what they can.
      const view = await w.mod.as.query(api.inbox.item, { ref });
      expect(view.item).not.toBeNull();
      const can = (view.item as { can: Record<string, string | null> }).can;
      // Ready, the check reads the moderator's member rows (a few hundred bytes each) and answers;
      // pending, it reads their asks one at a time and, when they don't fit, refuses plainly.
      const expected = mode === 'ready' ? null : ALONGSIDE_UNCHECKED;
      expect({ approve: can.approve, decline: can.decline }).toEqual({
        approve: expected,
        decline: expected,
      });
      // The decision: every one of the twenty closes, page by page.
      const first = w.asks[0] as Id<'waterBodyRequests'>;
      expect(
        (
          await outcomeOf(() =>
            w.admin.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'No' }),
          )
        ).kind,
      ).toBe('completed');
      await drainAll(w.t);
      expect(new Set(await statusesOf(w.t, w.asks))).toEqual(new Set(['declined']));
      // Its undo: every one reopens, page by page.
      const decision = await w.t.run(async (ctx) =>
        (await ctx.db.query('moderationActions').collect()).find(
          (r) => r.action === 'decline_request' && r.targetId === first,
        ),
      );
      expect(
        (
          await outcomeOf(() =>
            w.admin.as.mutation(api.undo.run, {
              actionId: decision?._id as Id<'moderationActions'>,
              reason: 'Undone',
            }),
          )
        ).kind,
      ).toBe('completed');
      await drainAll(w.t);
      expect(new Set(await statusesOf(w.t, w.asks))).toEqual(new Set(['open']));
      // A landmark question beside it (its drain pages by cursor: one paginate per execution).
      const landmark = await w.t.run(async (ctx) => {
        const ids: Id<'waterBodyRequests'>[] = [];
        for (const requesterId of w.people.slice(0, 2)) {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_landmark',
            status: 'open',
            requesterId,
            coord: { lat: 0.5, lng: 0.5 },
            waterBodyId: w.lake,
            name: 'Long Point',
            nameKey: requestNameKeyFor('name_landmark', 'Long Point'),
            createdAt: NOW - 1000,
          });
          await fileMember(ctx, requestSource(id));
          ids.push(id);
        }
        return ids;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        (
          await outcomeOf(() =>
            w.admin.as.mutation(api.corpusRequests.decline, {
              requestId: landmark[0] as Id<'waterBodyRequests'>,
              note: 'No',
            }),
          )
        ).kind,
      ).toBe('completed');
      await drainAll(w.t);
      expect(await statusesOf(w.t, landmark)).toEqual(['declined', 'declined']);
      // The undo of that: every one declined again.
      const reopen = await w.t.run(async (ctx) =>
        (await ctx.db.query('moderationActions').collect()).find(
          (r) => r.action === 'reopen_request',
        ),
      );
      expect(
        (
          await outcomeOf(() =>
            w.admin.as.mutation(api.undo.run, {
              actionId: reopen?._id as Id<'moderationActions'>,
              reason: 'Again',
            }),
          )
        ).kind,
      ).toBe('completed');
      await drainAll(w.t);
      expect(new Set(await statusesOf(w.t, w.asks))).toEqual(new Set(['declined']));
    });
  },
);

describe.each(['pending', 'ready'] as const)(
  'heavy rows: approving a heavy admit question — the Inbox %s',
  (mode) => {
    test('a heavy name refuses with its sentence; a heavy outline’s approval completes, every asker told once', async () => {
      // The question ten asks deep for the outline: the twenty-deep one carries the heavy name.
      const w = await heavyWorld();
      if (mode === 'ready') await markReady(w.t);
      // The name near the document limit is past the corpus's name cap: an honest refusal, nothing
      // written, every ask still open.
      expect(
        await outcomeOf(() =>
          w.admin.as.mutation(api.corpusRequests.approve, {
            requestId: w.asks[0] as Id<'waterBodyRequests'>,
          }),
        ),
      ).toEqual({
        kind: 'refused',
        why: 'The catalog’s name for this water is 921600 characters; keep it to 200. Decline this, or name it from the lake editor.',
      });
      expect(new Set(await statusesOf(w.t, w.asks))).toEqual(new Set(['open']));
      // The outline near the limit is admitted: ten asks of it, each ~860 KiB, for other water — more
      // than a page holds (a page reads into a quarter of what the transaction has left).
      const outline = { type: 'Polygon' as const, coordinates: [ring(48_000)] };
      const askers = w.people.slice(0, 10);
      const asks = await heavyAdmits(w.t, askers, 'catalog/outline', { polygon: outline });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const first = asks[0] as Id<'waterBodyRequests'>;
      let answer: { actionId: Id<'moderationActions'>; undoable: boolean } | undefined;
      const approve = await matrix({
        approve: async () => {
          answer = await w.admin.as.mutation(api.corpusRequests.approve, { requestId: first });
          return answer;
        },
      });
      expect(approve).toEqual({ approve: 'completed' });
      // Its answer, computed after its first page filled the transaction: its own row, undoable.
      expect(answer?.undoable).toBe(true);
      expect(
        (await w.t.run((ctx) => ctx.db.get(answer?.actionId as Id<'moderationActions'>)))?.targetId,
      ).toBe(first);
      expect(await drainAll(w.t)).toBeGreaterThan(0);
      expect(new Set(await statusesOf(w.t, asks))).toEqual(new Set(['approved']));
      // One body for the twenty, named on every ask the approval closed.
      const admitted = new Set<string>();
      for (const id of asks) {
        const ask = await w.t.run((ctx) => ctx.db.get(id));
        admitted.add(String(ask?.admittedWaterBodyId));
      }
      expect(admitted.size).toBe(1);
      // Every asker's message queued once, by the drain's every page.
      const queued = await w.t.run((ctx) => ctx.db.query('notificationQueue').collect());
      expect(
        queued
          .filter((r) => r.kind === 'request_decided')
          .map((r) => r.userId)
          .sort(),
      ).toEqual([...askers].sort());
      // And delivered: each message's re-check reads its ask whole (~860 KiB), so a batch of them
      // passes the flush's batch limit and it delivers them one at a time — every one, once.
      for (let pass = 0; pass < 30; pass++) {
        const due = await w.t.run((ctx) => ctx.db.query('notificationQueue').collect());
        if (due.length === 0) break;
        await w.t.run(async (ctx) => {
          for (const r of due) await ctx.db.patch(r._id, { flushAfter: Date.now() - 1 });
        });
        await w.t.mutation(internal.notifications.flushNotificationQueue, {});
      }
      const told = await w.t.run((ctx) => ctx.db.query('notifications').collect());
      expect(told.map((n) => n.userId).sort()).toEqual([...askers].sort());
      // Its undo completes, page by page: every ask open again.
      const decision = await w.t.run(async (ctx) =>
        (await ctx.db.query('moderationActions').collect()).find(
          (r) => r.action === 'approve_request' && r.targetId === first,
        ),
      );
      expect(
        (
          await outcomeOf(() =>
            w.admin.as.mutation(api.undo.run, {
              actionId: decision?._id as Id<'moderationActions'>,
              reason: 'Undone',
            }),
          )
        ).kind,
      ).toBe('completed');
      await drainAll(w.t);
      expect(new Set(await statusesOf(w.t, asks))).toEqual(new Set(['open']));
      // Ten outlines near the limit, written, approved, drained and reopened: ~10 s on a laptop.
    }, 90_000);
  },
);

/** `n` flags on one target, each with its longest note, each filed. */
async function heavyFlags(
  t: T,
  flaggers: Id<'profiles'>[],
  target: { targetType: Doc<'contentFlags'>['targetType']; targetId: string },
  reason: Doc<'contentFlags'>['reason'],
  subjectUserId?: Id<'profiles'>,
) {
  return t.run(async (ctx) => {
    const out: Id<'contentFlags'>[] = [];
    for (const flaggerId of flaggers) {
      const id = await ctx.db.insert('contentFlags', {
        flaggerId,
        ...target,
        reason,
        status: 'open',
        origin: 'user',
        note: maxText(1000),
        ...(subjectUserId ? { subjectUserId } : {}),
        createdAt: NOW - 10_000,
      });
      await fileMember(ctx, flagSource(id));
      out.push(id);
    }
    return out;
  });
}

describe('heavy rows: flags with their longest notes, tickets with their longest bodies', () => {
  test('every flag read answers; dismissal, takedown and ruling, each undone, complete', async () => {
    const w = await heavyWorld();
    await markReady(w.t);
    const author = w.people[0] as Id<'profiles'>;
    const report = await w.t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: author,
        waterBodyId: w.lake,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: NOW - 3_600_000,
        reportTime: NOW - 3_600_000,
        source: 'native',
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        notes: maxText(2000),
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: NOW - 3_600_000,
        updatedAt: NOW - 3_600_000,
      }),
    );
    const flaggers = w.people.slice(1);
    const flags = await heavyFlags(
      w.t,
      flaggers,
      { targetType: 'report', targetId: report },
      'spam',
      author,
    );
    await heavyFlags(
      w.t,
      flaggers,
      { targetType: 'waterbody', targetId: w.lake },
      'no_public_access',
    );
    const itemOf = (flag: Id<'contentFlags'> | undefined) =>
      w.t.run(async (ctx) => {
        const m = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) =>
            q.eq('sourceTable', 'contentFlags').eq('sourceId', flag as string),
          )
          .first();
        return m?.itemId as Id<'inboxItems'>;
      });
    const itemId = await itemOf(flags[0]);
    const reads = await matrix(READS(w, itemId, 'contentFlags'));
    expect(Object.values(reads).every((k) => k !== 'refused')).toBe(true);
    const access = await w.t.run(
      async (ctx) =>
        (await ctx.db.query('inboxItems').collect()).find((i) => i.kind === 'access')?._id,
    );
    const undo = (actionId: unknown) =>
      w.admin.as.mutation(api.undo.run, {
        actionId: actionId as Id<'moderationActions'>,
        reason: 'Undone',
      });
    const steps = await matrix({
      dismiss: async () => {
        const out = await w.admin.as.mutation(api.inboxWrites.dismissFlags, { itemId });
        await drainAll(w.t);
        await undo(out.actionId);
      },
      takeDown: async () => {
        const out = await w.admin.as.mutation(api.inboxWrites.takeDown, {
          itemId,
          status: 'hidden',
          reason: 'Checked',
        });
        await drainAll(w.t);
        await undo(out.actionId);
      },
      rule: async () => {
        const out = await w.admin.as.mutation(api.inboxWrites.ruleAccess, {
          itemId: access as Id<'inboxItems'>,
          verdict: 'none',
          reason: 'Posted',
        });
        await drainAll(w.t);
        await undo(out.actionId);
      },
    });
    expect(steps).toEqual({ dismiss: 'completed', takeDown: 'completed', rule: 'completed' });
    const open = await w.t.run(
      async (ctx) =>
        (await ctx.db.query('contentFlags').collect()).filter((f) => f.status === 'open').length,
    );
    expect(open).toBe(2 * flaggers.length);
  });

  test('tickets with their longest bodies: Support reads answer, a resolve completes', async () => {
    const w = await heavyWorld();
    const tickets = await w.t.run(async (ctx) => {
      const out: Id<'supportTickets'>[] = [];
      for (const userId of w.people) {
        const id = await ctx.db.insert('supportTickets', {
          userId,
          category: 'bug',
          body: maxText(5_000),
          status: 'open',
          createdAt: NOW - 10_000,
        });
        await fileMember(ctx, ticketSource(id));
        out.push(id);
      }
      return out;
    });
    const reads = await matrix({
      list: () => w.admin.as.query(api.inbox.listPage, { lane: 'support', pageSize: 100 }),
      item: () => w.admin.as.query(api.inbox.item, { ref: `ticket:${tickets[0]}` }),
      resolve: () =>
        w.admin.as.mutation(api.support.resolve, { ticketId: tickets[0] as Id<'supportTickets'> }),
    });
    expect(Object.values(reads).every((k) => k !== 'refused')).toBe(true);
  });
});

describe('heavy rows: drawn bodies with outlines near the document limit', () => {
  test('every read answers; an approval, its undo and a rejection complete', async () => {
    const w = await heavyWorld();
    await markReady(w.t);
    const outline = { type: 'Polygon' as const, coordinates: [ring(24_000)] };
    const drawn: Id<'waterBodies'>[] = [];
    for (const [i, by] of w.people.slice(0, 3).entries()) {
      drawn.push(
        await w.t.run(async (ctx) => {
          const id = (await ctx.db.insert('waterBodies', {
            name: `Drawn ${i}`,
            searchText: `Drawn ${i}`,
            type: 'lakePond',
            source: 'user',
            dedupStatus: 'clean',
            reviewStatus: 'pending',
            createdByUserId: by,
            polygon: outline,
            centroid: { lat: 0.5, lng: 0.5 },
            bbox: { minLat: 0.1, minLng: 0.1, maxLat: 0.9, maxLng: 0.9 },
            createdAt: NOW - 1000,
          } as never)) as Id<'waterBodies'>;
          const { bodySource } = await import('./lib/inboxItems');
          await fileMember(ctx, bodySource(id));
          return id;
        }),
      );
    }
    const reads = await matrix(READS(w, `body:${drawn[0]}`, 'drawnBodies'));
    expect(Object.values(reads).every((k) => k !== 'refused')).toBe(true);
    const steps = await matrix({
      approve: () =>
        w.admin.as.mutation(api.waterBodies.approve, {
          waterBodyId: drawn[0] as Id<'waterBodies'>,
        }),
      undoApproval: async () => {
        const row = await w.t.run(async (ctx) =>
          (await ctx.db.query('moderationActions').collect()).find(
            (r) => r.action === 'approve_waterbody',
          ),
        );
        return w.admin.as.mutation(api.undo.run, {
          actionId: row?._id as Id<'moderationActions'>,
          reason: 'Undone',
        });
      },
      reject: () =>
        w.admin.as.mutation(api.waterBodies.reject, { waterBodyId: drawn[1] as Id<'waterBodies'> }),
    });
    expect(steps).toEqual({ approve: 'completed', undoApproval: 'completed', reject: 'completed' });
  });
});
