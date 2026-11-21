/**
 * The dev inbox seed's fake people are never contacted (D287): the cast obeys the "Test-" rule, the
 * predicate tells a seed subject from a Clerk one, and every sender that could reach one — or be set
 * off by one — asks it. One test per call site; each fails if that site's check is dropped.
 */
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { SEED_NOT_DELETED } from './accountDeletion';
import { EMPTY_TALLY, type RunOutcome } from './clerkReconcile';
import { clerkEmailForSubject } from './lib/clerkEmail';
import { recipientWants } from './lib/notificationQueue';
import {
  assertSeedDeployment,
  DEV_DEPLOYMENT,
  hasTestSurname,
  isDevDeployment,
  isSeedProfile,
  SEED_CAST,
  SEED_CLERK_PREFIX,
  SEED_DEV_ONLY,
  SEED_PERSON_KEYS,
  SEED_SURNAME_PREFIX,
  seedPerson,
  surnameOf,
} from './lib/seedPeople';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const PREFS_ON = {
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
};

/**
 * A person with every toggle and channel ON, a mirrored email and a push token — so whatever stops a
 * send to a seed subject below is the predicate, never their settings.
 */
async function person(
  t: T,
  clerkUserId: string,
  over: { role?: 'member' | 'moderator' | 'admin'; status?: 'active' | 'banned' } = {},
) {
  const id = await t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId,
      displayName: `${clerkUserId} Test-Person`,
      username: clerkUserId.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS_ON,
      channelPrefs: { push: true, email: true },
      email: `${clerkUserId}@example.test`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: over.role ?? 'member',
      status: over.status ?? 'active',
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
  return { id, as: t.withIdentity({ subject: clerkUserId }) };
}

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72, 43],
      [-72, 43.01],
      [-71.99, 43.01],
      [-71.99, 43],
      [-72, 43],
    ],
  ],
};

async function body(t: T) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId: 'way/1',
        osmId: 'way/1',
        name: 'Fixture Pond',
        type: 'lakePond',
        polygon: square,
        bbox: { minLat: 43, minLng: -72, maxLat: 43.01, maxLng: -71.99 },
        centroid: { lat: 43.005, lng: -71.995 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const row = await t.run((ctx) => ctx.db.query('waterBodies').first());
  if (!row) throw new Error('seed failed');
  return row._id;
}

const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

/** A fetch stub that records every URL and answers every request with `body`. */
function recordingFetch(body: unknown = {}) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, fetchMock };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SEED = `${SEED_CLERK_PREFIX}1`;

