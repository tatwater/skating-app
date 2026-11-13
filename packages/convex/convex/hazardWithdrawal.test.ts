/**
 * An author withdrawing their own hazard (founder ruling, 2026-11-13): "any hazard that has
 * confirmations from other users shouldn't be able to be deleted, only hazards that are either
 * disputed or have no interactions at all." Another skater's `still_there` or `healing_unsafe`
 * blocks it; no votes, or only others' `fully_healed`, leave it withdrawable; the author's own votes
 * never count. Withdrawn means never here — the pin is gone, never healed or cleared (D3).
 */
import { HAZARD_VERDICTS, WITHDRAWN_ERASE_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { HAZARD_WITHDRAW_REFUSALS } from './hazardWithdrawal';
import { AUTHOR_DELETED_RESTORE } from './lib/authorDeletion';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2027, 0, 14, 12);
const DAY = 24 * 60 * 60 * 1000;
type T = ReturnType<typeof convexTest>;
type Verdict = (typeof HAZARD_VERDICTS)[number];

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' = 'member') {
  const id = await t.run((ctx) =>
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
        bountyAnswered: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: false,
        greatReportNearby: false,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const t = convexTest(schema, modules);
  const author = await seedUser(t, 'author');
  const other = await seedUser(t, 'other');
  const mod = await seedUser(t, 'mod', 'moderator');
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
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
  const hazardId = await t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
      createdByUserId: author.id,
      description: 'I think there was a hole here',
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: T0,
      lastConfirmedAt: T0,
      confirmCount: 0,
      goneCount: 0,
      createdAt: T0,
    }),
  );
  const vote = (userId: Id<'profiles'>, verdict: Verdict) =>
    t.run((ctx) =>
      ctx.db.insert('hazardConfirmations', {
        hazardId,
        userId,
        verdict,
        via: 'app_open_nearby' as const,
        createdAt: Date.now(),
      }),
    );
  const withdraw = () => author.as.mutation(api.hazardWithdrawal.withdraw, { hazardId });
  return { t, author, other, mod, waterBodyId, hazardId, vote, withdraw };
}

const literally = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

afterEach(() => vi.useRealTimers());

