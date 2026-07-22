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
