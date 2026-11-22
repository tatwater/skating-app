/**
 * The dev inbox seed end to end in a `convex-test` world (D287): the plan filed through the real
 * public mutations — as each fake person, and as the operator — exactly as `scripts/seed-inbox`
 * drives it (`state` → file every ready step → `state` again), the lanes read through
 * `inbox.lanes`, a second run filing nothing, and the clear leaving every table as it found it.
 */

import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id, TableNames } from './_generated/dataModel';
import type { SeedCall, SeedState } from './inboxSeed';
import { INBOX_LEAVE_COST } from './inboxSeed';
import { DEV_DEPLOYMENT, SEED_DEV_ONLY } from './lib/seedPeople';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const OPERATOR = 'user_operator';

const PREFS = {
  activityDetected: false,
  bountyRequest: false,
  hazardConfirmation: false,
  bountyAnswered: false,
  reportRated: false,
  reportCommented: false,
  contentFlagResolved: false,
  favoriteReport: false,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

/** A square body of `km` a side at `(lat, lng)`, through the canonical import as dev's came. */
async function body(t: T, name: string, lat: number, lng: number, km = 2) {
  const d = km / 111;
  const polygon: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng, lat + d],
        [lng + d, lat + d],
        [lng + d, lat],
        [lng, lat],
      ],
    ],
  };
  const externalId = `way/${name.replace(/\W+/g, '')}`;
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId,
        osmId: externalId,
        name,
        type: 'lakePond',
        polygon,
        bbox: { minLat: lat, minLng: lng, maxLat: lat + d, maxLng: lng + d },
        centroid: { lat: lat + d / 2, lng: lng + d / 2 },
        surfaceAreaSqM: km * km * 1_000_000,
      },
    ],
  });
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!row) throw new Error('seed failed');
  return row._id;
}

/** Dev, as far as the seed can tell: its five named bodies, one of each standing, a launch, staff. */
async function devWorld(t: T) {
  const operator = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: OPERATOR,
      displayName: 'Operator Person',
      username: 'operator',
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1980, 0, 1),
      reputationPoints: 0,
      role: 'admin',
      status: 'active',
      createdAt: Date.now(),
    }),
  );
  const mascoma = await body(t, 'Mascoma Lake', 43.6, -72.1);
  const caspian = await body(t, 'Caspian Lake', 44.6, -72.3);
  await body(t, 'Lake Morey', 43.9, -72.15);
  await body(t, 'Tomhannock Reservoir', 42.85, -73.6);
  await body(t, 'Newfound Lake', 43.65, -71.78, 4);
  const dormant = await body(t, 'Sleepy Pond', 44.1, -72.4, 1);
  const closed = await body(t, 'Gated Pond', 44.2, -72.5, 1);
  const removed = await body(t, 'Gone Pond', 44.3, -72.6, 1);
  await t.run(async (ctx) => {
    await ctx.db.patch(dormant, {
      dormant: { since: Date.now() - 400 * 86_400_000, reason: 'inactive' },
    });
    await ctx.db.patch(closed, {
      publicAccess: {
        verdict: 'none',
        decidedAt: Date.now() - 86_400_000,
        decidedByUserId: operator,
      },
    });
    await ctx.db.patch(removed, { removedAt: Date.now() - 86_400_000, removalReason: 'junk' });
    await ctx.db.insert('putIns', {
      waterBodyId: caspian,
      coord: { lat: 44.601, lng: -72.3 },
      source: 'osm',
      status: 'visible',
      createdAt: Date.now(),
    });
  });
  // Dev's towns are loaded: one under the merge-proof pair, whose pins name it (B01-5d).
  await t.mutation(internal.adminAreas.importCanonical, {
    areas: [
      {
        externalId: 'tiger/5000912345',
        name: 'Proofton',
        level: 'town',
        state: 'VT',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [-72.3, 44.62],
              [-72.3, 44.75],
              [-72.12, 44.75],
              [-72.12, 44.62],
              [-72.3, 44.62],
            ],
          ],
        },
        bbox: { minLat: 44.62, minLng: -72.3, maxLat: 44.75, maxLng: -72.12 },
        centroid: { lat: 44.685, lng: -72.21 },
      },
    ],
  });
  // Dev's cards are computed: every body has its summary before the seed touches it.
  for (const b of await t.run((ctx) => ctx.db.query('waterBodies').collect())) {
    await t.mutation(internal.waterBodies.refreshOneBodySummary, {
      waterBodyId: b._id,
      now: Date.now(),
    });
  }
  // Dev's library is built: every body has its rows and counts before the seed touches it.
  for (let more = true; more; ) {
    more = (await t.mutation(internal.bodyLibrary.drainQueue, {})).more;
  }
  return { operator, mascoma };
}

/**
 * Real people beside the seed, on its own bodies: an author with a recent report on Mascoma Lake and
 * a pin on Tomhannock Reservoir, and a fan who favorited Mascoma and has an open bounty there — each
 * with every toggle on, a push token and an email.
 */
