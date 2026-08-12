/**
 * Access alerts (N6d Workstream C / D73).
 *
 * Two properties carry this module and both are about what it refuses to inherit from hazards: the
 * decay is weather-blind (a locked gate does not thaw), and a moderator's pin is exempt from an expiry
 * sweep that structurally cannot see it.
 */

import { ACCESS_ALERT_TTL_MS, seasonEndMs, seasonOf } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      searchText: 'Test Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      externalId: 'way/1',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-72.01, 43.99],
            [-71.99, 43.99],
            [-71.99, 44.01],
            [-72.01, 44.01],
            [-72.01, 43.99],
          ],
        ],
      },
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44, lng: -72 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

async function seedPutIn(t: ReturnType<typeof convexTest>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 44.01, lng: -72 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'putIns'>>;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
  dateOfBirth = Date.UTC(1990, 0, 1),
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
        bountyFulfilled: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: false,
        greatReportNearby: false,
      },
      dateOfBirth,
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function setup() {
  const t = convexTest(schema, modules);
  const waterBodyId = await seedBody(t);
  const putInId = await seedPutIn(t, waterBodyId);
  const author = await seedUser(t, 'author');
  return { t, waterBodyId, putInId, author };
}

const ALERT = { targetType: 'put_in' as const, reason: 'gate_locked' as const };

describe('accessAlerts.create', () => {
  test('files an alert against the put-in and denormalizes its body', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, {
      ...ALERT,
      putInId,
      note: 'Chain across the road at the town line',
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.waterBodyId).toBe(waterBodyId);
    expect(row?.status).toBe('active');
    expect(row?.season).toBe(seasonOf(row?.createdAt ?? 0));
    expect(row?.expiresAt).toBe(
      Math.min((row?.createdAt ?? 0) + ACCESS_ALERT_TTL_MS, seasonEndMs(row?.season ?? 0)),
    );
  });

  test('minors are read-only here, as everywhere else that moves public content', async () => {
    const { t, putInId } = await setup();
    const minor = await seedUser(t, 'kid', 'member', Date.now() - 15 * 365 * DAY_MS);
    await expect(minor.as.mutation(api.accessAlerts.create, { ...ALERT, putInId })).rejects.toThrow(
      /under 18/,
    );
  });

  test('a future observation is clamped rather than trusted', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, {
      ...ALERT,
      putInId,
      observedAt: Date.now() + 30 * DAY_MS,
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.createdAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('refuses a target that does not exist or has been hidden', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    await t.run((ctx) => ctx.db.patch(putInId, { status: 'hidden' as const }));
    await expect(author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId })).rejects.toThrow(
      /Put-in not found/,
    );
    expect(waterBodyId).toBeDefined();
  });

  /** A lot with no body would file an alert nothing could ever read. */
  test('refuses a parking alert on a lot associated with no body', async () => {
    const { t, author } = await setup();
    const parkingAreaId = await t.run((ctx) =>
      ctx.db.insert('parkingAreas', {
        coord: { lat: 44.02, lng: -72 },
        source: 'osm' as const,
        status: 'visible' as const,
        amenities: [],
        createdAt: Date.now(),
      }),
    );
    await expect(
      author.as.mutation(api.accessAlerts.create, {
        targetType: 'parking_area',
        parkingAreaId,
        reason: 'not_plowed',
      }),
    ).rejects.toThrow(/not associated/);
  });
});

