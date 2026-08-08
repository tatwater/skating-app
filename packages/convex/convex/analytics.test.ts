/**
 * The analytics read side (Phase 7b). Two things matter most here and neither is about arithmetic:
 *
 *  - **The role split holds.** Charts and constants are admin-only (PII + tuning, D37); the
 *    contributor-trend panel is moderator-visible because it's *their* D57 lever's input — but the raw
 *    reputation number never comes with it (D50).
 *  - **The series never lies by omission.** A day with no rows is a real, rendered zero: gap-filling in
 *    the query is what stops a flat week from collapsing into a dense-looking one on the axis.
 */
import { metricDay } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 24 * 60 * 60 * 1000;

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

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

async function seedUser(
  t: ReturnType<typeof harness>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
  extra: Record<string, unknown> = {},
) {
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
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
      createdAt: Date.now(),
      ...extra,
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof harness>): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Pond',
      searchText: 'Pond',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
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
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

async function seedReport(
  t: ReturnType<typeof harness>,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  extra: Record<string, unknown> = {},
): Promise<Id<'reports'>> {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime,
      reportTime: skateEndTime,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: skateEndTime,
      updatedAt: skateEndTime,
      ...extra,
    }),
  );
}

describe('recordClientSignal', () => {
  const bumped = async (t: ReturnType<typeof harness>) => {
    const row = await t.run((ctx) =>
      ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) => q.eq('metric', 'report_rejected_future_skate'))
        .unique(),
    );
    return row?.scalar ?? 0;
  };

  test('requires an authenticated profile', async () => {
    const t = harness();
    await expect(
      t.mutation(api.analytics.recordClientSignal, { signal: 'report_rejected_future_skate' }),
    ).rejects.toThrow();
  });

  test('bumps the day counter for a signed-in user', async () => {
    const t = harness();
    const user = await seedUser(t, 'u');
    await user.as.mutation(api.analytics.recordClientSignal, {
      signal: 'report_rejected_future_skate',
    });
    expect(await bumped(t)).toBe(1);
  });

  test('caps one user so they cannot inflate an advisory chart — and drops silently, never errors', async () => {
    const t = harness();
    const user = await seedUser(t, 'u');
    // Well past the per-window cap; every call resolves (fire-and-forget telemetry never surfaces an
    // error to a user who legitimately tripped the form guard a few times).
    for (let i = 0; i < 25; i++) {
      await expect(
        user.as.mutation(api.analytics.recordClientSignal, {
          signal: 'report_rejected_future_skate',
        }),
      ).resolves.not.toThrow();
    }
    // The counter is bounded by the cap, not by how many times they called.
    expect(await bumped(t)).toBe(10);
  });

  test('the cap is per user — a second user is unaffected by the first hitting it', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    for (let i = 0; i < 15; i++) {
      await a.as.mutation(api.analytics.recordClientSignal, {
        signal: 'report_rejected_future_skate',
      });
    }
    await b.as.mutation(api.analytics.recordClientSignal, {
      signal: 'report_rejected_future_skate',
    });
    expect(await bumped(t)).toBe(11); // 10 from a (capped) + 1 from b
  });
});

describe('role gates', () => {
  test('the charts are admin-only — a moderator cannot read the series, latest, or catalogue', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(mod.as.query(api.analytics.series, { metrics: ['signups'] })).rejects.toThrow();
    await expect(mod.as.query(api.analytics.latest, { metrics: ['signups'] })).rejects.toThrow();
    await expect(mod.as.query(api.analytics.catalogue, {})).rejects.toThrow();
    await expect(mod.as.query(api.analytics.bountyGateScatter, {})).rejects.toThrow();
  });

  test('a member reaches none of it', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    await expect(member.as.query(api.analytics.series, { metrics: ['signups'] })).rejects.toThrow();
    await expect(
      member.as.query(api.analytics.contributorTrend, { userId: member.id }),
    ).rejects.toThrow();
  });

  test('the contributor trend IS moderator-visible — it is their D57 lever’s input', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const subject = await seedUser(t, 'subject');
    const trend = await mod.as.query(api.analytics.contributorTrend, { userId: subject.id });
    expect(trend).not.toBeNull();
    // …but never with the raw reputation number attached (D50 keeps that admin-only).
    expect(trend).not.toHaveProperty('reputationPoints');
  });
});

