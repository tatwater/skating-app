/**
 * Posted access rules — the moderator writer and the composition rule (N6e).
 *
 * The load-bearing property is the last describe block: a rule on one parking lot must not become a
 * claim about the lake, or about the lot next to it. Everything else here is the `setDepth` discipline
 * applied to a third target.
 */

import type { PostedAccess } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** *"Permitted January 1 - March 15, daylight hours only."* + the City of Troy permit. */
const TOMHANNOCK: PostedAccess = {
  dateRange: { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 },
  dailyWindow: { kind: 'daylight', offsetMinutes: 0 },
  permitRequired: true,
  note: 'NYSDEC; access permit from the City of Troy',
};

/** A lot shared with a business — the case that put rules on three tables instead of one. */
const BUSINESS_HOURS: PostedAccess = {
  dailyWindow: { kind: 'clock', openMinute: 17 * 60, closeMinute: 9 * 60 },
  note: 'Shared with the store — no parking during business hours',
};

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  };
}

async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'way/1') {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Tomhannock Reservoir',
      searchText: 'Tomhannock Reservoir',
      type: 'reservoir' as const,
      source: 'osm' as const,
      externalId,
      osmId: externalId,
      polygon: square(0.05),
      bbox: { minLat: 42.8, minLng: -73.6, maxLat: 42.9, maxLng: -73.5 },
      centroid: { lat: 42.8462, lng: -73.5501 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

async function seedPutIn(t: ReturnType<typeof convexTest>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 42.85, lng: -73.55 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'putIns'>>;
}

async function seedParking(t: ReturnType<typeof convexTest>, name: string) {
  return t.run((ctx) =>
    ctx.db.insert('parkingAreas', {
      coord: { lat: 42.851, lng: -73.551 },
      name,
      source: 'osm' as const,
      status: 'visible' as const,
      amenities: [],
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'parkingAreas'>>;
}

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

function audits(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query('moderationActions').collect());
}

describe('postedAccess.setPostedAccess — the role gate', () => {
  test('a member cannot post a rule on any of the three targets', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const putIn = await seedPutIn(t, body);
    const lot = await seedParking(t, 'Reservoir Road lot');
    const member = await seedUser(t, 'member');

    for (const target of [
      { type: 'waterbody' as const, id: body },
      { type: 'putIn' as const, id: putIn },
      { type: 'parkingArea' as const, id: lot },
    ]) {
      await expect(
        member.as.mutation(api.postedAccess.setPostedAccess, {
          target,
          postedAccess: TOMHANNOCK,
        }),
      ).rejects.toThrow(/moderator/i);
    }

    // A legal restriction is not a community claim: nothing was written, on any of them.
    expect(await audits(t)).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess).toBeUndefined();
  });

  test('an anonymous caller cannot either', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    await expect(
      t.mutation(api.postedAccess.setPostedAccess, {
        target: { type: 'waterbody', id: body },
        postedAccess: TOMHANNOCK,
      }),
    ).rejects.toThrow();
  });
});

describe('postedAccess.setPostedAccess — writing and auditing', () => {
  test('stores the rule and audits it with the rule in the reason', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: TOMHANNOCK,
    });

    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.postedAccess).toMatchObject({
      dateRange: { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 },
      dailyWindow: { kind: 'daylight', offsetMinutes: 0 },
      permitRequired: true,
    });

    const log = await audits(t);
    expect(log).toHaveLength(1);
    expect(log[0]?.action).toBe('set_posted_access');
    expect(log[0]?.targetType).toBe('waterbody');
    // The rule is in the reason, so the log answers "what was posted" without diffing the document.
    expect(log[0]?.reason).toContain('January 1 – March 15 · sunrise to sunset · permit required');
    expect(log[0]?.actorId).toBe(mod.id);
  });

  test('records the prior value so the change is reversible', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: TOMHANNOCK,
    });
    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: { dailyWindow: { kind: 'daylight', offsetMinutes: 30 } },
    });

    const log = await audits(t);
    const second = log[1]?.metadata as { prev?: { postedAccess?: PostedAccess | null } };
    expect(second.prev?.postedAccess).toMatchObject({ permitRequired: true });
  });

  test('null clears the rule, and says so in the log', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: TOMHANNOCK,
    });
    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: null,
    });

    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess).toBeUndefined();
    expect((await audits(t))[1]?.reason).toBe('Cleared the posted rules');
  });

  test('a whitespace-only note stores as absent, not as an empty citation', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: { permitRequired: true, note: '   ' },
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess?.note).toBeUndefined();
  });

  test('a rejected rule writes nothing at all', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');

    await expect(
      mod.as.mutation(api.postedAccess.setPostedAccess, {
        target: { type: 'waterbody', id: body },
        postedAccess: { dateRange: { startMonth: 2, startDay: 30, endMonth: 3, endDay: 15 } },
      }),
    ).rejects.toThrow(/February has no day 30/);

    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess).toBeUndefined();
    expect(await audits(t)).toHaveLength(0);
  });

  test('refuses a rule that asserts nothing', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.postedAccess.setPostedAccess, {
        target: { type: 'waterbody', id: body },
        postedAccess: {},
      }),
    ).rejects.toThrow(/needs a date range/);
  });

  test('a missing target is refused by name', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run((ctx) => ctx.db.delete(body));
    await expect(
      mod.as.mutation(api.postedAccess.setPostedAccess, {
        target: { type: 'waterbody', id: body },
        postedAccess: TOMHANNOCK,
      }),
    ).rejects.toThrow(/Water body not found/);
  });
});

