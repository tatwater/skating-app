import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
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

async function seedUser(t: ReturnType<typeof harness>, subject: string) {
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
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

let bodySeq = 0;
async function seedBody(t: ReturnType<typeof harness>) {
  const offset = bodySeq++;
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: `Pond ${offset}`,
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [offset, 0],
            [offset, 1],
            [offset + 1, 1],
            [offset + 1, 0],
            [offset, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: offset, maxLat: 1, maxLng: offset + 1 },
      centroid: { lat: 0.5, lng: offset + 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

type Actor = Awaited<ReturnType<typeof seedUser>>;

async function seedReport(
  actor: Actor,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime = Date.now(),
): Promise<Id<'reports'>> {
  return actor.as.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime,
    iceTypes: ['black_ice'],
  }) as Promise<Id<'reports'>>;
}

const HOUR = 60 * 60 * 1000;

describe('bounties.create', () => {
  test('creates an open bounty and fans out bounty_request to recent reporters, not the requester', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    // A report 60h old: outside the 48h freshness block but inside the 72h eligibility window.
    await seedReport(reporter, waterBodyId, Date.now() - 60 * HOUR);

    const bountyId = await requester.as.mutation(api.bounties.create, { waterBodyId });
    const bounty = await t.run((ctx) => ctx.db.get(bountyId));
    expect(bounty?.status).toBe('open');

    const notes = await t.run((ctx) => ctx.db.query('notifications').collect());
    const requests = notes.filter((n) => n.type === 'bounty_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userId).toBe(reporter.id); // eligible reporter notified; requester never
  });

  test('blocks a bounty on a body with a fresh report', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 2 * HOUR); // well within 48h

    await expect(requester.as.mutation(api.bounties.create, { waterBodyId })).rejects.toThrow(
      /already has a fresh report/,
    );
  });

  test('enforces the rolling open-bounty cap', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    for (let i = 0; i < 3; i++) {
      const body = await seedBody(t);
      await requester.as.mutation(api.bounties.create, { waterBodyId: body });
    }
    const fourth = await seedBody(t);
    await expect(
      requester.as.mutation(api.bounties.create, { waterBodyId: fourth }),
    ).rejects.toThrow(/maximum number of open bounties/);
  });
});

describe('bounties.cancel', () => {
  test('the requester cancels their open bounty; others cannot', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const other = await seedUser(t, 'other');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.mutation(api.bounties.create, { waterBodyId });

    await expect(other.as.mutation(api.bounties.cancel, { bountyId })).rejects.toThrow(
      /Only the requester/,
    );

    await requester.as.mutation(api.bounties.cancel, { bountyId });
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('cancelled');

    // Cancelling a non-open bounty is rejected.
    await expect(requester.as.mutation(api.bounties.cancel, { bountyId })).rejects.toThrow(
      /not open/,
    );
  });
});

describe('bounties fulfillment', () => {
  test('auto-attaches a new report, then a helpful thumb from the requester fulfills + rewards', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.mutation(api.bounties.create, { waterBodyId });

    const reportId = await seedReport(author, waterBodyId);
    // Auto-attached.
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toContain(reportId);

    await requester.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
      bountyId,
    });

    const bounty = await t.run((ctx) => ctx.db.get(bountyId));
    expect(bounty?.status).toBe('fulfilled');
    // Reward is the separate bountyPoints currency, awarded to the report author.
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.bountyPoints).toBe(bounty?.rewardPoints);
    const notes = await t.run((ctx) =>
      ctx.db
        .query('notifications')
        .filter((q) => q.eq(q.field('userId'), author.id))
        .collect(),
    );
    expect(notes.some((n) => n.type === 'bounty_fulfilled')).toBe(true);
  });

  test('an unhelpful thumb from the requester leaves the bounty open', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.mutation(api.bounties.create, { waterBodyId });
    const reportId = await seedReport(author, waterBodyId);

    await requester.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'unhelpful',
      bountyId,
    });

    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('open');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.bountyPoints ?? 0).toBe(0);
  });
});

