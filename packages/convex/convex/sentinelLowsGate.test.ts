import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

/**
 * **D275's one line, flipped** (the server half; the Home half is `sentinelLowsGate.test.tsx` in the
 * web app): with `SENTINEL_LOWS_CAPABILITY` set to `'season.read'`, a moderator is refused and an
 * admin still reads the row — nothing but the constant moves.
 */

vi.mock('@skating/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skating/core')>()),
  SENTINEL_LOWS_CAPABILITY: 'season.read',
}));

const modules = import.meta.glob('./**/*.*s');

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

async function as(t: ReturnType<typeof convexTest>, subject: string, role: 'moderator' | 'admin') {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

describe('the sentinels’ lows kept to admins', () => {
  test('a moderator is refused; an admin reads', async () => {
    const t = convexTest(schema, modules);
    const mod = await as(t, 'mod', 'moderator');
    const admin = await as(t, 'admin', 'admin');
    await expect(mod.query(api.sentinelLows.forSeason, {})).rejects.toThrow();
    await expect(admin.query(api.sentinelLows.forSeason, {})).resolves.toHaveProperty('state');
  });
});
