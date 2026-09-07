import { approximateUtcOffsetSeconds, localDayMsAt } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { CALIBRATION_WINDOW_DAYS } from './iceCalibration';
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
  // ⚠ **The lake's LOCAL day, not the UTC one.** `calibrationPairs` anchors its window with
  // `localDayMsAt(report.skateEndTime, offset)` — UTC midnight of the *local* date — while this
  // seeder used to floor `Date.now()` to a UTC day. The two agree for most of the day and diverge
  // between 19:00 Eastern and midnight, when the UTC date has already rolled over: the seeded rows
  // then sat one day later than the window the code computes, the overlap was 38 days instead of 39,
  // and the test failed for anyone running it in the evening. Exactly the trap `localDayMsAt`'s own
  // docblock warns about, reproduced in a fixture.
  const today = localDayMsAt(Date.now(), approximateUtcOffsetSeconds(-72.0331));
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

describe('iceCalibration: local dates, not UTC ones', () => {
  /** Archive days carrying an explicit provider offset, keyed by LOCAL date. */
  async function seedArchiveWithOffset(
    t: ReturnType<typeof convexTest>,
    anchorDayMs: number,
    days: number,
    fdhPerDay: number,
    utcOffsetSeconds = -5 * 3600,
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < days; i++) {
        const dayMs = anchorDayMs - i * DAY_MS;
        await ctx.db.insert('weatherDays', {
          cellKey: CELL_KEY,
          tier: 'browse' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          hours: 24,
          utcOffsetSeconds,
          freezingDegreeHours: fdhPerDay,
          thawDegreeHours: 0,
          fetchedAt: Date.now(),
        });
      }
    });
  }

  test('an evening skate reads the window ending on the day it was skated', async () => {
    // ⚠ The bug Greptile caught. 8 PM EST on the 10th is 01:00 UTC on the 11th, so a UTC floor
    // anchored the window on the 11th — including a day that had not happened at skate time and
    // dropping the oldest day it meant to cover. Evening skating is the common case.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedProfile(t, 'moderator');

    const localTenth = Date.UTC(2026, 1, 10);
    const skateEndTime = Date.UTC(2026, 1, 11, 1, 0); // 20:00 EST on the 10th

    // Archive covers the 10th backwards. Nothing exists for the 11th — a UTC anchor would reach for
    // it, find one fewer day, and integrate a different window.
    await seedArchiveWithOffset(t, localTenth, CALIBRATION_WINDOW_DAYS, 10);
    await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: mod.id,
        waterBodyId,
        point: { lat: 44.0163, lng: -72.0331 },
        skateEndTime,
        reportTime: skateEndTime,
        source: 'native' as const,
        iceTypes: ['black_ice'] as const,
        surfaceTags: [],
        photoIds: [],
        iceThickness: { readings: [{ valueCm: 12, method: 'measured' as const }] },
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: skateEndTime,
        updatedAt: skateEndTime,
      }),
    );

    const res = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    const pair = res.pairs[0];
    expect(pair).toBeDefined();
    // Every seeded day is in the window — the anchor landed on the 10th, not the 11th.
    expect(pair?.daysObserved).toBe(CALIBRATION_WINDOW_DAYS);
    expect(pair?.freezingDegreeHours).toBeCloseTo(10 * CALIBRATION_WINDOW_DAYS, 6);
  });

  test('falls back to a longitude-derived offset when none is stored', async () => {
    // Old rows predate the field. The fallback has to be Eastern, not UTC — returning 0 would put
    // the bug straight back.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedProfile(t, 'moderator');
    const localTenth = Date.UTC(2026, 1, 10);
    const skateEndTime = Date.UTC(2026, 1, 11, 1, 0);

    await t.run(async (ctx) => {
      for (let i = 0; i < CALIBRATION_WINDOW_DAYS; i++) {
        const dayMs = localTenth - i * DAY_MS;
        await ctx.db.insert('weatherDays', {
          cellKey: CELL_KEY,
          tier: 'browse' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          hours: 24,
          freezingDegreeHours: 10,
          thawDegreeHours: 0,
          fetchedAt: Date.now(),
        }); // no utcOffsetSeconds
      }
    });
    await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: mod.id,
        waterBodyId,
        point: { lat: 44.0163, lng: -72.0331 },
        skateEndTime,
        reportTime: skateEndTime,
        source: 'native' as const,
        iceTypes: ['black_ice'] as const,
        surfaceTags: [],
        photoIds: [],
        iceThickness: { readings: [{ valueCm: 12, method: 'measured' as const }] },
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: skateEndTime,
        updatedAt: skateEndTime,
      }),
    );

    const res = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    expect(res.pairs[0]?.daysObserved).toBe(CALIBRATION_WINDOW_DAYS);
  });

  test('a day still in progress does not enter the integral', async () => {
    // A partial row contributes a fraction of a day's freezing while counting as a whole day, which
    // biases the fitted alpha with nothing to reveal it.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedProfile(t, 'moderator');
    const localTenth = Date.UTC(2026, 1, 10);
    const skateEndTime = Date.UTC(2026, 1, 11, 1, 0);

    await seedArchiveWithOffset(t, localTenth - DAY_MS, 10, 10);
    await t.run((ctx) =>
      ctx.db.insert('weatherDays', {
        cellKey: CELL_KEY,
        tier: 'browse' as const,
        dayMs: localTenth,
        localDate: '2026-02-10',
        source: 'forecast' as const,
        hours: 4, // still going
        utcOffsetSeconds: -5 * 3600,
        freezingDegreeHours: 2,
        thawDegreeHours: 0,
        fetchedAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: mod.id,
        waterBodyId,
        point: { lat: 44.0163, lng: -72.0331 },
        skateEndTime,
        reportTime: skateEndTime,
        source: 'native' as const,
        iceTypes: ['black_ice'] as const,
        surfaceTags: [],
        photoIds: [],
        iceThickness: { readings: [{ valueCm: 12, method: 'measured' as const }] },
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: skateEndTime,
        updatedAt: skateEndTime,
      }),
    );

    const res = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    // Ten settled days, not eleven, and the partial day's 2 FDH is not in the sum.
    expect(res.pairs[0]?.daysObserved).toBe(10);
    expect(res.pairs[0]?.freezingDegreeHours).toBeCloseTo(100, 6);
  });
});

