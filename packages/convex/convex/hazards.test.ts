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
      searchText: 'Shelburne Pond',
      type: 'lakePond' as const,
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

  // A merge tombstone is represented by its survivor, so offering it here would pre-check a pin that
  // isn't on the map — and where the survivor is the author's own, it is already in this list one row
  // up, so they would see two entries for one ridge in the form that exists to tidy them up.
  test('never offers a pin that has been folded into another', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const first = await author.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, {
        geometry: { type: 'Point' as const, coordinates: [0.5 + 5 / 111_320, 0.5] },
      }),
    );

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now(),
    });
    expect(candidates.map((c) => c._id)).toEqual([first]);
  });

  // The query is a suggestion; the write is the record. A client holding a list from before the merge
  // would still send the stale id, so the guard has to be on the attach as well.
  test('refuses to bind a tombstone to a report even when asked directly', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await author.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, {
        geometry: { type: 'Point' as const, coordinates: [0.5 + 5 / 111_320, 0.5] },
      }),
    );
    const loser = await t.run(async (ctx) =>
      (await ctx.db.query('hazards').collect()).find((h) => h.mergedIntoHazardId !== undefined),
    );

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [loser?._id as Id<'hazards'>],
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.hazardIdsCreated).toEqual([]);
    // And the tombstone is left exactly as it was — refusing to bundle it is not the same as editing
    // it. (`t.run` serialises an absent field as `null` on the way out, hence the loose check.)
    expect(
      await t.run(async (ctx) => (await ctx.db.get(loser?._id as Id<'hazards'>))?.originReportId),
    ).toBeFalsy();
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

  // The report form is another way to draw a hazard, not another kind of hazard — so a pin filed this
  // way collapses into an existing duplicate exactly as a standalone one does. Leaving auto-merge off
  // this path would have made the report form the way to file a duplicate that never collapses.
  test('folds an in-report hazard into an existing duplicate, like any other', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const standing = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const reportId = await sam.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      hazards: [
        {
          type: 'open_water' as const,
          geometryKind: 'point_radius' as const,
          geometry: { type: 'Point' as const, coordinates: [0.5 + 5 / 111_320, 0.5] },
          radiusMeters: 40,
        },
      ],
    });

    // The report records the **survivor**, never the tombstone it just wrote — otherwise the report
    // would link a pin the map does not draw.
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.hazardIdsCreated).toEqual([standing]);
    const listed = await sam.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed.map((h) => h._id)).toEqual([standing]);
  });

  test('a report that draws one ridge twice created one hazard, and says so', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const at = (m: number) => ({ type: 'Point' as const, coordinates: [0.5 + m / 111_320, 0.5] });
    const hazard = (m: number) => ({
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: at(m),
      radiusMeters: 40,
    });

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      hazards: [hazard(0), hazard(5)],
    });

    // Deduped: two rows went in, one survivor came out, and listing it twice would double-count the
    // report's contribution for no reason a reader could see.
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.hazardIdsCreated).toHaveLength(1);
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

/**
 * The pre-first-ice pass (N5a). This list is the safety cover for hiding last winter's hazards, so
 * what it *omits* matters as much as what it ranks.
 */