describe('withdrawing a hazard', () => {
  test('with no votes: the pin is gone as if never posted — not healed, not archived', async () => {
    const { t, waterBodyId, hazardId, withdraw } = await setup();
    await withdraw();
    await withdraw(); // twice is once
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard).toMatchObject({
      moderationStatus: 'removed',
      status: 'active', // the lifecycle is untouched: nothing says it healed
      authorDeletedAt: T0,
      eraseAt: T0 + WITHDRAWN_ERASE_MS,
    });
    expect(hazard?.healingState).toBeUndefined();
    expect(await t.query(api.hazards.get, { hazardId })).toBeNull();
    const onLake = await t.query(api.hazards.listForBody, { waterBodyId });
    expect(JSON.stringify(onLake)).not.toContain(hazardId);
    const history = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(history.map((r) => r.action)).toEqual(['author_delete']);
  });

  test.each(['still_there', 'healing_unsafe'] as const)(
    "another skater's %s blocks it",
    async (verdict) => {
      const { t, other, hazardId, vote, withdraw } = await setup();
      await vote(other.id, verdict);
      await expect(withdraw()).rejects.toThrow(literally(HAZARD_WITHDRAW_REFUSALS.confirmed));
      expect((await t.run((ctx) => ctx.db.get(hazardId)))?.moderationStatus).toBe('visible');
    },
  );

  test("others' fully_healed or never_existed, and the author's own votes, do not", async () => {
    const { t, author, other, mod, hazardId, vote, withdraw } = await setup();
    await vote(other.id, 'fully_healed');
    await vote(mod.id, 'never_existed');
    await vote(author.id, 'still_there');
    await withdraw();
    expect((await t.run((ctx) => ctx.db.get(hazardId)))?.authorDeletedAt).toBe(T0);
  });

  test('only by its author; and not once a moderator made it a feature, or merge joined it', async () => {
    const { t, other, hazardId, waterBodyId, withdraw } = await setup();
    await expect(other.as.mutation(api.hazardWithdrawal.withdraw, { hazardId })).rejects.toThrow(
      literally(HAZARD_WITHDRAW_REFUSALS.notYours),
    );
    const absorbed = await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId,
        type: 'open_water' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        radiusMeters: 30,
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        createdByUserId: other.id,
        photoIds: [],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        mergedIntoHazardId: hazardId,
        firstReportedAt: T0,
        lastConfirmedAt: T0,
        confirmCount: 0,
        goneCount: 0,
        createdAt: T0,
      }),
    );
    await expect(withdraw()).rejects.toThrow(literally(HAZARD_WITHDRAW_REFUSALS.joined));
    await t.run((ctx) => ctx.db.delete(absorbed));
    // Counted in a cross-season pattern: a shared record too.
    const pattern = await t.run((ctx) =>
      ctx.db.insert('hazardRecurrence', {
        waterBodyId,
        family: 'ridge' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        radiusMeters: 30,
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        memberHazardIds: [hazardId],
        representativeHazardId: hazardId,
        seasonsObserved: [2025, 2026],
        windowSeasons: 4,
        distinctAuthorCount: 2,
        firstReportedDayOfSeasonP25: 40,
        firstReportedDayOfSeasonP75: 60,
        priority: 1,
        publiclyVisible: false,
        computedAt: T0,
        computedForSeason: 2026,
      }),
    );
    await expect(withdraw()).rejects.toThrow(literally(HAZARD_WITHDRAW_REFUSALS.joined));
    await t.run((ctx) => ctx.db.delete(pattern));
    const featureId = await t.run((ctx) =>
      ctx.db.insert('bodyFeatures', {
        waterBodyId,
        type: 'spring_current' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point', coordinates: [0.5, 0.5] },
        radiusMeters: 20,
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        addedByUserId: other.id,
        active: true,
        createdAt: T0,
      }),
    );
    await t.run((ctx) => ctx.db.patch(hazardId, { promotedToFeatureId: featureId }));
    await expect(withdraw()).rejects.toThrow(literally(HAZARD_WITHDRAW_REFUSALS.feature));
  });

  test('is final: no restore brings it back, and a verdict on it holds it from erasure', async () => {
    const { t, mod, hazardId, withdraw } = await setup();
    await withdraw();
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'hazard',
        targetId: hazardId,
        status: 'visible',
        reason: 'appeal',
      }),
    ).rejects.toThrow(literally(AUTHOR_DELETED_RESTORE));
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'hazard',
      targetId: hazardId,
      status: 'removed',
      reason: 'a fake pin to scare people off',
    });
    expect((await t.run((ctx) => ctx.db.get(hazardId)))?.eraseAt).toBeUndefined();
    vi.setSystemTime(T0 + 31 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await t.run((ctx) => ctx.db.get(hazardId))).not.toBeNull();
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'hazard',
      targetId: hazardId,
      reason: 'it was a mistake, not a scare',
    });
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toBeNull();
  });

  test("erasure takes the hazard and the author's own vote; another skater's vote stays theirs", async () => {
    const { t, author, other, hazardId, vote, withdraw } = await setup();
    const own = await vote(author.id, 'still_there');
    const theirs = await vote(other.id, 'fully_healed');
    await withdraw();
    vi.setSystemTime(T0 + 31 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(own))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(theirs))).not.toBeNull();
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(JSON.stringify(bundle)).not.toContain('I think there was a hole here');
  });
});

describe('the withdrawal rule, under any votes', () => {
  test('withdrawable exactly when no other skater has said it is there', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            who: fc.constantFrom('author' as const, 'other' as const, 'mod' as const),
            verdict: fc.constantFrom(...HAZARD_VERDICTS),
          }),
          { maxLength: 5 },
        ),
        async (votes) => {
          const base = await setup();
          // One vote row per skater, their latest — the shape `hazardConfirmations.confirm` keeps.
          const latest = new Map<'author' | 'other' | 'mod', Verdict>();
          for (const { who, verdict } of votes) latest.set(who, verdict);
          for (const [who, verdict] of latest) {
            await base.vote(base[who].id, verdict);
          }
          const blocked = [...latest].some(
            ([who, verdict]) =>
              who !== 'author' && (verdict === 'still_there' || verdict === 'healing_unsafe'),
          );
          const outcome = await base.withdraw().then(
            () => 'withdrawn',
            () => 'refused',
          );
          expect(outcome).toBe(blocked ? 'refused' : 'withdrawn');
          const hazard = await base.t.run((ctx) => ctx.db.get(base.hazardId));
          // Whatever happened, nothing reads it as healed.
          expect(hazard?.status).toBe('active');
          vi.useRealTimers();
        },
      ),
      { numRuns: 30 },
    );
  });
});
