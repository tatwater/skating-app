import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY_MS = 86_400_000;

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
      name: 'Calibration Pond',
      searchText: 'Calibration Pond',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01),
      bbox: { minLat: 43.99, minLng: -72.05, maxLat: 44.05, maxLng: -71.99 },
      centroid: { lat: 44.0163, lng: -72.0331 },
      interiorPoint: { lat: 44.0163, lng: -72.0331 },
      elevationM: 338,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

let seq = 0;
async function seedProfile(
  t: ReturnType<typeof convexTest>,
  role: 'member' | 'moderator',
): Promise<{ id: Id<'profiles'>; subject: string }> {
  const n = seq++;
  const subject = `${role}-${n}`;
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: role,
      username: `${role}-${n}`,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        hazardConfirmation: true,
        bountyFulfilled: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: true,
        greatReportNearby: true,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      role,
      status: 'active' as const,
      reputationPoints: 0,
      createdAt: Date.now(),
    }),
  )) as Id<'profiles'>;
  return { id, subject };
}

/** A visible report carrying `readings`, ending `daysAgo` days ago. */
async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  readings: {
    valueCm?: number;
    minCm?: number;
    maxCm?: number;
    method: 'measured' | 'estimated';
  }[],
  daysAgo = 1,
): Promise<Id<'reports'>> {
  const skateEndTime = Date.now() - daysAgo * DAY_MS;
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 44.0163, lng: -72.0331 },
      skateEndTime,
      reportTime: skateEndTime,
      source: 'native' as const,
      iceTypes: ['black_ice'] as const,
      surfaceTags: [],
      photoIds: [],
      iceThickness: { readings },
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: skateEndTime,
      updatedAt: skateEndTime,
    }),
  ) as Promise<Id<'reports'>>;
}

/** Archive days for the body's browse cell, `fdhPerDay` freezing-degree-hours each. */
async function seedArchive(
  t: ReturnType<typeof convexTest>,
  cellKey: string,
  days: number,
  fdhPerDay: number,
  thawPerDay = 0,
): Promise<void> {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  await t.run(async (ctx) => {
    for (let i = 0; i < days; i++) {
      const dayMs = today - i * DAY_MS;
      await ctx.db.insert('weatherDays', {
        cellKey,
        tier: 'browse' as const,
        dayMs,
        localDate: new Date(dayMs).toISOString().slice(0, 10),
        source: 'forecast' as const,
        hours: 24,
        freezingDegreeHours: fdhPerDay,
        thawDegreeHours: thawPerDay,
        fetchedAt: Date.now(),
      });
    }
  });
}

/** The body seeded above lands in this browse cell — 44.0163/-72.0331 at 338 m. */
const CELL_KEY = 'b:880:-1441:3';

describe('iceCalibration: the D160 gate', () => {
  test('refuses an unauthenticated caller', async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.iceCalibration.calibrationPairs, {})).rejects.toThrow();
    await expect(t.query(api.iceCalibration.calibrationFit, {})).rejects.toThrow();
  });

  test('refuses an ordinary skater — structurally, not by hiding the result', async () => {
    const t = convexTest(schema, modules);
    const skater = await seedProfile(t, 'member');
    const as = t.withIdentity({ subject: skater.subject });
    // The whole of D160's first rule: a derived thickness never enters a payload a skater receives.
    await expect(as.query(api.iceCalibration.calibrationPairs, {})).rejects.toThrow();
    await expect(as.query(api.iceCalibration.calibrationFit, {})).rejects.toThrow();
  });

  test('admits a moderator', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const result = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    expect(result.pairs).toEqual([]);
  });
});

