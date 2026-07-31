import { RECURRENCE_WINDOW_SEASONS, seasonOf, seasonStartMs } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { MAX_BODY_ATTEMPTS, RECURRENCE_LEASE_MS } from './recurrence';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

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

/** Pinned, per the convention `accountDeletion.test.ts` documents: a January fixture is in this season
 *  for half the year, and every date here is relative to a season boundary. */
const NOW = Date.UTC(2030, 0, 15, 12);
const CURRENT_SEASON = seasonOf(NOW);

/**
 * Fake timers from before the first schedule, per the trap `subAreas.test.ts` documents: the pass is a
 * `scheduler.runAfter(0)` chain, and convex-test leaves such a job `pending` until a timer fires — so
 * without this `finishAllScheduledFunctions` drains nothing and every assertion reads a table the job
 * never reached, which fails as a plausible-looking "the pass computed nothing".
 *
 * **And the clock is pinned to `NOW`**, which matters more here than in most files. Almost everything
 * in this phase defaults to `seasonOf(Date.now())` — the queue's season, the recompute's season, which
 * hazards `listForBody` shows — so fixtures dated in one season and a wall clock in another produce
 * empty results that look exactly like a broken query. The convention `accountDeletion.test.ts`
 * documents, for a phase where every single value is relative to a season boundary.
 */
function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(t: ReturnType<typeof convexTest>, subject: string, role = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: role as 'member' | 'moderator' | 'admin',
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      type: 'lake' as const,
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
      ...overrides,
    }),
  );
}

/** A day inside a given season, as epoch ms. `dayOffset` counts from July 1. */
function inSeason(season: number, dayOffset: number): number {
  return seasonStartMs(season) + dayOffset * 86_400_000;
}

/** A hazard at `metersEast` of the body's centre, first reported in `season`. */
async function seedHazard(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  {
    season,
    dayOffset = 190,
    metersEast = 0,
    type = 'pressure_ridge' as const,
    status = 'active' as const,
  }: {
    season: number;
    dayOffset?: number;
    metersEast?: number;
    type?: 'pressure_ridge' | 'thin_ice' | 'spring_current';
    status?: 'active' | 'archived';
  },
) {
  const at = inSeason(season, dayOffset);
  const lng = 0.5 + metersEast / 111_320;
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [lng, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.4995, minLng: lng - 0.0004, maxLat: 0.5005, maxLng: lng + 0.0004 },
      createdByUserId: authorId,
      photoIds: [],
      status,
      moderationStatus: 'visible' as const,
      firstReportedAt: at,
      lastConfirmedAt: at,
      confirmCount: 0,
      goneCount: 0,
      createdAt: at,
    }),
  );
}

