import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

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

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.05),
      bbox: { minLat: 43.95, minLng: -72.05, maxLat: 44.05, maxLng: -71.95 },
      centroid: { lat: 44, lng: -72 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

async function seedProfile(t: ReturnType<typeof convexTest>, subject: string, extra = {}) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
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
        nearbyReportDigest: false,
        greatReportNearby: false,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  ) as Promise<Id<'profiles'>>;
}

async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  skateEndTime: number,
  quality: 'great' | 'good' | 'fair' | 'poor',
  iceTypes: string[],
) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 44, lng: -72 },
      skateEndTime,
      reportTime: now,
      source: 'native' as const,
      skateQuality: quality,
      iceTypes: iceTypes as never,
      surfaceTags: [],
      moderationStatus: 'visible' as const,
      photoIds: [],
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  ) as Promise<Id<'reports'>>;
}

/** Seed `count` `report_corroborated` ledger rows for a report — its "community backing" in the model. */
async function seedCorroboration(
  t: ReturnType<typeof convexTest>,
  reportId: Id<'reports'>,
  authorId: Id<'profiles'>,
  count: number,
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('pointEvents', {
        userId: authorId,
        delta: 1,
        reason: 'report_corroborated' as const,
        refId: reportId,
        createdAt: Date.now(),
      });
    }
  });
}

