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
    await expect(
      author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId }),
    ).rejects.toThrow(/Put-in not found/);
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
    const { putInId, author } = await setup();
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
    await author.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      putInId,
      reason: 'gate_locked',
    });

    const alerts = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.id)).size).toBe(2);
  });
});

/**
 * Flagging an access alert (N6d correction 8) — and the half that is easy to ship without.
 *
 * Adding `accessAlert` to `FLAG_TARGET_TYPES` makes *filing* work on its own, so the feature looks
 * finished from the reporting side while the moderator queue renders every one of these as
 * "(deleted)" with no author and no note: `resolveFlagTarget`'s switch had no case and fell through
 * to its not-found branch. A flag nobody can read is a flag nobody can action.
 */
describe('a flagged alert is triageable, not a hole in the queue', () => {
  test('the queue resolves the alert to its author and its words', async () => {
    const { t, putInId, author } = await setup();
    const flagger = await seedUser(t, 'flagger');
    const mod = await seedUser(t, 'mod', 'moderator');

    const accessAlertId = await author.as.mutation(api.accessAlerts.create, {
      ...ALERT,
      putInId,
      note: 'Gate is wide open, this is nonsense',
    });
    await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'accessAlert',
      targetId: accessAlertId,
      reason: 'spam',
    });

    const { priority, standard } = await mod.as.query(api.moderation.listFlags, {});
    const row = [...priority, ...standard].find((f) => f.targetId === accessAlertId);
    expect(row?.target.exists).toBe(true);
    expect(row?.target.summary).toBe('Gate is wide open, this is nonsense');
    expect(row?.target.author?.username).toBe('author');
  });

  /** An alert with no note still has to say what it claims — the reason is the claim. */
  test('an alert with no note falls back to its reason rather than to nothing', async () => {
    const { t, putInId, author } = await setup();
    const flagger = await seedUser(t, 'flagger');
    const mod = await seedUser(t, 'mod', 'moderator');

    const accessAlertId = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'accessAlert',
      targetId: accessAlertId,
      reason: 'spam',
    });

    const { priority, standard } = await mod.as.query(api.moderation.listFlags, {});
    const row = [...priority, ...standard].find((f) => f.targetId === accessAlertId);
    expect(row?.target.summary).toBe('Access alert: gate_locked');
  });

  /**
   * The takedown verb, and why it is retraction rather than a hide.
   *
   * An access alert carries no `moderationStatus` axis, so `setModerationStatus` cannot touch it —
   * which is what made it, briefly, the one flaggable thing in the app a moderator could not act on.
   * `retract` is the right verb anyway: a bogus "gate locked" was never true, which is exactly what
   * D65's verdict says.
   */
  test('a moderator retracts the alert a flag was about', async () => {
    const { t, putInId, author } = await setup();
    const mod = await seedUser(t, 'mod', 'moderator');
    const accessAlertId = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });

    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId, reason: 'gate is open' });

    expect((await t.run((ctx) => ctx.db.get(accessAlertId)))?.status).toBe('retracted');
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.some((a) => a.action === 'retract_access_alert')).toBe(true);
  });
});

/**
 * The PR #43 security finding: **an alert may name exactly one target.**
 *
 * `targetType` selects which id is validated, and the original code persisted the other one
 * unchecked — so a `put_in` alert could smuggle the `parkingAreaId` of a lot on a lake the author has
 * never seen, and `loadLiveAlertsForBody`'s independent `by_parking_area` range would publish it
 * there. A contributor could put "gate locked" on any lake in the corpus, attributed to nothing that
 * lake can name.
 */