describe('iceCalibration: DST and the unfinished day', () => {
  /** Days keyed by local date, each carrying the offset that date actually had. */
  async function seedAcrossTransition(
    t: ReturnType<typeof convexTest>,
    anchorDayMs: number,
    days: number,
    offsetFor: (dayMs: number) => number,
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < days; i++) {
        const dayMs = anchorDayMs - i * DAY_MS;
        await ctx.db.insert('weatherDays', {
          cellKey: CELL_KEY,
          tier: 'browse' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          hours: 24,
          utcOffsetSeconds: offsetFor(dayMs),
          freezingDegreeHours: 10,
          thawDegreeHours: 0,
          fetchedAt: Date.now(),
        });
      }
    });
  }

  async function seedMeasuredReport(
    t: ReturnType<typeof convexTest>,
    waterBodyId: Id<'waterBodies'>,
    authorId: Id<'profiles'>,
    skateEndTime: number,
  ) {
    await t.run((ctx) =>
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
        iceThickness: { readings: [{ valueCm: 12, method: 'measured' as const }] },
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: skateEndTime,
        updatedAt: skateEndTime,
      }),
    );
  }

  test('a skate after spring-forward uses its own day offset, not the oldest row in range', async () => {
    // ⚠ **The bug.** `by_cell_day` returns ascending, so taking the first row with an offset took it
    // from the *oldest* day in the lookup window — three days before the skate, and on the far side
    // of the transition. EST is −5, EDT is −4; near local midnight that hour moves the anchor day by
    // one, which drops the oldest intended day and adds one that had not happened.
    //
    // 2026-03-08 is the US spring-forward. A skate at 03:30 UTC on the 9th is 23:30 EDT on the 8th —
    // the same evening — but reading it at EST puts it at 22:30 on the 8th too. The discriminating
    // case is a skate at 03:30 UTC on the 9th being read against an offset from the 6th (EST, −5):
    // that lands on the 8th either way, so use 04:30 UTC, which is 00:30 EDT on the 9th but 23:30
    // EST on the 8th.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedProfile(t, 'moderator');

    const transition = Date.UTC(2026, 2, 8);
    const offsetFor = (dayMs: number) => (dayMs >= transition ? -4 * 3600 : -5 * 3600);
    // Ten days of archive ending the 9th, spanning the change.
    await seedAcrossTransition(t, Date.UTC(2026, 2, 9), 10, offsetFor);

    const skateEndTime = Date.UTC(2026, 2, 9, 4, 30); // 00:30 EDT on the 9th
    await seedMeasuredReport(t, waterBodyId, mod.id, skateEndTime);

    const res = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    const pair = res.pairs[0];
    expect(pair).toBeDefined();
    // Anchored on the 9th (EDT), so all ten seeded days are in the window. Reading the offset off the
    // oldest row (EST, −5) put the anchor on the 8th and dropped the 9th — nine days, 90 degree-hours.
    expect(pair?.daysObserved).toBe(10);
    expect(pair?.freezingDegreeHours).toBeCloseTo(100, 6);
  });

  test('an unfinished day never enters the integral, even holding 24 hours', async () => {
    // ⚠ Open-Meteo returns whole calendar days and the ingest trims nothing, so today's row carries
    // 24 hours with the un-elapsed ones forecast. Fitting a physical constant to a forecast is the
    // failure this prevents — and no hour count could have revealed it.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedProfile(t, 'moderator');

    const offset = -5 * 3600;
    const todayLocal = localDayMsAt(Date.now(), offset);
    // Five settled days ending yesterday, then today carrying a full 24 hours of mostly forecast.
    await t.run(async (ctx) => {
      for (let i = 1; i <= 5; i++) {
        const dayMs = todayLocal - i * DAY_MS;
        await ctx.db.insert('weatherDays', {
          cellKey: CELL_KEY,
          tier: 'browse' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          hours: 24,
          utcOffsetSeconds: offset,
          freezingDegreeHours: 10,
          thawDegreeHours: 0,
          fetchedAt: Date.now(),
        });
      }
      await ctx.db.insert('weatherDays', {
        cellKey: CELL_KEY,
        tier: 'browse' as const,
        dayMs: todayLocal,
        localDate: new Date(todayLocal).toISOString().slice(0, 10),
        source: 'forecast' as const,
        hours: 24,
        utcOffsetSeconds: offset,
        freezingDegreeHours: 999, // forecast, and wildly out of family
        thawDegreeHours: 0,
        fetchedAt: Date.now(),
      });
    });

    await seedMeasuredReport(t, waterBodyId, mod.id, Date.now());

    const res = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    const pair = res.pairs[0];
    expect(pair).toBeDefined();
    // Five settled days at 10, and not a degree-hour of the 999.
    expect(pair?.daysObserved).toBe(5);
    expect(pair?.freezingDegreeHours).toBeCloseTo(50, 6);
  });
});