describe('the cast and the predicate', () => {
  test('every fake person’s last name starts with "Test-"', () => {
    expect(SEED_CAST).toHaveLength(SEED_PERSON_KEYS.length);
    for (const p of SEED_CAST) {
      expect(surnameOf(p.displayName).startsWith(SEED_SURNAME_PREFIX)).toBe(true);
      expect(hasTestSurname(p.displayName)).toBe(true);
    }
    expect(hasTestSurname('Ada Lindqvist')).toBe(false);
    expect(hasTestSurname('Test-Ada')).toBe(false); // a one-word name has no last name
    expect(surnameOf('  Ada   Test-Lindqvist ')).toBe('Test-Lindqvist');
  });

  test('every fake person is a seed subject Clerk could never issue, each id and handle unique', () => {
    const ids = new Set(SEED_CAST.map((p) => p.clerkUserId));
    const handles = new Set(SEED_CAST.map((p) => p.username));
    expect(ids.size).toBe(SEED_CAST.length);
    expect(handles.size).toBe(SEED_CAST.length);
    for (const p of SEED_CAST) {
      expect(isSeedProfile(p)).toBe(true);
      expect(isSeedProfile(p.clerkUserId)).toBe(true);
      expect(p.clerkUserId.startsWith('user_')).toBe(false);
      expect(p.username).toMatch(/^[a-z0-9_]{3,30}$/);
      expect(seedPerson(p.key)).toBe(p);
    }
    expect(() => seedPerson('zed' as never)).toThrow(/No seed person/);
  });

  test('a Clerk subject, an empty one and nothing are not seed people', () => {
    expect(isSeedProfile('user_2abc')).toBe(false);
    expect(isSeedProfile({ clerkUserId: 'user_2abc' })).toBe(false);
    expect(isSeedProfile('')).toBe(false);
    expect(isSeedProfile(null)).toBe(false);
    expect(isSeedProfile(undefined)).toBe(false);
    expect(isSeedProfile('xseed_inbox_1')).toBe(false);
  });

  test('dev is told from prod by the deployment’s own URL, and an unknown one is not dev', () => {
    expect(isDevDeployment(`https://${DEV_DEPLOYMENT}.convex.cloud`)).toBe(true);
    expect(isDevDeployment('https://diligent-guanaco-965.convex.cloud')).toBe(false);
    expect(isDevDeployment('')).toBe(false);
    expect(isDevDeployment(undefined)).toBe(false);
    // Look-alikes: the name as a prefix, a suffix, a subdomain, a path, a query; another scheme or
    // port; garbage.
    for (const lookAlike of [
      `https://${DEV_DEPLOYMENT}0.convex.cloud`,
      `https://x${DEV_DEPLOYMENT}.convex.cloud`,
      `https://${DEV_DEPLOYMENT}.convex.cloud.evil.example`,
      `https://${DEV_DEPLOYMENT}.evil.example`,
      `https://evil.example/${DEV_DEPLOYMENT}.convex.cloud`,
      `https://evil.example/?d=${DEV_DEPLOYMENT}.convex.cloud`,
      `https://${DEV_DEPLOYMENT}.convex.site`,
      `http://${DEV_DEPLOYMENT}.convex.cloud`,
      `https://${DEV_DEPLOYMENT}.convex.cloud:8443`,
      DEV_DEPLOYMENT,
      `${DEV_DEPLOYMENT}.convex.cloud`,
      'not a url',
      '://',
    ]) {
      expect([lookAlike, isDevDeployment(lookAlike)]).toEqual([lookAlike, false]);
    }
    expect(isDevDeployment(`https://${DEV_DEPLOYMENT}.convex.cloud/`)).toBe(true);
    expect(isDevDeployment(`https://${DEV_DEPLOYMENT.toUpperCase()}.CONVEX.CLOUD`)).toBe(true); // hosts are case-blind
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://diligent-guanaco-965.convex.cloud');
    expect(() => assertSeedDeployment()).toThrow(SEED_DEV_ONLY);
    vi.stubEnv('CONVEX_CLOUD_URL', `https://${DEV_DEPLOYMENT}.convex.cloud`);
    expect(() => assertSeedDeployment()).not.toThrow();
  });
});