/** Open-Meteo response with `n` hours of a uniform temperature ending just before the new skate. */
function weatherBetween(newSkateMs: number, tempC: number, n = 6) {
  const s = (hoursBeforeNew: number) => Math.floor((newSkateMs - hoursBeforeNew * HOUR_MS) / 1000);
  return {
    utc_offset_seconds: -18000,
    hourly: {
      time: Array.from({ length: n }, (_, i) => s(n - i)),
      temperature_2m: Array.from({ length: n }, () => tempC),
      precipitation: Array.from({ length: n }, () => 0),
      rain: Array.from({ length: n }, () => 0),
      snowfall: Array.from({ length: n }, () => 0),
      snow_depth: Array.from({ length: n }, () => 0),
      wind_speed_10m: Array.from({ length: n }, () => 5),
      wind_gusts_10m: Array.from({ length: n }, () => 8),
      cloud_cover: Array.from({ length: n }, () => 50),
      sunshine_duration: Array.from({ length: n }, () => 0),
      shortwave_radiation: Array.from({ length: n }, () => 0),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const quietWeather = (newSkate: number) =>
  vi.fn(async () => new Response(JSON.stringify(weatherBetween(newSkate, -0.5)), { status: 200 }));

describe('contradictions.settleContradictions', () => {
  test('discloses a disagreement but escalates no one while it is unsettled (both un-corroborated)', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const a = await seedProfile(t, 'a');
    const b = await seedProfile(t, 'b');
    const newSkate = Date.now() - DAY_MS;
    const priorId = await seedReport(t, bodyId, a, newSkate - DAY_MS, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, b, newSkate, 'poor', ['snow_ice']);
    vi.stubGlobal('fetch', quietWeather(newSkate));

    await t.action(internal.contradictions.settleContradictions, { reportId: newId });

    // Symmetric disclosure to skaters…
    expect((await t.run((ctx) => ctx.db.get(newId)))?.conflicting).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(priorId)))?.conflicting).toBe(true);
    // …but neither side is the corroborated-vs-uncorroborated split yet, so no one is escalated.
    expect((await t.run((ctx) => ctx.db.get(newId)))?.contradiction ?? false).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(priorId)))?.contradiction ?? false).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(a)))?.contradictionCount ?? 0).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(b)))?.contradictionCount ?? 0).toBe(0);
  });

  test('escalates the un-corroborated minority, NOT the corroborated report (order-independent)', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const liar = await seedProfile(t, 'liar');
    const honest = await seedProfile(t, 'honest');
    const newSkate = Date.now() - DAY_MS;
    // The false read is posted FIRST and stays un-corroborated; the honest correction is corroborated.
    const liarReport = await seedReport(t, bodyId, liar, newSkate - DAY_MS, 'great', ['black_ice']);
    const honestReport = await seedReport(t, bodyId, honest, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, honestReport, honest, 2);
    vi.stubGlobal('fetch', quietWeather(newSkate));

    await t.action(internal.contradictions.settleContradictions, { reportId: honestReport });

    // The first-posted liar is the minority and is escalated; the corroborated honest reporter never is.
    expect((await t.run((ctx) => ctx.db.get(liarReport)))?.contradiction).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(liar)))?.contradictionCount).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(honestReport)))?.contradiction ?? false).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(honest)))?.contradictionCount ?? 0).toBe(0);
  });

  test('does NOT record when the weather-since explains the change (honest "ice changed")', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const a = await seedProfile(t, 'a');
    const b = await seedProfile(t, 'b');
    const newSkate = Date.now() - DAY_MS;
    const priorId = await seedReport(t, bodyId, a, newSkate - DAY_MS, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, b, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, newId, b, 2); // even a corroborated disagreement isn't a contradiction if…
    // …a hard freeze between them plausibly changed the ice.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(weatherBetween(newSkate, -20)), { status: 200 }),
      ),
    );

    await t.action(internal.contradictions.settleContradictions, { reportId: newId });

    expect((await t.run((ctx) => ctx.db.get(newId)))?.conflicting ?? false).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(priorId)))?.contradiction ?? false).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(a)))?.contradictionCount ?? 0).toBe(0);
  });

  test('self-corrects: a report that later earns corroboration clears its flag and decrements the author', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const wasMinority = await seedProfile(t, 'x', { contradictionCount: 1 });
    const opponent = await seedProfile(t, 'y');
    const newSkate = Date.now() - DAY_MS;
    // `r` was flagged a contradiction on an earlier settle; now it has picked up its own corroboration.
    const r = await seedReport(t, bodyId, wasMinority, newSkate - DAY_MS, 'great', ['black_ice']);
    await t.run((ctx) => ctx.db.patch(r, { contradiction: true }));
    const opp = await seedReport(t, bodyId, opponent, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, opp, opponent, 1);
    await seedCorroboration(t, r, wasMinority, 2); // now the better-backed side ⇒ no longer the minority
    vi.stubGlobal('fetch', quietWeather(newSkate));

    await t.action(internal.contradictions.settleContradictions, { reportId: opp });

    expect((await t.run((ctx) => ctx.db.get(r)))?.contradiction).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(wasMinority)))?.contradictionCount).toBe(0);
  });

  test("escalates two disagreeing reports under an hour apart — weather can't explain a sub-hour gap (no fetch)", async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const opponent = await seedProfile(t, 'opponent');
    const liar = await seedProfile(t, 'liar');
    const oppSkate = Date.now() - DAY_MS;
    const oppReport = await seedReport(t, bodyId, opponent, oppSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, oppReport, opponent, 2);
    // 30 minutes later — too close for weather to have changed the ice, so this is a genuine contradiction.
    const liarReport = await seedReport(t, bodyId, liar, oppSkate + 30 * 60_000, 'great', [
      'black_ice',
    ]);
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await t.action(internal.contradictions.settleContradictions, { reportId: liarReport });

    expect((await t.run((ctx) => ctx.db.get(liarReport)))?.contradiction).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(liar)))?.contradictionCount).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(oppReport)))?.contradiction ?? false).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); // sub-hour ⇒ no weather fetch at all
  });

  test("a throwaway report just outside a flagged report's window CANNOT clear its contradiction (consensus-global, not window-membership)", async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const liar = await seedProfile(t, 'liar', { contradictionCount: 1 });
    const opponent = await seedProfile(t, 'opponent');
    const bystander = await seedProfile(t, 'bystander');
    const t0 = Date.now() - 30 * DAY_MS;
    // opponent (corroborated majority) at t0; liar (un-corroborated minority) 6d later — already flagged.
    const oppReport = await seedReport(t, bodyId, opponent, t0, 'poor', ['snow_ice']);
    await seedCorroboration(t, oppReport, opponent, 2);
    const liarReport = await seedReport(t, bodyId, liar, t0 + 6 * DAY_MS, 'great', ['black_ice']);
    await t.run((ctx) => ctx.db.patch(liarReport, { contradiction: true, conflicting: true }));
    // A throwaway posted 12d after t0: its NARROW ±7d window [t0+5d, t0+19d] contains the liar but NOT the
    // opponent — the exact evasion the old anchor-window reconcile allowed. The widened ±2×7d load must
    // still see the opponent and re-confirm the liar's flag.
    const throwaway = await seedReport(t, bodyId, bystander, t0 + 12 * DAY_MS, 'good', [
      'black_ice',
    ]);
    vi.stubGlobal('fetch', quietWeather(t0 + 6 * DAY_MS));

    await t.action(internal.contradictions.settleContradictions, { reportId: throwaway });

    expect((await t.run((ctx) => ctx.db.get(liarReport)))?.contradiction).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(liarReport)))?.conflicting).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(liar)))?.contradictionCount).toBe(1); // NOT decremented
  });

  test('sizes Open-Meteo `past_days` from the real now, not the (past) window end — no truncation for a delayed report', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const a = await seedProfile(t, 'a');
    const b = await seedProfile(t, 'b');
    // Both skates are days in the PAST (a report logged after a reporting delay); the pair window is
    // [now−5d, now−3d]. Sized from the window END that'd be past_days≈2 and drop the early days; sized from
    // real now it must cover ≈5 days so the intervening weather is actually fetched.
    const lo = Date.now() - 5 * DAY_MS;
    const hi = Date.now() - 3 * DAY_MS;
    const priorId = await seedReport(t, bodyId, a, lo, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, b, hi, 'poor', ['snow_ice']);
    await seedCorroboration(t, newId, b, 2);
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(weatherBetween(hi, -0.5)), { status: 200 });
      }),
    );

    await t.action(internal.contradictions.settleContradictions, { reportId: newId });

    const pastDays = Number(new URL(capturedUrl).searchParams.get('past_days'));
    expect(pastDays).toBeGreaterThanOrEqual(5); // covers from real now back past `lo`, not just hi−lo
    void priorId;
  });

  test('escalates to a moderator flag once the pattern threshold is crossed — never a trust penalty', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const liar = await seedProfile(t, 'liar', { contradictionCount: 2 }); // one away from the threshold
    const honest = await seedProfile(t, 'honest');
    const newSkate = Date.now() - DAY_MS;
    const liarReport = await seedReport(t, bodyId, liar, newSkate - DAY_MS, 'great', ['black_ice']);
    const honestReport = await seedReport(t, bodyId, honest, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, honestReport, honest, 2);
    vi.stubGlobal('fetch', quietWeather(newSkate));

    await t.action(internal.contradictions.settleContradictions, { reportId: honestReport });

    expect((await t.run((ctx) => ctx.db.get(liar)))?.contradictionCount).toBe(3);
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags).toHaveLength(1);
    expect(flags[0]?.targetType).toBe('user');
    expect(flags[0]?.targetId).toBe(liar);
    expect(flags[0]?.reason).toBe('unsafe_false_report');
    expect(flags[0]?.flaggerId).toBe(honest); // a corroborated opponent, per the model
    // Never a reputation penalty — trust stays boost-only (D50).
    expect((await t.run((ctx) => ctx.db.get(liar)))?.reputationPoints).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(liarReport)))?.contradiction).toBe(true);
  });
});

