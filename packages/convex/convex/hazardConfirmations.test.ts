import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  dateOfBirth = Date.UTC(1990, 0, 1),
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth,
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      type: 'lake' as const,
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
}

async function seedHazard(
  author: { as: ReturnType<ReturnType<typeof convexTest>['withIdentity']> },
  waterBodyId: Id<'waterBodies'>,
  type = 'open_water' as const,
) {
  return author.as.mutation(api.hazards.create, {
    waterBodyId,
    type,
    geometryKind: 'point_radius' as const,
    geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
    radiusMeters: 40,
  });
}

async function setup() {
  const t = harness();
  const author = await seedUser(t, 'author');
  const waterBodyId = await seedBody(t);
  const hazardId = await seedHazard(author, waterBodyId);
  return { t, author, waterBodyId, hazardId };
}

const VIA = { via: 'app_open_nearby' as const };

describe('still_there', () => {
  test('resets the decay clock and counts toward confirmation', async () => {
    const { t, hazardId, waterBodyId } = await setup();
    const skater = await seedUser(t, 'skater');
    // Age the hazard well past fresh.
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { lastConfirmedAt: Date.now() - 100 * 60 * 60 * 1000 }),
    );

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      ...VIA,
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.confirmCount).toBe(1);
    expect(hazard?.goneCount).toBe(0);
    expect(hazard?.status).toBe('active');
    const [view] = await skater.as.query(api.hazards.listForBody, { waterBodyId });
    expect(view?.freshness).toBe('fresh');
  });

  // The confirm-gate (D54): one independent confirm promotes a soft "can you see it?" into a real
  // warning for subsequent skaters.
  test('promotes a hazard out of provisional', async () => {
    const { t, hazardId, waterBodyId } = await setup();
    const skater = await seedUser(t, 'skater');

    const before = await skater.as.query(api.hazards.listForBody, { waterBodyId });
    expect(before[0]?.provisional).toBe(true);

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      ...VIA,
    });

    const after = await skater.as.query(api.hazards.listForBody, { waterBodyId });
    expect(after[0]?.provisional).toBe(false);
  });
});

describe('healing_unsafe', () => {
  // The whole reason the middle verdict exists — a healing hazard is still a hazard.
  test('keeps the pin up and counts toward nothing', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'healing_unsafe',
      ...VIA,
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.healingState).toBe('healing_unsafe');
    expect(hazard?.status).toBe('active');
    expect(hazard?.confirmCount).toBe(0);
    expect(hazard?.goneCount).toBe(0);
  });

  test('never archives, however many skaters report healing', async () => {
    const { t, hazardId } = await setup();
    for (const name of ['a', 'b', 'c', 'd']) {
      const skater = await seedUser(t, name);
      await skater.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'healing_unsafe',
        ...VIA,
      });
    }
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({ status: 'active' });
  });
});

describe('fully_healed', () => {
  test('archives only at the removal threshold of two independent verdicts', async () => {
    const { t, hazardId } = await setup();
    const first = await seedUser(t, 'first');
    const second = await seedUser(t, 'second');

    await first.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      ...VIA,
    });
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      goneCount: 1,
      status: 'active',
    });

    await second.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      ...VIA,
    });
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      goneCount: 2,
      status: 'archived',
    });
  });

  // The whole reason counts are derived from distinct users, not incremented per vote (D3): a single
  // account casting `fully_healed` twice — even hours apart, past the re-confirm window — must not be
  // able to hit the two-verdict removal threshold and archive a real hazard on its own.
  test('one account cannot archive a hazard by voting fully_healed twice', async () => {
    const { t, hazardId } = await setup();
    const troll = await seedUser(t, 'troll');
    const now = Date.now();

    // First vote: observed 13h ago (outside the 12h re-confirm window), so a naive per-row counter
    // would treat the second vote as fresh.
    await troll.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      observedAt: now - 13 * 60 * 60 * 1000,
      ...VIA,
    });
    await troll.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      observedAt: now,
      ...VIA,
    });

    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      goneCount: 1,
      status: 'active',
    });
    // And only one vote row survives — one skater, one current opinion.
    const rows = await t.run((ctx) =>
      ctx.db
        .query('hazardConfirmations')
        .withIndex('by_hazard', (q) => q.eq('hazardId', hazardId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  // The offline twin of the abuse above, without any malice: a lost ack after a committed mutation is
  // classified transient and retried on the next flush. Replaying the same confirmation must be a no-op.
  test('replaying a queued fully_healed confirmation does not double-count', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');
    const observedAt = Date.now() - 20 * 60 * 60 * 1000; // old enough to fall outside the window

    for (let i = 0; i < 3; i++) {
      await skater.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'fully_healed',
        observedAt,
        ...VIA,
      });
    }

    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      goneCount: 1,
      status: 'active',
    });
    // The reputation boost is awarded once, not once per replay.
    const events = await t.run((ctx) => ctx.db.query('pointEvents').collect());
    expect(events).toHaveLength(1);
  });

  // Archived, never deleted — the row survives so it can resurface on a re-report (D15).
  test('archives rather than deleting the row', async () => {
    const { t, hazardId } = await setup();
    for (const name of ['first', 'second']) {
      const skater = await seedUser(t, name);
      await skater.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'fully_healed',
        ...VIA,
      });
    }
    expect(await t.run((ctx) => ctx.db.get(hazardId))).not.toBeNull();
  });
});