async function realLife(t: T) {
  const make = (clerkUserId: string) =>
    t.run(async (ctx) => {
      const id = await ctx.db.insert('profiles', {
        clerkUserId,
        displayName: `${clerkUserId} Person`,
        username: clerkUserId,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: Object.fromEntries(
          Object.keys(PREFS).map((k) => [k, true]),
        ) as typeof PREFS,
        channelPrefs: { push: true, email: true },
        email: `${clerkUserId}@example.test`,
        dateOfBirth: Date.UTC(1985, 0, 1),
        reputationPoints: 0,
        // As onboarding writes them (`profiles.upsertFromClerk`).
        reportCount: 0,
        commentCount: 0,
        role: 'member',
        status: 'active',
        createdAt: Date.now(),
      });
      await ctx.db.insert('pushTokens', {
        userId: id,
        token: `ExponentPushToken[${clerkUserId}]`,
        platform: 'android',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return id;
    });
  const author = await make('user_author');
  const fan = await make('user_fan');
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
  const named = (name: string) => {
    const b = bodies.find((x) => x.name === name);
    if (!b) throw new Error(name);
    return b;
  };
  const mascoma = named('Mascoma Lake');
  const tomhannock = named('Tomhannock Reservoir');
  const as = t.withIdentity({ subject: 'user_author' });
  // The same ice as the seed's black-ice report, a few hours apart: every corroboration and
  // contradiction rule would pair them.
  await as.mutation(api.reports.create, {
    waterBodyId: mascoma._id,
    skateEndTime: Date.now() - 6 * 3_600_000,
    iceTypes: ['black_ice'],
    skateQuality: 'good',
  });
  const p = tomhannock.representativePoint ?? tomhannock.centroid;
  await as.mutation(api.hazards.create, {
    waterBodyId: tomhannock._id,
    type: 'wet_crack',
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat + 200 / 111_320] },
    radiusMeters: 40,
  });
  await t.run(async (ctx) => {
    await ctx.db.insert('waterBodyFavorites', {
      userId: fan,
      waterBodyId: mascoma._id,
      createdAt: Date.now(),
    });
    await ctx.db.insert('bounties', {
      requesterId: fan,
      waterBodyId: mascoma._id,
      windowHours: 48,
      rewardPoints: 10,
      fulfillingReportIds: [],
      status: 'open',
      createdAt: Date.now() - 48 * 3_600_000,
      expiresAt: Date.now() + 86_400_000,
    });
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return [author, fan];
}

/** Everything of a real person's the seed could have touched. */
async function realState(t: T, people: Id<'profiles'>[]) {
  const json = await t.run(async (ctx) => {
    const mine = <R extends { userId?: Id<'profiles'> }>(rows: R[]) =>
      rows.filter((r) => r.userId !== undefined && people.includes(r.userId)).length;
    return JSON.stringify({
      profiles: await Promise.all(
        people.map(async (id) => {
          const p = await ctx.db.get(id);
          return [p?.reputationPoints, p?.contradictionCount, p?.reportCount, p?.badges, p?.status];
        }),
      ),
      reports: (await ctx.db.query('reports').collect())
        .filter((r) => people.includes(r.authorId))
        .map((r) => [r.conflicting, r.contradiction, r.moderationStatus]),
      hazards: (await ctx.db.query('hazards').collect())
        .filter((h) => h.createdByUserId !== undefined && people.includes(h.createdByUserId))
        .map((h) => [h.status, h.mergedIntoHazardId, h.moderationStatus]),
      // A real person's bounties (the merge-proof pair's is a fake person's, on the seed's body).
      bounties: (await ctx.db.query('bounties').collect())
        .filter((b) => people.includes(b.requesterId))
        .map((b) => b.fulfillingReportIds),
      pointEvents: mine(await ctx.db.query('pointEvents').collect()),
      queued: mine(await ctx.db.query('notificationQueue').collect()),
      notified: mine(await ctx.db.query('notifications').collect()),
      flagsAbout: (await ctx.db.query('contentFlags').collect()).filter(
        (f) => f.subjectUserId != null && people.includes(f.subjectUserId),
      ).length,
    });
  });
  return JSON.parse(json) as unknown;
}

/**
 * What a ready step acts on, as `[table, id]` — every id a step's arguments name. The plan's own
 * rule: a seed step acts on what the fake people wrote, on a fake person, or on a body (no one's).
 */
function targetsOf(call: SeedCall): [string, string][] {
  const a = call.args as Record<string, unknown>;
  const out: [string, string][] = [];
  const add = (table: string, key: string) => {
    if (typeof a[key] === 'string') out.push([table, a[key] as string]);
  };
  if (
    call.fn === 'contentFlags:flag' ||
    call.fn === 'moderation:setModerationStatus' ||
    call.fn === 'moderation:keepOnRecord'
  ) {
    const table = {
      report: 'reports',
      comment: 'comments',
      accessAlert: 'accessAlerts',
      hazard: 'hazards',
      user: 'profiles',
      waterbody: 'waterBodies',
      post: 'posts',
    }[a.targetType as string];
    if (table) add(table, 'targetId');
  }
  if (call.fn === 'ratings:rate') add('reports', 'targetId');
  add('reports', 'reportId');
  add('hazards', 'hazardId');
  add('accessAlerts', 'accessAlertId');
  add('profiles', 'userId');
  add('waterBodyRequests', 'requestId');
  add('contentFlags', 'flagId');
  add('gpsActivities', 'activityId');
  add('inboxItems', 'itemId');
  if (call.fn === 'waterBodies:approve' || call.fn === 'waterBodies:reject') {
    add('drawnBodies', 'waterBodyId');
  }
  return out;
}

/** The paths at which two JSON values differ, so a failure says where (`bodies.Lake Morey.publicAccess`). */
function diffPaths(a: unknown, b: unknown, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      diffPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        at ? `${at}.${k}` : k,
      ),
    );
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((x, i) => diffPaths(x, b[i], `${at}[${i}]`));
  }
  return [`${at}: ${JSON.stringify(a)?.slice(0, 160)} → ${JSON.stringify(b)?.slice(0, 160)}`];
}

/** Dev's crons, as they'd have run within the minute: geometry facts, the library, the cards. */
async function crons(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  for (let i = 0; i < 20; i++) {
    const r = await t.action(internal.bodyGeo.computeDue, {});
    if (r.computed + r.failed === 0) break;
  }
  await drainLibrary(t);
  // The cards' due sweep (the cron's batch), to the end of what is due now.
  for (let more = true; more; ) {
    more = (await t.mutation(internal.waterBodies.refreshDueBodySummaries, {})).more;
  }
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await drainLibrary(t);
}

/**
 * Real people around everything the seed touches, before it runs: a real access report on Lake
 * Morey (the body the old plan ruled accessible when no body was), and `realLife`'s author, pin,
 * fan, favorite and bounty.
 */
async function realAround(t: T) {
  const [author, fan] = await realLife(t);
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
  const id = (name: string) => bodies.find((b) => b.name === name)?._id as Id<'waterBodies'>;
  const reporter = t.withIdentity({ subject: 'user_fan' });
  const accessFlag = await reporter.mutation(api.contentFlags.flag, {
    targetType: 'waterbody',
    targetId: id('Lake Morey'),
    reason: 'no_public_access',
    note: 'The town lot has a no-trespassing sign.',
  });
  // And a real comment on the real report, which nothing of the seed's may touch.
  const realReport = await t.run(
    async (ctx) =>
      (await ctx.db.query('reports').collect()).find((r) => r.authorId === author)
        ?._id as Id<'reports'>,
  );
  await reporter.mutation(api.comments.create, {
    reportId: realReport,
    body: 'Thanks — heading there Saturday.',
  });
  return { people: [author as Id<'profiles'>, fan as Id<'profiles'>], accessFlag };
}

