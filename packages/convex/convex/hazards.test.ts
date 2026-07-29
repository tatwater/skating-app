import { seasonOf, seasonStartMs } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** `reports.create` resolves a place label through the adminAreas cell index. */
function harness() {
  const t = convexTest(schema, modules);
  return t;
}

/** A photo row backed by real stored blobs, so `storage.getUrl` resolves. */
async function seedPhoto(t: ReturnType<typeof convexTest>, uploaderId: Id<'profiles'>) {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['full'])));
  const thumbStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['thumb'])));
  return t.run((ctx) =>
    ctx.db.insert('photos', {
      storageId,
      thumbStorageId,
      uploaderId,
      placeOnMap: false,
      createdAt: Date.now(),
    }),
  );
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

const ADULT_DOB = Date.UTC(1990, 0, 1);
const MINOR_DOB = Date.UTC(2015, 0, 1);

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  overrides: { role?: 'member' | 'moderator' | 'admin'; dateOfBirth?: number } = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: overrides.dateOfBirth ?? ADULT_DOB,
      reputationPoints: 0,
      role: overrides.role ?? ('member' as const),
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

const POINT = { type: 'Point' as const, coordinates: [0.5, 0.5] };

function createArgs(waterBodyId: Id<'waterBodies'>, overrides = {}) {
  return {
    waterBodyId,
    type: 'open_water' as const,
    geometryKind: 'point_radius' as const,
    geometry: POINT,
    radiusMeters: 40,
    ...overrides,
  };
}

describe('hazards.create', () => {
  test('creates a hazard with derived bbox and initial lifecycle state', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));

    expect(hazard?.type).toBe('open_water');
    expect(hazard?.status).toBe('active');
    expect(hazard?.moderationStatus).toBe('visible');
    expect(hazard?.confirmCount).toBe(0);
    expect(hazard?.goneCount).toBe(0);
    expect(hazard?.originReportId).toBeUndefined();
    // The bbox is of the *footprint* (point grown by its radius), not the bare point.
    expect(hazard?.bbox.maxLat).toBeGreaterThan(0.5);
    expect(hazard?.bbox.minLat).toBeLessThan(0.5);
  });

  test('fills the type-aware radius default when the client omits one', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    const hazardId = await user.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'drilled_hole', radiusMeters: undefined }),
    );
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    // A drilled hole is metres across, not tens of metres.
    expect(hazard?.radiusMeters).toBe(5);
  });

  test('rejects a degenerate geometry rather than storing an invisible hazard', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    await expect(
      user.as.mutation(
        api.hazards.create,
        createArgs(waterBodyId, {
          geometryKind: 'line',
          geometry: { type: 'LineString', coordinates: [[0.5, 0.5]] },
          radiusMeters: undefined,
        }),
      ),
    ).rejects.toThrow(/Invalid hazard geometry/);
  });

  test('requires authentication', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    await expect(t.mutation(api.hazards.create, createArgs(waterBodyId))).rejects.toThrow(
      /Not authenticated/,
    );
  });

  // Minors are read-only (D41) — a hazard is public safety content.
  test('rejects minors', async () => {
    const t = harness();
    const minor = await seedUser(t, 'minor', { dateOfBirth: MINOR_DOB });
    const waterBodyId = await seedBody(t);
    await expect(minor.as.mutation(api.hazards.create, createArgs(waterBodyId))).rejects.toThrow(
      /under 18/,
    );
  });

  test('rejects a photo the author does not own', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const stranger = await seedUser(t, 'stranger');
    const waterBodyId = await seedBody(t);
    const photoId = await seedPhoto(t, stranger.id);

    await expect(
      author.as.mutation(api.hazards.create, createArgs(waterBodyId, { photoIds: [photoId] })),
    ).rejects.toThrow(/not owned/);
  });
});