describe('iceCalibration: pairing', () => {
  test('pairs a measured reading with the archive and predicts a thickness', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120);
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.observedCm).toBe(25);
    expect(pairs[0]?.readingCount).toBe(1);
    // The window ends on the skate day and reaches back 60 days, so it overlaps 39 of the 40 seeded
    // days — 4,680 fdh = 195 FDD. Asserted against the reported integral rather than a hand-computed
    // constant, so the two can't drift apart.
    expect(pairs[0]?.daysObserved).toBe(39);
    expect(pairs[0]?.freezingDegreeHours).toBe(39 * 120);
    const fdd = (pairs[0]?.freezingDegreeHours ?? 0) / 24;
    expect(pairs[0]?.predictedCm).toBeCloseTo(2.0 * Math.sqrt(fdd), 6);
    expect(pairs[0]?.declined).toBe(false);
    expect(pairs[0]?.waterBodyName).toBe('Calibration Pond');
  });

  test('excludes a report whose readings are all estimates, and counts the cost', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120);
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'estimated' }]);

    const result = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});

    // Fitting to somebody else's estimate fits the model to a guess and calls the agreement proof.
    expect(result.pairs).toHaveLength(0);
    expect(result.excludedEstimates).toBe(1);
  });

  test('takes only the measured readings from a mixed report', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120);
    await seedReport(t, body, mod.id, [
      { valueCm: 20, method: 'measured' },
      { valueCm: 30, method: 'measured' },
      { valueCm: 90, method: 'estimated' }, // would wreck the mean if it counted
    ]);

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    expect(pairs[0]?.observedCm).toBe(25);
    expect(pairs[0]?.readingCount).toBe(2);
  });

  test('reads a range reading at its midpoint', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120);
    await seedReport(t, body, mod.id, [{ minCm: 10, maxCm: 20, method: 'measured' }]);

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    expect(pairs[0]?.observedCm).toBe(15);
  });

  test('skips a report with no archive coverage rather than predicting from nothing', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    // Not a failure — just not a pair yet. A zero-FDD prediction would be a fabricated data point.
    expect(pairs).toHaveLength(0);
  });

  test('declines a window carrying too much thaw for a growth model', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120, 40); // 40 × 40 = 1600 thaw-degree-hours
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.declined).toBe(true);
    // Declining means reporting no number, not reporting a wrong one.
    expect(pairs[0]?.predictedCm).toBeNull();
  });

  test('ignores a moderator-hidden report', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120);
    const reportId = await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' as const }));

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    expect(pairs).toHaveLength(0);
  });

  test('does not count a missing archive day toward the integrals', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    await t.run(async (ctx) => {
      await ctx.db.insert('weatherDays', {
        cellKey: CELL_KEY,
        tier: 'browse' as const,
        dayMs: today,
        localDate: new Date(today).toISOString().slice(0, 10),
        source: 'forecast' as const,
        missing: true,
        fetchedAt: Date.now(),
      });
    });
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);

    const { pairs } = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    // A gap contributes no cold. Treating it as zero-degree-hours would be the same thing here, but
    // the `daysObserved` count is what tells an operator the sample is thin.
    expect(pairs).toHaveLength(0);
  });
});

describe('iceCalibration: the fit', () => {
  test('reports a coefficient and never applies it', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120);
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);

    const fit = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationFit, {});

    expect(fit.fitted?.n).toBe(1);
    expect(fit.fitted?.alpha).toBeGreaterThan(0);
    // ⚠ D160's second rule: the shipped default is untouched by whatever the fit says.
    expect(fit.defaultAlpha).toBe(2.0);
  });

  test('returns a null fit rather than a fabricated one when there is nothing to fit', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const fit = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationFit, {});
    expect(fit.fitted).toBeNull();
  });

  test('excludes declined pairs from the fit and says how many', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedProfile(t, 'moderator');
    const body = await seedBody(t);
    await seedArchive(t, CELL_KEY, 40, 120, 40);
    await seedReport(t, body, mod.id, [{ valueCm: 25, method: 'measured' }]);

    const fit = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationFit, {});
    expect(fit.declined).toBe(1);
    expect(fit.fitted).toBeNull();
  });
});