describe('an alert names one target, and cannot be made to name two', () => {
  /** A second lake with its own lot — the one an attacker wants their warning to appear on. */
  async function otherLake(t: ReturnType<typeof convexTest>) {
    const waterBodyId = (await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Innocent Pond',
        searchText: 'Innocent Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/2',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [-70.01, 41.99],
              [-69.99, 41.99],
              [-69.99, 42.01],
              [-70.01, 42.01],
              [-70.01, 41.99],
            ],
          ],
        },
        bbox: { minLat: 41.99, minLng: -70.01, maxLat: 42.01, maxLng: -69.99 },
        centroid: { lat: 42, lng: -70 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'waterBodies'>;
    const parkingAreaId = (await t.run((ctx) =>
      ctx.db.insert('parkingAreas', {
        coord: { lat: 42.01, lng: -70 },
        source: 'osm' as const,
        status: 'visible' as const,
        amenities: [],
        createdAt: Date.now(),
      }),
    )) as Id<'parkingAreas'>;
    await t.run((ctx) =>
      ctx.db.insert('parkingAreaBodies', {
        parkingAreaId,
        waterBodyId,
        inferred: true,
        createdAt: Date.now(),
      }),
    );
    return { waterBodyId, parkingAreaId };
  }

  test('a put-in alert carrying a foreign lot is refused outright', async () => {
    const { t, putInId, author } = await setup();
    const victim = await otherLake(t);

    await expect(
      author.as.mutation(api.accessAlerts.create, {
        ...ALERT,
        putInId,
        parkingAreaId: victim.parkingAreaId,
      }),
    ).rejects.toThrow(/cannot also name a parking area/);

    // And the lake it was aimed at is untouched — the assertion that matters, since a stored row
    // would have been reachable from there whatever the mutation returned.
    expect(
      await t.query(api.accessAlerts.listForBody, { waterBodyId: victim.waterBodyId }),
    ).toEqual([]);
  });

  test('a parking alert carrying a foreign launch is refused too', async () => {
    const { t, putInId, author } = await setup();
    const victim = await otherLake(t);

    await expect(
      author.as.mutation(api.accessAlerts.create, {
        targetType: 'parking_area',
        parkingAreaId: victim.parkingAreaId,
        putInId,
        reason: 'gate_locked',
      }),
    ).rejects.toThrow(/cannot also name a put-in/);
    expect(await t.run((ctx) => ctx.db.query('accessAlerts').collect())).toEqual([]);
  });

  /** Belt to that braces: even a legitimate alert stores only the field its type names. */
  test('a legitimate put-in alert stores no parking id at all', async () => {
    const { t, putInId, author } = await setup();
    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.putInId).toBe(putInId);
    expect(row?.parkingAreaId).toBeUndefined();
  });
});

/**
 * The PR #43 cap finding: **the read cap must bound the answer, not the history.**
 *
 * No alert row is ever deleted — expiring flips a status — so a lake accumulates them across seasons.
 * Reading the bare `by_water_body` index took the oldest page and only then filtered for liveness, so
 * two winters of settled rows would hide a locked gate behind them.
 */
describe('a live alert survives a lake full of settled ones', () => {
  test('an active alert is found behind more than a cap of expired rows', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    // Comfortably past MAX_ACCESS_ROWS_PER_BODY (64), all older than the live one.
    await t.run(async (ctx) => {
      for (let i = 0; i < 80; i++) {
        await ctx.db.insert('accessAlerts', {
          targetType: 'put_in' as const,
          putInId,
          waterBodyId,
          reason: 'not_plowed' as const,
          createdByUserId: (await ctx.db.query('profiles').first())?._id as Id<'profiles'>,
          createdAt: Date.now() - (i + 2) * DAY_MS,
          season: seasonOf(Date.now()),
          status: 'expired' as const,
          confirmCount: 0,
          denyCount: 0,
        });
      }
    });

    const id = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });

    const live = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(live.map((a) => a.id)).toContain(id);
    expect(live).toHaveLength(1);
  });

  /** The pin's exemption, applied to the read: a busy season must not crowd out a moderator. */
  test('an official pin survives a cap of newer active alerts', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    const mod = await seedUser(t, 'mod', 'moderator');
    const pinned = await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: pinned,
      official: true,
      reason: 'confirmed with the town',
    });

    await t.run(async (ctx) => {
      for (let i = 0; i < 80; i++) {
        await ctx.db.insert('accessAlerts', {
          targetType: 'put_in' as const,
          putInId,
          waterBodyId,
          reason: 'lot_full' as const,
          createdByUserId: author.id as Id<'profiles'>,
          createdAt: Date.now() + i,
          season: seasonOf(Date.now()),
          expiresAt: Date.now() + 30 * DAY_MS,
          status: 'active' as const,
          confirmCount: 0,
          denyCount: 0,
        });
      }
    });

    const live = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(live.map((a) => a.id)).toContain(pinned);
    // And it sorts first, because a moderator's claim outranks a passer-by's.
    expect(live[0]?.id).toBe(pinned);
  });
});