describe('hazards clip-to-body (Phase 9.5)', () => {
  // A hazard well inside the lake needs no clip — the footprint is already all water, so nothing is
  // stored and reads fall back to the live footprint.
  test('stores no clipped footprint for a hazard well inside the body', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.clippedFootprint).toBeUndefined();
  });

  // A hazard dropped on the shoreline buffers into a circle that spills off the lake; the stored clip
  // confines it, and the stored bbox is pulled back to the shore rather than bulging past it.
  test('clips a shoreline hazard to the body and tightens its bbox', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t); // unit square, lng/lat 0..1

    const hazardId = await user.as.mutation(
      api.hazards.create,
      // Right on the western edge (lng 0): the 40 m circle's western half falls outside the body.
      createArgs(waterBodyId, { geometry: { type: 'Point', coordinates: [0, 0.5] } }),
    );
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));

    expect(hazard?.clippedFootprint).toBeDefined();
    expect(['Polygon', 'MultiPolygon']).toContain(hazard?.clippedFootprint?.type);
    // The clip drives the bbox: its western edge is the shoreline (lng 0), not the circle's raw bulge
    // into the land west of it.
    expect(hazard?.bbox.minLng).toBeGreaterThanOrEqual(-1e-6);
  });
});

describe('hazards.create idempotency (offline flush)', () => {
  // A hazard is flagged standing next to it, which is exactly where there's no signal — so the
  // offline flush is the common path, and a lost ack must not drop a second pin metres from the
  // first. Duplicate hazards are worse than duplicate reports: two overlapping footprints read as
  // two dangers, and the confirm loop then has to retire both.
  test('replays to the same hazard instead of creating a second pin', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const args = createArgs(waterBodyId, { idempotencyKey: 'key-1' });

    const first = await user.as.mutation(api.hazards.create, args);
    const second = await user.as.mutation(api.hazards.create, args);

    expect(second).toBe(first);
    const all = await t.run((ctx) => ctx.db.query('hazards').collect());
    expect(all).toHaveLength(1);
  });

  test('a different key is a different sighting', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    await user.as.mutation(api.hazards.create, createArgs(waterBodyId, { idempotencyKey: 'a' }));
    await user.as.mutation(api.hazards.create, createArgs(waterBodyId, { idempotencyKey: 'b' }));

    const all = await t.run((ctx) => ctx.db.query('hazards').collect());
    expect(all).toHaveLength(2);
  });

  // Scoped to the author so a (UUID-collision-improbable) shared key can never hand back someone
  // else's pin.
  test('rejects a key that belongs to another author', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const other = await seedUser(t, 'other');
    const waterBodyId = await seedBody(t);

    await author.as.mutation(api.hazards.create, createArgs(waterBodyId, { idempotencyKey: 'k' }));
    await expect(
      other.as.mutation(api.hazards.create, createArgs(waterBodyId, { idempotencyKey: 'k' })),
    ).rejects.toThrow(/Idempotency key conflict/);
  });

  test('online callers omit the key and always create', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await user.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const all = await t.run((ctx) => ctx.db.query('hazards').collect());
    expect(all).toHaveLength(2);
    expect(all.every((h) => h.idempotencyKey === undefined)).toBe(true);
  });
});

describe('hazards.listForBody', () => {
  test('derives freshness and provisional status at read time', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await user.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const [hazard] = await user.as.query(api.hazards.listForBody, { waterBodyId });
    expect(hazard?.freshness).toBe('fresh');
    expect(hazard?.provisional).toBe(true); // nobody else has confirmed it yet
  });

  // Dropping stale hazards would make "unconfirmed lately" indistinguishable from "gone" (D3).
  test('still returns stale hazards, annotated rather than filtered', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
    // open_water goes stale after 72h.
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { lastConfirmedAt: Date.now() - 100 * 60 * 60 * 1000 }),
    );

    const [hazard] = await user.as.query(api.hazards.listForBody, { waterBodyId });
    expect(hazard?.freshness).toBe('stale');
  });

  test('hides moderator-hidden hazards', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await t.run((ctx) => ctx.db.patch(hazardId, { moderationStatus: 'hidden' }));

    expect(await user.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(0);
  });

  test('excludes archived hazards by default and includes them on request', async () => {
    const t = harness();
    const user = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await t.run((ctx) => ctx.db.patch(hazardId, { status: 'archived' }));

    expect(await user.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(0);
    expect(
      await user.as.query(api.hazards.listForBody, { waterBodyId, includeArchived: true }),
    ).toHaveLength(1);
  });

  // The hardest call in N5a, and the one most likely to be "fixed" back: a hazard's season is the
  // clock **nobody can move**, so a single confirmation can't carry last winter's ridge into this one.
  describe('seasonal scoping (N5a/D63)', () => {
    /** Backdate a hazard's first sighting past the July boundary, leaving its confirmation fresh. */
    const lastSeasonStart = () => seasonStartMs(seasonOf(Date.now())) - 1;

    test('a hazard first reported last season is hidden, however recently it was confirmed', async () => {
      const t = harness();
      const user = await seedUser(t, 'author');
      const waterBodyId = await seedBody(t);
      const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
      // Six other skaters confirmed it yesterday — the most current thing on that shore, and still
      // last season's ridge. `lastConfirmedAt` is what the redaction sweep and the decay curve read;
      // the season reads `firstReportedAt` precisely so the community can't move it.
      await t.run((ctx) =>
        ctx.db.patch(hazardId, { firstReportedAt: lastSeasonStart(), lastConfirmedAt: Date.now() }),
      );

      expect(await user.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(0);
    });

    test('and is right there under last season, still fresh', async () => {
      const t = harness();
      const user = await seedUser(t, 'author');
      const waterBodyId = await seedBody(t);
      const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId));
      await t.run((ctx) =>
        ctx.db.patch(hazardId, { firstReportedAt: lastSeasonStart(), lastConfirmedAt: Date.now() }),
      );

      const past = await user.as.query(api.hazards.listForBody, {
        waterBodyId,
        season: seasonOf(Date.now()) - 1,
      });
      expect(past).toHaveLength(1);
      // Hidden, not deleted, and not degraded on the way out: the pin browses exactly as it was.
      expect(past[0]?.freshness).toBe('fresh');
    });

    test('this season’s hazards are untouched by the bound', async () => {
      const t = harness();
      const user = await seedUser(t, 'author');
      const waterBodyId = await seedBody(t);
      await user.as.mutation(api.hazards.create, createArgs(waterBodyId));

      expect(await user.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(1);
    });
  });
});

