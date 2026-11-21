/**
 * **A continuation is the same act, in another transaction** (B01-5, PR #170). Every paged operation
 * — a flag decision's undo, a flag decision's later flags, a request decision's undo, a re-decline,
 * the sibling drain — is forced into pages (`PAGE_SEAM`), and between its first page and the rest a
 * write that can matter lands: the reporter files again, a colleague decides one of the remaining
 * sources, the asker withdraws one, the act is undone, the undo is undone, the actor is suspended.
 * The end state must be what the rule says — the per-source rule re-checked in the transaction that
 * applies it, the act stopping once it is undone, every later row written with the links its first
 * page's rows carry — and the stored Inbox must still be what its sources say.
 */

import { requestNameKeyFor } from '@skating/core';
import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { fileMember, PAGE_SEAM, requestSource } from './lib/inboxItems';
import { inboxDrift } from './lib/inboxRepair';
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
};

beforeEach(() => {
  PAGE_SEAM.sources = 2;
});
afterEach(() => {
  PAGE_SEAM.sources = Number.POSITIVE_INFINITY;
});

const CONTINUATIONS = new Set([
  'corpusRequests:closeSiblings',
  'inboxWrites:closeFlagsRest',
  'inboxWrites:reopenRequestsRest',
  'inboxWrites:closeRequestsRest',
  'inboxWrites:reopenFlagsRest',
]);

/** Every continuation still waiting, run to the end — each its own execution. */
async function drain(t: T) {
  const seen = new Set<string>();
  for (let pages = 0; pages < 200; pages++) {
    const next = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).find(
      (s) => !seen.has(s._id) && s.state.kind === 'pending' && CONTINUATIONS.has(s.name),
    );
    if (!next) return pages;
    seen.add(next._id);
    await t.mutation(makeFunctionReference<'mutation'>(next.name), next.args[0] as never);
  }
  throw new Error('a continuation never ended');
}

/** Whether a continuation is waiting — the act is mid-way. */
const midway = async (t: T) =>
  (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).some(
    (s) => s.state.kind === 'pending' && CONTINUATIONS.has(s.name),
  );

async function world() {
  const t = harness();
  const person = async (subject: string, role: 'member' | 'moderator' | 'admin' = 'member') => {
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
  };
  const actor = await person('actor', 'admin');
  const colleague = await person('colleague', 'admin');
  const people: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> }[] = [];
  for (let i = 0; i < 6; i++) people.push(await person(`p${i}`));
  const lake = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Pond',
      searchText: 'Pond',
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      centroid: { lat: 0.5, lng: 0.5 },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      createdAt: NOW,
    } as never),
  );
  const report = await t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId: people[5]?.id as Id<'profiles'>,
      waterBodyId: lake,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: NOW - 3_600_000,
      reportTime: NOW - 3_600_000,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 3_600_000,
    }),
  );
  return { t, actor, colleague, people, lake, report };
}
type W = Awaited<ReturnType<typeof world>>;

/** Five reporters' flags on the report, filed into its Content item. */
async function flags(w: W) {
  const ids: Id<'contentFlags'>[] = [];
  for (const p of w.people.slice(0, 5)) {
    ids.push(
      await p.as.mutation(api.contentFlags.flag, {
        targetType: 'report',
        targetId: w.report,
        reason: 'spam',
      }),
    );
  }
  return ids;
}

/** Five bay asks for one bay, filed into its item. */
async function asks(w: W) {
  const ids = await w.t.run(async (ctx) => {
    const out: Id<'waterBodyRequests'>[] = [];
    for (const [i, p] of w.people.slice(0, 5).entries()) {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        requesterId: p.id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: w.lake,
        name: 'North Bay',
        nameKey: requestNameKeyFor('name_bay', 'North Bay'),
        createdAt: NOW - 1000 + i,
      });
      await fileMember(ctx, requestSource(id));
      out.push(id);
    }
    return out;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return ids;
}

const itemOfFlag = (w: W, id: Id<'contentFlags'>) =>
  w.t.run(async (ctx) => {
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', id))
      .first();
    return m?.itemId as Id<'inboxItems'>;
  });

