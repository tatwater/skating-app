/**
 * **A content write that changes nothing writes nothing** (D270 as a class, with D267): a hide or a
 * removal of what that decision already holds, a pin of a pinned alert, a release of one that isn't —
 * each refused with a plain sentence, and nothing written.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { TAKEDOWN_ALREADY } from './lib/recordRules';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const NOTIF_PREFS = {
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
  moderatorDecision: false,
};

async function seed(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0 - 400 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

async function world() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
  await seed(t, 'mod', { role: 'moderator' });
  await seed(t, 'mod2', { role: 'moderator' });
  const skater = await seed(t, 'skater');
  const body = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Mascoma Lake',
      searchText: 'Mascoma Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: T0,
    }),
  );
  const report = (over: Partial<Doc<'reports'>> = {}) =>
    t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: skater,
        waterBodyId: body,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
        ...over,
      }),
    );
  return { t, skater, body, report };
}

const rows = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('moderationActions').collect()).length);
const take = (t: T, who: string, id: Id<'reports'>, status: 'hidden' | 'removed', reason = 'r') =>
  as(t, who).mutation(api.moderation.setModerationStatus, {
    targetType: 'report',
    targetId: id,
    status,
    reason,
  });

describe('a takedown that changes nothing writes nothing', () => {
  test('hiding what a hide already holds is refused — whoever asks, whatever the reason', async () => {
    const { t, report } = await world();
    const id = await report();
    await take(t, 'mod', id, 'hidden', 'first');
    const before = await rows(t);
    await expect(take(t, 'mod2', id, 'hidden', 'again')).rejects.toThrow(TAKEDOWN_ALREADY.hidden);
    expect(await rows(t)).toBe(before);
    // Removing it is a real change: one row.
    await take(t, 'mod2', id, 'removed');
    expect(await rows(t)).toBe(before + 1);
    await expect(take(t, 'mod', id, 'removed')).rejects.toThrow(TAKEDOWN_ALREADY.removed);
  });

  test('a hidden item with no decision holding it gets one: a real change', async () => {
    const { t, report } = await world();
    const id = await report({ moderationStatus: 'hidden' });
    const before = await rows(t);
    await take(t, 'mod', id, 'hidden');
    expect(await rows(t)).toBe(before + 1);
  });

  test('content its author deleted, a removal already holding it: a second removal is refused', async () => {
    const { t, report } = await world();
    const id = await report({ moderationStatus: 'removed', authorDeletedAt: T0 - DAY });
    await take(t, 'mod', id, 'removed');
    const before = await rows(t);
    await expect(take(t, 'mod2', id, 'removed')).rejects.toThrow(TAKEDOWN_ALREADY.removed);
    expect(await rows(t)).toBe(before);
  });
});
