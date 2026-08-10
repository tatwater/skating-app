import { SUMMARY_RECENT_DAYS, summaryHasCard } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
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
  bountyFulfilled: true,
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
      iceTypes: ['black_ice'] as const,
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

    // Convex serialises an absent optional as `null` across the `t.run` boundary.
    expect(await summaryOf(t, waterBodyId)).toBeNull();
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
    // No reports, and its one hazard is a tombstone ⇒ nothing to say ⇒ no card (E3).
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