describe('hazards.listPromotionCandidates', () => {
  const lastSeasonStart = () => seasonStartMs(seasonOf(Date.now()) - 1) + 1;

  test('offers last season’s recurring types, ranked, and never this season’s', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const spring = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'spring_current' }),
    );
    const ridge = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'pressure_ridge' }),
    );
    const thisSeason = await author.as.mutation(
      api.hazards.create,
      // Deliberately elsewhere on the lake. Dropped on the same point it would auto-merge into the
      // spring above (D80) — same family, identical footprint — and this test is about the season
      // filter, not about duplicates.
      createArgs(waterBodyId, {
        type: 'spring_current',
        geometry: { type: 'Point' as const, coordinates: [0.7, 0.7] },
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(spring, { firstReportedAt: lastSeasonStart() });
      await ctx.db.patch(ridge, { firstReportedAt: lastSeasonStart() });
    });

    const candidates = await mod.as.query(api.hazards.listPromotionCandidates, { waterBodyId });
    // Permanent behavior ahead of structural; this season's hazard isn't a question for this pass.
    expect(candidates.map((c) => c.hazardId)).toEqual([spring, ridge]);
    expect(candidates.map((c) => c.hazardId)).not.toContain(thisSeason);
    expect(candidates[0]?.promotesTo).toBe('spring_current');
  });

  test('leaves out the volatile types — an event has nothing to be promoted to', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const lead = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'open_water' }),
    );
    await t.run((ctx) => ctx.db.patch(lead, { firstReportedAt: lastSeasonStart() }));

    expect(await mod.as.query(api.hazards.listPromotionCandidates, { waterBodyId })).toEqual([]);
  });

  test('keeps a hazard the community voted healed — that is a fact about last winter', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const ridge = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'pressure_ridge' }),
    );
    await t.run((ctx) =>
      ctx.db.patch(ridge, { firstReportedAt: lastSeasonStart(), status: 'archived' }),
    );

    const candidates = await mod.as.query(api.hazards.listPromotionCandidates, { waterBodyId });
    expect(candidates.map((c) => c.hazardId)).toEqual([ridge]);
    expect(candidates[0]?.archived).toBe(true);
  });

  test('is a moderator surface — it lists content ordinary users can no longer see', async () => {
    const t = harness();
    const user = await seedUser(t, 'member');
    const waterBodyId = await seedBody(t);
    await expect(
      user.as.query(api.hazards.listPromotionCandidates, { waterBodyId }),
    ).rejects.toThrow(/moderator/i);
  });

  /**
   * `by_water_body` has no status or time key, so this read was a `.collect()` over every hazard a
   * lake had ever held — on a table seasons make permanent. Bounded now, newest-created first, which
   * is where last season's rows are relative to older ones.
   */
  test('reads the newest hazards rather than the whole lifetime of a lake', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const recent = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'spring_current' }),
    );
    await t.run((ctx) => ctx.db.patch(recent, { firstReportedAt: lastSeasonStart() }));

    const candidates = await mod.as.query(api.hazards.listPromotionCandidates, { waterBodyId });
    expect(candidates.map((c) => c.hazardId)).toEqual([recent]);
  });
});

/**
 * `season` arrives as a bare optional number, so it can be `NaN` or `1e15`. Neither throws — both
 * become index bounds matching nothing — and the resulting empty lake reads as "quiet winter" rather
 * than as a malformed request.
 */
describe('a nonsense season argument falls back rather than emptying the lake', () => {
  test('hazards.listForBody ignores a NaN season', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const asked = await author.as.query(api.hazards.listForBody, {
      waterBodyId,
      season: Number.NaN,
    });
    const bare = await author.as.query(api.hazards.listForBody, { waterBodyId });
    expect(asked).toHaveLength(1);
    expect(asked.map((h) => h._id)).toEqual(bare.map((h) => h._id));
  });

  test('a season nobody could be browsing is treated as no argument at all', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    expect(
      await author.as.query(api.hazards.listForBody, { waterBodyId, season: 1e15 }),
    ).toHaveLength(1);
    // A real past season still hides it — the fallback must not mean "ignore the argument".
    expect(
      await author.as.query(api.hazards.listForBody, { waterBodyId, season: 2000 }),
    ).toHaveLength(0);
  });
});

/**
 * Cluster pooling (N5c / D80) — the gates read what the *cluster* knows, not what one row does.
 *
 * The seeded body is a 1°-square polygon around `[0.5, 0.5]`, so "40 m away" is a coordinate nudge of
 * about 0.00036°. Two 40 m-radius pins that close overlap comfortably inside `DUPLICATE_MATCH_METERS`.
 */