const statuses = (w: W, ids: readonly string[]) =>
  w.t.run(async (ctx) =>
    Promise.all(ids.map(async (id) => (await ctx.db.get(id as Id<'contentFlags'>))?.status)),
  );

const rowsOf = (w: W, action: string) =>
  w.t.run(async (ctx) =>
    (await ctx.db.query('moderationActions').collect()).filter((r) => r.action === action),
  );

/** The stored Inbox is what its sources say: no item the repair would fix. */
async function noDrift(w: W) {
  const drift = await w.t.run(async (ctx) => {
    const out: string[] = [];
    for (const item of await ctx.db.query('inboxItems').collect()) {
      const kinds = await inboxDrift(ctx, item);
      if (kinds.length > 0) out.push(`${item.key}: ${kinds.join(',')}`);
    }
    return out;
  });
  expect(drift).toEqual([]);
}

const undo = (who: W['actor'], actionId: Id<'moderationActions'>) =>
  who.as.mutation(api.undo.run, { actionId, reason: 'Undone' });

describe('a flag decision’s undo, paged', () => {
  /** Five flags dismissed, then the dismissal undone — its first page reopens two. */
  async function reopening(w: W) {
    const ids = await flags(w);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOfFlag(w, ids[0] as Id<'contentFlags'>),
    });
    await drain(w.t);
    await undo(w.actor, out.actionId);
    expect(await midway(w.t)).toBe(true);
    return { ids, dismissal: out.actionId };
  }

  test('uninterrupted: every flag reopens, every later row linked to the undo as the first page’s are', async () => {
    const w = await world();
    const { ids, dismissal } = await reopening(w);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['open']));
    const rows = await rowsOf(w, 'reopen_flag');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.undoesActionId)).toEqual(Array(5).fill(dismissal));
    expect(new Set(rows.map((r) => r.undoRoot))).toEqual(new Set([dismissal]));
    expect(new Set(rows.map((r) => r.undoDepth))).toEqual(new Set([1]));
    await noDrift(w);
  });

  test('the reporter files again between pages: their old flag stays closed, recorded; one open flag each', async () => {
    const w = await world();
    const { ids } = await reopening(w);
    // The last reporter's flag is on a later page, still closed: they file again.
    const reporter = w.people[4] as W['actor'];
    const fresh = await reporter.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: w.report,
      reason: 'spam',
    });
    await drain(w.t);
    const old = ids[4] as Id<'contentFlags'>;
    expect(await statuses(w, [old, fresh])).toEqual(['dismissed', 'open']);
    const open = await w.t.run(async (ctx) =>
      (await ctx.db.query('contentFlags').collect()).filter(
        (f) => f.flaggerId === reporter.id && f.status === 'open',
      ),
    );
    expect(open).toHaveLength(1);
    const lead = (await rowsOf(w, 'reopen_flag')).find((r) => r.metadata?.reopened);
    expect(lead?.metadata?.flagsLeftClosed?.map((l: { flagId: string }) => l.flagId)).toEqual([
      old,
    ]);
    expect(lead?.metadata?.reopened).not.toContain(old);
    await noDrift(w);
    // The undo of the undo closes what reopened, and only that.
    await undo(w.actor, lead?._id as Id<'moderationActions'>);
    await drain(w.t);
    expect(await statuses(w, [...ids.slice(0, 4), fresh])).toEqual([
      'dismissed',
      'dismissed',
      'dismissed',
      'dismissed',
      'open',
    ]);
  });

  test('the undo is undone between pages: the later pages reopen nothing more', async () => {
    const w = await world();
    const { ids } = await reopening(w);
    const lead = (await rowsOf(w, 'reopen_flag')).find((r) => r.metadata?.reopened);
    await undo(w.actor, lead?._id as Id<'moderationActions'>);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['dismissed']));
    await noDrift(w);
  });

  test('the actor is suspended between pages: the act they made completes, as one act', async () => {
    const w = await world();
    const { ids } = await reopening(w);
    await w.t.run((ctx) => ctx.db.patch(w.actor.id, { status: 'suspended' }));
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['open']));
    await noDrift(w);
  });
});