describe('accessAlerts.vote', () => {
  test('a confirmation resets the clock from the observation', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const before = await t.run((ctx) => ctx.db.get(id));

    const voter = await seedUser(t, 'voter-1');
    const observedAt = Date.now();
    await voter.as.mutation(api.accessAlerts.vote, {
      accessAlertId: id,
      verdict: 'still_blocked',
      observedAt,
    });

    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.confirmCount).toBe(1);
    expect(after?.lastConfirmedAt).toBe(observedAt);
    expect(after?.expiresAt).toBeGreaterThanOrEqual(before?.expiresAt ?? 0);
  });

  test('two denials resolve it; one does not', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });

    const first = await seedUser(t, 'voter-1');
    await first.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'open' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('active');

    const second = await seedUser(t, 'voter-2');
    await second.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'open' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('resolved');
  });

  /** The offline-replay property: one row per user per alert, counts derived not incremented. */
  test('the same skater voting twice counts once, and a replay is idempotent', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const voter = await seedUser(t, 'voter-1');

    await voter.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'still_blocked' });
    await voter.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'still_blocked' });

    expect((await t.run((ctx) => ctx.db.get(id)))?.confirmCount).toBe(1);
    expect(await t.run((ctx) => ctx.db.query('accessAlertVotes').collect())).toHaveLength(1);
  });

  test('changing your mind moves the counts both ways', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const a = await seedUser(t, 'voter-a');
    const b = await seedUser(t, 'voter-b');

    await a.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'open' });
    await b.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'open' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('resolved');

    await a.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'still_blocked' });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.status).toBe('active');
    expect(after?.denyCount).toBe(1);
  });

  test('a retracted alert is closed to votes', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await author.as.mutation(api.accessAlerts.retract, { accessAlertId: id });
    const voter = await seedUser(t, 'voter-1');
    await expect(
      voter.as.mutation(api.accessAlerts.vote, { accessAlertId: id, verdict: 'still_blocked' }),
    ).rejects.toThrow(/no longer open to votes/);
  });
});

describe('accessAlerts.retract (D65 applied to access)', () => {
  test('the author can withdraw their own claim', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await author.as.mutation(api.accessAlerts.retract, { accessAlertId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('retracted');
  });

  test('a stranger cannot, and a moderator can — with an audit row', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });

    const stranger = await seedUser(t, 'stranger');
    await expect(
      stranger.as.mutation(api.accessAlerts.retract, { accessAlertId: id }),
    ).rejects.toThrow(/Only the author or a moderator/);

    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: id, reason: 'Wrong lake' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('retracted');
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((a) => a.action)).toContain('retract_access_alert');
  });

  /** Retraction is never a delete: the row is what makes a pattern of bad claims visible. */
  test('the row survives retraction', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await author.as.mutation(api.accessAlerts.retract, { accessAlertId: id });
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  });
});

describe('accessAlerts.setOfficial — the founder exemption', () => {
  test('a member cannot pin', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await expect(
      author.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: id,
        official: true,
        reason: 'x',
      }),
    ).rejects.toThrow();
  });

  test('pinning clears the expiry entirely, and audits', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: id,
      official: true,
      reason: 'State forest road closed indefinitely',
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe('official');
    expect(row?.expiresAt).toBeUndefined();
    expect(row?.pinnedByUserId).toBeDefined();
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((a) => a.action)).toContain('pin_access_alert');
  });

  test('releasing restarts the clock from now, not from the original assertion', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: id,
      official: true,
      reason: 'pin',
    });
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: id,
      official: false,
      reason: 'reopened',
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe('active');
    expect(row?.pinnedByUserId).toBeUndefined();
    // An alert a moderator vouched for until today is not simultaneously thirty days stale.
    expect(row?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('a reason is required, because pinning is the one way a claim outlives its season', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: id,
        official: true,
        reason: '   ',
      }),
    ).rejects.toThrow(/reason is required/);
  });
});

describe('accessAlerts.expireLapsedAlerts', () => {
  test('sweeps a lapsed alert', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await t.run((ctx) => ctx.db.patch(id, { expiresAt: Date.now() - 1 }));

    const result = await t.mutation(internal.accessAlerts.expireLapsedAlerts, {});
    expect(result.expired).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('expired');
  });

  /**
   * The trap this schema was shaped around. Convex indexes on optional fields are not sparse, so an
   * absent `expiresAt` sorts *first* — a bare `lte(now)` range would sweep exactly the rows that are
   * exempt. `official` being a status keeps them in a different prefix entirely.
   */
  test('the sweep structurally cannot reach a pinned alert with no expiry', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: id,
      official: true,
      reason: 'indefinite',
    });

    const result = await t.mutation(internal.accessAlerts.expireLapsedAlerts, {});
    expect(result.expired).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('official');
  });

  /** No annual job: every write clamps to `min(TTL, season end)`, so a rollover is just a batch. */
  test('a previous season lapses through the same sweep, counted apart', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const row = await t.run((ctx) => ctx.db.get(id));
    await t.run((ctx) =>
      ctx.db.patch(id, { season: (row?.season ?? 2027) - 1, expiresAt: Date.now() - 1 }),
    );

    const result = await t.mutation(internal.accessAlerts.expireLapsedAlerts, {});
    expect(result.expired).toBe(1);
    expect(result.seasonExpired).toBe(1);
  });
});