/** Run a whole pass to completion. `convex-test` drains scheduled functions on `finishAllScheduledFunctions`. */
async function runPass(t: ReturnType<typeof convexTest>, season = CURRENT_SEASON) {
  await t.mutation(internal.recurrence.startRecurrenceRun, { season });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/**
 * The queue's first page, unwrapped — every assertion here is about which clusters come back, not
 * about the cursor. `listQueue` is genuinely paginated (its filters run per page and cannot ride the
 * index), so the pagination args are boilerplate at every call site and belong in one place.
 */
type QueueFilters = {
  family?: 'ridge' | 'spring' | 'gas' | 'reef' | 'volatile';
  minSeasons?: number;
  includePromoted?: boolean;
  includeSuppressed?: boolean;
};
/** What `t.withIdentity(...)` hands back — narrower than `convexTest`'s own return type. */
type AsUser = ReturnType<ReturnType<typeof convexTest>['withIdentity']>;

async function queuePage(as: AsUser, filters: QueueFilters = {}) {
  const { page } = await as.query(api.recurrence.listQueue, {
    paginationOpts: { numItems: 50, cursor: null },
    ...filters,
  });
  return page;
}

/**
 * Cast `never_existed` verdicts **the way the app does** — the vote rows *and* the `goneCount` the
 * confirm path recomputes alongside them.
 *
 * Not bookkeeping. The recompute skips reading a hazard's confirmations entirely when `goneCount` is
 * `0`, which is exact only because `hazardConfirmations.confirm` is the single writer and always
 * follows an insert with `recomputeLifecycle`. A fixture that inserted votes and left `goneCount` at
 * zero would be building a state the app cannot produce, and would then "prove" the short-circuit
 * broken. If a second writer of `hazardConfirmations` ever appears without maintaining `goneCount`,
 * the test below this helper is the one that should fail.
 */
async function seedNeverExisted(
  t: ReturnType<typeof convexTest>,
  hazardId: Id<'hazards'>,
  userIds: readonly Id<'profiles'>[],
) {
  await t.run(async (ctx) => {
    for (const userId of userIds) {
      await ctx.db.insert('hazardConfirmations', {
        hazardId,
        userId,
        verdict: 'never_existed' as const,
        via: 'app_open_nearby' as const,
        createdAt: Date.now(),
      });
    }
    const hazard = await ctx.db.get(hazardId);
    // Pooled with `fully_healed` (D65) — which is why the job still has to read the votes for the
    // split, and why `goneCount` can only ever answer "could there be any".
    if (hazard) await ctx.db.patch(hazardId, { goneCount: hazard.goneCount + userIds.length });
  });
}

describe('the recurrence pass', () => {
  test('records a cluster seen in three winters, with its denominator', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    for (const season of [CURRENT_SEASON - 2, CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await runPass(t);

    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seasonsObserved).toHaveLength(3);
    // The denominator is stored, not derived — "3 of the last 4 winters" is only honest if both halves
    // came from the same pass.
    expect(rows[0]?.windowSeasons).toBe(RECURRENCE_WINDOW_SEASONS);
    expect(rows[0]?.family).toBe('ridge');
    expect(rows[0]?.suggestedFeatureType).toBe('recurring_pressure_ridge');
  });

  test('a season contributes at most one, however many people pinned it', async () => {
    // Three skaters pinning the same ridge in one January is one winter of evidence. Without this,
    // one enthusiastic week becomes "a pattern" — the exact D3 trap the phase is built to avoid.
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const c = await seedUser(t, 'c');
    const waterBodyId = await seedBody(t);
    for (const author of [a, b, c]) {
      await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 5 });
    }
    await runPass(t);

    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows[0]?.seasonsObserved).toEqual([CURRENT_SEASON]);
    // The authors are still all counted — that is the number an operator reads to tell a real pattern
    // from one person's repeated mistake.
    expect(rows[0]?.distinctAuthorCount).toBe(3);
  });

  test('never crosses families', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, type: 'pressure_ridge' });
    await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON,
      type: 'spring_current',
      metersEast: 5,
    });
    await runPass(t);

    const families = (await t.run((ctx) => ctx.db.query('hazardRecurrence').collect()))
      .map((r) => r.family)
      .sort();
    expect(families).toEqual(['ridge', 'spring']);
  });

  test('counts an archived winter — "it healed" is a fact about last winter', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON - 1,
      status: 'archived',
    });
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 10 });
    await runPass(t);

    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows[0]?.seasonsObserved).toHaveLength(2);
  });

  test('excludes what a moderator hid and what the community said never existed', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);
    const hidden = await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON - 1 });
    const bogus = await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON - 2,
      metersEast: 5,
    });
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 10 });

    await t.run((ctx) => ctx.db.patch(hidden, { moderationStatus: 'hidden' }));
    // Two distinct non-author "never existed" verdicts: a claim the *report* was bogus, which is the
    // opposite of corroboration. `goneCount` can't answer this — it pools the two verdicts (D65).
    await seedNeverExisted(t, bogus, [sam.id, kim.id]);
    await runPass(t);

    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows[0]?.seasonsObserved).toEqual([CURRENT_SEASON]);
  });

  test('drops a hazard from before the window', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON - RECURRENCE_WINDOW_SEASONS,
    });
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 10 });
    await runPass(t);

    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows[0]?.seasonsObserved).toEqual([CURRENT_SEASON]);
  });

  test('is idempotent — two runs agree on everything but the clock', async () => {
    // The plan names this one explicitly, and it is the property that makes a "recompute now" button
    // safe to press: an operator must be able to re-run a body without wondering what it changed.
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    for (const season of [CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }

    await runPass(t);
    const first = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    await runPass(t);
    const second = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());

    expect(second).toHaveLength(first.length);
    const strip = (r: (typeof first)[number]) => ({ ...r, computedAt: 0, _creationTime: 0 });
    expect(second.map(strip)).toEqual(first.map(strip));
    // And the row was *patched*, not replaced — the id is what a suppression hangs off.
    expect(second[0]?._id).toBe(first[0]?._id);
  });

  test('a recompute keeps a suppression and a promotion across the diff', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON - 1, metersEast: 10 });
    await runPass(t);

    const before = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    await t.run((ctx) =>
      ctx.db.patch(before?._id as Id<'hazardRecurrence'>, {
        suppressedAt: 1_000,
        suppressedByUserId: mod.id,
        suppressReason: 'Three people misreading one shadow.',
      }),
    );

    // A new winter's sighting joins the cluster. Matched on member overlap rather than identity, so
    // the row a human touched survives growing by one.
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 15 });
    await runPass(t);

    const after = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(after).toHaveLength(1);
    expect(after[0]?._id).toBe(before?._id);
    expect(after[0]?.suppressedAt).toBe(1_000);
    expect(after[0]?.seasonsObserved).toHaveLength(2);
  });

  test('keeps a human-touched row that no longer matches, and marks it stale', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazard = await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await runPass(t);

    const row = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    await t.run(async (ctx) => {
      await ctx.db.patch(row?._id as Id<'hazardRecurrence'>, {
        suppressedAt: 1_000,
        suppressedByUserId: mod.id,
        suppressReason: 'Not a pattern.',
      });
      // The evidence goes away — a moderator hides the only pin behind it.
      await ctx.db.patch(hazard, { moderationStatus: 'hidden' });
    });
    await runPass(t);

    const after = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    // Kept, and said so: deleting it would drop the decision along with the reason for it.
    expect(after).toHaveLength(1);
    expect(after[0]?.staleSince).toBeGreaterThan(0);
    expect(after[0]?.publiclyVisible).toBe(false);
  });

  test('deletes an untouched row whose cluster is gone', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazard = await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await runPass(t);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(1);

    await t.run((ctx) => ctx.db.patch(hazard, { moderationStatus: 'hidden' }));
    await runPass(t);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(0);
  });

  test('nothing is publicly visible while the master switch is off', async () => {
    // The engine ships dark. Every output reaches an operator dashboard and nothing else.
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    for (const season of [
      CURRENT_SEASON - 3,
      CURRENT_SEASON - 2,
      CURRENT_SEASON - 1,
      CURRENT_SEASON,
    ]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await runPass(t);

    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows[0]?.seasonsObserved).toHaveLength(4);
    expect(rows[0]?.publiclyVisible).toBe(false);
  });

  test('empties its queue, so a later run is not blocked by an earlier one', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await runPass(t);
    expect(await t.run((ctx) => ctx.db.query('recurrenceQueue').collect())).toHaveLength(0);
  });
});

