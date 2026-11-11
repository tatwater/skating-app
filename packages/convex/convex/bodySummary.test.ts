import { SUMMARY_RECENT_DAYS, SUMMARY_WINDOW_MS, summaryHasCard } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { recomputeBodySummary } from './lib/bodySummary';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY_MS = 86_400_000;

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

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  };
}

async function seedBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      searchText: 'Test Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01),
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44.0, lng: -72.0 },
      states: ['VT'],
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

let seq = 0;
async function seedAuthor(t: ReturnType<typeof convexTest>): Promise<Id<'profiles'>> {
  const n = seq++;
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: `sum-author-${n}`,
      displayName: 'a',
      username: `sum-a-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'profiles'>>;
}

async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  over: { skateQuality?: 'great' | 'good' | 'fair' | 'poor'; hidden?: boolean } = {},
): Promise<Id<'reports'>> {
  const authorId = await seedAuthor(t);
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 44.0, lng: -72.0 },
      skateEndTime,
      reportTime: now,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: over.hidden ? ('hidden' as const) : ('visible' as const),
      ...(over.skateQuality ? { skateQuality: over.skateQuality } : {}),
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  ) as Promise<Id<'reports'>>;
}

async function seedHazard(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  type: 'open_water' | 'thin_ice' | 'pressure_ridge',
  status: 'active' | 'archived' = 'active',
): Promise<Id<'hazards'>> {
  const authorId = await seedAuthor(t);
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point', coordinates: [-72.0, 44.0] },
      radiusMeters: 30,
      bbox: { minLat: 43.999, minLng: -72.001, maxLat: 44.001, maxLng: -71.999 },
      createdByUserId: authorId,
      photoIds: [],
      status,
      moderationStatus: 'visible' as const,
      firstReportedAt: now,
      lastConfirmedAt: now,
      confirmCount: 0,
      goneCount: 0,
      createdAt: now,
    }),
  ) as Promise<Id<'hazards'>>;
}

async function seedAuthorId(t: ReturnType<typeof convexTest>): Promise<Id<'profiles'>> {
  return seedAuthor(t);
}

function summaryOf(t: ReturnType<typeof convexTest>, id: Id<'waterBodies'>) {
  return t.run(async (ctx) => (await ctx.db.get(id))?.summary);
}

describe('recomputeBodySummary', () => {
  test('counts visible reports inside the window', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    await seedReport(t, waterBodyId, now - DAY_MS);
    await seedReport(t, waterBodyId, now - 2 * DAY_MS);
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId, now));

    const summary = await summaryOf(t, waterBodyId);
    expect(summary?.recentReportCount).toBe(2);
    expect(summary?.latestReportAt).toBe(now - DAY_MS);
  });

  test('excludes a report that has aged out of the window', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    await seedReport(t, waterBodyId, now - (SUMMARY_RECENT_DAYS + 3) * DAY_MS);
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId, now));

    expect(await summaryOf(t, waterBodyId)).toMatchObject({ recentReportCount: 0 });
  });

  test('excludes a hidden report, so moderating one takes it off the card', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    await seedReport(t, waterBodyId, now - DAY_MS, { hidden: true });
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId, now));

    expect((await summaryOf(t, waterBodyId))?.recentReportCount).toBe(0);
  });

  test('names active hazard types by frequency and ignores archived ones', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, 'open_water');
    await seedHazard(t, waterBodyId, 'open_water');
    await seedHazard(t, waterBodyId, 'thin_ice');
    await seedHazard(t, waterBodyId, 'pressure_ridge', 'archived');
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));

    expect((await summaryOf(t, waterBodyId))?.topHazardTypes).toEqual(['open_water', 'thin_ice']);
  });

  /** D86: below quorum there are no dots at all, which is a different state from "bad ice". */
  test('withholds the quality mark below quorum', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    await seedReport(t, waterBodyId, now - DAY_MS, { skateQuality: 'poor' });
    await seedReport(t, waterBodyId, now - 2 * DAY_MS, { skateQuality: 'poor' });
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId, now));

    const summary = await summaryOf(t, waterBodyId);
    expect(summary?.recentReportCount).toBe(2);
    expect(summary?.qualityDots).toBeUndefined();
  });

  test('renders the mark once three reports have rated it', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    await seedReport(t, waterBodyId, now - DAY_MS, { skateQuality: 'great' });
    await seedReport(t, waterBodyId, now - 2 * DAY_MS, { skateQuality: 'great' });
    await seedReport(t, waterBodyId, now - 3 * DAY_MS, { skateQuality: 'good' });
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId, now));

    const summary = await summaryOf(t, waterBodyId);
    expect(summary?.qualityDots).toBe(4);
    expect(summary?.qualityCount).toBe(3);
  });

  test('a body with no activity gets a summary that draws no card', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));

    const summary = await summaryOf(t, waterBodyId);
    expect(summary?.recentReportCount).toBe(0);
    expect(summary?.topHazardTypes).toEqual([]);
  });
});

describe('waterBodies.sweepAllBodySummaries', () => {
  /**
   * The decay the event paths cannot catch: nothing writes when a report merely gets old, so
   * without this tick a lake busy in January still shows January's card in March.
   */
  test('re-derives a stale card whose reports have aged out', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    // A report that WAS recent when the card was written, and no longer is.
    await seedReport(t, waterBodyId, now - (SUMMARY_RECENT_DAYS + 2) * DAY_MS);
    await t.run((ctx) =>
      ctx.db.patch(waterBodyId, {
        summary: {
          recentReportCount: 5,
          topHazardTypes: ['thin_ice'],
          updatedAt: now - 30 * DAY_MS,
        },
      }),
    );

    await t.action(internal.waterBodies.sweepAllBodySummaries, {});

    const summary = await summaryOf(t, waterBodyId);
    expect(summary?.recentReportCount).toBe(0);
    expect(summary?.topHazardTypes).toEqual([]);
  });

  test('leaves a body with no summary alone', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);

    await t.action(internal.waterBodies.sweepAllBodySummaries, {});

    // Convex serializes an absent optional as `null` across the `t.run` boundary.
    expect(await summaryOf(t, waterBodyId)).toBeNull();
  });
});

describe('the due sweep — bodySummaryRefreshes', () => {
  // A fixed mid-winter clock, so a season boundary cannot fall inside a window by accident. Only
  // `Date` is faked: convex-test schedules with real timers.
  const NOW = Date.UTC(2027, 0, 20, 12);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const refreshRows = (t: ReturnType<typeof convexTest>) =>
    t.run((ctx) => ctx.db.query('bodySummaryRefreshes').collect());

  /** Run the full walk once, so the tick reads only due rows from here on. */
  const backfill = (t: ReturnType<typeof convexTest>) =>
    t.action(internal.waterBodies.sweepAllBodySummaries, {});

  /** A card that says something the body's reports do not — a recompute would overwrite it. */
  const plantStaleCard = (t: ReturnType<typeof convexTest>, id: Id<'waterBodies'>) =>
    t.run((ctx) =>
      ctx.db.patch(id, {
        summary: { recentReportCount: 9, topHazardTypes: ['thin_ice'], updatedAt: NOW - DAY_MS },
      }),
    );

  test('a recompute records when the card next changes; no report in the window, no row', async () => {
    const t = convexTest(schema, modules);
    const busy = await seedBody(t);
    const oldest = NOW - 10 * DAY_MS;
    await seedReport(t, busy, NOW - 2 * DAY_MS);
    await seedReport(t, busy, oldest);
    // Hidden reports count too: an early refresh is cheap, a late one is a stale card.
    await seedReport(t, busy, NOW - 3 * DAY_MS, { hidden: true });
    const hazardOnly = await seedBody(t);
    await seedHazard(t, hazardOnly, 'thin_ice');

    await t.run((ctx) => recomputeBodySummary(ctx, busy));
    await t.run((ctx) => recomputeBodySummary(ctx, hazardOnly));

    const rows = await refreshRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ waterBodyId: busy, refreshAt: oldest + SUMMARY_WINDOW_MS + 1 });
    // A hazard card has no clock: it changes only when a write archives the hazard.
    expect((await summaryOf(t, hazardOnly))?.topHazardTypes).toEqual(['thin_ice']);

    // A second recompute with nothing new leaves one row, unchanged.
    await t.run((ctx) => recomputeBodySummary(ctx, busy));
    expect(await refreshRows(t)).toEqual(rows);
  });

  test('a card ages out on the tick at its refresh time, and not before', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const skated = NOW - 10 * DAY_MS;
    await seedReport(t, waterBodyId, skated, { skateQuality: 'great' });
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));
    await backfill(t);
    expect((await summaryOf(t, waterBodyId))?.recentReportCount).toBe(1);
    const refreshAt = skated + SUMMARY_WINDOW_MS + 1;

    vi.setSystemTime(refreshAt - 1);
    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toEqual({
      mode: 'due',
      refreshed: 0,
      batches: 1,
    });
    expect((await summaryOf(t, waterBodyId))?.recentReportCount).toBe(1);

    vi.setSystemTime(refreshAt);
    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toMatchObject({
      mode: 'due',
      refreshed: 1,
    });
    const summary = await summaryOf(t, waterBodyId);
    expect(summary?.recentReportCount).toBe(0);
    expect(summary?.latestReportAt).toBeUndefined();
    // Nothing left that time can change: the row is gone and the next tick reads nothing.
    expect(await refreshRows(t)).toEqual([]);
  });

  test('the season turning is a refresh time of its own', async () => {
    const t = convexTest(schema, modules);
    const lateJune = Date.UTC(2027, 5, 28, 12);
    vi.setSystemTime(lateJune);
    const waterBodyId = await seedBody(t);
    await seedReport(t, waterBodyId, lateJune - DAY_MS);
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));
    await backfill(t);
    const seasonEnd = Date.UTC(2027, 6, 1);
    expect((await refreshRows(t))[0]?.refreshAt).toBe(seasonEnd);

    vi.setSystemTime(seasonEnd);
    await t.action(internal.waterBodies.sweepDueBodySummaries, {});
    // Still inside the 14-day window, but last season's — a card must not carry it into the next.
    expect((await summaryOf(t, waterBodyId))?.recentReportCount).toBe(0);
  });

  /**
   * The point of the table: a tick reads the due rows and the bodies they name, nothing else. The
   * two stale cards below would be rewritten by any recompute, so their surviving untouched is the
   * proof neither body was read.
   */
  test('the tick recomputes only due cards — a card not yet due, or with no row, is never read', async () => {
    const t = convexTest(schema, modules);
    const due = await seedBody(t);
    const notDue = await seedBody(t);
    const noRow = await seedBody(t);
    await backfill(t);
    for (const id of [due, notDue, noRow]) await plantStaleCard(t, id);
    await t.run(async (ctx) => {
      await ctx.db.insert('bodySummaryRefreshes', { waterBodyId: due, refreshAt: NOW - 1 });
      await ctx.db.insert('bodySummaryRefreshes', { waterBodyId: notDue, refreshAt: NOW + DAY_MS });
    });

    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toEqual({
      mode: 'due',
      refreshed: 1,
      batches: 1,
    });
    expect((await summaryOf(t, due))?.recentReportCount).toBe(0);
    expect((await summaryOf(t, notDue))?.recentReportCount).toBe(9);
    expect((await summaryOf(t, noRow))?.recentReportCount).toBe(9);
    // The due body had no report, so its row went with the recompute; the other is untouched.
    expect((await refreshRows(t)).map((r) => r.waterBodyId)).toEqual([notDue]);
  });

  test('a batch takes at most its size, oldest first, and the tick drains every batch', async () => {
    const t = convexTest(schema, modules);
    await backfill(t);
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedBody(t);
      ids.push(id);
      await plantStaleCard(t, id);
      await t.run((ctx) =>
        ctx.db.insert('bodySummaryRefreshes', { waterBodyId: id, refreshAt: NOW - 10 + i }),
      );
    }
    const first = await t.mutation(internal.waterBodies.refreshDueBodySummaries, { batchSize: 2 });
    expect(first).toEqual({ refreshed: 2, more: true });
    expect((await summaryOf(t, ids[0] as Id<'waterBodies'>))?.recentReportCount).toBe(0);
    expect((await summaryOf(t, ids[2] as Id<'waterBodies'>))?.recentReportCount).toBe(9);

    const rest = await t.action(internal.waterBodies.sweepDueBodySummaries, {});
    expect(rest).toMatchObject({ mode: 'due', refreshed: 3 });
    for (const id of ids) expect((await summaryOf(t, id))?.recentReportCount).toBe(0);
  });

  test('the first tick on a deployment without the backfill walks every card, once', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    // A card written before the table existed: stale, and with no row to bring it up.
    await seedReport(t, waterBodyId, NOW - (SUMMARY_RECENT_DAYS + 2) * DAY_MS);
    await plantStaleCard(t, waterBodyId);
    const fresh = await seedBody(t);
    await seedReport(t, fresh, NOW - DAY_MS);
    await t.run((ctx) =>
      ctx.db.patch(fresh, { summary: { recentReportCount: 0, topHazardTypes: [], updatedAt: 0 } }),
    );

    const first = await t.action(internal.waterBodies.sweepDueBodySummaries, {});
    expect(first).toMatchObject({ mode: 'walk', refreshed: 2 });
    expect((await summaryOf(t, waterBodyId))?.recentReportCount).toBe(0);
    expect((await summaryOf(t, fresh))?.recentReportCount).toBe(1);
    // The walk filled the table for the card that holds a report.
    expect((await refreshRows(t)).map((r) => r.waterBodyId)).toEqual([fresh]);
    const runs = await t.run((ctx) => ctx.db.query('importRuns').collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'body_summary_backfill',
      campaignId: 'body-summary-refresh-backfill',
      status: 'succeeded',
    });

    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toMatchObject({
      mode: 'due',
    });
    expect(await t.run((ctx) => ctx.db.query('importRuns').collect())).toHaveLength(1);
  });

  test('a walk still running is trusted for a while, then walked again', async () => {
    const t = convexTest(schema, modules);
    await backfill(t);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query('importRuns').collect();
      if (!run) throw new Error('expected the walk’s run row');
      await ctx.db.patch(run._id, { status: 'running', startedAt: NOW - 60_000 });
    });
    expect(await t.query(internal.waterBodies.summaryBackfillState, {})).toBe('running');
    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toMatchObject({
      mode: 'due',
    });

    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
    expect(await t.query(internal.waterBodies.summaryBackfillState, {})).toBe('needed');
    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toMatchObject({
      mode: 'walk',
    });
    expect(await t.query(internal.waterBodies.summaryBackfillState, {})).toBe('done');
  });

  test('duplicate rows for one body fold into one, and a missing body clears its row', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    await seedReport(t, waterBodyId, NOW - DAY_MS);
    await t.run(async (ctx) => {
      await ctx.db.insert('bodySummaryRefreshes', { waterBodyId, refreshAt: 1 });
      await ctx.db.insert('bodySummaryRefreshes', { waterBodyId, refreshAt: 2 });
    });
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));
    const rows = await refreshRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refreshAt).toBe(NOW - DAY_MS + SUMMARY_WINDOW_MS + 1);

    await t.run((ctx) => ctx.db.delete(waterBodyId));
    await t.run((ctx) =>
      ctx.db.patch(rows[0]?._id as Id<'bodySummaryRefreshes'>, { refreshAt: NOW - 1 }),
    );
    await backfill(t);
    expect(await t.action(internal.waterBodies.sweepDueBodySummaries, {})).toMatchObject({
      refreshed: 1,
    });
    expect(await refreshRows(t)).toEqual([]);
  });
});

describe('Greptile P1 regressions (2026-08-10)', () => {
  /**
   * D80's auto-merge sets `mergedIntoHazardId` and deliberately leaves `status`/`moderationStatus`
   * alone, so a tombstone stays `active` and `visible`. The map's own renderer excludes them
   * (`hazards.ts`: `inScope.filter((h) => h.mergedIntoHazardId === undefined)`); the card has to
   * agree with the map it sits on.
   *
   * **Note on what is observable.** `topHazardTypes` returns *unique* types, so counting a
   * same-type tombstone twice does not change the list — the harm shows up in the two places the
   * count actually reaches: whether a card is drawn at all, and the frequency ordering.
   */
  test('a body whose only hazard is a merged tombstone draws no card', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const survivorBody = await seedBody(t); // the survivor lives on a different lake
    const loser = await seedHazard(t, waterBodyId, 'open_water');
    const survivor = await seedHazard(t, survivorBody, 'open_water');
    await t.run((ctx) => ctx.db.patch(loser, { mergedIntoHazardId: survivor }));

    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));

    const summary = await summaryOf(t, waterBodyId);
    // No reports, and its one hazard is a tombstone ⇒ nothing to say ⇒ no card (A06c §5.3).
    expect(summary?.topHazardTypes).toEqual([]);
    expect(summaryHasCard(summary ?? undefined)).toBe(false);
  });

  test('merged duplicates do not out-rank a genuinely more common type', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);

    // One real thin_ice pin, plus three tombstones merged into it.
    const thinIce = await seedHazard(t, waterBodyId, 'thin_ice');
    for (let i = 0; i < 3; i++) {
      const dup = await seedHazard(t, waterBodyId, 'thin_ice');
      await t.run((ctx) => ctx.db.patch(dup, { mergedIntoHazardId: thinIce }));
    }
    // Two genuinely distinct open_water pins.
    await seedHazard(t, waterBodyId, 'open_water');
    await seedHazard(t, waterBodyId, 'open_water');

    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));

    // Counting tombstones would read thin_ice 4 vs open_water 2 and put thin_ice first. The map
    // shows one thin-ice pin and two open-water ones, so open_water leads.
    expect((await summaryOf(t, waterBodyId))?.topHazardTypes).toEqual(['open_water', 'thin_ice']);
  });
});

describe('merge/unmerge keep the card in step (Greptile P1 + self-review, 2026-08-10)', () => {
  /**
   * The direction the first fix missed. Excluding merged tombstones made
   * `mergedIntoHazardId` a summary input — so **both** writers of that field have to recompute, and
   * `hazards.unmerge` is a moderator action with no creation to ride on. The recompute now lives
   * beside the field write in `lib/hazardMerge.ts` rather than in each caller, because every round of
   * this review found a caller that forgot.
   */
  test('un-merging puts the hazard back on the card', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const survivor = await seedHazard(t, waterBodyId, 'open_water');
    const loser = await seedHazard(t, waterBodyId, 'thin_ice');

    // Merged: the card shows one type.
    await t.run((ctx) => ctx.db.patch(loser, { mergedIntoHazardId: survivor }));
    await t.run((ctx) => recomputeBodySummary(ctx, waterBodyId));
    expect((await summaryOf(t, waterBodyId))?.topHazardTypes).toEqual(['open_water']);

    // Un-merged through the real path: the card gains it back, with no extra recompute by the caller.
    const loserDoc = await t.run((ctx) => ctx.db.get(loser));
    const actorId = await seedAuthorId(t);
    await t.run(async (ctx) => {
      const { unmergeHazard } = await import('./lib/hazardMerge');
      await unmergeHazard(ctx, loserDoc as NonNullable<typeof loserDoc>, {
        actorId,
        reason: 'distinct pins',
      });
    });

    expect((await summaryOf(t, waterBodyId))?.topHazardTypes).toEqual(['open_water', 'thin_ice']);
  });
});