describe('a flag reopen undone (the flags closed again), paged', () => {
  test('every later page’s rows carry the undo’s link and chain', async () => {
    const w = await world();
    const ids = await flags(w);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOfFlag(w, ids[0] as Id<'contentFlags'>),
    });
    await drain(w.t);
    await undo(w.actor, out.actionId);
    await drain(w.t);
    const lead = (await rowsOf(w, 'reopen_flag')).find((r) => r.metadata?.reopened);
    await undo(w.actor, lead?._id as Id<'moderationActions'>);
    expect(await midway(w.t)).toBe(true);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['dismissed']));
    const reclosed = (await rowsOf(w, 'dismiss_flag')).filter(
      (r) => r.undoesActionId === lead?._id,
    );
    expect(reclosed).toHaveLength(5);
    expect(new Set(reclosed.map((r) => r.undoDepth))).toEqual(new Set([2]));
    await noDrift(w);
  });
});

describe('a flag decision, paged (a takedown’s later flags)', () => {
  async function takingDown(w: W) {
    const ids = await flags(w);
    const out = await w.actor.as.mutation(api.inboxWrites.takeDown, {
      itemId: await itemOfFlag(w, ids[0] as Id<'contentFlags'>),
      status: 'hidden',
      reason: 'Checked',
    });
    expect(await midway(w.t)).toBe(true);
    return { ids, takedown: out.actionId };
  }

  test('a reporter withdraws a remaining flag: it stays withdrawn, never closed after', async () => {
    const w = await world();
    const { ids } = await takingDown(w);
    await (w.people[4] as W['actor']).as.mutation(api.contentFlags.retract, {
      flagId: ids[4] as Id<'contentFlags'>,
    });
    await drain(w.t);
    expect(await statuses(w, ids)).toEqual([
      'actioned',
      'actioned',
      'actioned',
      'actioned',
      'retracted',
    ]);
    await noDrift(w);
  });

  test('a colleague decides a remaining flag: it keeps the colleague’s decision', async () => {
    const w = await world();
    const { ids } = await takingDown(w);
    await w.colleague.as.mutation(api.moderation.resolveFlag, {
      flagId: ids[4] as Id<'contentFlags'>,
      resolution: 'dismissed',
      reason: 'Not this one',
    });
    await drain(w.t);
    const last = await w.t.run((ctx) => ctx.db.get(ids[4] as Id<'contentFlags'>));
    expect(last).toMatchObject({ status: 'dismissed', resolvedByUserId: w.colleague.id });
    await noDrift(w);
  });

  test('the takedown is undone between pages: the flags it hadn’t reached stay open', async () => {
    const w = await world();
    const { ids, takedown } = await takingDown(w);
    await undo(w.actor, takedown);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['open']));
    await noDrift(w);
  });
});