/**
 * The enforcement funnel (Phase 7b). These three counters are the *only* record that a disagreement
 * was ever considered: a pair the weather gate explains away is a `continue`, and afterwards it's
 * indistinguishable from two reports that never disagreed. Without them, a permissive weather gate and
 * a quiet season look identical — which is precisely the question the 48 FDH / 36 TDH numbers need
 * answered.
 */
describe('contradiction funnel metrics', () => {
  const counter = async (t: ReturnType<typeof harness>, metric: string) => {
    const rows = await t.run((ctx) =>
      ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) => q.eq('metric', metric))
        .collect(),
    );
    return rows.reduce((sum, r) => sum + (r.scalar ?? 0), 0);
  };

  test('counts a detected disagreement and the escalation it produced', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const liar = await seedProfile(t, 'liar');
    const honest = await seedProfile(t, 'honest');
    const newSkate = Date.now() - DAY_MS;
    await seedReport(t, bodyId, liar, newSkate - DAY_MS, 'great', ['black_ice']);
    const honestReport = await seedReport(t, bodyId, honest, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, honestReport, honest, 2);
    vi.stubGlobal('fetch', quietWeather(newSkate));

    await t.action(internal.contradictions.settleContradictions, { reportId: honestReport });

    expect(await counter(t, 'contradiction_detected')).toBe(1);
    expect(await counter(t, 'contradiction_weather_explained')).toBe(0);
    expect(await counter(t, 'contradiction_escalated')).toBe(1);
  });

  test('counts a weather-explained drop at the middle stage, and escalates no one', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const a = await seedProfile(t, 'a');
    const b = await seedProfile(t, 'b');
    const newSkate = Date.now() - DAY_MS;
    await seedReport(t, bodyId, a, newSkate - DAY_MS, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, b, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, newId, b, 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(weatherBetween(newSkate, -20)), { status: 200 }),
      ),
    );

    await t.action(internal.contradictions.settleContradictions, { reportId: newId });

    expect(await counter(t, 'contradiction_detected')).toBe(1);
    expect(await counter(t, 'contradiction_weather_explained')).toBe(1);
    expect(await counter(t, 'contradiction_escalated')).toBe(0);
  });

  test('does not re-count an escalation that was already standing', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const liar = await seedProfile(t, 'liar');
    const honest = await seedProfile(t, 'honest');
    const newSkate = Date.now() - DAY_MS;
    await seedReport(t, bodyId, liar, newSkate - DAY_MS, 'great', ['black_ice']);
    const honestReport = await seedReport(t, bodyId, honest, newSkate, 'poor', ['snow_ice']);
    await seedCorroboration(t, honestReport, honest, 2);
    vi.stubGlobal('fetch', quietWeather(newSkate));

    // Two settles of the same unchanged cluster. Only the first *escalates* anything; a re-settle that
    // leaves the flag where it was would otherwise drift the stage upward on traffic alone.
    await t.action(internal.contradictions.settleContradictions, { reportId: honestReport });
    await t.action(internal.contradictions.settleContradictions, { reportId: honestReport });

    expect(await counter(t, 'contradiction_detected')).toBe(2); // detection is per settle, by design
    expect(await counter(t, 'contradiction_escalated')).toBe(1); // escalation is per *new* flag
  });
});