describe('the volatile family and the depth cross-check (§C7)', () => {
  async function volatilePass(depth: Record<string, unknown>) {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t, depth);
    for (const season of [CURRENT_SEASON - 2, CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, waterBodyId, author.id, { season, type: 'thin_ice', metersEast: 10 });
    }
    await runPass(t);
    return t.run((ctx) => ctx.db.query('hazardRecurrence').first());
  }

  test('proposes the type no hazard could ever reach', async () => {
    const row = await volatilePass({});
    expect(row?.family).toBe('volatile');
    // Unreachable from any hazard before this: no promotion path, no form. Recurrence is the evidence
    // that distinguishes "a thin patch happened here" from "this spot thaws first, every year".
    expect(row?.suggestedFeatureType).toBe('shallow_early_thaw');
  });

  test('agrees more readily when the depth says shallow', async () => {
    const row = await volatilePass({ meanDepthM: 2, meanDepthSource: 'lagos_us' });
    expect(row?.suggestedFeatureType).toBe('shallow_early_thaw');
  });

  test('withholds the suggestion where a measured depth contradicts it', async () => {
    // The claim is about the lake *bed*. A measured mean of 30 m is the only physical measurement we
    // hold, and it says the opposite — so the suggestion is withheld while the history is kept.
    const row = await volatilePass({ meanDepthM: 30, meanDepthSource: 'lagos_us' });
    expect(row?.suggestedFeatureType).toBeUndefined();
    expect(row?.seasonsObserved).toHaveLength(3);
  });

  test('still suggests where the contradicting depth is only modelled', async () => {
    // D68's provenance ladder exists so a claim can be weighted by what it was read off, and a
    // modelled depth is a guess that several winters of people standing there outweighs.
    const row = await volatilePass({ meanDepthM: 30, meanDepthSource: 'hydrolakes_modeled' });
    expect(row?.suggestedFeatureType).toBe('shallow_early_thaw');
  });
});

describe('recomputeForBody, the button and the merge hook', () => {
  test('a body merge recomputes both lakes', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const author = await seedUser(t, 'author');
    const survivorId = await seedBody(t);
    const loserId = await seedBody(t, { name: 'Duplicate Pond' });
    await seedHazard(t, loserId, author.id, { season: CURRENT_SEASON });
    await runPass(t);
    // The loser's cluster exists, ranked, on a lake that is about to stop existing.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('hazardRecurrence')
          .withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))
          .collect(),
      ),
    ).toHaveLength(1);

    await admin.as.mutation(api.waterBodies.merge, {
      survivorId,
      loserId,
      reason: 'Same pond, imported twice.',
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const onLoser = await t.run((ctx) =>
      ctx.db
        .query('hazardRecurrence')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))
        .collect(),
    );
    const onSurvivor = await t.run((ctx) =>
      ctx.db
        .query('hazardRecurrence')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', survivorId))
        .collect(),
    );
    // The hazards moved, so the clusters moved with them: nothing ranked on a tombstoned lake, and the
    // survivor carries the winter it just inherited.
    expect(onLoser).toHaveLength(0);
    expect(onSurvivor).toHaveLength(1);
  });
});