/**
 * The cap must rank by the **same clock the API reports** (PR #43 review, round 2).
 *
 * `createdAt` is an *observation* time, not an insertion time: `create` takes `observedAt` and clamps
 * it to "no later than now", so a row's `createdAt` can sit well before the moment it was written.
 * The offline queue makes that the ordinary case rather than an adversarial one — a skater posts from
 * a lake with no signal and the row lands hours later.
 *
 * Ordering the capped read by the index's implicit `_creationTime` therefore ranked by *when we heard*
 * rather than *when it was seen*, while the returned list sorts by `createdAt`. A flush of stale
 * observations could push the freshest locked-gate warning out of the window entirely.
 */
describe('the cap ranks by observation time, not by when the row landed', () => {
  test('a fresh observation survives a later flush of backdated ones', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    const now = Date.now();

    // Seen today, and written first.
    const freshest = await author.as.mutation(api.accessAlerts.create, {
      ...ALERT,
      putInId,
      note: 'Gate went on this morning',
      observedAt: now - 60_000,
    });

    // Then a queue drains: more than a capful of alerts, every one of them *seen* ten days ago and
    // written now. By insertion order these are the newest rows on the lake; by observation they are
    // the stalest thing on it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 80; i++) {
        await ctx.db.insert('accessAlerts', {
          targetType: 'put_in' as const,
          putInId,
          waterBodyId,
          reason: 'not_plowed' as const,
          createdByUserId: author.id as Id<'profiles'>,
          createdAt: now - 10 * DAY_MS,
          season: seasonOf(now),
          expiresAt: now + 20 * DAY_MS,
          status: 'active' as const,
          confirmCount: 0,
          denyCount: 0,
        });
      }
    });

    const live = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(live.map((a) => a.id)).toContain(freshest);
    // And it leads, because the list is ordered by observation and this is the newest observation.
    expect(live[0]?.id).toBe(freshest);
  });
});

/**
 * The cap must contain **only rows that can still be live** (PR #43 review, round 3).
 *
 * Scoping the range by `status` removed settled rows, and it does not remove *unswept* ones: expiry
 * is a status flip performed by a cron every six hours in pages of 200, so a row whose `expiresAt`
 * passed an hour ago is still `status: 'active'` and still inside the range. Taking a capful of those
 * and only then applying `accessAlertIsLive` spends the budget on rows that are about to be thrown
 * away — and the row they displace is the worst possible one to lose, because an alert kept current
 * by confirmations has an *old* `createdAt` and a *future* expiry. It sorts last and it is the only
 * live warning on the lake.
 */
describe('an unswept backlog cannot hide a confirmed, still-live warning', () => {
  test('a long closure kept current by confirmations survives a capful of lapsed rows', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    const now = Date.now();

    // The one that matters: asserted seven weeks ago, re-confirmed yesterday, so it is live for
    // another month — and its `createdAt` is the oldest on the lake.
    const confirmed = (await t.run((ctx) =>
      ctx.db.insert('accessAlerts', {
        targetType: 'put_in' as const,
        putInId,
        waterBodyId,
        reason: 'road_closed' as const,
        note: 'Town has not reopened the gate',
        createdByUserId: author.id as Id<'profiles'>,
        createdAt: now - 50 * DAY_MS,
        season: seasonOf(now),
        expiresAt: now + 29 * DAY_MS,
        lastConfirmedAt: now - DAY_MS,
        status: 'active' as const,
        confirmCount: 3,
        denyCount: 0,
      }),
    )) as Id<'accessAlerts'>;

    // The backlog: lapsed a week ago, newer than the live one by `createdAt`, and still `active`
    // because the sweep has not reached them.
    await t.run(async (ctx) => {
      for (let i = 0; i < 80; i++) {
        await ctx.db.insert('accessAlerts', {
          targetType: 'put_in' as const,
          putInId,
          waterBodyId,
          reason: 'lot_full' as const,
          createdByUserId: author.id as Id<'profiles'>,
          createdAt: now - 40 * DAY_MS,
          season: seasonOf(now),
          expiresAt: now - 7 * DAY_MS,
          status: 'active' as const,
          confirmCount: 0,
          denyCount: 0,
        });
      }
    });

    const live = await t.query(api.accessAlerts.listForBody, { waterBodyId });
    expect(live.map((a) => a.id)).toContain(confirmed);
    // And it is the only thing on the lake, because everything else lapsed.
    expect(live).toHaveLength(1);
  });
});