describe('analytics.series', () => {
  test('gap-fills days with no snapshot so a quiet week reads as zeroes, not as a shorter axis', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const today = metricDay(Date.now());
    await t.run((ctx) =>
      ctx.db.insert('metricSnapshots', {
        metric: 'signups',
        date: today,
        scalar: 4,
        updatedAt: Date.now(),
      }),
    );

    const result = await admin.as.query(api.analytics.series, { metrics: ['signups'], days: 5 });
    expect(result.dates).toHaveLength(5);
    expect(result.series.signups).toHaveLength(5);
    expect(result.series.signups?.at(-1)?.scalar).toBe(4);
    expect(result.series.signups?.[0]?.scalar).toBeNull(); // never measured ≠ measured zero
  });

  test('omits an unknown metric key rather than erroring the whole chart page', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const result = await admin.as.query(api.analytics.series, {
      metrics: ['signups', 'not_a_metric'],
    });
    expect(result.series).toHaveProperty('signups');
    expect(result.series).not.toHaveProperty('not_a_metric');
  });
});

describe('analytics.latest', () => {
  test('falls back to the most recent measured day so a chart is not blank before today’s rollup', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const yesterday = metricDay(Date.now() - DAY);
    await t.run((ctx) =>
      ctx.db.insert('metricSnapshots', {
        metric: 'reputation_points_hist',
        date: yesterday,
        buckets: [1, 2, 3],
        updatedAt: Date.now(),
      }),
    );

    const result = await admin.as.query(api.analytics.latest, {
      metrics: ['reputation_points_hist'],
    });
    expect(result.reputation_points_hist?.date).toBe(yesterday);
    expect(result.reputation_points_hist?.buckets).toEqual([1, 2, 3]);
  });
});

describe('analytics.catalogue', () => {
  test('serves each metric’s axis labels from the same edges the rollup buckets against', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const entries = await admin.as.query(api.analytics.catalogue, {});
    const hist = entries.find((e) => e.key === 'reputation_points_hist');
    expect(hist?.shape).toBe('buckets');
    expect(hist?.bucketLabels?.at(-1)).toBe('250+');
    // A scalar metric carries no axis labels — the shape decides, so the chart never guesses.
    expect(entries.find((e) => e.key === 'signups')?.bucketLabels).toBeUndefined();
  });
});