// Hazards are moderated through the shared `moderation.setModerationStatus` (targetType: 'hazard'), so
// the Phase 7 takedown queue has one entry point rather than a hazard-only mutation to also wire up.
describe('hazard moderation (moderation.setModerationStatus)', () => {
  // The full flag → hide path a phone now reaches (mobile gained a flag control): a member flags a bad
  // pin through `contentFlags`, a moderator resolves it and hides the hazard, and it leaves the map.
  test('a flagged pin can be reviewed and hidden end to end', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const reporter = await seedUser(t, 'reporter');
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const flagId = await reporter.as.mutation(api.contentFlags.flag, {
      targetType: 'hazard',
      targetId: hazardId,
      reason: 'unsafe_false_report',
    });
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'actioned',
      reason: 'confirmed fake',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'hazard',
      targetId: hazardId,
      status: 'hidden',
      reason: 'confirmed fake',
    });

    expect(await reporter.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(0);
  });

  test('hides a bad pin without touching its lifecycle status', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'hazard',
      targetId: hazardId,
      status: 'hidden',
      reason: 'fake pin',
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.moderationStatus).toBe('hidden');
    // The two axes are separate on purpose: a moderator hiding a pin must never read as the community
    // clearing a hazard (D3).
    expect(hazard?.status).toBe('active');
  });

  test('writes an audit row', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'hazard',
      targetId: hazardId,
      status: 'hidden',
      reason: 'spam',
    });

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.targetType).toBe('hazard');
    expect(actions[0]?.action).toBe('hide');
    expect(actions[0]?.reason).toBe('spam');
  });

  test('removing a hazard filters it out of every read path', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'hazard',
      targetId: hazardId,
      status: 'removed',
      reason: 'abuse',
    });

    expect(await author.as.query(api.hazards.get, { hazardId })).toBeNull();
    const listed = await author.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(0);
  });

  test('requires the moderator role and a non-blank reason', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    await expect(
      author.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'hazard',
        targetId: hazardId,
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow(/moderator/);
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'hazard',
        targetId: hazardId,
        status: 'hidden',
        reason: '  ',
      }),
    ).rejects.toThrow(/reason is required/);
  });
});

describe('hazards.get reporter line (Phase 9.5)', () => {
  test("resolves the reporter's display name for the drawer's author line", async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const viewer = await seedUser(t, 'viewer');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const view = await viewer.as.query(api.hazards.get, { hazardId });
    expect(view?.reporterName).toBe('author');
  });

  test('withholds the reporter name when viewer and author have blocked each other, but keeps the hazard visible (D3/D32)', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const viewer = await seedUser(t, 'viewer');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await t.run((ctx) =>
      ctx.db.insert('blocks', {
        blockerId: viewer.id,
        blockedId: author.id,
        createdAt: Date.now(),
      }),
    );

    const view = await viewer.as.query(api.hazards.get, { hazardId });
    // The name is suppressed the way a blocked comment's author is — but the safety observation itself
    // is untouched: a block never pulls a hazard off the map.
    expect(view).not.toBeNull();
    expect(view?.reporterName).toBeUndefined();
  });

  test('does not attach a reporter name on the map list path', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const rows = await author.as.query(api.hazards.listForBody, { waterBodyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reporterName).toBeUndefined();
  });
});