/**
 * The reason posted rules hang off three tables rather than one.
 *
 * A lake open around the clock with one of three lots shut during business hours is **not** a lake
 * shut during business hours, and the other two lots must not inherit the restriction. Nothing in the
 * system merges the three levels, and this is the test that says so.
 */
describe('postedAccess — rules compose, they never merge', () => {
  test('a rule on one lot touches neither the lake, the launch, nor the lot beside it', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const putIn = await seedPutIn(t, body);
    const sharedLot = await seedParking(t, 'Shared with the store');
    const otherLot = await seedParking(t, 'Reservoir Road pulloff');
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'parkingArea', id: sharedLot },
      postedAccess: BUSINESS_HOURS,
    });

    expect((await t.run((ctx) => ctx.db.get(sharedLot)))?.postedAccess).toMatchObject({
      dailyWindow: { kind: 'clock', openMinute: 1020, closeMinute: 540 },
    });
    expect((await t.run((ctx) => ctx.db.get(otherLot)))?.postedAccess).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.postedAccess).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess).toBeUndefined();
  });

  test('the lake’s rule does not propagate down to its access points', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const putIn = await seedPutIn(t, body);
    const lot = await seedParking(t, 'Reservoir Road lot');
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: TOMHANNOCK,
    });

    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess).toBeDefined();
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.postedAccess).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(lot)))?.postedAccess).toBeUndefined();
  });

  test('all three can hold different rules at once, each audited to its own target', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const putIn = await seedPutIn(t, body);
    const lot = await seedParking(t, 'Reservoir Road lot');
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body },
      postedAccess: TOMHANNOCK,
    });
    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'putIn', id: putIn },
      postedAccess: { dailyWindow: { kind: 'daylight', offsetMinutes: 30 } },
    });
    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'parkingArea', id: lot },
      postedAccess: BUSINESS_HOURS,
    });

    expect((await t.run((ctx) => ctx.db.get(body)))?.postedAccess?.permitRequired).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(putIn)))?.postedAccess?.dailyWindow).toMatchObject({
      kind: 'daylight',
      offsetMinutes: 30,
    });
    expect((await t.run((ctx) => ctx.db.get(lot)))?.postedAccess?.dailyWindow).toMatchObject({
      kind: 'clock',
    });

    const log = await audits(t);
    expect(log.map((a) => a.targetType)).toEqual(['waterbody', 'putIn', 'parkingArea']);
    expect(log.map((a) => a.targetId)).toEqual([body, putIn, lot]);
  });
});
