/**
 * **Every record list pages to its end, each item once, whatever its documents weigh** (B01-4d,
 * Greptile on #134). A page that says `isDone: false` has returned a row or moved its cursor: its first
 * row is read whole before any other is admitted, and a document many rows share (fifty comments on
 * one Report) is read once a page. A property drives any mix of kinds and document sizes up to their
 * worst case through Standing, Reversed and Deleted; the pane's decisions are selected in the order it
 * shows them. Pinned seeds, plus one random seed, logged. Run under Convex's real limits.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { headFirst } from './contentRecord';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { OverBudget } from './lib/readBudget';
import { syncWithdrawalById } from './lib/withdrawals';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
const KIB = 1024;

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
  const t = convexTest({ schema, modules, transactionLimits: true });
  const ids = await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts', 'withdrawals'] as const) {
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
    const matt = await profile('matt', 'moderator');
    const waterBodyId = await ctx.db.insert('waterBodies', {
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
    return { rob, kate, matt, waterBodyId };
  });
  return { t, ...ids, mod: t.withIdentity({ subject: 'matt' }) };
}
type W = Awaited<ReturnType<typeof world>>;

/** A Report of about `bytes` (its notes — a legacy row can carry more than today's cap). */
function report(w: W, authorId: Id<'profiles'>, bytes: number, over: Partial<Doc<'reports'>> = {}) {
  return w.t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId: w.waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      notes: 'n'.repeat(bytes),
      createdAt: T0,
      updatedAt: T0,
      ...over,
    }),
  );
}

/** A comment `rob` deleted on Report `on`, at `at`. */
function deletedComment(w: W, on: Id<'reports'>, at: number) {
  return w.t.run(async (ctx) => {
    const id = await ctx.db.insert('comments', {
      reportId: on,
      authorId: w.rob,
      body: 'Fine, I’ll stop posting here.',
      moderationStatus: 'removed' as const,
      source: 'native' as const,
      authorDeletedAt: at,
      eraseAt: at + 30 * 86_400_000,
      createdAt: at - 1,
    } as never);
    // Its withdrawal row, as the author's delete writes it (B01-4m).
    await syncWithdrawalById(ctx, 'comment', id);
    return id;
  });
}

/** A verdict on an item of `rob`'s, standing or ended by a restore. */
async function verdict(
  w: W,
  targetType: 'report' | 'comment',
  targetId: string,
  at: number,
  ended: boolean,
) {
  await w.t.run(async (ctx) => {
    const actionId = await ctx.db.insert('moderationActions', {
      actorId: w.matt,
      action: 'hide',
      targetType,
      targetId,
      reason: 'hidden',
      metadata: { priorStatus: 'visible', newStatus: 'hidden' },
      createdAt: at,
    });
    const endedBy = ended
      ? await ctx.db.insert('moderationActions', {
          actorId: w.matt,
          action: 'restore',
          targetType,
          targetId,
          reason: 'Restored',
          metadata: { priorStatus: 'hidden', newStatus: 'visible', reasonDefaulted: true },
          createdAt: at + 1,
        })
      : undefined;
    await ctx.db.insert('contentVerdicts', {
      subjectUserId: w.rob,
      targetType,
      targetId,
      actionId,
      kind: 'hidden',
      at,
      standing: !ended,
      superseded: false,
      ...(endedBy ? { endedAt: at + 1, endedByActionId: endedBy } : {}),
    });
  });
}

type List = 'personVerdicts' | 'personReversed' | 'personDeleted';

/** Every page of a list from the start: it must end, and say how many pages it took. */
async function walk(w: W, list: List) {
  const ids: string[] = [];
  let pages = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { page: { targetId: string }[]; isDone: boolean; continueCursor: string } =
      await w.mod.query(api.contentRecord[list], { userId: w.rob, cursor });
    pages++;
    ids.push(...page.page.map((r) => r.targetId));
    if (page.isDone) return { ids, pages };
    // A page that isn't the last has moved the list on.
    expect(page.page.length > 0 || page.continueCursor !== cursor, `${list} moved on`).toBe(true);
    expect(pages, `${list} ends`).toBeLessThan(120);
    cursor = page.continueCursor;
  }
}

describe('headFirst', () => {
  test('the first row alone, then the rest; nothing read for no rows', async () => {
    const calls: number[][] = [];
    const shape = async (some: readonly number[]) => {
      calls.push([...some]);
      return some.map((n) => `${n}`);
    };
    expect(await headFirst([], shape)).toEqual([]);
    expect(await headFirst([7], shape)).toEqual(['7']);
    expect(await headFirst([1, 2, 3], shape)).toEqual(['1', '2', '3']);
    expect(calls).toEqual([[7], [1], [2, 3]]);
  });

  test('a first row that doesn’t come back whole is a plan error, never an empty page', async () => {
    await expect(headFirst([1, 2], async () => [])).rejects.toThrow(OverBudget);
  });
});