describe('Clerk is never called about a fake person', () => {
  test('clerkAdmin.setBanned sends nothing and pages no one', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const { fetchMock } = recordingFetch();
    await person(t, SEED, { status: 'banned' });
    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: SEED, banned: true });
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: SEED,
      banned: true,
      repair: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await scheduled(t)).toHaveLength(0);
  });

  test('a ban and its lift from People reach Clerk for a person, never for a fake one', async () => {
    vi.useFakeTimers();
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const { urls } = recordingFetch();
    const admin = await person(t, 'user_admin', { role: 'admin' });
    const fake = await person(t, SEED);
    const real = await person(t, 'user_real');
    for (const who of [fake, real]) {
      await admin.as.mutation(api.moderation.banUser, { userId: who.id, reason: 'spam run' });
      await admin.as.mutation(api.moderation.unbanUser, { userId: who.id });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(urls.some((u) => u.includes('user_real'))).toBe(true);
    expect(urls.filter((u) => u.includes(SEED_CLERK_PREFIX))).toEqual([]);
  });

  test('clerkAdmin.deleteUser sends nothing for a fake person', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const { fetchMock } = recordingFetch();
    await t.action(internal.clerkAdmin.deleteUser, { clerkUserId: SEED });
    expect(fetchMock).not.toHaveBeenCalled();
    await t.action(internal.clerkAdmin.deleteUser, { clerkUserId: 'user_gone' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('the email lookup never asks Clerk about a fake person', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const { fetchMock } = recordingFetch({
      primary_email_address_id: 'e1',
      email_addresses: [{ id: 'e1', email_address: 'someone@example.test' }],
    });
    expect(await clerkEmailForSubject(SEED)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await clerkEmailForSubject('user_real')).toBe('someone@example.test');
  });

  test('the daily reconcile (D277) counts a banned fake person and skips them — never asked, never repaired', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    // Clerk knows no one: its banned list is empty, and a read by id answers nobody.
    const { urls } = recordingFetch([]);
    await person(t, SEED, { status: 'banned' });
    await person(t, `${SEED_CLERK_PREFIX}2`, { status: 'banned' });
    await person(t, 'user_banned', { status: 'banned' });
    const out = (await t.action(internal.clerkReconcile.run, {
      dryRun: true,
    })) as RunOutcome;
    expect(out.state).toBe('done');
    expect(out.tally).toEqual({
      ...EMPTY_TALLY,
      convexChecked: 1,
      notInClerk: 1,
      clerkReads: 2,
      seedSkipped: 2,
    });
    expect(urls.filter((u) => u.includes(SEED_CLERK_PREFIX))).toEqual([]);
    expect(urls.some((u) => u.includes('user_banned'))).toBe(true);
  });

  test('a page of only fake people costs no Clerk read', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const { urls } = recordingFetch([]);
    await person(t, SEED, { status: 'banned' });
    const out = (await t.action(internal.clerkReconcile.run, { dryRun: true })) as RunOutcome;
    expect(out.tally.seedSkipped).toBe(1);
    expect(out.tally.clerkReads).toBe(1); // the Clerk side's banned list, and nothing for Convex's
    expect(urls).toHaveLength(1);
  });
});

describe('a fake person is never notified, pushed or mailed', () => {
  test('recipientWants refuses a fake person whatever their toggles say', async () => {
    const t = harness();
    const fake = await person(t, SEED);
    const real = await person(t, 'user_real');
    const [f, r] = await t.run(async (ctx) => [
      await ctx.db.get(fake.id),
      await ctx.db.get(real.id),
    ]);
    if (!f || !r) throw new Error('seed failed');
    expect(recipientWants(r, 'report_rated')).toBe(true);
    expect(recipientWants(f, 'report_rated')).toBe(false);
  });

  test('a thumb on a fake person’s report queues nothing; on a person’s it is delivered', async () => {
    const t = harness();
    const waterBodyId = await body(t);
    const fake = await person(t, SEED);
    const real = await person(t, 'user_author');
    const rater = await person(t, 'user_rater');
    const report = (who: typeof fake) =>
      who.as.mutation(api.reports.create, {
        waterBodyId,
        skateEndTime: Date.now() - 3_600_000,
        iceTypes: ['black_ice'],
        skateQuality: 'good',
      });
    const fakeReport = await report(fake);
    const realReport = await report(real);
    for (const targetId of [fakeReport, realReport]) {
      await rater.as.mutation(api.ratings.rate, {
        targetType: 'report',
        targetId,
        verdict: 'helpful',
      });
    }
    const queued = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queued.filter((q) => q.userId === fake.id)).toEqual([]);
    expect(queued.some((q) => q.userId === real.id && q.kind === 'thumb')).toBe(true);
  });

  test('the flush drops a row already queued for a fake person', async () => {
    const t = harness();
    const waterBodyId = await body(t);
    const fake = await person(t, SEED);
    const rater = await person(t, 'user_rater');
    const reportId = await fake.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now() - 3_600_000,
      iceTypes: ['black_ice'],
      skateQuality: 'good',
    });
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    // As the enqueue would have written it before the guard: a real, settled thumb.
    await t.run((ctx) =>
      ctx.db.insert('notificationQueue', {
        userId: fake.id,
        kind: 'thumb',
        type: 'report_rated',
        coalesceKey: `${fake.id}:${reportId}:thumb`,
        count: 1,
        flushAfter: Date.now() - 1,
        firstDueAt: Date.now() - 1,
        createdAt: Date.now() - 1,
        trigger: { kind: 'thumb', targetType: 'report', targetId: reportId, actorIds: [rater.id] },
      }),
    );
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    const left = await t.run(async (ctx) => ({
      queue: await ctx.db.query('notificationQueue').collect(),
      inbox: await ctx.db.query('notifications').collect(),
    }));
    expect(left.queue.filter((q) => q.userId === fake.id)).toEqual([]);
    expect(left.inbox.filter((n) => n.userId === fake.id)).toEqual([]);
  });

  test('the transports load nothing to push or mail for a fake person', async () => {
    const t = harness();
    const fake = await person(t, SEED);
    const real = await person(t, 'user_real');
    const ids = await t.run(async (ctx) =>
      Promise.all(
        [fake.id, real.id].map((userId) =>
          ctx.db.insert('notifications', {
            userId,
            type: 'content_flag_resolved',
            payload: {
              flagId: 'x',
              resolution: 'actioned',
              targetType: 'report',
              coalesceKey: 'k',
            },
            createdAt: Date.now(),
          }),
        ),
      ),
    );
    const loaded = await t.query(internal.notificationDelivery.loadForDelivery, {
      notificationIds: ids,
    });
    expect(loaded.some((d) => d.userId === real.id)).toBe(true);
    expect(loaded.filter((d) => d.userId === fake.id)).toEqual([]);
  });
});