describe('the operator surface', () => {
  /** A body with a three-winter ridge cluster, already computed. */
  async function withCluster() {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const skater = await seedUser(t, 'skater');
    const waterBodyId = await seedBody(t);
    for (const season of [CURRENT_SEASON - 2, CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await runPass(t);
    const row = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    return { t, mod, author, skater, waterBodyId, row };
  }

  test('shows an operator everything, including a pattern too thin to be public', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await runPass(t);

    // One of one is exactly the "thin pattern" the founder call put on the dashboard and nowhere else.
    const admin = await mod.as.query(api.recurrence.listForBodyAdmin, { waterBodyId });
    expect(admin).toHaveLength(1);
    expect(admin[0]?.seasonsObserved).toHaveLength(1);
  });

  test('shows a skater nothing at all while the flag is off', async () => {
    const { t, skater, waterBodyId } = await withCluster();
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toEqual([]);
    void t;
  });

  test('refuses the operator reads to a member', async () => {
    const { skater, waterBodyId } = await withCluster();
    await expect(
      skater.as.query(api.recurrence.listForBodyAdmin, { waterBodyId }),
    ).rejects.toThrow();
    await expect(queuePage(skater.as)).rejects.toThrow();
  });

  test('ranks the cross-lake queue and names each lake', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const quiet = await seedBody(t, { name: 'Quiet Pond' });
    const busy = await seedBody(t, { name: 'Busy Pond' });
    await seedHazard(t, quiet, author.id, { season: CURRENT_SEASON });
    for (const season of [CURRENT_SEASON - 2, CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, busy, author.id, { season, metersEast: 10 });
    }
    await runPass(t);

    const queue = await queuePage(mod.as);
    expect(queue).toHaveLength(2);
    // Three winters outranks one — the only input that is about recurrence rather than about a row.
    expect(queue[0]?.waterBodyName).toBe('Busy Pond');
    expect(queue[0]?.priority).toBeGreaterThan(queue[1]?.priority as number);
  });

  test('suppression takes a cluster out of the queue and keeps the reason', async () => {
    const { mod, row } = await withCluster();
    await mod.as.mutation(api.recurrence.suppress, {
      recurrenceId: row?._id as Id<'hazardRecurrence'>,
      reason: 'Three people misreading the same shadow.',
    });

    expect(await queuePage(mod.as)).toHaveLength(0);
    // Still there, with the reason readable — never a delete.
    const withSuppressed = await queuePage(mod.as, { includeSuppressed: true });
    expect(withSuppressed[0]?.suppressReason).toBe('Three people misreading the same shadow.');
    expect(withSuppressed[0]?.publiclyVisible).toBe(false);
  });

  test('suppression requires a reason, and survives a recompute', async () => {
    const { t, mod, author, waterBodyId, row } = await withCluster();
    await expect(
      mod.as.mutation(api.recurrence.suppress, {
        recurrenceId: row?._id as Id<'hazardRecurrence'>,
        reason: '   ',
      }),
    ).rejects.toThrow(/reason/i);

    await mod.as.mutation(api.recurrence.suppress, {
      recurrenceId: row?._id as Id<'hazardRecurrence'>,
      reason: 'Not a pattern.',
    });
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 12 });
    await mod.as.mutation(api.recurrence.recomputeForBody, { waterBodyId });

    const after = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    expect(after?.suppressedAt).toBeGreaterThan(0);
  });

  test('unsuppressing puts it back', async () => {
    const { mod, row } = await withCluster();
    const recurrenceId = row?._id as Id<'hazardRecurrence'>;
    await mod.as.mutation(api.recurrence.suppress, { recurrenceId, reason: 'Not a pattern.' });
    await mod.as.mutation(api.recurrence.unsuppress, {
      recurrenceId,
      reason: 'On reflection it is.',
    });
    expect(await queuePage(mod.as)).toHaveLength(1);
  });

  test('promoting a cluster backlinks every member and hides none of them', async () => {
    const { t, mod, waterBodyId, row } = await withCluster();
    const featureId = await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId: row?._id as Id<'hazardRecurrence'>,
      type: 'recurring_pressure_ridge',
      reason: 'Reforms in the same place every winter.',
    });

    const members = await t.run(async (ctx) => {
      const cluster = await ctx.db.get(row?._id as Id<'hazardRecurrence'>);
      return Promise.all((cluster?.memberHazardIds ?? []).map((id) => ctx.db.get(id)));
    });
    expect(members).toHaveLength(3);
    for (const member of members) expect(member?.promotedToFeatureId).toBe(featureId);

    // **And they are all still on the map** (D53 amendment) — a feature is a pattern, a hazard is a
    // sighting, and promoting the first must not delete the second.
    const listed = await mod.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed.length).toBeGreaterThan(0);

    // The cluster leaves the queue but keeps its members, because the denominator has to go on meaning
    // something after a promotion.
    expect(await queuePage(mod.as)).toHaveLength(0);
    const after = await t.run((ctx) => ctx.db.get(row?._id as Id<'hazardRecurrence'>));
    expect(after?.memberHazardIds).toHaveLength(3);
  });

  test('the promoted feature carries the medoid’s own shape, not an average', async () => {
    const { t, mod, row } = await withCluster();
    const featureId = await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId: row?._id as Id<'hazardRecurrence'>,
      type: 'recurring_pressure_ridge',
      reason: 'Reforms here.',
    });
    const { feature, representative } = await t.run(async (ctx) => ({
      feature: await ctx.db.get(featureId),
      representative: await ctx.db.get(row?.representativeHazardId as Id<'hazards'>),
    }));
    expect(feature?.geometry).toEqual(representative?.geometry);
    expect(feature?.promotedFromHazardId).toBe(row?.representativeHazardId);
  });

  test('refuses to promote the same pattern twice', async () => {
    const { mod, row } = await withCluster();
    const recurrenceId = row?._id as Id<'hazardRecurrence'>;
    await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId,
      type: 'recurring_pressure_ridge',
      reason: 'Reforms here.',
    });
    await expect(
      mod.as.mutation(api.recurrence.promoteFromRecurrence, {
        recurrenceId,
        type: 'recurring_pressure_ridge',
        reason: 'Again by mistake.',
      }),
    ).rejects.toThrow(/already been promoted/);
  });

  test('demoting clears the backlink from every member the promotion set', async () => {
    // Clearing only `promotedFromHazardId` would leave the rest of the cluster naming a standing
    // statement about the lake that has been withdrawn — worse than no line at all.
    const { t, mod, row } = await withCluster();
    const featureId = await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId: row?._id as Id<'hazardRecurrence'>,
      type: 'recurring_pressure_ridge',
      reason: 'Reforms here.',
    });
    await mod.as.mutation(api.bodyFeatures.demote, {
      bodyFeatureId: featureId,
      reason: 'Not actually recurring.',
    });

    const members = await t.run(async (ctx) => {
      const cluster = await ctx.db.get(row?._id as Id<'hazardRecurrence'>);
      return Promise.all((cluster?.memberHazardIds ?? []).map((id) => ctx.db.get(id)));
    });
    for (const member of members) expect(member?.promotedToFeatureId).toBeUndefined();
    // And the pattern is back in the queue where the operator left it, rather than waiting for July.
    expect(await queuePage(mod.as)).toHaveLength(1);
  });

  test('every suppression and promotion leaves an audit row with its reason', async () => {
    const { t, mod, row } = await withCluster();
    await mod.as.mutation(api.recurrence.suppress, {
      recurrenceId: row?._id as Id<'hazardRecurrence'>,
      reason: 'Not a pattern.',
    });
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    const suppression = actions.find((a) => a.action === 'suppress_recurrence');
    expect(suppression?.reason).toBe('Not a pattern.');
    expect(suppression?.targetType).toBe('hazardRecurrence');
  });
});