describe('hazards.listForBody — cluster consensus', () => {
  /** ~`meters` east of the body's centre, at this latitude. */
  const eastOf = (meters: number) => ({
    type: 'Point' as const,
    coordinates: [0.5 + meters / 111_320, 0.5],
  });

  test('a lone hazard is untouched — no cluster fields, and the row is the answer', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    await author.as.mutation(api.hazards.create, createArgs(waterBodyId));

    const [only] = await author.as.query(api.hazards.listForBody, { waterBodyId });
    expect(only?.provisional).toBe(true);
    expect(only?.clusterMemberIds).toBeUndefined();
    expect(only?.clusterConfirmCount).toBeUndefined();
  });

  test('two people marking the same spot corroborate each other, with no confirm taps', async () => {
    // The headline failure: today each pin sits at zero confirmations, so every phone on the lake gets
    // the soft "can you see it?" and nobody is ever warned about a ridge two people have drawn.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(30) }));

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(2);
    for (const h of listed) {
      expect(h.clusterMemberIds).toHaveLength(2);
      expect(h.clusterConfirmCount).toBe(1);
      // Above the threshold of 1, so the on-ice evaluator fires a real warning rather than a prompt.
      expect(h.provisional).toBe(false);
    }
  });

  test('one person posting twice is still one witness', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const waterBodyId = await seedBody(t);
    await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await alex.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(30) }));

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    for (const h of listed) {
      expect(h.clusterConfirmCount).toBe(0);
      expect(h.provisional).toBe(true); // D54's confirm-gate survives clustering intact
    }
  });

  test('confirmations cast on one duplicate count for the other', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const second = await alex.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30) }),
    );
    await sam.as.mutation(api.hazardConfirmations.confirm, {
      hazardId: first,
      verdict: 'still_there',
      via: 'app_open_nearby',
    });
    await kim.as.mutation(api.hazardConfirmations.confirm, {
      hazardId: second,
      verdict: 'still_there',
      via: 'app_open_nearby',
    });

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    // Two witnesses across the cluster, though each stored row still shows one — the stored counts are
    // untouched, because pooling is a read-time judgement and never rewrites what somebody said.
    for (const h of listed) expect(h.clusterConfirmCount).toBe(2);
    const stored = await t.run(async (ctx) => (await ctx.db.get(first))?.confirmCount);
    expect(stored).toBe(1);
  });

  test('a fresh duplicate refreshes the whole cluster clock', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const old = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const twelveDaysAgo = Date.now() - 12 * 24 * 60 * 60 * 1000;
    await t.run((ctx) => ctx.db.patch(old, { lastConfirmedAt: twelveDaysAgo }));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(30) }));

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    const aged = listed.find((h) => h._id === old);
    // Somebody stood there today and drew the same thing. The old pin is not stale information.
    expect(aged?.freshness).toBe('fresh');
    expect(aged?.lastConfirmedAt).toBe(twelveDaysAgo); // the stored row is never rewritten
  });

  test('different families in the same spot stay separate facts', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'spring_current', geometry: eastOf(10) }),
    );

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    for (const h of listed) expect(h.clusterMemberIds).toBeUndefined();
  });

  test('clearance votes are never pooled — archival stays strictly per-row', async () => {
    // The unsafe direction, and the one this must never take: two people clearing one pin must not
    // retire the neighbouring pin nobody looked at.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const second = await alex.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30) }),
    );
    for (const voter of [sam, kim]) {
      await voter.as.mutation(api.hazardConfirmations.confirm, {
        hazardId: first,
        verdict: 'fully_healed',
        via: 'app_open_nearby',
      });
    }

    const rows = await t.run(async (ctx) => ({
      first: await ctx.db.get(first),
      second: await ctx.db.get(second),
    }));
    expect(rows.first?.status).toBe('archived');
    expect(rows.second?.status).toBe('active');
    expect(rows.second?.goneCount).toBe(0);
  });

  test('the drawer agrees with the map about the same pin', async () => {
    // A pin drawn solid on the map and then labelled "Unconfirmed" the moment you open it is the app
    // disagreeing with itself about live ice.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(30) }));

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    const onMap = listed.find((h) => h._id === first);
    const inDrawer = await alex.as.query(api.hazards.get, { hazardId: first });
    expect(inDrawer?.provisional).toBe(onMap?.provisional);
    expect(inDrawer?.clusterConfirmCount).toBe(onMap?.clusterConfirmCount);
    expect(inDrawer?.freshness).toBe(onMap?.freshness);
  });

  test('a crossing never pools, however many are drawn on one spot', async () => {
    // A passage marker is the one pin where escalating too readily is the anti-conservative direction:
    // "reported crossable" carries people onto ice. Excluded structurally, not by a threshold.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    await alex.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'ridge_crossing', radiusMeters: 15 }),
    );
    await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'ridge_crossing', radiusMeters: 15, geometry: eastOf(10) }),
    );

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(2);
    for (const h of listed) {
      expect(h.clusterMemberIds).toBeUndefined();
      expect(h.provisional).toBe(true);
    }
  });

  test('records the pin a skater was shown and told us is different', async () => {
    // The nudge promised not to argue. Auto-merge is a strictly stronger claim than the 25 m match,
    // so without this a skater who tapped "no, this is different" could be merged a second later —
    // the same argument, held quietly.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const second = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30), dismissedDuplicateOf: first }),
    );
    expect(await t.run(async (ctx) => (await ctx.db.get(second))?.dismissedDuplicateOf)).toBe(
      first,
    );
    // **Dismissal blocks the merge, and only the merge** (founder call). It does not switch off
    // pooling or consensus rendering, which are non-destructive: the union outline is never smaller
    // than either member, so nothing is un-warned, and the drawer still lists both pins with their own
    // reporters and descriptions. Two people independently marking something here is real evidence
    // that something is here, whether or not they agree it is one thing.
    //
    // The residual tension, stated because a future reader will notice it: one outline is visually the
    // same claim a merge makes. If that reads as overruling the skater, the lever is to carry
    // `dismissedDuplicateOf` into `poolConsensus` as a cluster split, not to weaken the merge bar.
    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed.every((h) => h.clusterMemberIds?.length === 2)).toBe(true);
  });

  test('the drawer can name every pin behind a consensus outline', async () => {
    // Collapsing duplicates into one outline must not collapse *who saw it* — several people seeing a
    // thing separately is precisely what makes a cluster more convincing than one report.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30), description: 'right by the point' }),
    );

    const members = await alex.as.query(api.hazards.listClusterMembers, { hazardId: first });
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.reporterName).sort()).toEqual(['alex', 'sam']);
    expect(members.find((m) => m.hazardId === first)?.isOpen).toBe(true);
    expect(members.find((m) => m.description === 'right by the point')).toBeDefined();
  });

  test('a lone hazard has no cluster members to list', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const waterBodyId = await seedBody(t);
    const only = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    expect(await alex.as.query(api.hazards.listClusterMembers, { hazardId: only })).toEqual([]);
  });

  test('last season and this season are never one cluster', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const thisSeason = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const lastSeason = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30) }),
    );
    await t.run((ctx) =>
      // A pin from last February is not corroboration for one drawn this January.
      ctx.db.patch(lastSeason, { firstReportedAt: seasonStartMs(seasonOf(Date.now()) - 1) + 1000 }),
    );

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed.map((h) => h._id)).toEqual([thisSeason]);
    expect(listed[0]?.clusterMemberIds).toBeUndefined();
  });
});