describe('hazards.listBundleCandidates (D55)', () => {
  test("offers the author's own unattached hazards inside the skate window", async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now() + 1000,
    });
    expect(candidates.map((c) => c._id)).toEqual([hazardId]);
  });

  test("never offers another skater's hazard", async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const other = await seedUser(t, 'other');
    const waterBodyId = await seedBody(t);
    await other.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now() + 1000,
    });
    expect(candidates).toHaveLength(0);
  });

  test('never offers a hazard already attached to a report', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    });
    expect(reportId).toBeDefined();

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now() + 1000,
    });
    expect(candidates).toHaveLength(0);
  });

  test('bundles an offline hazard captured during the skate but flushed after it ended', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const skateEndTime = now - 45 * 60 * 1000; // skate ended 45 min ago
    const capturedAt = now - 90 * 60 * 1000; // hazard captured mid-skate, 90 min ago
    // Flush happens *now* (signal came back after leaving the ice) — but capturedAt lands it in-window.
    const hazardId = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { idempotencyKey: 'k', capturedAt }),
    );

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime,
    });
    expect(candidates.map((c) => c._id)).toEqual([hazardId]);
  });

  test('excludes hazards outside the skate window', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));
    // Flagged a week before this skate.
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await t.run((ctx) => ctx.db.patch(hazardId, { firstReportedAt: weekAgo }));

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now(),
    });
    expect(candidates).toHaveLength(0);
  });
});

describe('reports.create with hazards', () => {
  test('creates in-report hazards stamped with originReportId', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      hazards: [
        {
          type: 'pressure_ridge' as const,
          geometryKind: 'point_radius' as const,
          geometry: POINT,
          radiusMeters: 25,
        },
      ],
    });

    const report = await t.run((ctx) => ctx.db.get(reportId));
    const createdId = report?.hazardIdsCreated[0];
    expect(report?.hazardIdsCreated).toHaveLength(1);
    expect(createdId).toBeDefined();

    if (!createdId) throw new Error('expected an in-report hazard');
    const hazard = await t.run((ctx) => ctx.db.get(createdId));
    expect(hazard?.originReportId).toBe(reportId);
    expect(hazard?.type).toBe('pressure_ridge');
  });

  test("bundles the author's standalone hazards into the report (D55)", async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    });

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.hazardIdsCreated).toEqual([hazardId]);
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.originReportId).toBe(reportId);
  });

  // Bundling someone else's observation would misattribute it — mis-sourced safety content is a D3
  // problem, so the server re-checks ownership rather than trusting the id list.
  test("silently skips another skater's hazard rather than stealing it", async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const other = await seedUser(t, 'other');
    const waterBodyId = await seedBody(t);
    const foreignId = await other.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [foreignId],
    });

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.hazardIdsCreated).toEqual([]);
    const hazard = await t.run((ctx) => ctx.db.get(foreignId));
    expect(hazard?.originReportId).toBeUndefined();
  });

  test('does not re-attach a hazard already bound to another report', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const firstReport = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    });
    const secondReport = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    });

    expect(await t.run((ctx) => ctx.db.get(secondReport))).toMatchObject({ hazardIdsCreated: [] });
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      originReportId: firstReport,
    });
  });
});

describe('photos.getHazardUrls', () => {
  test("serves a standalone hazard's photos without needing a report", async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const photoId = await seedPhoto(t, author.id);
    const hazardId = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { photoIds: [photoId] }),
    );

    const photos = await author.as.query(api.photos.getHazardUrls, { hazardId });
    expect(photos).toHaveLength(1);
    expect(photos[0]?.photoId).toBe(photoId);
  });

  test('serves nothing for a moderator-hidden hazard', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const photoId = await seedPhoto(t, author.id);
    const hazardId = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { photoIds: [photoId] }),
    );
    await t.run((ctx) => ctx.db.patch(hazardId, { moderationStatus: 'hidden' }));

    expect(await author.as.query(api.photos.getHazardUrls, { hazardId })).toEqual([]);
  });
});