describe('the job’s own machinery', () => {
  test('the July gate lets the rollover through in the first week and not otherwise', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });

    // January — nothing happens, which is 358 days of the year.
    await t.mutation(internal.recurrence.maybeRunRollover, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(0);

    // July 3rd of the following season: the pass runs.
    vi.setSystemTime(Date.UTC(2030, 6, 3, 12));
    await t.mutation(internal.recurrence.maybeRunRollover, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(1);
  });

  test('the daily tick is a no-op once the season has been computed', async () => {
    // What makes a *retryable* rollover safe: it fires every day in the window, and only the first one
    // that finds nothing computed does any work.
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    vi.setSystemTime(Date.UTC(2030, 6, 2, 12));

    await t.mutation(internal.recurrence.maybeRunRollover, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const first = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());

    await t.mutation(internal.recurrence.maybeRunRollover, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.computedAt).toBe(first?.computedAt); // untouched, not recomputed
  });

  test('a run that died part-way is picked up the next day, stamp or no stamp', async () => {
    // **The failure the daily tick exists for, and the one the no-op guard above nearly swallowed.**
    // The stamp records that *some* body was computed, not that the run finished — so a chain that
    // dies after body 1 of 200 leaves the stamp set and the queue full. Gating on the stamp alone
    // makes every remaining tick a no-op and the pass really does wait a year, which is precisely the
    // `crons.cron` failure §18.2 chose an interval to avoid.
    const t = harness();
    const author = await seedUser(t, 'author');
    const first = await seedBody(t);
    const second = await seedBody(t, { name: 'Lake Iroquois' });
    await seedHazard(t, first, author.id, { season: CURRENT_SEASON });
    await seedHazard(t, second, author.id, { season: CURRENT_SEASON });
    vi.setSystemTime(Date.UTC(2030, 6, 2, 12));

    // Stand in for the chain dying after the first body: one lake computed, one still queued.
    await t.mutation(internal.recurrence.startRecurrenceRun, { season: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      const done = await ctx.db.query('hazardRecurrence').collect();
      for (const row of done.slice(1)) await ctx.db.delete(row._id);
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: second,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
      });
    });
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(1);

    // The next day's tick. A stamp exists — and the leftover queue outranks it.
    vi.setSystemTime(Date.UTC(2030, 6, 3, 12));
    await t.mutation(internal.recurrence.maybeRunRollover, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(2);
    // And it finished: nothing left queued, so the tick after this one is a no-op again.
    expect(await t.run((ctx) => ctx.db.query('recurrenceQueue').collect())).toHaveLength(0);
  });

  test('a body whose recompute keeps failing is stepped over, not left blocking the queue', async () => {
    // **Greptile's finding, PR #35.** Claiming and computing used to be one transaction, so a
    // recompute that could not commit rolled the claim back with it: the queue row stayed, nothing
    // downstream was scheduled, and every later run picked the same lake first and died the same way.
    // One lake could stop the annual pass for the whole corpus, permanently — and the read set that
    // failed is a function of user-created hazards, so it was reachable from ordinary use.
    //
    // Simulated here by exhausting the attempt counter directly, which is the state a run of failures
    // leaves behind. The assertion that matters is that the *other* lake still gets computed.
    const t = harness();
    const author = await seedUser(t, 'author');
    const poisoned = await seedBody(t);
    const healthy = await seedBody(t, { name: 'Lake Iroquois' });
    await seedHazard(t, poisoned, author.id, { season: CURRENT_SEASON });
    await seedHazard(t, healthy, author.id, { season: CURRENT_SEASON });

    // The queue is built by hand rather than by discovery, so the poisoned row is *ahead* of the
    // healthy one and already holding the attempts a run of failures would have left on it. Driving
    // phase two directly is the only way to see the state a rolled-back recompute leaves behind.
    await t.run(async (ctx) => {
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: poisoned,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
        attempts: MAX_BODY_ATTEMPTS,
      });
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: healthy,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
      });
    });
    await t.mutation(internal.recurrence.processNextBody, { runForSeason: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const computed = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    // The healthy lake got its recompute — the queue drained past the one it could not do.
    expect(computed.map((r) => r.waterBodyId)).toEqual([healthy]);
    // And the poisoned one is still on the record rather than silently dropped.
    const left = await t.run((ctx) => ctx.db.query('recurrenceQueue').collect());
    expect(left).toHaveLength(1);
    expect(left[0]?.waterBodyId).toBe(poisoned);
    expect(left[0]?.skippedAt).toBeGreaterThan(0);
  });

  test('a long prefix of skipped bodies does not strand the ones behind it', async () => {
    // **Greptile's P1, PR #35.** `processNextBody` used to `.take(200)` and `.find()` an eligible row
    // in that slice, which is only "the next body" if no 200-row prefix is ineligible. Skipped rows
    // are retained on purpose and claimed rows linger until their lease expires, so a prefix of
    // exactly that kind is the *expected* end state of a bad run — and past 200 of them the scan found
    // nothing, scheduled nothing, and every body behind them went unrecomputed for the year.
    //
    // 250 skipped rows, then one real lake at the back.
    const t = harness();
    const author = await seedUser(t, 'author');
    const stranded = await seedBody(t, { name: 'Lake Iroquois' });
    await seedHazard(t, stranded, author.id, { season: CURRENT_SEASON });
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        const dead = await ctx.db.insert('waterBodies', {
          name: `Skipped ${i}`,
          type: 'lake' as const,
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
        });
        await ctx.db.insert('recurrenceQueue', {
          waterBodyId: dead,
          runForSeason: CURRENT_SEASON,
          createdAt: Date.now(),
          skippedAt: Date.now(),
        });
      }
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: stranded,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
      });
    });

    await t.mutation(internal.recurrence.processNextBody, { runForSeason: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The lake at the back of a 250-row skipped prefix got its recompute.
    const computed = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(computed.map((r) => r.waterBodyId)).toEqual([stranded]);
  }, 20_000);

  test('a claimed-but-fresh prefix stops the chain without stranding anything', async () => {
    // The other half of the same index: unclaimed rows sort ahead of claimed ones, and among claimed
    // the oldest lease comes first. So a fresh claim at the front is genuine proof that every
    // remaining row is claimed *more* recently — the chain stops because another run holds the queue,
    // not because it could not see past a slice.
    const t = harness();
    const author = await seedUser(t, 'author');
    const held = await seedBody(t);
    const free = await seedBody(t, { name: 'Lake Iroquois' });
    await seedHazard(t, held, author.id, { season: CURRENT_SEASON });
    await seedHazard(t, free, author.id, { season: CURRENT_SEASON });
    await t.run(async (ctx) => {
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: held,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
        claimedAt: Date.now(), // fresh lease, another run has it
      });
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: free,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
      });
    });

    await t.mutation(internal.recurrence.processNextBody, { runForSeason: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The unclaimed one sorts first and is taken, despite being inserted second.
    const computed = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(computed.map((r) => r.waterBodyId)).toEqual([free]);
  });

  test('a skipped body does not make every later tick restart a run with nothing to do', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    vi.setSystemTime(Date.UTC(2030, 6, 2, 12));
    await t.run((ctx) =>
      ctx.db.insert('recurrenceQueue', {
        waterBodyId,
        runForSeason: seasonOf(Date.now()),
        createdAt: Date.now(),
        skippedAt: Date.now(),
      }),
    );
    await t.mutation(internal.recurrence.maybeRunRollover, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The leftover is skipped, so it is not "unfinished work" — the stamp check decides, and there is
    // no stamp, so a real run happened. What must not happen is the skipped row being treated as a
    // reason to restart forever.
    const left = await t.run((ctx) => ctx.db.query('recurrenceQueue').collect());
    expect(left.every((r) => r.skippedAt !== undefined)).toBe(true);
  });

  test('the per-body read is bounded by the window at the index, not filtered after it', async () => {
    // The other half of the same finding: `by_water_body` is creation-ordered, so bounding four
    // winters there meant reading every hazard the lake has ever held. `hazards` never ages out, so
    // that read grows for the life of the app on exactly the lakes people use most.
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    // One inside the window, one long before it.
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 10 });
    await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON - RECURRENCE_WINDOW_SEASONS - 3,
      metersEast: 10,
    });
    await runPass(t);
    const row = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    expect(row?.seasonsObserved).toEqual([CURRENT_SEASON]);
    expect(row?.memberHazardIds).toHaveLength(1);
    // Nothing was truncated, so the honesty flag stays off.
    expect(row?.computedFromPartialHistory).toBeUndefined();
  });

  test('queues each body once however many of its hazards the scan sees', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    for (let i = 0; i < 5; i++) {
      await seedHazard(t, waterBodyId, author.id, {
        season: CURRENT_SEASON,
        metersEast: i * 500, // far apart, so they are five clusters rather than one
      });
    }
    await t.mutation(internal.recurrence.startRecurrenceRun, { season: CURRENT_SEASON });
    // Mid-run: discovery has queued, nothing has drained yet.
    const queued = await t.run((ctx) => ctx.db.query('recurrenceQueue').collect());
    expect(queued.length).toBeLessThanOrEqual(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(5);
  });

  test('a fresh claim is respected, so two runs do not do the same body twice', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await t.run((ctx) =>
      ctx.db.insert('recurrenceQueue', {
        waterBodyId,
        runForSeason: CURRENT_SEASON,
        claimedAt: Date.now(), // another run has it, and has it recently
        createdAt: Date.now(),
      }),
    );

    await t.mutation(internal.recurrence.processNextBody, { runForSeason: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Left alone: the other run owns it, and the chain stops rather than duplicating the work.
    expect(await t.run((ctx) => ctx.db.query('recurrenceQueue').collect())).toHaveLength(1);
  });

  test('a stale claim is taken over — the alternative is a body never recomputed at all', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await t.run((ctx) =>
      ctx.db.insert('recurrenceQueue', {
        waterBodyId,
        runForSeason: CURRENT_SEASON,
        claimedAt: Date.now() - 2 * RECURRENCE_LEASE_MS,
        createdAt: Date.now(),
      }),
    );

    await t.mutation(internal.recurrence.processNextBody, { runForSeason: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('recurrenceQueue').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(1);
  });

  test('a run clears an abandoned earlier season’s queue', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    await t.run((ctx) =>
      ctx.db.insert('recurrenceQueue', {
        waterBodyId,
        runForSeason: CURRENT_SEASON - 1,
        createdAt: Date.now(),
      }),
    );
    await runPass(t);
    // Leftovers would make a later phase-two think there is work it has already done.
    expect(await t.run((ctx) => ctx.db.query('recurrenceQueue').collect())).toHaveLength(0);
  });

  test('a queue row for a deleted body is dropped rather than stalling the run', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId,
        runForSeason: CURRENT_SEASON,
        createdAt: Date.now(),
      });
      await ctx.db.delete(waterBodyId);
    });
    await t.mutation(internal.recurrence.processNextBody, { runForSeason: CURRENT_SEASON });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Work that can never complete, left in place, would stall every later run on the same season.
    expect(await t.run((ctx) => ctx.db.query('recurrenceQueue').collect())).toHaveLength(0);
  });

  test('one "never existed" vote is not enough to drop a sighting', async () => {
    // The same two-vote bar archival uses. One person disagreeing is not the community saying a pin
    // was bogus, and treating it as such would let a single account erase a winter of evidence.
    const t = harness();
    const author = await seedUser(t, 'author');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const hazard = await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });
    await seedNeverExisted(t, hazard, [sam.id]);
    await runPass(t);
    expect(await t.run((ctx) => ctx.db.query('hazardRecurrence').collect())).toHaveLength(1);
  });

  test('a rejected hazard stays rejected however many people argued about the pin', async () => {
    // **Greptile's other P1, PR #35.** The verdict read was a `.take(200)` over the hazard's whole
    // argument, reduced to each user's latest vote. On a contested pin the decisive `never_existed`
    // rows can sit outside that prefix — and because a user's row is *patched in place* rather than
    // stacked, the prefix does not give a stale answer, it gives a wrong one: the community's
    // rejection is simply invisible and the hazard is admitted into a pattern.
    //
    // 300 `still_there` votes cast first, so they own the front of `by_hazard`, then the two verdicts
    // that decide the question. Read off `by_hazard_and_verdict`, the argument's size is irrelevant.
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bogus = await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON - 1,
      metersEast: 5,
    });
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 400 });

    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const voter = await ctx.db.insert('profiles', {
          clerkUserId: `noisy-${i}`,
          displayName: `noisy-${i}`,
          username: `noisy-${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: NOTIF_PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'active' as const,
          createdAt: Date.now(),
        });
        await ctx.db.insert('hazardConfirmations', {
          hazardId: bogus,
          userId: voter,
          verdict: 'still_there' as const,
          via: 'app_open_nearby' as const,
          createdAt: Date.now(),
        });
      }
    });
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    await seedNeverExisted(t, bogus, [sam.id, kim.id]);

    await runPass(t);
    // The rejected sighting is out, so the surviving cluster is this season's pin alone.
    const rows = await t.run((ctx) => ctx.db.query('hazardRecurrence').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seasonsObserved).toEqual([CURRENT_SEASON]);
    expect(rows[0]?.memberHazardIds).not.toContain(bogus);
  }, 20_000);

  test('the confirm path keeps goneCount in step, which is what lets the recompute skip the read', async () => {
    // **The invariant the pass's read budget rests on** (Greptile, PR #35, second pass). Bounding the
    // hazards left the transaction as `hazards × votes-per-hazard`, and votes are the cheapest thing a
    // user can add. The fix is that `goneCount === 0` *proves* there is no `never_existed` verdict —
    // `deriveHazardLifecycle` counts distinct non-author users whose latest vote is `fully_healed` or
    // `never_existed`, so zero of the pool means zero of either. No read can change that answer, and
    // nearly every pin is in that case.
    //
    // Driven through the real mutation rather than a fixture, because the proof is only as good as the
    // claim that `hazardConfirmations.confirm` is the single writer and always recomputes the column.
    // A second writer that forgot to should fail here.
    const t = harness();
    const author = await seedUser(t, 'author');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON });

    const before = await t.run((ctx) => ctx.db.get(hazardId));
    expect(before?.goneCount).toBe(0);

    await sam.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'never_existed',
      via: 'app_open_nearby',
    });

    const after = await t.run((ctx) => ctx.db.get(hazardId));
    const votes = await t.run((ctx) => ctx.db.query('hazardConfirmations').collect());
    expect(votes).toHaveLength(1);
    // The vote landed *and* the column moved with it. If these ever disagree, the recompute starts
    // silently skipping pins that do carry a bogus verdict.
    expect(after?.goneCount).toBe(1);
  });

  test('carries a line hazard’s own buffer onto the record', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId,
        type: 'pressure_ridge' as const,
        geometryKind: 'line' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [0.5, 0.5],
            [0.502, 0.5],
          ],
        },
        bufferMeters: 15,
        bbox: { minLat: 0.4995, minLng: 0.4995, maxLat: 0.5005, maxLng: 0.5025 },
        createdByUserId: author.id,
        photoIds: [],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        firstReportedAt: inSeason(CURRENT_SEASON, 190),
        lastConfirmedAt: inSeason(CURRENT_SEASON, 190),
        confirmCount: 0,
        goneCount: 0,
        createdAt: inSeason(CURRENT_SEASON, 190),
      }),
    );
    await runPass(t);
    const row = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    // A promoted ridge has to keep its real width — a hairline is a lie about a folded ridge.
    expect(row?.geometryKind).toBe('line');
    expect(row?.bufferMeters).toBe(15);
    expect(row?.radiusMeters).toBeUndefined();
  });
});

describe('listQueue’s filters, and the advisory yielding', () => {
  test('filters by family, by minimum seasons, and by what a human has decided', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    // A three-winter ridge and a one-winter spring, far enough apart to be separate clusters.
    for (const season of [CURRENT_SEASON - 2, CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON,
      type: 'spring_current',
      metersEast: 900,
    });
    await runPass(t);

    expect(await queuePage(mod.as)).toHaveLength(2);
    expect(await queuePage(mod.as, { family: 'spring' })).toHaveLength(1);
    expect(await queuePage(mod.as, { minSeasons: 2 })).toHaveLength(1);

    const ridge = (await queuePage(mod.as, { family: 'ridge' }))[0];
    await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId: ridge?._id as Id<'hazardRecurrence'>,
      type: 'recurring_pressure_ridge',
      reason: 'Reforms here.',
    });
    // A promoted cluster is finished as a *suggestion* — but an operator can still ask to see it.
    expect(await queuePage(mod.as)).toHaveLength(1);
    expect(await queuePage(mod.as, { includePromoted: true })).toHaveLength(2);
  });

  test('an unknown lake returns nothing rather than throwing', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const waterBodyId = await seedBody(t);
    await t.run((ctx) => ctx.db.delete(waterBodyId));
    expect(await mod.as.query(api.recurrence.listForBodyAdmin, { waterBodyId })).toEqual([]);
    expect(await mod.as.query(api.recurrence.listForBody, { waterBodyId })).toEqual([]);
  });

  test('the recompute button refuses a lake that is not there', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const waterBodyId = await seedBody(t);
    await t.run((ctx) => ctx.db.delete(waterBodyId));
    await expect(mod.as.mutation(api.recurrence.recomputeForBody, { waterBodyId })).rejects.toThrow(
      /not found/i,
    );
  });

  test('the advisory stands down where a pin has been reported this season', async () => {
    // §9.3, asserted against the public read directly since the master switch keeps it dark: a pin has
    // a date, a reporter and a confirm loop, and is better than history in every respect.
    const t = harness();
    const author = await seedUser(t, 'author');
    const skater = await seedUser(t, 'skater');
    const waterBodyId = await seedBody(t);
    for (const season of [CURRENT_SEASON - 2, CURRENT_SEASON - 1, CURRENT_SEASON]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await runPass(t);
    // Force the row public, standing in for the flag being on — the yield rule is separate from the bar.
    await t.run(async (ctx) => {
      const row = await ctx.db.query('hazardRecurrence').first();
      if (row) await ctx.db.patch(row._id, { publiclyVisible: true });
    });

    // A member from this season is live, so the cluster yields.
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toHaveLength(0);

    // Take this season's sighting away and the history speaks again.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('hazards').collect();
      const thisSeason = rows.find((h) => h.firstReportedAt >= inSeason(CURRENT_SEASON, 0));
      if (thisSeason) await ctx.db.patch(thisSeason._id, { moderationStatus: 'hidden' });
    });
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toHaveLength(1);
  });

  test('it yields to a pin filed after the pass ran, which is the only timing that happens', async () => {
    // **The production case, and the one the test above cannot reach.** The rollover runs in the first
    // week of July, when the season it computes for is days old and holds no hazards — so a ridge
    // pinned the following January is *never* in `memberHazardIds`. A membership test would leave the
    // advisory talking over a live pin for the whole winter, which is the season it exists to stand
    // down in. §9.3's words are "inside the cluster footprint", and this asserts that sentence.
    const t = harness();
    const author = await seedUser(t, 'author');
    const skater = await seedUser(t, 'skater');
    const waterBodyId = await seedBody(t);
    for (const season of [CURRENT_SEASON - 3, CURRENT_SEASON - 2, CURRENT_SEASON - 1]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await runPass(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('hazardRecurrence').first();
      if (row) await ctx.db.patch(row._id, { publiclyVisible: true });
    });
    // Three winters of history, nothing yet this one.
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toHaveLength(1);

    // Now somebody marks it, in January, months after the pass. No recompute runs.
    const fresh = await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON,
      metersEast: 20,
    });
    const stored = await t.run((ctx) => ctx.db.query('hazardRecurrence').first());
    expect(stored?.memberHazardIds).not.toContain(fresh); // the point: not a member, and still yields
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toHaveLength(0);
  });

  test('a pin far away, or of another family, does not silence the history', async () => {
    // The other half of erring wide: yielding is scoped to the ice the pattern is about. A spring at
    // the far end of the lake is not evidence about a ridge in this bay, and saying nothing because of
    // it would withhold the one honest thing the panel has.
    const t = harness();
    const author = await seedUser(t, 'author');
    const skater = await seedUser(t, 'skater');
    const waterBodyId = await seedBody(t);
    for (const season of [CURRENT_SEASON - 3, CURRENT_SEASON - 2, CURRENT_SEASON - 1]) {
      await seedHazard(t, waterBodyId, author.id, { season, metersEast: 10 });
    }
    await runPass(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('hazardRecurrence').first();
      if (row) await ctx.db.patch(row._id, { publiclyVisible: true });
    });

    // Same family, but a kilometre away — well past RECURRENCE_MATCH_METERS.
    await seedHazard(t, waterBodyId, author.id, { season: CURRENT_SEASON, metersEast: 1000 });
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toHaveLength(1);

    // On the same spot, but a different family — a spring is not a report about the ridge.
    await seedHazard(t, waterBodyId, author.id, {
      season: CURRENT_SEASON,
      metersEast: 10,
      type: 'spring_current',
    });
    expect(await skater.as.query(api.recurrence.listForBody, { waterBodyId })).toHaveLength(1);
  });
});