describe('iceCalibration: the two hours a year a day boundary is ambiguous', () => {
  /**
   * Ten days of archive ending `anchorDayMs`, each carrying the offset its own date was on.
   *
   * 2025's real transitions, because they are in the past — a window of future-dated days would be
   * excluded by the completeness guard and the test would pass for the wrong reason.
   */
  async function seedTransition(
    t: ReturnType<typeof convexTest>,
    anchorDayMs: number,
    offsetFor: (dayMs: number) => number,
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        const dayMs = anchorDayMs - i * DAY_MS;
        await ctx.db.insert('weatherDays', {
          cellKey: CELL_KEY,
          tier: 'browse' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          hours: 24,
          utcOffsetSeconds: offsetFor(dayMs),
          freezingDegreeHours: 10,
          thawDegreeHours: 0,
          fetchedAt: Date.now(),
        });
      }
    });
  }

  async function daysObservedFor(
    t: ReturnType<typeof convexTest>,
    skateEndTime: number,
  ): Promise<number | undefined> {
    const waterBodyId = await seedBody(t);
    const mod = await seedProfile(t, 'moderator');
    await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: mod.id,
        waterBodyId,
        point: { lat: 44.0163, lng: -72.0331 },
        skateEndTime,
        reportTime: skateEndTime,
        source: 'native' as const,
        iceTypes: ['black_ice'] as const,
        surfaceTags: [],
        photoIds: [],
        iceThickness: { readings: [{ valueCm: 12, method: 'measured' as const }] },
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: skateEndTime,
        updatedAt: skateEndTime,
      }),
    );
    const res = await t
      .withIdentity({ subject: mod.subject })
      .query(api.iceCalibration.calibrationPairs, {});
    return res.pairs[0]?.daysObserved;
  }

  test('a skate the evening BEFORE spring-forward anchors on that evening', async () => {
    // ⚠ **The case that broke the previous fix, which looked principled and confirmed its own error.**
    // Spring-forward 2025 is 09 March at 2 AM EST = 07:00 UTC. A skate at 23:30 EST on the 8th is
    // 2025-03-09T04:30Z — a UTC stamp on the 9th, two and a half hours before the clocks move. The old
    // code seeded from the row nearest the *UTC* day (the 9th, already EDT at −4), which put the
    // instant on the 9th, then re-read the 9th's row and agreed with itself.
    //
    // Span containment gets it right: the 8th (−5) covers [03-08T05:00Z, 03-09T05:00Z) and so does the
    // 9th (−4) from 04:00Z — the doubled hour — and the earlier day wins because the clocks have not
    // moved yet.
    const t = convexTest(schema, modules);
    const transition = Date.UTC(2025, 2, 9);
    await seedTransition(t, transition, (d) => (d >= transition ? -4 * 3600 : -5 * 3600));

    // Anchored on the 8th, the window holds the nine seeded days up to and including it; anchored on
    // the 9th it would hold ten.
    expect(await daysObservedFor(t, Date.UTC(2025, 2, 9, 4, 30))).toBe(9);
  });

  test('a skate in the hour fall-back removes anchors on the later day', async () => {
    // The mirror case, and the one span containment cannot answer by containment: fall-back 2025 is
    // 02 November at 2 AM EDT = 06:00 UTC. A skate at 2025-11-02T04:30Z is 00:30 EDT on the 2nd, but
    // the 1st's span (−4) ends at 11-02T04:00Z and the 2nd's (−5) does not start until 05:00Z — the
    // instant falls in the gap between them. The later day is right, for the mirror reason.
    const t = convexTest(schema, modules);
    const transition = Date.UTC(2025, 10, 2);
    await seedTransition(t, transition, (d) => (d >= transition ? -5 * 3600 : -4 * 3600));

    expect(await daysObservedFor(t, Date.UTC(2025, 10, 2, 4, 30))).toBe(10);
  });

  test('an ordinary evening skate is unaffected by either rule', async () => {
    // The common path has exactly one containing span and must stay boring.
    const t = convexTest(schema, modules);
    const tenth = Date.UTC(2025, 1, 10);
    await seedTransition(t, tenth, () => -5 * 3600);

    // 8 PM EST on the 10th is 01:00Z on the 11th — the original bug's shape.
    expect(await daysObservedFor(t, Date.UTC(2025, 1, 11, 1, 0))).toBe(10);
    // And an afternoon skate on the 9th anchors on the 9th, one day back.
    expect(await daysObservedFor(t, Date.UTC(2025, 1, 9, 20, 0))).toBe(9);
  });
});