describe('the author cannot move their own hazard', () => {
  // One person must not be able to both plant a pin and promote it into a warning for everyone else
  // on that ice (D54).
  test('their confirm refreshes the clock but does not count', async () => {
    const { t, author, hazardId } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { lastConfirmedAt: Date.now() - 100 * 60 * 60 * 1000 }),
    );

    await author.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      ...VIA,
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.confirmCount).toBe(0);
    expect(hazard?.lastConfirmedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  test('cannot self-archive their own hazard', async () => {
    const { t, author, hazardId } = await setup();
    for (let i = 0; i < 5; i++) {
      await author.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'fully_healed',
        ...VIA,
      });
    }
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      goneCount: 0,
      status: 'active',
    });
  });
});

describe('re-confirmation within the window', () => {
  // Otherwise a skater doing laps could archive a hazard single-handedly by tapping twice.
  test('replaces the vote instead of stacking it', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      ...VIA,
    });
    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      ...VIA,
    });

    const votes = await t.run((ctx) => ctx.db.query('hazardConfirmations').collect());
    expect(votes).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      goneCount: 1,
      status: 'active',
    });
  });

  test('unwinds the prior verdict when a skater changes their mind', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      ...VIA,
    });
    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      ...VIA,
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.goneCount).toBe(0); // the healed vote was withdrawn
    expect(hazard?.confirmCount).toBe(1);
  });
});

describe('gating', () => {
  test('requires authentication', async () => {
    const { t, hazardId } = await setup();
    await expect(
      t.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'still_there',
        ...VIA,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test('rejects minors — a confirmation moves public safety content', async () => {
    const { t, hazardId } = await setup();
    const minor = await seedUser(t, 'minor', Date.UTC(2015, 0, 1));
    await expect(
      minor.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'still_there',
        ...VIA,
      }),
    ).rejects.toThrow(/under 18/);
  });

  test('refuses to confirm a moderator-hidden hazard', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');
    await t.run((ctx) => ctx.db.patch(hazardId, { moderationStatus: 'hidden' }));

    await expect(
      skater.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'still_there',
        ...VIA,
      }),
    ).rejects.toThrow(/not found/i);
  });

  // A device with a fast clock (or a client trying to freeze a pin as permanently fresh) must not be
  // able to push lastConfirmedAt into the future.
  test('clamps a future observedAt to now', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');
    const wayAhead = Date.now() + 10 * 24 * 60 * 60 * 1000;

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      observedAt: wayAhead,
      ...VIA,
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.lastConfirmedAt).toBeLessThan(wayAhead);
  });

  test('honors an offline observedAt from earlier in the day', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');
    // The hazard was first reported yesterday; the skater observed it this morning while offline and
    // is only flushing now. `observedAt` must stamp the morning, not the flush.
    const firstReportedAt = Date.now() - 24 * 60 * 60 * 1000;
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { firstReportedAt, lastConfirmedAt: firstReportedAt }),
    );
    const earlier = Date.now() - 3 * 60 * 60 * 1000;

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      observedAt: earlier,
      ...VIA,
    });

    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({ lastConfirmedAt: earlier });
  });

  test('a late offline confirmation never ages a hazard a newer online vote already refreshed', async () => {
    const { t, hazardId } = await setup();
    const online = await seedUser(t, 'online');
    const offline = await seedUser(t, 'offline');
    const now = Date.now();

    // Online skater confirms it "still here" at 10:00, refreshing the clock.
    await online.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      observedAt: now,
      ...VIA,
    });
    // A different skater's 06:00 observation flushes at 10:05. It must not drag the clock backward and
    // fade a pin that was verified minutes ago.
    await offline.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      observedAt: now - 4 * 60 * 60 * 1000,
      ...VIA,
    });

    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({ lastConfirmedAt: now });
  });
});

describe('side effects', () => {
  test('records a boost-only point event for the reputation signal (D50)', async () => {
    const { t, hazardId } = await setup();
    const skater = await seedUser(t, 'skater');

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'fully_healed',
      ...VIA,
    });

    const events = await t.run((ctx) => ctx.db.query('pointEvents').collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'hazard_confirmed', delta: 1, userId: skater.id });
  });

  test('lists confirmations newest-first for the detail drawer', async () => {
    const { t, hazardId } = await setup();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    await a.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      observedAt: Date.now() - 60_000,
      ...VIA,
    });
    await b.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'healing_unsafe',
      ...VIA,
    });

    const votes = await a.as.query(api.hazardConfirmations.listForHazard, { hazardId });
    expect(votes.map((v) => v.verdict)).toEqual(['healing_unsafe', 'still_there']);
  });
});