/**
 * Every real row the seed could have written to, as JSON: each real body's stored document (its
 * card's `updatedAt` aside — a recompute stamps it even when nothing changed), its geometry facts,
 * links to bodies that no longer exist, and the real people's profiles, flags and their Inbox
 * members, reports, pins, bounties, notifications and points.
 */
async function realRows(t: T, people: Id<'profiles'>[]) {
  const json = await t.run(async (ctx) => {
    const bodies = (await ctx.db.query('waterBodies').collect()).filter((b) => b.source !== 'user');
    const live = new Set((await ctx.db.query('waterBodies').collect()).map((b) => b._id as string));
    const facts = await ctx.db.query('bodyGeoFacts').collect();
    const links = await ctx.db.query('bodyGeoLinks').collect();
    const mine = (id: string | undefined) =>
      id !== undefined && people.includes(id as Id<'profiles'>);
    const real = (id: string) => bodies.some((b) => b._id === id);
    const flags = (await ctx.db.query('contentFlags').collect()).filter((f) => mine(f.flaggerId));
    const members = await ctx.db.query('inboxItemMembers').collect();
    const items = await ctx.db.query('inboxItems').collect();
    return JSON.stringify({
      bodies: Object.fromEntries(
        bodies.map((b) => {
          const { summary, ...rest } = b;
          const { updatedAt: _u, ...card } = summary ?? ({} as Record<string, unknown>);
          return [b.name, { ...rest, summary: card }];
        }),
      ),
      facts: Object.fromEntries(
        facts
          .filter((f) => bodies.some((b) => b._id === f.waterBodyId))
          .map((f) => [f.waterBodyId, (f.neighbors ?? []).map((n) => n.waterBodyId).sort()]),
      ),
      orphanLinks: links.filter((l) => !live.has(l.waterBodyId) || !live.has(l.neighborId)).length,
      profiles: await Promise.all(people.map((id) => ctx.db.get(id))),
      flags: flags.map((f) => {
        const m = members.find((x) => x.sourceId === f._id);
        const item = items.find((i) => i._id === m?.itemId);
        return [f.status, f.resolvedAt ?? null, m?.status ?? null, item?.status ?? null];
      }),
      reports: (await ctx.db.query('reports').collect()).filter((r) => mine(r.authorId)),
      comments: (await ctx.db.query('comments').collect()).filter((c) => mine(c.authorId)),
      hazards: (await ctx.db.query('hazards').collect()).filter((h) => mine(h.createdByUserId)),
      // Those on real bodies: the merge-proof pair's launch and bounty sit on the seed's own (B01-5d).
      bounties: (await ctx.db.query('bounties').collect()).filter((x) => real(x.waterBodyId)),
      putIns: (await ctx.db.query('putIns').collect()).filter((x) => real(x.waterBodyId)),
      queued: (await ctx.db.query('notificationQueue').collect()).filter((q) => mine(q.userId)),
      notified: (await ctx.db.query('notifications').collect()).filter((q) => mine(q.userId)),
      points: (await ctx.db.query('pointEvents').collect()).filter((e) => mine(e.userId)),
    });
  });
  return JSON.parse(json) as Record<string, unknown>;
}

/** Every table's row count — what the clear must put back. */
async function counts(t: T) {
  const tables = Object.keys(schema.tables) as TableNames[];
  return t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of tables) out[table] = (await ctx.db.query(table).collect()).length;
    return out;
  });
}

