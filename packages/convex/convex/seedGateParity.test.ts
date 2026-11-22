/**
 * The seed gates (D287) change nothing between two real people. For random content by real authors
 * only — reports, pins and a bounty on one body — the same writes are run in two worlds: one with no
 * seed person (every gate answers "real" without reading a profile) and one where a seed person
 * exists elsewhere (every gate reads its authors). Corroboration points, the contradiction cluster,
 * bounty answers, pin merges and queued notifications come out the same, label for label.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;

const PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: true,
  greatReportNearby: true,
  moderatorDecision: false,
};

const QUALITIES = ['great', 'good', 'fair', 'poor'] as const;
const ICE = ['black_ice', 'snow_ice'] as const;

interface Scenario {
  authors: number;
  reports: { by: number; hoursAgo: number; quality: number; ice: number }[];
  pins: { by: number; east: number }[];
  bounty: boolean;
  last: { by: number; hoursAgo: number; quality: number; ice: number; east: number };
}

const scenario: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: 4 }).chain((authors) => {
  const by = fc.integer({ min: 0, max: authors - 1 });
  const report = fc.record({
    by,
    hoursAgo: fc.integer({ min: 2, max: 150 }),
    quality: fc.integer({ min: 0, max: 3 }),
    ice: fc.integer({ min: 0, max: 1 }),
  });
  return fc.record({
    authors: fc.constant(authors),
    reports: fc.array(report, { minLength: 1, maxLength: 4 }),
    pins: fc.array(fc.record({ by, east: fc.integer({ min: 0, max: 60 }) }), { maxLength: 3 }),
    bounty: fc.boolean(),
    last: fc.record({
      by,
      hoursAgo: fc.integer({ min: 1, max: 2 }),
      quality: fc.integer({ min: 0, max: 3 }),
      ice: fc.integer({ min: 0, max: 1 }),
      east: fc.integer({ min: 0, max: 60 }),
    }),
  });
});

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72, 43],
      [-72, 43.02],
      [-71.98, 43.02],
      [-71.98, 43],
      [-72, 43],
    ],
  ],
};

/** Run a scenario in a fresh world; what came out, every id as the label of what made it. */
async function play(s: Scenario, withSeed: boolean) {
  const t: T = convexTest(schema, modules);
  if (withSeed) {
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'seed_inbox_1',
        displayName: 'Ada Test-Lindqvist',
        username: 'test_ada',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: Date.now(),
      }),
    );
  }
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId: 'way/1',
        osmId: 'way/1',
        name: 'Parity Pond',
        type: 'lakePond',
        polygon: square,
        bbox: { minLat: 43, minLng: -72, maxLat: 43.02, maxLng: -71.98 },
        centroid: { lat: 43.01, lng: -71.99 },
        surfaceAreaSqM: 4_000_000,
      },
    ],
  });
  const waterBodyId = (await t.run((ctx) =>
    ctx.db
      .query('waterBodies')
      .first()
      .then((b) => b?._id),
  )) as Id<'waterBodies'>;
  const people: Id<'profiles'>[] = [];
  for (let i = 0; i < s.authors; i++) {
    people.push(
      await t.run((ctx) =>
        ctx.db.insert('profiles', {
          clerkUserId: `user_${i}`,
          displayName: `Person ${i}`,
          username: `person_${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: Date.now(),
        }),
      ),
    );
    await t.run((ctx) =>
      ctx.db.insert('waterBodyFavorites', {
        userId: people[i] as Id<'profiles'>,
        waterBodyId,
        createdAt: Date.now(),
      }),
    );
  }
  const as = (i: number) => t.withIdentity({ subject: `user_${i}` });
  const labels = new Map<string, string>();
  const label = (id: string | undefined) => (id === undefined ? null : (labels.get(id) ?? '?'));
  for (const [i, id] of people.entries()) labels.set(id, `p${i}`);
  let bountyId: Id<'bounties'> | null = null;
  if (s.bounty) {
    bountyId = await t.run((ctx) =>
      ctx.db.insert('bounties', {
        requesterId: people[0] as Id<'profiles'>,
        waterBodyId,
        windowHours: 48,
        rewardPoints: 10,
        fulfillingReportIds: [],
        status: 'open',
        createdAt: Date.now() - 100 * 3_600_000,
        expiresAt: Date.now() + 86_400_000,
      }),
    );
  }
  const report = async (r: Scenario['last'] | Scenario['reports'][number], name: string) => {
    const id = await as(r.by).mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now() - r.hoursAgo * 3_600_000,
      iceTypes: [ICE[r.ice] ?? 'black_ice'],
      skateQuality: QUALITIES[r.quality] ?? 'fair',
    });
    labels.set(id, name);
    return id;
  };
  const pin = async (by: number, east: number) => {
    const id = await as(by).mutation(api.hazards.create, {
      waterBodyId,
      type: 'wet_crack',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [-71.99 + east / 81_000, 43.01] },
      radiusMeters: 40,
    });
    return id as string;
  };
  for (const [i, r] of s.reports.entries()) await report(r, `r${i}`);
  const pinsAnswered: string[] = [];
  for (const p of s.pins) pinsAnswered.push(await pin(p.by, p.east));
  const lastReport = await report(s.last, 'last');
  pinsAnswered.push(await pin(s.last.by, s.last.east));
  const cluster = await t.query(internal.contradictions.contradictionCluster, {
    reportId: lastReport,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const out = await t.run(async (ctx) => ({
    points: (await ctx.db.query('pointEvents').collect()).map((e) =>
      [e.userId, e.reason, e.refId ?? '', e.delta].join('|'),
    ),
    queued: (await ctx.db.query('notificationQueue').collect()).map((q) =>
      [q.userId, q.kind, q.count, q.latestReportId ?? ''].join('|'),
    ),
    hazards: (await ctx.db.query('hazards').collect()).map((h) =>
      [h._id, h.mergedIntoHazardId ?? '', h.status].join('|'),
    ),
    bounty: bountyId ? ((await ctx.db.get(bountyId))?.fulfillingReportIds ?? []) : [],
    reports: (await ctx.db.query('reports').collect()).map((r) =>
      [r._id, r.conflicting ?? '', r.contradiction ?? ''].join('|'),
    ),
  }));
  // A pin folded into another answers with the survivor's id; every pin is labeled by its order.
  const pins = await t.run(async (ctx) =>
    (await ctx.db.query('hazards').collect())
      .sort((a, b) => a._creationTime - b._creationTime)
      .map((h) => h._id as string),
  );
  for (const [i, id] of pins.entries()) labels.set(id, `pin${i}`);
  const relabel = (row: string) =>
    row
      .split('|')
      .map((part) => (labels.has(part) ? labels.get(part) : part))
      .join('|');
  return {
    points: out.points.map(relabel).sort(),
    queued: out.queued.map(relabel).sort(),
    hazards: out.hazards.map(relabel).sort(),
    pinsAnswered: pinsAnswered.map((id) => label(id)),
    bounty: out.bounty.map((id: string) => label(id)),
    reports: out.reports.map(relabel).sort(),
    cluster: (cluster?.reports ?? []).map((r) => label(r.id)).sort(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Twelve scenarios as three draws of four, each its own test, so none holds a slow runner for long.
test.each(['first', 'second', 'third'])(
  'for real authors only, the gated paths give what the ungated ones give (%s draw)',
  async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        expect(await play(s, true)).toEqual(await play(s, false));
      }),
      { numRuns: 4 },
    );
  },
);