describe('a page always moves on', () => {
  test('fifteen whole-document Reports on Standing and Reversed: cut, carried on, each once', async () => {
    const w = await world();
    const want = { standing: [] as string[], reversed: [] as string[] };
    for (let i = 0; i < 15; i++) {
      for (const list of ['standing', 'reversed'] as const) {
        const id = await report(w, w.rob, 900 * KIB, { moderationStatus: 'hidden' });
        await verdict(w, 'report', id, T0 - 100_000 + i * 10, list === 'reversed');
        want[list].push(id);
      }
    }
    for (const [list, key] of [
      ['personVerdicts', 'standing'],
      ['personReversed', 'reversed'],
    ] as const) {
      const { ids, pages } = await walk(w, list);
      expect([...ids].sort(), list).toEqual([...want[key]].sort());
      // Fifteen whole documents don't fit one page's budget: the page was cut and the next went on.
      expect(pages, list).toBeGreaterThan(1);
    }
  });

  test('Greptile’s case: fifty deleted comments on one ~250 KiB Report, every one listed once', async () => {
    const w = await world();
    const on = await report(w, w.kate, 250 * KIB);
    const want: string[] = [];
    for (let i = 0; i < 50; i++) want.push(await deletedComment(w, on, T0 - 10_000 + i));
    const { ids, pages } = await walk(w, 'personDeleted');
    expect([...ids].sort()).toEqual([...want].sort());
    expect(new Set(ids).size).toBe(50);
    // The Report is read once a page, so the comments come a page's worth at a time.
    expect(pages).toBeLessThanOrEqual(2);
  });

  test.each([20261115, 9, Math.floor(Math.random() * 2 ** 31)])(
    'any mix of kinds and sizes up to their worst case pages to its end, each item once (seed %i)',
    async (seed) => {
      console.log(`recordPaging seed ${seed}`);
      const SIZES = [64, 250 * KIB, 900 * KIB];
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              kind: fc.constantFrom('report' as const, 'comment' as const),
              size: fc.constantFrom(...SIZES),
              list: fc.constantFrom('standing' as const, 'reversed' as const, 'deleted' as const),
              shared: fc.boolean(),
            }),
            { minLength: 1, maxLength: 7 },
          ),
          async (items) => {
            vi.setSystemTime(T0);
            const w = await world();
            const shared = await report(w, w.kate, 900 * KIB);
            const want: Record<'standing' | 'reversed' | 'deleted', string[]> = {
              standing: [],
              reversed: [],
              deleted: [],
            };
            let at = T0 - 100_000;
            for (const it of items) {
              at += 10;
              let id: string;
              if (it.kind === 'comment') {
                // A comment on a heavy Report: the one shared, or its own.
                const on = it.shared ? shared : await report(w, w.kate, it.size);
                id =
                  it.list === 'deleted'
                    ? await deletedComment(w, on, at)
                    : await w.t.run((ctx) =>
                        ctx.db.insert('comments', {
                          reportId: on,
                          authorId: w.rob,
                          body: 'b',
                          moderationStatus: 'hidden' as const,
                          source: 'native' as const,
                          createdAt: at,
                        } as never),
                      );
              } else {
                // A heavy Report of rob's own.
                id = await report(w, w.rob, it.size, {
                  moderationStatus: it.list === 'deleted' ? 'removed' : 'hidden',
                  ...(it.list === 'deleted' ? { authorDeletedAt: at } : {}),
                });
                if (it.list === 'deleted') {
                  const reportId = id;
                  await w.t.run((ctx) => syncWithdrawalById(ctx, 'report', reportId));
                }
              }
              if (it.list !== 'deleted') await verdict(w, it.kind, id, at, it.list === 'reversed');
              want[it.list].push(id);
            }
            for (const [list, key] of [
              ['personVerdicts', 'standing'],
              ['personReversed', 'reversed'],
              ['personDeleted', 'deleted'],
            ] as const) {
              const { ids } = await walk(w, list);
              expect([...ids].sort(), list).toEqual([...want[key]].sort());
            }
            // Presence is never false while its list shows a row.
            const presence = await w.mod.query(api.contentRecord.recordPresence, { userId: w.rob });
            if (want.deleted.length > 0) expect(presence.deleted).toBe(true);
            if (want.reversed.length > 0) expect(presence.reversed).toBe(true);
          },
        ),
        { seed, numRuns: 3 },
      );
    },
  );
});

describe('the pane selects its decisions in the order it shows them', () => {
  test('51 older verdicts backfilled after a newer one: the newer is shown, and the list is capped', async () => {
    const w = await world();
    const r = await report(w, w.rob, 64);
    // The newer decision exists first (inserted first, so its creation time is the earliest)…
    await verdict(w, 'report', r, T0 - 1_000, true);
    // …then a backfill inserts 51 older ones.
    for (let i = 0; i < 51; i++) await verdict(w, 'report', r, T0 - 500_000 + i * 10, true);
    const pane = await w.mod.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    expect(pane?.decisions[0]?.at).toBe(T0 - 1_000);
    expect(pane?.decisionsCapped).toBe(true);
    // Newest first throughout.
    const ats = (pane?.decisions ?? []).map((d) => d.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  test('a standing decision older than the newest fifty is still shown, last', async () => {
    const w = await world();
    const r = await report(w, w.rob, 64);
    await verdict(w, 'report', r, T0 - 900_000, false);
    for (let i = 0; i < 51; i++) await verdict(w, 'report', r, T0 - 500_000 + i * 10, true);
    const pane = await w.mod.query(api.contentRecord.item, { targetType: 'report', targetId: r });
    expect(pane?.decisions).toHaveLength(51);
    expect(pane?.decisions.at(-1)).toMatchObject({ at: T0 - 900_000, standing: true });
    expect(pane?.decisions.filter((d) => d.standing)).toHaveLength(1);
    expect(pane?.decisionsCapped).toBe(true);
  });
});