/**
 * A lot alert follows the **association**, not the denormalized column (self-review, pre-round-4).
 *
 * `waterBodyId` is stamped at `create` from whichever association came first. `setOfficialParking`
 * can then delete that association — a moderator narrowing a lot to the lakes it really serves — and
 * the row goes on naming a body the lot has nothing to do with. Same failure as the
 * contradictory-target hole, reached from the write side: a "gate locked" warning on a lake nobody
 * parks at that lot for.
 */
describe('a lot alert stops showing on a lake the lot no longer serves', () => {
  test('dropping the association drops the warning with it', async () => {
    const t = convexTest(schema, modules);
    const a = await seedBody(t);
    const b = (await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Second Lake',
        searchText: 'Second Lake',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/9',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [-72.01, 44.99],
              [-71.99, 44.99],
              [-71.99, 45.01],
              [-72.01, 45.01],
              [-72.01, 44.99],
            ],
          ],
        },
        bbox: { minLat: 44.99, minLng: -72.01, maxLat: 45.01, maxLng: -71.99 },
        centroid: { lat: 45, lng: -72 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'waterBodies'>;

    const mod = await seedUser(t, 'mod', 'moderator');
    const member = await seedUser(t, 'member');
    const parkingAreaId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 44.5, lng: -72 },
      amenities: [],
      waterBodyIds: [a, b],
    });
    const alertId = await member.as.mutation(api.accessAlerts.create, {
      targetType: 'parking_area',
      parkingAreaId,
      reason: 'gate_locked',
    });
    // Filed against the first association, and visible from both lakes — the D72 shared-lot rule.
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId: a })).toHaveLength(1);
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId: b })).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.waterBodyId).toBe(a);

    // The moderator narrows the lot to the lake it actually serves.
    await mod.as.mutation(api.accessPoints.setOfficialParking, {
      parkingAreaId,
      coord: { lat: 44.5, lng: -72 },
      amenities: [],
      waterBodyIds: [b],
    });

    // Gone from the lake it no longer serves, still on the one it does — even though the row's own
    // `waterBodyId` still says otherwise.
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId: a })).toEqual([]);
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId: b })).toHaveLength(1);
  });
});

/**
 * The same rule for the other target type, and the honest limit of it.
 *
 * A re-import can move a launch between bodies — `matchAndImportPutIns` patches `waterBodyId` from
 * the OSM coordinate. The alert then names a lake its launch has left. What this guarantees is that
 * **the wrong lake stops being warned**; it does not make the alert appear on the new one, because
 * the read is keyed on the denormalized column and the row is simply unreachable from there.
 *
 * That asymmetry is the right way round — showing nothing beats showing a locked gate to people
 * heading somewhere else — and making it *follow* would need a write-side repair in the import lane
 * (plus the `by_put_in` index back). Deliberately not built: a mapper moving a slipway across a lake
 * boundary is not a case worth carrying code for, where a moderator narrowing a lot's associations
 * is an ordinary Tuesday.
 */
describe('a put-in alert stops warning the lake its launch left', () => {
  test('the warning leaves with the launch', async () => {
    const { t, waterBodyId, putInId, author } = await setup();
    const elsewhere = (await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Elsewhere Pond',
        searchText: 'Elsewhere Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: 'way/8',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [-70.01, 41.99],
              [-69.99, 41.99],
              [-69.99, 42.01],
              [-70.01, 42.01],
              [-70.01, 41.99],
            ],
          ],
        },
        bbox: { minLat: 41.99, minLng: -70.01, maxLat: 42.01, maxLng: -69.99 },
        centroid: { lat: 42, lng: -70 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'waterBodies'>;

    await author.as.mutation(api.accessAlerts.create, { ...ALERT, putInId });
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId })).toHaveLength(1);

    // The OSM coordinate moved and the join re-attached the launch to a different body.
    await t.run((ctx) => ctx.db.patch(putInId, { waterBodyId: elsewhere }));

    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId })).toEqual([]);
    // Not on the new lake either — see the note above. Asserted so the limit is pinned rather than
    // discovered by somebody who assumed it followed.
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId: elsewhere })).toEqual([]);
  });
});