describe('accessAlerts.listForBody', () => {
  test('official pins sort first, and dead alerts never appear', async () => {
    const { t, putInId, waterBodyId, author } = await setup();
    const community = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const pinned = await author.as.mutation(api.accessAlerts.create, {
      ...ALERT,
      putInId,
      reason: 'road_closed',
    });
    const retracted = await author.as.mutation(api.accessAlerts.create, {
      ...ALERT,
      putInId,
      reason: 'lot_full',
    });

    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: pinned,
      official: true,
      reason: 'pin',
    });
    await author.as.mutation(api.accessAlerts.retract, { accessAlertId: retracted });

    const alerts = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(alerts.map((a) => a.id)).toEqual([pinned, community]);
    expect(alerts[0]?.official).toBe(true);
  });

  /**
   * The sweep's schedule must never be a visible behaviour: an alert past its expiry stops annotating
   * the moment it passes, not the moment the cron next runs.
   */
  test('an alert past its expiry is already gone before the cron reaches it', async () => {
    const { t, putInId, waterBodyId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await t.run((ctx) => ctx.db.patch(id, { expiresAt: Date.now() - 1 }));

    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId })).toEqual([]);
    // …and the row is still `active`, so this is the read being honest rather than the cron being fast.
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('active');
  });
});

describe('an alert on a shared lot (D72 amendment)', () => {
  /**
   * A trailhead serving three ponds is the normal case here, and a gate is locked for everybody who
   * parks there. The alert is filed against **one** body — fanning out a row per body would make one
   * locked gate look like three — so the read has to pull it back through the lot's associations, or
   * two of the three lakes are silently unwarned.
   */
  test('shows on every lake the parking area serves, not just the one it was filed against', async () => {
    const { t, waterBodyId, author } = await setup();
    const second = await seedBody(t);

    const parkingAreaId = await t.run((ctx) =>
      ctx.db.insert('parkingAreas', {
        coord: { lat: 44.02, lng: -72 },
        name: 'Trailhead Lot',
        source: 'osm' as const,
        status: 'visible' as const,
        amenities: [],
        createdAt: Date.now(),
      }),
    );
    for (const body of [waterBodyId, second]) {
      await t.run((ctx) =>
        ctx.db.insert('parkingAreaBodies', {
          parkingAreaId,
          waterBodyId: body,
          inferred: false,
          createdAt: Date.now(),
        }),
      );
    }

    await author.as.mutation(api.accessAlerts.create, {
      targetType: 'parking_area',
      parkingAreaId,
      reason: 'gate_locked',
    });

    const onFirst = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    const onSecond = await t.query(api.accessAlerts.listForBody, { waterBodyId: second });
    expect(onFirst).toHaveLength(1);
    expect(onSecond).toHaveLength(1);
    expect(onFirst[0]?.id).toBe(onSecond[0]?.id);
  });

  /** Deduped: an alert reachable both directly and through a lot must not render twice. */
  test('an alert reachable by both paths appears once', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    const parkingAreaId = await t.run((ctx) =>
      ctx.db.insert('parkingAreas', {
        coord: { lat: 44.02, lng: -72 },
        source: 'osm' as const,
        status: 'visible' as const,
        amenities: [],
        createdAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('parkingAreaBodies', {
        parkingAreaId,
        waterBodyId,
        inferred: true,
        createdAt: Date.now(),
      }),
    );
    await author.as.mutation(api.accessAlerts.create, {
      targetType: 'parking_area',
      parkingAreaId,
      reason: 'not_plowed',
    });
    await author.as.mutation(api.accessAlerts.create, { targetType: 'put_in', putInId, reason: 'gate_locked' });

    const alerts = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.id)).size).toBe(2);
  });
});