/** The script's loop, against the world: `state`, file every ready step as its actor, again. */
async function runSeed(t: T) {
  await t.mutation(internal.inboxSeed.ensurePeople, { apply: true });
  const filed: string[] = [];
  const calls: SeedCall[] = [];
  const failed: { key: string; error: string }[] = [];
  for (let wave = 0; wave < 20; wave++) {
    const s = (await t.query(internal.inboxSeed.state, {})) as SeedState;
    const ready = s.ready.filter((c) => !failed.some((f) => f.key === c.key));
    if (ready.length === 0) return { filed, failed, calls, last: s };
    for (const call of ready) {
      try {
        await fileStep(t, call);
        filed.push(call.key);
        calls.push(call);
      } catch (err) {
        failed.push({ key: call.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  throw new Error('the seed did not settle in 20 waves');
}

async function fileStep(t: T, call: SeedCall) {
  const ref = makeFunctionReference<'mutation'>(call.fn);
  if (call.as === 'bare') return t.mutation(ref, call.args);
  const subject = call.as === 'operator' ? OPERATOR : call.clerkUserId;
  if (!subject) throw new Error(`no subject for ${call.key}`);
  return t.withIdentity({ subject, via: 'seed-inbox' }).mutation(ref, call.args);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CONVEX_CLOUD_URL', `https://${DEV_DEPLOYMENT}.convex.cloud`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Run `clear` to done, as the script does; how many calls it took and what it removed. */
async function runClear(t: T, budgetBytes?: number) {
  const removed: Record<string, number> = {};
  for (let calls = 1; calls <= 2_000; calls++) {
    const out = await t.mutation(
      internal.inboxSeed.clear,
      budgetBytes !== undefined ? { budgetBytes } : {},
    );
    const moved = Object.values(out.removed).reduce((a, b) => a + b, 0);
    // Every call removes something or finishes — never wedges.
    if (!out.done && moved === 0) throw new Error(`clear made no progress on call ${calls}`);
    for (const [k, n] of Object.entries(out.removed)) removed[k] = (removed[k] ?? 0) + n;
    if (out.done) return { calls, removed };
  }
  throw new Error('the clear did not finish');
}

/** What a stored-count table says, without its zero rows (a count that went 1 → 0 keeps its row). */
async function tallies(t: T) {
  return t.run(async (ctx) => {
    const read = async (table: 'inboxCounts' | 'peopleCounts' | 'bodyLibraryCounts') =>
      Object.fromEntries(
        (await ctx.db.query(table).collect())
          .filter((r) => r.count !== 0)
          .map((r) => [`${'lane' in r ? `${r.lane}:${r.scope}:` : ''}${r.key}`, r.count]),
      );
    return {
      inboxCounts: await read('inboxCounts'),
      peopleCounts: await read('peopleCounts'),
      bodyLibraryCounts: await read('bodyLibraryCounts'),
    };
  });
}

/** The tables the clear leaves by design: anonymous counters no row of which names a person. */
const UNATTRIBUTED = new Set(['textLengthEvents', 'externalApiCalls', 'metricSnapshots']);
/** The stored counts: compared by what they count, above. */
const COUNTS = new Set(['inboxCounts', 'peopleCounts', 'bodyLibraryCounts']);

async function drainLibrary(t: T) {
  for (let more = true; more; ) more = (await t.mutation(internal.bodyLibrary.drainQueue, {})).more;
}

const lanesOf = async (t: T) => {
  const view = await t
    .withIdentity({ subject: OPERATOR })
    .query(api.inbox.lanes, { now: Date.now(), dayStart: Date.now() - 3_600_000 });
  return {
    allOpen: view.allOpen,
    decided: view.decided,
    lanes: Object.fromEntries(view.lanes.map((l) => [l.lane, { open: l.open, ...l.facets }])),
  };
};

describe('the seed, end to end', () => {
  test('files every step through the real mutations; the lanes hold the plan; a second run files nothing; the clear puts every table back', async () => {
    const t = harness();
    const urls: string[] = [];
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 });
      }),
    );
    await devWorld(t);
    const real = await realLife(t);
    await crons(t);
    const realBefore = await realState(t, real);
    const before = await counts(t);
    const beforeTallies = await tallies(t);

    const beforeApply = urls.length;
    const run = await runSeed(t);
    const byHost = (list: string[]) =>
      list.reduce<Record<string, number>>((acc, u) => {
        const host = new URL(u).hostname;
        acc[host] = (acc[host] ?? 0) + 1;
        return acc;
      }, {});
    // A full apply's external calls: the three admit asks' catalog lookups (USGS 3DHP), and no
    // weather (every seeded report carries its own conditions, so none schedules the auto-fill).
    expect(byHost(urls.slice(beforeApply))).toEqual({ 'hydro.nationalmap.gov': 3 });
    // The seed touched nothing of a real person's — not a point, a tally, a report, a pin, a bounty
    // or a notification — though their report, pin, favorite and bounty sit on its bodies.
    expect(await realState(t, real)).toEqual(realBefore);
    // And by the plan's own rule: every step acts on what the fake people wrote, on one of them, or
    // on a body.
    const seedIds = await t.run(async (ctx) => {
      const fake = new Set(
        (await ctx.db.query('profiles').collect())
          .filter((p) => p.clerkUserId.startsWith('seed_inbox_'))
          .map((p) => p._id as string),
      );
      const owned = new Set<string>(fake);
      const add = (id: string, owner: string | undefined) => {
        if (owner !== undefined && fake.has(owner)) owned.add(id);
      };
      for (const r of await ctx.db.query('reports').collect()) add(r._id, r.authorId);
      for (const r of await ctx.db.query('comments').collect()) add(r._id, r.authorId);
      for (const r of await ctx.db.query('hazards').collect()) add(r._id, r.createdByUserId);
      for (const r of await ctx.db.query('accessAlerts').collect()) add(r._id, r.createdByUserId);
      for (const r of await ctx.db.query('waterBodyRequests').collect()) add(r._id, r.requesterId);
      for (const r of await ctx.db.query('contentFlags').collect()) add(r._id, r.flaggerId);
      for (const r of await ctx.db.query('gpsActivities').collect()) add(r._id, r.userId);
      for (const b of await ctx.db.query('waterBodies').collect()) add(b._id, b.createdByUserId);
      // An Inbox item is the fake people's when every member was filed by one of them.
      const members = await ctx.db.query('inboxItemMembers').collect();
      for (const item of await ctx.db.query('inboxItems').collect()) {
        const of = members.filter((m) => m.itemId === item._id);
        if (
          of.length > 0 &&
          of.every((m) => m.filedByUserId !== undefined && fake.has(m.filedByUserId))
        ) {
          owned.add(item._id);
        }
      }
      return [...owned];
    });
    const seedOwned = new Set(seedIds);
    for (const call of run.calls) {
      for (const [table, id] of targetsOf(call)) {
        if (table === 'waterBodies') continue;
        expect([call.key, table, seedOwned.has(id)]).toEqual([call.key, table, true]);
      }
    }
    // Dev's library cron builds the drawn bodies' rows, as it would within the minute.
    await drainLibrary(t);
    expect(run.failed).toEqual([]);
    expect(run.last.waiting).toEqual([]);
    expect(run.last.unavailable).toEqual([]);
    expect(run.last.ready).toEqual([]);

    // The merge-proof pair (B01-5d) adds four open items — its drawing, an access report on each of
    // its two sides, its bay ask — and its two seed lakes' approvals to the decided.
    expect(await lanesOf(t)).toEqual({
      allOpen: 27,
      decided: 14,
      lanes: {
        safety: { open: 2, all: 2, reports: 1, hazards: 1, people: 0 },
        accessReports: { open: 4, all: 4, disputes: 1, new: 3 },
        requests: {
          open: 6,
          all: 6,
          activate: 1,
          admit: 2,
          restore: 1,
          contest_access: 1,
          takedown: 1,
        },
        placesAsked: { open: 4, all: 4, bays: 2, landmarks: 2 },
        drawnBodies: { open: 2, all: 2, overlap: 2, newWater: 0 },
        contentFlags: { open: 5, all: 5, reports: 2, comments: 1, alerts: 1, photos: 0, people: 1 },
        support: { open: 4, all: 4, account: 1, bug: 1, safety: 1, other: 1 },
      },
    });
    // The merge-proof pair (B01-5d), as the proof finds it: the drawing over two of the seed's own
    // lakes, and a preview of every row a merge would move, none of it on a real body (D287).
    const pair = await t.run(async (ctx) => {
      const bodies = await ctx.db.query('waterBodies').collect();
      const named = (name: string) => bodies.find((b) => b.name === name);
      return {
        cove: named('Merge Proof Cove'),
        pond: named('Merge Proof Pond')?._id,
        west: named('Merge Proof Pond West')?._id,
        morey: named('Morey East Bay')?.duplicateCandidateIds,
      };
    });
    expect(pair.cove?.reviewStatus).toBe('pending');
    expect([...(pair.cove?.duplicateCandidateIds ?? [])].sort()).toEqual(
      [pair.pond, pair.west].sort(),
    );
    const survivorId = pair.cove?.duplicateCandidateIds?.[0] as Id<'waterBodies'>;
    const operatorAs = t.withIdentity({ subject: OPERATOR });
    const preview = await operatorAs.query(api.bodyConsole.mergePreview, {
      loserId: pair.cove?._id as Id<'waterBodies'>,
      survivorId,
    });
    if (!preview.ok) throw new Error(preview.refusal);
    expect(Object.fromEntries(Object.entries(preview.moves).map(([k, c]) => [k, c.count]))).toEqual(
      {
        reports: 1,
        hazards: 1,
        bounties: 1,
        bodyFeatures: 0,
        putIns: 1,
        favorites: 1, // the drawing only; the other person's is dropped as a twin
        requests: 1,
        placeNames: 1,
        flags: 1, // the second report stays: its reporter already reported the survivor
        subAreas: 2,
        landmarks: 1,
        gpsActivities: 1,
      },
    );
    expect(preview).toMatchObject({
      favoritesDeduped: 1,
      baysClashing: ['Proof Bay'],
      lists: { pins: 1, aliases: 2, links: 2 },
      tooBig: false,
    });
    // The census reads the same state the same way twice.
    const census = { ids: [pair.cove?._id as Id<'waterBodies'>, survivorId] };
    const first = await t.query(internal.waterBodies.mergeProofCensus, census);
    expect(await t.query(internal.waterBodies.mergeProofCensus, census)).toBe(first);
    expect(first).toContain('Proof Inlet');

    // The Decided lane holds every decision word, each made by the operator on what a fake person
    // filed (D289), every one through the Inbox's writes or the ask's and drawing's own mutations.
    const decided = await t.run(async (ctx) => {
      const operator = (await ctx.db.query('profiles').collect()).find(
        (p) => p.clerkUserId === OPERATOR,
      );
      const items = (await ctx.db.query('inboxItems').collect()).filter(
        (i) => i.status === 'decided',
      );
      return {
        words: items.map((i) => `${i.lane}:${i.decision}`).sort(),
        byOperator: items.every((i) => i.decidedByUserId === operator?._id),
        withAction: items.every((i) => i.decisionActionId !== undefined),
      };
    });
    expect(decided).toEqual({
      words: [
        'contentFlags:dismissed',
        'contentFlags:hidden',
        'contentFlags:removed',
        'contentFlags:restored',
        'contentFlags:unpinned',
        'drawnBodies:approved',
        'drawnBodies:approved',
        'drawnBodies:approved',
        'drawnBodies:approved',
        'drawnBodies:approved',
        'drawnBodies:approved',
        'drawnBodies:rejected',
        'requests:approved',
        'requests:declined',
      ],
      byOperator: true,
      withAction: true,
    });

    const world = await t.run(async (ctx) => {
      const items = await ctx.db.query('inboxItems').collect();
      const flags = await ctx.db.query('contentFlags').collect();
      const people = (await ctx.db.query('profiles').collect()).filter((p) =>
        p.clerkUserId.startsWith('seed_inbox_'),
      );
      return {
        members: Object.fromEntries(
          items
            .filter((i) => i.status === 'open')
            .map((i) => [
              `${i.lane}:${i.facet}:${i.key.split(':')[0]}:${i.waterBodyId ?? i.subjectUserId ?? ''}`,
              i.memberCount,
            ]),
        ),
        maxMembers: Math.max(...items.map((i) => i.memberCount)),
        safetyReport: items.find((i) => i.lane === 'safety' && i.facet === 'reports')?.memberCount,
        accessNew: items.find((i) => i.lane === 'accessReports' && i.facet === 'new')?.memberCount,
        disputes: items.find((i) => i.lane === 'accessReports' && i.facet === 'disputes')
          ?.memberCount,
        bay: items.find((i) => i.lane === 'placesAsked' && i.facet === 'bays')?.memberCount,
        landmarks: items
          .filter((i) => i.lane === 'placesAsked' && i.facet === 'landmarks')
          .map((i) => i.memberCount)
          .sort(),
        activate: items.find((i) => i.lane === 'requests' && i.facet === 'activate')?.memberCount,
        auto: flags.filter((f) => f.origin === 'auto').map((f) => [f.reason, f.occurrences]),
        reasons: [...new Set(flags.map((f) => f.reason))].sort(),
        statuses: Object.fromEntries(
          people.map((p) => [
            p.displayName.split(' ')[0],
            [p.status, p.suspendedUntil !== undefined, p.canPostComments ?? true],
          ]),
        ),
        notified: (await ctx.db.query('notifications').collect()).filter((n) =>
          people.some((p) => p._id === n.userId),
        ).length,
        queued: (await ctx.db.query('notificationQueue').collect()).filter((n) =>
          people.some((p) => p._id === n.userId),
        ).length,
        alerts: (await ctx.db.system.query('_scheduled_functions').collect()).filter(
          (j) => j.name === 'operatorAlerts:send',
        ).length,
      };
    });
    expect(world).toMatchObject({
      safetyReport: 3, // three people flag one report: one item
      accessNew: 3,
      disputes: 2,
      bay: 3,
      landmarks: [1, 2], // one place two people named, and a lookalike by name elsewhere
      activate: 2, // siblings
      reasons: [
        'auto_low_quality',
        'harassment',
        'inappropriate',
        'no_public_access',
        'other',
        'spam',
        'unsafe_false_report',
      ],
      statuses: {
        Ada: ['active', false, true],
        Ben: ['banned', false, true],
        Cleo: ['active', false, false],
        Dev: ['active', false, true], // suspended, then lifted
        Elin: ['active', false, true],
        Finn: ['suspended', true, true],
        Gus: ['active', false, true],
        Hana: ['active', false, true],
      },
      notified: 0,
      queued: 0,
      alerts: 0, // no operator was paged by anything a fake person did
    });
    expect(world.auto).toEqual(
      expect.arrayContaining([
        ['auto_low_quality', 3], // five thumbs down, counted from the third
        ['unsafe_false_report', 1], // the hazard nobody else found
      ]),
    );
    expect(urls.filter((u) => u.includes('clerk.com'))).toEqual([]);

    // A second run files nothing new: every step's seed key finds its row.
    const beforeAgain = urls.length;
    const again = await runSeed(t);
    // A second apply, and the plan read, cost no external call.
    expect(urls.slice(beforeAgain)).toEqual([]);
    expect(again.filed).toEqual([]);
    expect(again.last.done).toHaveLength(run.filed.length);

    // The dry run of the clear says what it would remove, and removes nothing.
    const plan = await t.query(internal.inboxSeed.clearPlan, {});
    // The merge-proof pair adds its report and its three tracks (B01-5d).
    expect(plan).toMatchObject({ profiles: 8, reports: 10, supportTickets: 4, gpsActivities: 9 });

    const beforeClear = urls.length;
    const cleared = await runClear(t);
    const clearCalls = urls.slice(beforeClear);
    expect(clearCalls).toEqual([]);
    expect(cleared.removed.profiles).toBe(8);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Before any cron runs, the drawn bodies' library rows are already gone with them.
    expect((await counts(t)).bodyLibraryRows).toBe(before.bodyLibraryRows);
    // Then dev's crons re-derive what the removed rows counted on (the cards, the library, the
    // geometry facts), and every table the clear owns is back.
    await crons(t);
    const end = await counts(t);
    const left = Object.fromEntries(
      Object.entries(end)
        .filter(([k, n]) => n !== before[k] && !UNATTRIBUTED.has(k) && !COUNTS.has(k))
        .map(([k, n]) => [k, n - (before[k] ?? 0)]),
    );
    expect(left).toEqual({});
    expect(await tallies(t)).toEqual(beforeTallies);
    expect(await lanesOf(t)).toMatchObject({ allOpen: 0, decided: 0 });

    // Nothing of the merge-proof pair survives the clear.
    expect(
      await t.run(async (ctx) => ({
        bodies: (await ctx.db.query('waterBodies').collect()).filter((b) =>
          b.name.startsWith('Merge Proof'),
        ).length,
        bays: (await ctx.db.query('waterBodySubAreas').collect()).length,
        landmarks: (await ctx.db.query('bodyLandmarks').collect()).filter((l) =>
          l.name.startsWith('Proof'),
        ).length,
        placeNames: (await ctx.db.query('corpusPlaceNames').collect()).length,
        favorites: (await ctx.db.query('waterBodyFavorites').collect()).filter(
          (f) => String(f.waterBodyId) === String(pair.cove?._id),
        ).length,
      })),
    ).toEqual({ bodies: 0, bays: 0, landmarks: 0, placeNames: 0, favorites: 0 });

    // A second clear has nothing to do.
    const twice = await runClear(t);
    expect(twice.removed).toEqual({});
  });

  test('the clear walks on a small budget, a row at a time, to the same end', async () => {
    const t = harness();
    await devWorld(t);
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'user_real',
        displayName: 'Real Person',
        username: 'real_person',
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
    await crons(t);
    const before = await counts(t);
    await runSeed(t);
    await drainLibrary(t);
    // What a real person writes about the fake people goes with them: a flag on a fake person's
    // report, a comment under it, a flag on a fake person.
    const real = t.withIdentity({ subject: 'user_real' });
    const blackIce = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('reports')
            .withIndex('by_idempotency_key', (q) =>
              q.eq('idempotencyKey', 'seed-inbox:r-black-ice'),
            )
            .first()
        )?._id,
    );
    const hana = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('profiles')
            .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'seed_inbox_8'))
            .first()
        )?._id,
    );
    if (!blackIce || !hana) throw new Error('seed failed');
    await real.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: blackIce,
      reason: 'spam',
    });
    await real.mutation(api.comments.create, {
      reportId: blackIce,
      body: 'Where exactly were the holes?',
    });
    await real.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: hana,
      reason: 'other',
    });
    // One Inbox exit and a little more: about a row a call.
    const small = await runClear(t, INBOX_LEAVE_COST + 2 * 1024 * 1024);
    await crons(t);
    const full = small.calls;
    expect(full).toBeGreaterThan(40);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const end = await counts(t);
    for (const [table, n] of Object.entries(end)) {
      if (UNATTRIBUTED.has(table) || COUNTS.has(table) || table === 'bodyLibraryQueue') continue;
      expect([table, n]).toEqual([table, before[table]]);
    }
  });
});

