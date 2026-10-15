import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

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
};

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
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
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const DAY = 86_400_000;

async function seedFlag(
  t: ReturnType<typeof convexTest>,
  flaggerId: Id<'profiles'>,
  reason: 'unsafe_false_report' | 'no_public_access' | 'spam',
  targetType: 'report' | 'waterbody' | 'user',
  targetId: string,
) {
  await t.run((ctx) =>
    ctx.db.insert('contentFlags', {
      flaggerId,
      targetType,
      targetId,
      reason,
      status: 'open',
      createdAt: Date.now(),
    }),
  );
}

async function seedRequest(
  t: ReturnType<typeof convexTest>,
  requesterId: Id<'profiles'>,
  kind: 'activate' | 'name_bay' | 'name_landmark',
) {
  await t.run((ctx) =>
    ctx.db.insert('waterBodyRequests', {
      kind,
      status: 'open',
      requesterId,
      coord: { lat: 43.6, lng: -72.1 },
      ...(kind === 'name_bay' ? { name: 'Shaker cove', nameKey: 'shaker cove' } : {}),
      createdAt: Date.now(),
    }),
  );
}

describe('console.overview (B01 §5.1)', () => {
  test('counts every inbox lane, access reports per body, and places apart from requests', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const skater = await seedUser(t, 's');
    await seedFlag(t, skater.id, 'unsafe_false_report', 'report', 'r1');
    await seedFlag(t, skater.id, 'no_public_access', 'waterbody', 'b1');
    await seedFlag(t, skater.id, 'no_public_access', 'waterbody', 'b1');
    await seedFlag(t, skater.id, 'no_public_access', 'waterbody', 'b2');
    await seedFlag(t, skater.id, 'spam', 'report', 'r2');
    await seedFlag(t, skater.id, 'spam', 'user', skater.id);
    await seedRequest(t, skater.id, 'activate');
    await seedRequest(t, skater.id, 'name_bay');
    await seedRequest(t, skater.id, 'name_landmark');

    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.safety).toEqual({ count: 1, capped: false });
    expect(o.inbox.accessReports).toEqual({ count: 2, capped: false });
    expect(o.inbox.contentFlags).toEqual({ count: 2, capped: false });
    expect(o.inbox.requests).toEqual({ count: 1, capped: false });
    expect(o.inbox.placesAsked).toEqual({ count: 2, capped: false });
    expect(o.inbox.drawnBodies).toEqual({ count: 0, capped: false });
    expect(o.inbox.oldestOpenAt).not.toBeNull();
    expect(o.people.flaggedPeople).toEqual({ count: 1, capped: false });
  });

  test('support is counted only for a viewer who may open it (PII, D37)', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'adm', 'admin');
    await t.run((ctx) =>
      ctx.db.insert('supportTickets', {
        category: 'account',
        status: 'open',
        body: 'Appeal: my suspension',
        createdAt: Date.now(),
      }),
    );
    expect((await mod.as.query(api.console.overview, {})).inbox.support).toBeNull();
    expect((await mod.as.query(api.console.overview, {})).people.appealsOpen).toBeNull();
    const a = await admin.as.query(api.console.overview, {});
    expect(a.inbox.support).toEqual({ count: 1, capped: false });
    expect(a.people.appealsOpen).toBe(1);
  });

  test('people: staff, live suspensions with the soonest end, the new, the banned, the leaving', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedUser(t, 'adm', 'admin');
    const live = await seedUser(t, 'live');
    const lapsed = await seedUser(t, 'lapsed');
    const gone = await seedUser(t, 'gone');
    const leaver = await seedUser(t, 'leaver');
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(live.id, { status: 'suspended', suspendedUntil: now + 3 * DAY });
      await ctx.db.patch(lapsed.id, { status: 'suspended', suspendedUntil: now - DAY });
      await ctx.db.patch(gone.id, { status: 'banned' });
      await ctx.db.patch(leaver.id, { deletionRequestedAt: now - DAY });
      await ctx.db.patch(mod.id, { createdAt: now - 30 * DAY });
    });

    const p = (await mod.as.query(api.console.overview, {})).people;
    expect(p.moderators.count).toBe(1);
    expect(p.admins.count).toBe(1);
    expect(p.suspended).toEqual({ count: 1, capped: false });
    expect(p.nextSuspensionEnds).toBe(now + 3 * DAY);
    expect(p.banned.count).toBe(1);
    expect(p.leaving.count).toBe(1);
    // Everyone but the back-dated moderator joined this week.
    expect(p.newThisWeek.count).toBe(5);
  });

  test('a lane past the cap reads as capped rather than being scanned', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const skater = await seedUser(t, 's');
    for (let i = 0; i < 201; i++) await seedFlag(t, skater.id, 'spam', 'report', `r${i}`);
    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.contentFlags).toEqual({ count: 200, capped: true });
  });

  test('a member is refused', async () => {
    const t = convexTest(schema, modules);
    const member = await seedUser(t, 'm');
    await expect(member.as.query(api.console.overview, {})).rejects.toThrow(/requires moderator/i);
  });
});