describe('a request decision, paged: the drain, the undo, the re-decline', () => {
  /** Five asks declined from the first — its first page closes the primary and one sibling. */
  async function declining(w: W) {
    const ids = await asks(w);
    await w.actor.as.mutation(api.corpusRequests.decline, {
      requestId: ids[0] as Id<'waterBodyRequests'>,
      note: 'No',
    });
    expect(await midway(w.t)).toBe(true);
    const decision = (await rowsOf(w, 'decline_request')).find((r) => r.targetId === ids[0]);
    return { ids, decision: decision?._id as Id<'moderationActions'> };
  }

  // (An asker can't withdraw an ask once a moderator acted on its question — the retraction's own
  // rule — so a withdrawal can't land between a decision's pages.)
  test('the drain: a colleague decides a remaining ask, and a new ask is filed', async () => {
    const w = await world();
    const { ids } = await declining(w);
    await w.colleague.as.mutation(api.corpusRequests.decline, {
      requestId: ids[3] as Id<'waterBodyRequests'>,
      note: 'Mine',
    });
    const later = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        requesterId: (w.people[5] as W['actor']).id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: w.lake,
        name: 'North Bay',
        nameKey: requestNameKeyFor('name_bay', 'North Bay'),
        createdAt: Date.now(),
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    await drain(w.t);
    expect(await statuses(w, [...ids, later])).toEqual([
      'declined',
      'declined',
      'declined',
      'declined',
      'declined',
      'open',
    ]);
    const colleagues = await w.t.run((ctx) => ctx.db.get(ids[3] as Id<'waterBodyRequests'>));
    expect(colleagues?.decidedByUserId).toBe(w.colleague.id);
    await noDrift(w);
  });

  test('the decision is undone between drain pages: the drain stops, and every ask is open', async () => {
    const w = await world();
    const { ids, decision } = await declining(w);
    await undo(w.actor, decision);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['open']));
    await noDrift(w);
  });

  /** Declined in full, then undone — the undo's first page reopens two. */
  async function reopening(w: W) {
    const { ids, decision } = await declining(w);
    await drain(w.t);
    await undo(w.actor, decision);
    expect(await midway(w.t)).toBe(true);
    const reopen = (await rowsOf(w, 'reopen_request'))[0];
    return { ids, decision, reopen: reopen?._id as Id<'moderationActions'> };
  }

  test('the request undo: uninterrupted every ask reopens; undone between pages, the rest stay declined', async () => {
    const w = await world();
    const { ids } = await reopening(w);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['open']));
    await noDrift(w);

    const w2 = await world();
    const second = await reopening(w2);
    const firstPage = await statuses(w2, second.ids);
    await undo(w2.actor, second.reopen);
    await drain(w2.t);
    expect(new Set(await statuses(w2, second.ids))).toEqual(new Set(['declined']));
    expect(firstPage.filter((s) => s === 'open').length).toBeGreaterThan(0);
    await noDrift(w2);
  });

  /** Reopened in full, then the reopen undone — the re-decline's first page closes two. */
  async function redeclining(w: W) {
    const r = await reopening(w);
    await drain(w.t);
    await undo(w.actor, r.reopen);
    expect(await midway(w.t)).toBe(true);
    return r;
  }

  test('the re-decline: every later row linked to the undo; a colleague’s decision kept', async () => {
    const w = await world();
    const { ids, reopen } = await redeclining(w);
    await w.colleague.as.mutation(api.corpusRequests.decline, {
      requestId: ids[3] as Id<'waterBodyRequests'>,
      note: 'Mine',
    });
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['declined']));
    const redeclined = (await rowsOf(w, 'decline_request')).filter(
      (r) => r.undoesActionId === reopen,
    );
    // The primary and the first page's siblings, linked to the undo. The colleague's decline answered
    // the same question — its own drain closed the last ask — so the later page found both decided.
    expect(redeclined.map((r) => r.targetId).sort()).toEqual(
      [ids[0], ids[1], ids[2]].map(String).sort(),
    );
    const last = await w.t.run((ctx) => ctx.db.get(ids[4] as Id<'waterBodyRequests'>));
    expect(last?.decidedByUserId).toBe(w.colleague.id);
    await noDrift(w);
  });

  test('the re-decline uninterrupted: every row of every page carries the undo’s link and chain', async () => {
    const w = await world();
    const { ids, reopen } = await redeclining(w);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['declined']));
    const redeclined = (await rowsOf(w, 'decline_request')).filter(
      (r) => r.undoesActionId === reopen,
    );
    expect(redeclined.map((r) => r.targetId).sort()).toEqual(ids.map(String).sort());
    expect(new Set(redeclined.map((r) => r.undoDepth))).toEqual(new Set([2]));
    await noDrift(w);
  });

  test('the re-decline undone between pages: the asks it hadn’t reached stay open', async () => {
    const w = await world();
    const { ids } = await redeclining(w);
    const redecline = (await rowsOf(w, 'decline_request')).find(
      (r) => r.undoesActionId !== undefined && r.targetId === ids[0],
    );
    await undo(w.actor, redecline?._id as Id<'moderationActions'>);
    await drain(w.t);
    expect(new Set(await statuses(w, ids))).toEqual(new Set(['open']));
    await noDrift(w);
  });
});