describe('analytics.contributorTrend', () => {
  test('counts a settled contradiction as bad and a corroborated report as good, by month', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const subject = await seedUser(t, 'subject');
    const body = await seedBody(t);

    const goodReport = await seedReport(t, subject.id, body, Date.now() - DAY);
    await t.run((ctx) =>
      ctx.db.insert('pointEvents', {
        userId: subject.id,
        delta: 4,
        reason: 'report_corroborated' as const,
        refId: goodReport,
        createdAt: Date.now(),
      }),
    );
    await seedReport(t, subject.id, body, Date.now() - 2 * DAY, { contradiction: true });

    const trend = await mod.as.query(api.analytics.contributorTrend, { userId: subject.id });
    const totals = (trend?.months ?? []).reduce(
      (acc, m) => ({ good: acc.good + m.good, bad: acc.bad + m.bad, total: acc.total + m.total }),
      { good: 0, bad: 0, total: 0 },
    );
    expect(totals).toEqual({ good: 1, bad: 1, total: 2 });
    expect(trend?.accountCreatedAt).toBeGreaterThan(0); // the tenure half of "tenure-aware" (D57)
  });

  test('counts only an UPHELD safety flag — an open accusation is not a finding', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const subject = await seedUser(t, 'subject');
    const flagger = await seedUser(t, 'flagger');
    const insertFlag = (status: 'open' | 'dismissed' | 'actioned') =>
      t.run((ctx) =>
        ctx.db.insert('contentFlags', {
          flaggerId: flagger.id,
          targetType: 'user' as const,
          targetId: subject.id,
          reason: 'unsafe_false_report' as const,
          status,
          createdAt: Date.now(),
          ...(status === 'open' ? {} : { resolvedAt: Date.now() }),
        }),
      );
    await insertFlag('open');
    await insertFlag('dismissed');
    await insertFlag('actioned');

    const trend = await mod.as.query(api.analytics.contributorTrend, { userId: subject.id });
    const bad = (trend?.months ?? []).reduce((sum, m) => sum + m.bad, 0);
    // Otherwise anyone could darken a contributor's record just by filing flags.
    expect(bad).toBe(1);
  });

  test('does not double-count a contradicted report that also drew a helpful thumb', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const subject = await seedUser(t, 'subject');
    const rater = await seedUser(t, 'rater');
    const body = await seedBody(t);
    const reportId = await seedReport(t, subject.id, body, Date.now() - DAY, {
      contradiction: true,
    });
    await t.run((ctx) =>
      ctx.db.insert('reportRatings', {
        targetType: 'report' as const,
        targetId: reportId,
        raterId: rater.id,
        verdict: 'helpful' as const,
        createdAt: Date.now(),
      }),
    );

    const trend = await mod.as.query(api.analytics.contributorTrend, { userId: subject.id });
    const month = trend?.months[0];
    expect(month).toMatchObject({ good: 0, bad: 1, total: 1 });
  });

  test('a single over-budget report is dropped whole, not half-counted, and truncates', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const subject = await seedUser(t, 'subject');
    const rater = await seedUser(t, 'rater');
    const body = await seedBody(t);

    // Newest: an ordinary net-helpful report — fully classified within budget, counted good.
    const good = await seedReport(t, subject.id, body, Date.now() - DAY);
    await t.run((ctx) =>
      ctx.db.insert('reportRatings', {
        targetType: 'report' as const,
        targetId: good,
        raterId: rater.id,
        verdict: 'helpful' as const,
        createdAt: Date.now(),
      }),
    );
    // Older: so heavily rated that classifying it alone would exceed the remaining read budget — the
    // exact case the P1 fix guards (bounded `.take`, not `.collect`). It must be dropped ENTIRELY, not
    // read in full then half-counted, so total reaction reads stay capped at the budget.
    const heavy = await seedReport(t, subject.id, body, Date.now() - 2 * DAY);
    await t.run(async (ctx) => {
      // Counts rows, so same-rater rows exercise the read budget fine. > budget, minus the good report's.
      for (let i = 0; i < 12_000; i++) {
        await ctx.db.insert('reportRatings', {
          targetType: 'report' as const,
          targetId: heavy,
          raterId: rater.id,
          verdict: 'helpful' as const,
          createdAt: Date.now(),
        });
      }
    });
    // Oldest: past the heavy report, so never reached.
    await seedReport(t, subject.id, body, Date.now() - 3 * DAY);

    const trend = await mod.as.query(api.analytics.contributorTrend, { userId: subject.id });
    expect(trend?.truncated).toBe(true);
    const totals = (trend?.months ?? []).reduce(
      (acc, m) => ({ good: acc.good + m.good, total: acc.total + m.total }),
      { good: 0, total: 0 },
    );
    // Only the good report survives; the over-budget report and everything older are absent — not
    // partially tallied. (If the heavy report were half-counted, total would be 2.)
    expect(totals).toEqual({ good: 1, total: 1 });
  }, 30_000); // heavy seed; CI runs ~8×+ slower than local (see memory: ci-test-timeout-5s)
});