/**
 * Auto-merge (N5c / D80, layer 4) — the only destructive-looking layer, and the one whose safety rests
 * on three properties: the survivor takes the union, clearance votes are never pooled, and a moderator
 * can put both pins back.
 */
describe('hazards auto-merge', () => {
  const eastOf = (meters: number) => ({
    type: 'Point' as const,
    coordinates: [0.5 + meters / 111_320, 0.5],
  });

  test('folds an overlapping duplicate into the earliest sighting and returns the survivor', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    // `create` returns the **survivor**, so a client navigating to what it just filed lands on the
    // live pin rather than on a tombstone.
    const returned = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(5) }),
    );
    expect(returned).toBe(first);

    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed.map((h) => h._id)).toEqual([first]);
  });

  test('the survivor takes the union, so a merge never shrinks the warned area', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const before = await t.run(async (ctx) => (await ctx.db.get(first))?.bbox);
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(20) }));
    const after = await t.run(async (ctx) => (await ctx.db.get(first))?.bbox);

    // The second pin sat further east, so the merged footprint reaches further east than the first
    // pin's ever did — more ice warned about, never less.
    expect(after?.maxLng).toBeGreaterThan(before?.maxLng as number);
    expect(after?.minLng).toBeLessThanOrEqual(before?.minLng as number);
  });

  test('counts the merged-away reporter as a witness without re-pointing their statement', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));

    const view = await alex.as.query(api.hazards.get, { hazardId: first });
    // Sam drew the thing independently, which is stronger evidence than a confirm tap.
    expect(view?.clusterConfirmCount).toBe(1);
    expect(view?.provisional).toBe(false);
    // The drawer still names both people. A merge collapses the geometry, never the record.
    const members = await alex.as.query(api.hazards.listClusterMembers, { hazardId: first });
    expect(members.map((m) => m.reporterName).sort()).toEqual(['alex', 'sam']);
    expect(members.find((m) => m.merged)).toBeDefined();
  });

  test('a permalink to a merged-away pin lands on the live one', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    // Grab the loser's id from the tombstone rather than the mutation, which returns the survivor.
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));
    const loser = await t.run(async (ctx) =>
      (await ctx.db.query('hazards').collect()).find((h) => h.mergedIntoHazardId !== undefined),
    );

    expect(
      (await alex.as.query(api.hazards.get, { hazardId: loser?._id as Id<'hazards'> }))?._id,
    ).toBe(first);
    // And a vote cast from a stale deep link lands on the pin actually carrying the warning.
    await sam.as.mutation(api.hazardConfirmations.confirm, {
      hazardId: loser?._id as Id<'hazards'>,
      verdict: 'still_there',
      via: 'proximity_alert',
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(first))?.confirmCount)).toBe(1);

    // The confirmer list follows the same chain the count does. Reading it off the argument instead
    // would print the tombstone's confirmers under the survivor's count — two numbers about two
    // different pins, one line apart.
    const named = await alex.as.query(api.hazardConfirmations.listForHazard, {
      hazardId: loser?._id as Id<'hazards'>,
    });
    expect(named.map((v) => v.displayName)).toEqual(['sam']);
  });

  test('never merges what a skater said was different', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const second = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(5), dismissedDuplicateOf: first }),
    );
    expect(second).not.toBe(first);
    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(2);
  });

  // A dismissal names a row, but a skater declines a *hazard* — and there are two ways for the app's
  // own notion of "the same hazard" to route around an exact-id check.
  test('never merges into the survivor the dismissed pin was folded into', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);

    // What the skater will be shown, and what it gets folded into a moment later. The earlier
    // `capturedAt` wins the survivor race, so `shown` becomes a tombstone pointing at `survivor`.
    const shown = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const survivor = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, {
        geometry: eastOf(5),
        capturedAt: Date.now() - 60 * 60 * 1000,
      }),
    );
    expect(await t.run(async (ctx) => (await ctx.db.get(shown))?.mergedIntoHazardId)).toBe(
      survivor,
    );

    // Kim declined `shown` on the ice; by the time their pin flushes it is a tombstone. Refusing only
    // that id would hand the pin to the survivor — the very hazard they rejected, one hop away.
    const mine = await kim.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(5), dismissedDuplicateOf: shown }),
    );
    expect(mine).not.toBe(survivor);
    expect(await t.run(async (ctx) => (await ctx.db.get(mine))?.mergedIntoHazardId)).toBeFalsy();
  });

  test('never merges into a cluster sibling of the pin that was dismissed', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);

    // 30 m apart: one cluster (their footprints overlap), two rows (under the merge bar).
    const shown = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const sibling = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30) }),
    );
    expect(sibling).not.toBe(shown);

    // Kim declined `shown`, and draws right on top of its sibling. Folding into the sibling would put
    // the pin in exactly the cluster they rejected, by a different door.
    const mine = await kim.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30), dismissedDuplicateOf: shown }),
    );
    expect(mine).not.toBe(sibling);
    const listed = await kim.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(3);
  });

  // The refusal is scoped to one hazard, not to the lake: a dismissal must not turn off deduplication
  // for everything else the skater draws that session.
  test('still merges a pin that has nothing to do with what was dismissed', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);
    const shown = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    // Far enough east to be a different hazard entirely — its own cluster, its own identity.
    const elsewhere = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(400) }),
    );

    const mine = await kim.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(400), dismissedDuplicateOf: shown }),
    );
    expect(mine).toBe(elsewhere);
  });

  test('unmerge puts both pins back, and nothing re-merges them', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));
    const loser = await t.run(async (ctx) =>
      (await ctx.db.query('hazards').collect()).find((h) => h.mergedIntoHazardId !== undefined),
    );

    await mod.as.mutation(api.hazards.unmerge, {
      hazardId: loser?._id as Id<'hazards'>,
      reason: 'These are two separate leads.',
    });
    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(2);

    // The survivor's footprint goes back to its own shape — the merge is fully reversible, including
    // the geometry it widened.
    const restored = await t.run(async (ctx) => await ctx.db.get(first));
    expect(restored?.clippedFootprint).toBeUndefined();

    // And a third identical pin cannot re-merge the pair a moderator just separated, which is what
    // stops Unmerge being a button that undoes nothing.
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));
    const after = await t.run(async (ctx) =>
      (await ctx.db.query('hazards').collect()).filter((h) => h.mergedIntoHazardId !== undefined),
    );
    expect(after.every((h) => h._id !== loser?._id)).toBe(true);
  });

  // The reversibility above is easy to get right for two pins mid-lake and easy to get wrong for
  // three: recomputing the union from the survivor's *stored* footprint unions the answer with itself,
  // so the pin a moderator just pulled out leaves its area behind and Unmerge does nothing to the
  // outline it was pressed to undo. Every recomputation therefore starts from what was drawn.
  test('unmerging one of three gives back exactly that pin’s area, and no more', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));
    const twoPinEast = await t.run(
      async (ctx) => (await ctx.db.get(first))?.bbox?.maxLng as number,
    );
    await kim.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(12) }));

    const all = await t.run((ctx) => ctx.db.query('hazards').collect());
    expect(all.filter((h) => h.mergedIntoHazardId !== undefined)).toHaveLength(2);
    const furthestEast = all.find((h) => h.createdByUserId === kim.id);
    const threePinEast = await t.run(
      async (ctx) => (await ctx.db.get(first))?.bbox?.maxLng as number,
    );
    expect(threePinEast).toBeGreaterThan(twoPinEast);

    await mod.as.mutation(api.hazards.unmerge, {
      hazardId: furthestEast?._id as Id<'hazards'>,
      reason: 'That eastern one is a separate lead.',
    });

    // Back to exactly the two-pin union — the third pin's reach east is gone, and the second pin's
    // is not, because only the pin that was pulled out was pulled out.
    const afterEast = await t.run(async (ctx) => (await ctx.db.get(first))?.bbox?.maxLng as number);
    expect(afterEast).toBeLessThan(threePinEast);
    expect(afterEast).toBeCloseTo(twoPinEast, 6);
    const listed = await alex.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(2);
  });

  test('every merge leaves an audit row, and the automatic ones name no actor', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));

    const merges = await mod.as.query(api.hazards.listRecentMerges, {});
    expect(merges).toHaveLength(1);
    // No human took this action, and naming the creating skater would record a member as having
    // moderated when they didn't.
    expect(merges[0]?.automatic).toBe(true);
    expect(merges[0]?.action).toBe('merge_hazards');
    expect(merges[0]?.stillMerged).toBe(true);
    expect(merges[0]?.waterBodyName).toBe('Shelburne Pond');
  });

  test('clearance votes still archive one row at a time', async () => {
    // Merging reduces the N× retirement work by making duplicates one row — never by sharing their
    // clearance votes, which would let two people clearing one pin retire an unexamined neighbour.
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const kim = await seedUser(t, 'kim');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    await sam.as.mutation(api.hazards.create, createArgs(waterBodyId, { geometry: eastOf(5) }));
    const loser = await t.run(async (ctx) =>
      (await ctx.db.query('hazards').collect()).find((h) => h.mergedIntoHazardId !== undefined),
    );

    for (const voter of [sam, kim]) {
      await voter.as.mutation(api.hazardConfirmations.confirm, {
        hazardId: first,
        verdict: 'fully_healed',
        via: 'app_open_nearby',
      });
    }
    const rows = await t.run(async (ctx) => ({
      survivor: await ctx.db.get(first),
      loser: await ctx.db.get(loser?._id as Id<'hazards'>),
    }));
    expect(rows.survivor?.status).toBe('archived');
    expect(rows.loser?.goneCount).toBe(0);
  });

  // The survivor chain is the one place a data bug could hang a query rather than answer it wrong, so
  // the hop cap has to degrade into "we couldn't resolve this" — the same contract `resolveSurvivor`
  // holds for merged water bodies (D36).
  test('a merge cycle resolves to nothing rather than looping forever', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const first = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    const second = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(5), dismissedDuplicateOf: first }),
    );
    // Only a bug could write this, which is exactly why the reader is capped rather than trusting.
    await t.run(async (ctx) => {
      await ctx.db.patch(first, { mergedIntoHazardId: second });
      await ctx.db.patch(second, { mergedIntoHazardId: first });
    });

    expect(await alex.as.query(api.hazards.get, { hazardId: first })).toBeNull();
    expect(await alex.as.query(api.hazards.listClusterMembers, { hazardId: first })).toEqual([]);
  });
});

