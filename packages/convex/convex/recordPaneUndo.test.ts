/**
 * **The record pane's decisions carry the write that ended them, and its undo where the pane offers
 * one** (B01-4h; server half — the web half follows its toast work). Each decision says `endActionId`
 * (absent while it stands); the item's newest decision, while Reversed, says that write's undo state
 * for this viewer, exactly as History says it (`moderation.listActions`) — so the pane can offer the
 * Undo of a restore it opened from any list, not only from a Reversed row handed to it. Every older
 * decision's `undo` is absent: a newer decision's write overtook its ending. And the pane at its
 * deepest — more decisions than it reads, the newest restored — stays inside the request's budget.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { itemPane } from './contentRecord';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { TX_CALLS } from './lib/readBudget';
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
  moderatorDecision: false,
};

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
  const rob = await profile('rob', 'moderator');
  const matt = await profile('matt', 'moderator');
  const reportId = await t.run(async (ctx) => {
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
    return ctx.db.insert('reports', {
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
  });
  return {
    t,
    rob,
    matt,
    reportId,
    mod: t.withIdentity({ subject: 'matt' }),
    // The author is a moderator too: their own record's undo is another moderator's to make (D269).
    author: t.withIdentity({ subject: 'rob' }),
  };
}
type W = Awaited<ReturnType<typeof world>>;

const set = (w: W, status: 'visible' | 'hidden') => {
  vi.advanceTimersByTime(1_000);
  return w.mod.mutation(api.moderation.setModerationStatus, {
    targetType: 'report',
    targetId: w.reportId,
    status,
    ...(status === 'hidden' ? { reason: 'unsafe claim' } : {}),
  });
};

const pane = (w: W, who: 'mod' | 'author' = 'mod') =>
  w[who].query(api.contentRecord.item, { targetType: 'report', targetId: w.reportId });

/** History's undo state for a row, as the moderator reads it. */
async function historyUndo(w: W, actionId: Id<'moderationActions'>, who: 'mod' | 'author' = 'mod') {
  const rows = await w[who].query(api.moderation.listActions, {
    targetType: 'report',
    targetId: w.reportId,
  });
  return rows.find((r) => r.id === actionId)?.undo;
}

describe('the pane’s decisions name the write that ended them', () => {
  test('the newest, restored: its ending and its undo, as History says them; the older: the id only', async () => {
    const w = await world();
    await set(w, 'hidden');
    const first = await set(w, 'visible');
    await set(w, 'hidden');
    const second = await set(w, 'visible');
    const p = await pane(w);
    const [newest, older] = p?.decisions ?? [];
    expect(newest).toMatchObject({ endedHow: 'restore', endActionId: second.actionId });
    expect(newest?.undo).toEqual(await historyUndo(w, second.actionId));
    expect(newest?.undo).toEqual({ state: 'available', needsReason: true });
    // Overtaken by the hide that made the newer decision: the id, no undo to read.
    expect(older).toMatchObject({ endedHow: 'restore', endActionId: first.actionId });
    expect(older?.undo).toBeUndefined();
    expect(await historyUndo(w, first.actionId)).toMatchObject({ state: 'overtaken' });

    // The pane's Undo is the restore's: run by the id it names, the decision stands again.
    await w.mod.mutation(api.undo.run, { actionId: second.actionId, reason: 'it was right' });
    const after = await pane(w);
    expect(after?.decisions[0]).toMatchObject({ standing: true });
    expect(after?.decisions[0]?.endActionId).toBeUndefined();
    expect(after?.decisions[0]?.undo).toBeUndefined();
  });

  test('for the author — a moderator too — the undo says why not, as History does', async () => {
    const w = await world();
    await set(w, 'hidden');
    const restore = await set(w, 'visible');
    const mine = (await pane(w, 'author'))?.decisions[0];
    expect(mine?.undo).toMatchObject({ state: 'unavailable' });
    expect(mine?.undo).toEqual(await historyUndo(w, restore.actionId, 'author'));
  });

  test('a decision undone: its ending is the undo, whose own undo (the redo) the pane reads', async () => {
    const w = await world();
    const hide = await set(w, 'hidden');
    await w.mod.mutation(api.undo.run, { actionId: hide.actionId });
    const decision = (await pane(w))?.decisions[0];
    expect(decision).toMatchObject({ endedHow: 'undo' });
    expect(decision?.endActionId).toBeDefined();
    expect(decision?.undo).toEqual(
      await historyUndo(w, decision?.endActionId as Id<'moderationActions'>),
    );
  });
});

/** A query's view of `ctx` whose database calls are counted (as `recordRounds.test.ts` counts them). */
function counted(ctx: MutationCtx) {
  const stats = { calls: 0 };
  const track = <R>(p: Promise<R>): Promise<R> => {
    stats.calls++;
    return p;
  };
  const TERMINAL = new Set(['first', 'unique', 'take', 'collect', 'paginate']);
  const wrapQuery = (q: unknown): unknown =>
    new Proxy(q as object, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return TERMINAL.has(String(key)) ? track(out as Promise<unknown>) : wrapQuery(out);
        };
      },
    });
  const db = {
    get: (id: never) => track(ctx.db.get(id)),
    query: (table: never) => wrapQuery(ctx.db.query(table)),
    normalizeId: ctx.db.normalizeId.bind(ctx.db),
    system: ctx.db.system,
  };
  return { ctx: { ...ctx, db } as unknown as QueryCtx, stats };
}

describe('the pane at its deepest stays inside its budget', () => {
  test('52 decisions, the newest restored: the newest 50 read, the undo read, calls counted', async () => {
    const w = await world();
    for (let i = 0; i < 52; i++) {
      await set(w, 'hidden');
      await set(w, 'visible');
    }
    const { calls, out } = await w.t.run(async (ctx) => {
      const viewer = (await ctx.db.get(w.matt)) as Doc<'profiles'>;
      const c = counted(ctx);
      const out = await itemPane(c.ctx, viewer, { targetType: 'report', targetId: w.reportId });
      return { calls: c.stats.calls, out };
    });
    expect(out?.decisions).toHaveLength(50);
    expect(out?.decisionsCapped).toBe(true);
    expect(out?.decisions[0]?.undo).toEqual({ state: 'available', needsReason: true });
    expect(out?.decisions.slice(1).every((d) => d.undo === undefined && d.endActionId)).toBe(true);
    // Two reads a decision (its row and its ending), the item, the undo's first step (3) and the rest
    // of the pane — far inside the transaction's calls.
    expect(calls).toBeLessThan(2 * 50 + 20);
    expect(calls).toBeLessThan(TX_CALLS);
    console.log(`record pane calls at its deepest: ${calls}`);
  });
});