describe('real people and real bodies, left exactly as they were found', () => {
  test('a full apply writes nothing of theirs; the clear puts back what their own acts on seeded content moved', async () => {
    const t = harness();
    await devWorld(t);
    const { people, accessFlag } = await realAround(t);
    await crons(t);
    const before = await realRows(t, people);

    const run = await runSeed(t);
    expect(run.failed).toEqual([]);
    await crons(t);
    // After the apply: nothing of a real person's, and no real body's stored state, has moved —
    // the cards of the bodies the seed reported on aside, which the clear re-derives.
    const applied = await realRows(t, people);
    const cardless = (rows: Record<string, unknown>) => ({
      ...rows,
      bodies: Object.fromEntries(
        Object.entries(rows.bodies as Record<string, Record<string, unknown>>).map(([k, b]) => [
          k,
          { ...b, summary: null },
        ]),
      ),
      facts: null,
    });
    expect(diffPaths(cardless(before), cardless(applied))).toEqual([]);
    const accessItem = await t.run(async (ctx) => (await ctx.db.get(accessFlag))?.status);
    expect(accessItem).toBe('open');

    // Real people then act on seeded content: a comment, a flag, a thumb.
    const real = t.withIdentity({ subject: 'user_author' });
    const blackIce = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('reports')
            .withIndex('by_idempotency_key', (q) =>
              q.eq('idempotencyKey', 'seed-inbox:r-black-ice'),
            )
            .first()
        )?._id as Id<'reports'>,
    );
    await real.mutation(api.comments.create, { reportId: blackIce, body: 'Which launch?' });
    await real.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: blackIce,
      reason: 'other',
      note: 'Wrong lake?',
    });
    await real.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: blackIce,
      verdict: 'helpful',
    });
    // And a vote on the seed's pin, which earns the real voter points the clear must move back.
    const crack = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('hazards')
            .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', 'seed-inbox:h-crack'))
            .first()
        )?._id as Id<'hazards'>,
    );
    await real.mutation(api.hazardConfirmations.confirm, {
      hazardId: crack,
      verdict: 'still_there',
      via: 'app_open_nearby',
    });
    const voted = await t.run(
      async (ctx) => (await ctx.db.get(people[0] as Id<'profiles'>))?.reputationPoints,
    );
    const was = (before.profiles as { reputationPoints: number }[])[0]?.reputationPoints ?? 0;
    expect(voted).toBeGreaterThan(was);

    await runClear(t);
    await crons(t);
    // After the clear: every real row as it was — their comment and flag on seeded content went
    // with it (by design), and the counter the comment moved moved back.
    expect(diffPaths(before, await realRows(t, people))).toEqual([]);
  });
  test('a body the operator moves through the seeded Inbox is re-derived by the clear, a later real ruling stands, and a second apply files nothing on another body', async () => {
    const t = harness();
    await devWorld(t);
    // A second dormant body, so a role resolved from live state would move to it.
    const second = await body(t, 'Second Sleepy Pond', 44.15, -72.45, 1);
    await t.run((ctx) =>
      ctx.db.patch(second, {
        dormant: { since: Date.now() - 400 * 86_400_000, reason: 'inactive' },
      }),
    );
    await crons(t);
    const run = await runSeed(t);
    expect(run.failed).toEqual([]);
    const operator = t.withIdentity({ subject: OPERATOR });
    const [activate, morey, sleepy, other] = await t.run(async (ctx) => {
      const asks = await ctx.db.query('waterBodyRequests').collect();
      const bodies = await ctx.db.query('waterBodies').collect();
      const ask = asks.find((r) => r.kind === 'activate');
      const dormant = bodies.filter((b) => b.name.includes('Sleepy Pond')).map((b) => b._id);
      return [
        ask?._id,
        bodies.find((b) => b.name === 'Lake Morey')?._id,
        ask?.waterBodyId,
        dormant.find((id) => id !== ask?.waterBodyId),
      ];
    });
    if (!activate || !morey || !sleepy || !other) throw new Error('seed failed');
    // The operator uses the seeded Inbox: the activate ask approved wakes the real dormant body.
    await operator.mutation(api.corpusRequests.approve, { requestId: activate });
    // And rules a real body by hand, after the seed filed on it.
    await operator.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: morey,
      verdict: 'open',
      note: 'Town beach.',
    });
    await crons(t);
    // A second apply files nothing — no activate ask on the second dormant body.
    const again = await runSeed(t);
    expect(again.filed).toEqual([]);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query('waterBodyRequests').collect()).filter((r) => r.waterBodyId === other),
      ),
    ).toEqual([]);

    await runClear(t);
    await crons(t);
    const after = await t.run(async (ctx) => ({
      morey: (await ctx.db.get(morey))?.publicAccess?.verdict ?? null,
      sleepyAsks: (
        await ctx.db
          .query('bodyLibraryRows')
          .withIndex('by_body', (q) => q.eq('waterBodyId', sleepy))
          .collect()
      ).map((r) => r.asks),
    }));
    // The hand ruling stands; the woken body's library row no longer counts the seed's asks.
    expect(after.morey).toBe('open');
    expect(after.sleepyAsks.every((n) => n === 0)).toBe(true);
  });
});