/**
 * Pooling scope (N5c / D77) — which rows are even eligible to be one hazard. The exclusions matter more
 * than the matches: each one is a claim that some pin must *not* borrow another's evidence.
 */
describe('hazards cluster scope', () => {
  const eastOf = (meters: number) => ({
    type: 'Point' as const,
    coordinates: [0.5 + meters / 111_320, 0.5],
  });

  // A pin the community voted healed must not read its freshness off a live neighbour — that is
  // pooling in the unsafe direction by the back door, and the `status: 'active'` bound is what stops
  // it. Asserted because the bound is a line in an index expression, not a visible guard.
  test('an archived pin neither borrows a cluster nor lends itself to one', async () => {
    const t = harness();
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const waterBodyId = await seedBody(t);
    const live = await alex.as.mutation(api.hazards.create, createArgs(waterBodyId));
    // 30 m apart: overlapping footprints, so they cluster — but under the merge bar, so they stay two.
    const healed = await sam.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { geometry: eastOf(30) }),
    );
    expect(healed).not.toBe(live);
    expect(
      (await alex.as.query(api.hazards.get, { hazardId: live }))?.clusterMemberIds,
    ).toHaveLength(2);

    await t.run((ctx) => ctx.db.patch(healed, { status: 'archived' }));

    // The live pin is alone again — an archived sighting is not evidence that something is there now.
    const stillHere = await alex.as.query(api.hazards.get, { hazardId: live });
    expect(stillHere?.clusterMemberIds).toBeUndefined();
    expect(stillHere?.clusterConfirmCount).toBeUndefined();
    // And the archived pin reads its own row rather than the live one's clock.
    const gone = await alex.as.query(api.hazards.get, { hazardId: healed });
    expect(gone?.clusterMemberIds).toBeUndefined();
    expect(gone?.lastConfirmedAt).toBe(
      await t.run(async (ctx) => (await ctx.db.get(healed))?.lastConfirmedAt),
    );
  });
});

/**
 * The merges panel's read (N5c / D80). Its whole justification is that auto-merge can be watched, so
 * the read backing it must not be the kind that gets slower every week the app is alive.
 */
describe('hazards.listRecentMerges', () => {
  async function seedAction(
    t: ReturnType<typeof harness>,
    createdAt: number,
    extra: Record<string, unknown> = {},
  ) {
    return t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action: 'merge_hazards' as const,
        targetType: 'hazard' as const,
        targetId: 'h-old',
        reason: 'Footprints overlap above the automatic-merge bar (D80).',
        createdAt,
        ...extra,
      }),
    );
  }

  test('reads a window, so an ageing audit log never makes the panel slower', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', { role: 'moderator' });
    const recent = await seedAction(t, Date.now() - 2 * 24 * 60 * 60 * 1000);
    await seedAction(t, Date.now() - 200 * 24 * 60 * 60 * 1000);

    const rows = await mod.as.query(api.hazards.listRecentMerges, {});
    // Last winter's merges are history and live on the per-day chart; this panel is recent detail.
    expect(rows.map((r) => r.actionId)).toEqual([recent]);
  });

  test('is moderator-only', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    await expect(member.as.query(api.hazards.listRecentMerges, {})).rejects.toThrow();
  });
});