describe('bounties.listOpen (global / near-me / viewport browse)', () => {
  test('returns open bounties newest-first; excludes cancelled + expired', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t);
    const body1 = await seedBody(t);
    const b0 = await requester.as.mutation(api.bounties.create, { waterBodyId: body0 });
    const b1 = await requester.as.mutation(api.bounties.create, { waterBodyId: body1 });
    // Make b1 unambiguously newer than b0 so the sort is deterministic.
    await t.run((ctx) => ctx.db.patch(b0, { createdAt: Date.now() - HOUR }));

    let open = await t.query(api.bounties.listOpen, {});
    expect(open.map((b) => b._id)).toEqual([b1, b0]);
    expect(open[0]?.requester.trustClass).toBe('new'); // fresh account, 0 points
    expect(open[0]?.waterBodyName).toBeDefined();

    // Cancel one and expire the other → both drop out of the browse.
    await requester.as.mutation(api.bounties.cancel, { bountyId: b1 });
    await t.run((ctx) => ctx.db.patch(b0, { expiresAt: Date.now() - HOUR }));
    open = await t.query(api.bounties.listOpen, {});
    expect(open).toHaveLength(0);
  });

  test('viewport filters to bounties whose body intersects the rectangle', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t); // bbox lng [n, n+1]
    const body1 = await seedBody(t); // bbox lng [n+1, n+2]
    const b0 = await requester.as.mutation(api.bounties.create, { waterBodyId: body0 });
    await requester.as.mutation(api.bounties.create, { waterBodyId: body1 });
    const body0Doc = await t.run((ctx) => ctx.db.get(body0));
    // A rectangle covering only body0's bbox.
    const viewport = {
      minLat: 0,
      maxLat: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
      minLng: body0Doc!.bbox.minLng - 0.1,
      // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
      maxLng: body0Doc!.bbox.minLng + 0.1,
    };
    const open = await t.query(api.bounties.listOpen, { viewport });
    expect(open.map((b) => b._id)).toEqual([b0]);
  });

  test('sortByHome sorts by the viewer private home coord without returning distances', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t);
    const body1 = await seedBody(t);
    await requester.as.mutation(api.bounties.create, { waterBodyId: body0 });
    const b1 = await requester.as.mutation(api.bounties.create, { waterBodyId: body1 });
    const body1Doc = await t.run((ctx) => ctx.db.get(body1));
    // A viewer whose home sits on body1's centroid → body1's bounty sorts first, but no distance leaks.
    const viewer = await seedUser(t, 'viewer');
    // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
    await t.run((ctx) => ctx.db.patch(viewer.id, { homeCoord: body1Doc!.centroid }));

    const open = await viewer.as.query(api.bounties.listOpen, { sortByHome: true });
    expect(open[0]?._id).toBe(b1); // nearest-to-home first
    expect(open[0]?.distanceMeters).toBeUndefined(); // never returned in home-sort mode (D11)
  });

  test('near sorts by distance and attaches distanceMeters', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t);
    const body1 = await seedBody(t);
    await requester.as.mutation(api.bounties.create, { waterBodyId: body0 });
    const b1 = await requester.as.mutation(api.bounties.create, { waterBodyId: body1 });
    const body1Doc = await t.run((ctx) => ctx.db.get(body1));
    // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
    const near = body1Doc!.centroid;
    const open = await t.query(api.bounties.listOpen, { near });
    expect(open[0]?._id).toBe(b1); // nearest first
    expect(open[0]?.distanceMeters).toBeDefined();
    expect(open[0]?.distanceMeters ?? 1).toBeLessThan(open[1]?.distanceMeters ?? 0);
  });
});

describe('bounties.getDetail', () => {
  test('enriches the bounty with requester, body, and candidate reports with isOwn', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.mutation(api.bounties.create, { waterBodyId });
    const reportId = await seedReport(author, waterBodyId); // auto-attaches

    const asRequester = await requester.as.query(api.bounties.getDetail, { bountyId });
    expect(asRequester?.isRequester).toBe(true);
    expect(asRequester?.requester.trustClass).toBe('new');
    expect(asRequester?.waterBody?.name).toBeDefined();
    expect(asRequester?.fulfillingReports).toHaveLength(1);
    expect(asRequester?.fulfillingReports[0]?._id).toBe(reportId);
    expect(asRequester?.fulfillingReports[0]?.isOwn).toBe(false); // the report is the author's

    const asAuthor = await author.as.query(api.bounties.getDetail, { bountyId });
    expect(asAuthor?.isRequester).toBe(false);
    expect(asAuthor?.fulfillingReports[0]?.isOwn).toBe(true); // author viewing their own report
  });
});

describe('trust class in profile reads (D50)', () => {
  test('getPublicProfile derives the class from points + age and exposes badges/bountyPoints', async () => {
    const t = harness();
    const user = await seedUser(t, 'ada');

    // Fresh account (0 points) → the `new` welcome class; badges empty; bountyPoints 0.
    let profile = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(profile?.trustClass).toBe('new');
    expect(profile && !profile.private ? profile.badges : null).toEqual([]);
    expect(profile && !profile.private ? profile.bountyPoints : null).toBe(0);

    // Crossing the `trusted` threshold (≥15) promotes the class; points always beat age.
    await t.run((ctx) =>
      ctx.db.patch(user.id, {
        reputationPoints: 20,
        badges: ['trusted_reporter'],
        bountyPoints: 10,
      }),
    );
    profile = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(profile?.trustClass).toBe('trusted');
    expect(profile && !profile.private ? profile.badges : null).toEqual(['trusted_reporter']);
    expect(profile && !profile.private ? profile.bountyPoints : null).toBe(10);
  });

  test('publicByIds returns each author trust class (never the raw score)', async () => {
    const t = harness();
    const user = await seedUser(t, 'nadia');
    await t.run((ctx) => ctx.db.patch(user.id, { reputationPoints: 70 })); // expert threshold

    const map = await t.query(api.profiles.publicByIds, { profileIds: [user.id] });
    expect(map[user.id]?.trustClass).toBe('expert');
    expect(map[user.id]).not.toHaveProperty('reputationPoints');
  });
});

describe('bounties.expireBounties', () => {
  test('flips open bounties past their expiry to expired', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.mutation(api.bounties.create, { waterBodyId });
    await t.run((ctx) => ctx.db.patch(bountyId, { expiresAt: Date.now() - HOUR }));

    const res = await t.mutation(internal.bounties.expireBounties, {});
    expect(res.expired).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('expired');
  });
});