/** The merge-proof pair merged from the Inbox, as the operator would: the drawing's own lever. */
async function mergeProofPair(t: T) {
  const { itemId, survivorId, cove } = await t.run(async (ctx) => {
    const cove = (await ctx.db.query('waterBodies').collect()).find(
      (b) => b.name === 'Merge Proof Cove',
    );
    if (!cove) throw new Error('no merge-proof drawing');
    const member = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', 'waterBodies').eq('sourceId', cove._id))
      .first();
    return {
      cove: cove._id,
      itemId: member?.itemId as Id<'inboxItems'>,
      survivorId: cove.duplicateCandidateIds?.[0] as Id<'waterBodies'>,
    };
  });
  const out = await t
    .withIdentity({ subject: OPERATOR })
    .mutation(api.inboxWrites.mergeDrawn, { itemId, survivorId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { ...out, cove };
}

/** The tables the clear owns, against `before`: every one back (the anonymous counters aside). */
async function leftAfterClear(t: T, before: Record<string, number>) {
  const end = await counts(t);
  return Object.fromEntries(
    Object.entries(end)
      .filter(([k, n]) => n !== before[k] && !UNATTRIBUTED.has(k) && !COUNTS.has(k))
      .map(([k, n]) => [k, n - (before[k] ?? 0)]),
  );
}

/** The seed's whole life on dev with a merge in it, from a world of real people and bodies. */
async function mergedWorld() {
  const t = harness();
  await devWorld(t);
  const { people } = await realAround(t);
  await crons(t);
  const before = {
    counts: await counts(t),
    real: await realRows(t, people),
    tallies: await tallies(t),
  };
  const run = await runSeed(t);
  expect(run.failed).toEqual([]);
  await crons(t);
  const merged = await mergeProofPair(t);
  expect((await t.run((ctx) => ctx.db.get(merged.cove)))?.reviewStatus).toBe('merged');
  return { t, people, before, merged };
}

/** Clear to done, let dev's crons re-derive, and hold that nothing of the seed is left. */
async function clearsEverything(w: Awaited<ReturnType<typeof mergedWorld>>) {
  await runClear(w.t);
  await w.t.finishAllScheduledFunctions(vi.runAllTimers);
  await crons(w.t);
  expect(await leftAfterClear(w.t, w.before.counts)).toEqual({});
  expect(await tallies(w.t)).toEqual(w.before.tallies);
  expect(diffPaths(w.before.real, await realRows(w.t, w.people))).toEqual([]);
  expect((await runClear(w.t)).removed).toEqual({});
}

describe('the clear finds everything the seed made, whatever was merged since (B01-5d)', () => {
  test('apply, merge the proof pair from the Inbox, clear: nothing of the seed remains', async () => {
    await clearsEverything(await mergedWorld());
  });

  test('apply, merge, apply again: nothing new is filed; then the clear takes it all', async () => {
    const w = await mergedWorld();
    const again = await runSeed(w.t);
    expect(again.failed).toEqual([]);
    expect(again.filed).toEqual([]);
    expect(again.last.ready).toEqual([]);
    // Every step still finds its row: none waits, none reads as impossible here.
    expect(again.last.waiting).toEqual([]);
    expect(again.last.unavailable).toEqual([]);
    await clearsEverything(w);
  });

  // The unmerge is the undo of the merge's row (B01-5d's S4b inverse).
  test('apply, merge, unmerge, clear: nothing of the seed remains', async () => {
    const w = await mergedWorld();
    await w.t
      .withIdentity({ subject: OPERATOR })
      .mutation(api.undo.run, { actionId: w.merged.actionId, reason: 'Not the same water' });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    for (let pages = 0; pages < 50; pages++) {
      const next = (
        await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      ).find((j) => j.state.kind === 'pending');
      if (!next) break;
      await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    expect((await w.t.run((ctx) => ctx.db.get(w.merged.cove)))?.reviewStatus).toBe('pending');
    await clearsEverything(w);
  });
});

describe('the seed refuses any deployment that is not dev', () => {
  test.each([
    ['no URL', undefined],
    ['prod', 'https://diligent-guanaco-965.convex.cloud'],
    ['a look-alike host', `https://${DEV_DEPLOYMENT}.convex.cloud.evil.example`],
    ['garbage', 'not a url'],
  ])('%s', async (_, url) => {
    const t = harness();
    if (url === undefined) vi.stubEnv('CONVEX_CLOUD_URL', '');
    else vi.stubEnv('CONVEX_CLOUD_URL', url);
    await expect(t.mutation(internal.inboxSeed.ensurePeople, { apply: true })).rejects.toThrow(
      SEED_DEV_ONLY,
    );
    await expect(t.query(internal.inboxSeed.state, {})).rejects.toThrow(SEED_DEV_ONLY);
    await expect(t.mutation(internal.inboxSeed.clear, {})).rejects.toThrow(SEED_DEV_ONLY);
    await expect(t.query(internal.inboxSeed.clearPlan, {})).rejects.toThrow(SEED_DEV_ONLY);
    await expect(
      t.mutation(internal.inboxSeed.ensureActivity, {
        person: 'ada',
        key: 'x',
        path: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        startTime: 0,
      }),
    ).rejects.toThrow(SEED_DEV_ONLY);
    expect(await t.run((ctx) => ctx.db.query('profiles').collect())).toEqual([]);
  });
});

describe('ensurePeople', () => {
  test('a dry run says who it would create and writes nothing; applied twice, the second creates no one', async () => {
    const t = harness();
    const dry = await t.mutation(internal.inboxSeed.ensurePeople, {});
    expect(dry).toMatchObject({ applied: false, existing: [] });
    expect(dry.created).toHaveLength(8);
    expect(await t.run((ctx) => ctx.db.query('profiles').collect())).toEqual([]);
    await t.mutation(internal.inboxSeed.ensurePeople, { apply: true });
    const second = await t.mutation(internal.inboxSeed.ensurePeople, { apply: true });
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(8);
    const people = await t.run((ctx) => ctx.db.query('profiles').collect());
    expect(people).toHaveLength(8);
    for (const p of people) {
      expect(p.clerkUserId.startsWith('seed_inbox_')).toBe(true);
      expect(Object.values(p.notificationPrefs).every((on) => on === false)).toBe(true);
      expect(p.channelPrefs).toEqual({ push: false, email: false });
      expect(p.email).toBeUndefined();
    }
    expect(await t.run((ctx) => ctx.db.query('peopleRows').collect())).toHaveLength(8);
    expect(await t.run((ctx) => ctx.db.query('pushTokens').collect())).toEqual([]);
  });

  test('asked about the operator, it answers their role and status — or null — and writes nothing', async () => {
    const t = harness();
    await devWorld(t);
    const out = await t.mutation(internal.inboxSeed.ensurePeople, { operator: OPERATOR });
    expect(out.operator).toEqual({ role: 'admin', status: 'active' });
    expect(
      (await t.mutation(internal.inboxSeed.ensurePeople, { operator: 'user_nobody' })).operator,
    ).toBeNull();
    expect('operator' in (await t.mutation(internal.inboxSeed.ensurePeople, {}))).toBe(false);
    const fake = (await t.run((ctx) => ctx.db.query('profiles').collect())).filter((p) =>
      p.clerkUserId.startsWith('seed_inbox_'),
    );
    expect(fake).toEqual([]);
  });

  test('names resolve through the library rows, not a full-text search over outlines', async () => {
    const t = harness();
    await devWorld(t);
    // The search index finds nothing for Mascoma Lake any more; its library row still names it.
    await t.run(async (ctx) => {
      const mascoma = (await ctx.db.query('waterBodies').collect()).find(
        (b) => b.name === 'Mascoma Lake',
      );
      if (mascoma) await ctx.db.patch(mascoma._id, { searchText: 'zzz' });
    });
    await t.mutation(internal.inboxSeed.ensurePeople, { apply: true });
    const s = (await t.query(internal.inboxSeed.state, {})) as SeedState;
    expect(s.bodies.find((b) => b.role === 'mascoma')?.name).toBe('Mascoma Lake');
  });

  test('a body the deployment lacks makes its steps unavailable, never waiting for ever', async () => {
    const t = harness();
    await t.mutation(internal.inboxSeed.ensurePeople, { apply: true });
    const s = (await t.query(internal.inboxSeed.state, {})) as SeedState;
    expect(s.waiting).toEqual([]);
    expect(s.ready.map((c) => c.key)).toEqual(['f-person', 't-bug', 't-safety', 't-other']);
    expect(s.unavailable.length).toBeGreaterThan(40);
    expect(s.bodies.every((b) => b.name === null)).toBe(true);
  });
});