describe('what a fake person does pages no operator', () => {
  test('a safety flag from a fake person sends no alert; from a person it does', async () => {
    const t = harness();
    const waterBodyId = await body(t);
    const author = await person(t, 'user_author');
    const fake = await person(t, SEED);
    const real = await person(t, 'user_flagger');
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now() - 3_600_000,
      iceTypes: ['black_ice'],
      skateQuality: 'good',
    });
    const alerts = async () =>
      (await scheduled(t)).filter((j) => j.name === 'operatorAlerts:send').length;
    const before = await alerts();
    await fake.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });
    expect(await alerts()).toBe(before);
    await real.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });
    expect(await alerts()).toBe(before + 1);
  });

  test('a ticket from a fake person is filed and mails no operator; from a person it does', async () => {
    const t = harness();
    const fake = await person(t, SEED);
    const real = await person(t, 'user_real');
    const alerts = async () =>
      (await scheduled(t)).filter((j) => j.name === 'operatorAlerts:send').length;
    const ticketId = await fake.as.mutation(api.support.create, {
      category: 'bug',
      body: 'The map froze.',
    });
    expect(await t.run((ctx) => ctx.db.get(ticketId as Id<'supportTickets'>))).not.toBeNull();
    expect(await alerts()).toBe(0);
    await real.as.mutation(api.support.create, { category: 'bug', body: 'The map froze.' });
    expect(await alerts()).toBe(1);
  });
});

describe('a fake person is never deleted, only cleared', () => {
  test('their own request, an admin’s immediate finalize and the staged job all refuse', async () => {
    const t = harness();
    const fake = await person(t, SEED);
    await expect(fake.as.mutation(api.accountDeletion.requestDeletion, {})).rejects.toThrow(
      SEED_NOT_DELETED,
    );
    await expect(
      t.mutation(internal.accountDeletion.finalizeNow, { userId: fake.id }),
    ).rejects.toThrow(SEED_NOT_DELETED);
    await t.run((ctx) => ctx.db.patch(fake.id, { deletionRequestedAt: Date.now() - 1 }));
    expect(await t.mutation(internal.accountDeletion.finalizeAccount, { userId: fake.id })).toEqual(
      {
        stopped: 'seed',
      },
    );
    const row = await t.run((ctx) => ctx.db.get(fake.id));
    expect(row?.clerkUserId).toBe(SEED);
    expect(row?.status).toBe('active');
  });
});
