/**
 * **The intake queue's counts, bounded** (B01-3p). `waterBodies.reviewQueueCounts` read up to 201
 * whole bodies — outlines and all — for each of six reasons, one reason after another: 1,206 rows,
 * 1.1–1.4 s on dev, on the Overview's Corpus card and the intake page. Convex has no count without a
 * read, so the count reads fewer rows: at most {@link REVIEW_COUNT_CAP} + 1 a reason, every reason at
 * once, and past the cap it says "N+" — never a capped count that reads as a complete one.
 */

import { REVIEW_REASONS, type ReviewReason } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import { REVIEW_COUNT_CAP } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');

const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-72.1, 44],
      [-72, 44],
      [-72, 44.1],
      [-72.1, 44.1],
      [-72.1, 44],
    ],
  ],
};

async function seed(
  t: ReturnType<typeof convexTest>,
  counts: Partial<Record<ReviewReason, number>>,
) {
  await t.run(async (ctx) => {
    for (const [reason, n] of Object.entries(counts) as [ReviewReason, number][]) {
      for (let k = 0; k < n; k++) {
        await ctx.db.insert('waterBodies', {
          name: `${reason} ${k}`,
          searchText: `${reason} ${k}`,
          type: 'lakePond',
          source: 'osm',
          polygon: SQUARE,
          bbox: { minLng: -72.1, maxLng: -72, minLat: 44, maxLat: 44.1 },
          centroid: { lat: 44.05, lng: -72.05 },
          states: ['VT'],
          dedupStatus: 'clean',
          createdAt: 0,
          minVisibleZoom: 10,
          displayScore: k,
          reviewReasons: [reason],
          reviewReason: reason,
        });
      }
    }
  });
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'queue-mod',
      displayName: 'M',
      username: 'queue-m',
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      reputationPoints: 0,
      role: 'moderator',
      status: 'active',
      createdAt: 0,
    }),
  );
  return t.withIdentity({ subject: 'queue-mod' });
}

describe('the intake queue’s counts', () => {
  test('a reason past the cap reads "N+"; one at the cap or under reads whole', async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, {
      'class-conflict': REVIEW_COUNT_CAP + 1,
      'name-conflict': REVIEW_COUNT_CAP,
      'bay-without-parent': 3,
    });
    const counts = await as.query(api.waterBodies.reviewQueueCounts, {});
    expect(counts['class-conflict']).toEqual({
      count: REVIEW_COUNT_CAP,
      capped: true,
      advisory: false,
    });
    expect(counts['name-conflict']).toEqual({
      count: REVIEW_COUNT_CAP,
      capped: false,
      advisory: true,
    });
    expect(counts['bay-without-parent']).toMatchObject({ count: 3, capped: false });
    // Every reason answers, an empty one with a whole zero.
    expect(Object.keys(counts).sort()).toEqual([...REVIEW_REASONS].sort());
    expect(counts['same-source-duplicate']).toMatchObject({ count: 0, capped: false });
  });

  test('a guard on the cost: the read is a few hundred rows, never a reason’s whole queue', () => {
    // Each row is a whole body; at most cap + 1 a reason, every reason together.
    const rows = (REVIEW_COUNT_CAP + 1) * REVIEW_REASONS.length;
    expect(REVIEW_COUNT_CAP).toBe(50);
    expect(rows).toBeLessThanOrEqual(320);
  });
});
