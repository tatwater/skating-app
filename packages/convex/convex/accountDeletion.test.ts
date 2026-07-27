/**
 * Account deletion (D33/D62) — the grace window, the three buckets, and the two invariants that would
 * be silent failures if they broke: the second tombstone must not break authentication, and finalize
 * must not pull a departing skater's published tracks off the aggregate map.
 */
import {
  DELETED_DISPLAY_NAME,
  DELETION_GRACE_MS,
  deletedClerkUserId,
  deletedUsername,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * Fake timers from before the first schedule, per the note in `subAreas.test.ts`: finalize is a
 * `scheduler.runAfter(0)` chain, and convex-test leaves such a job `pending` until a timer fires —
 * so without this `finishAllScheduledFunctions` drains nothing and every assertion reads a row the
 * job never reached, failing as a plausible-looking "the deletion didn't happen".
 */
function harness() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

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
const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

/** What `seedUser` hands back: the profile id plus a client bound to that identity. */
type SeededUser = Awaited<ReturnType<typeof seedUser>>;

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      homeCoord: { lat: 44.5, lng: -73.2 },
      homeTownLabel: 'Burlington, VT',
      bio: 'I skate.',
      profileImageUrl: 'https://img.clerk.com/x',
      outerRadiusMeters: 90_000,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: ADULT_DOB,
      reputationPoints: 40,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0,
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof convexTest>, offset = 0) {
  const externalId = `osm/del-${offset}`;
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm' as const,
        externalId,
        name: 'Shelburne Pond',
        type: 'lake' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [offset, offset],
              [offset, offset + 1],
              [offset + 1, offset + 1],
              [offset + 1, offset],
              [offset, offset],
            ],
          ],
        },
        bbox: { minLat: offset, minLng: offset, maxLat: offset + 1, maxLng: offset + 1 },
        centroid: { lat: offset + 0.5, lng: offset + 0.5 },
      },
    ],
  });
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
  // biome-ignore lint/style/noNonNullAssertion: the import above just wrote it.
  return bodies.find((b) => b.externalId === externalId)!._id;
}

/** Drive the staged job to completion the way the scheduler would. */
async function finalize(t: ReturnType<typeof convexTest>, userId: Id<'profiles'>) {
  await t.mutation(internal.accountDeletion.finalizeNow, { userId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Same, but forcing the continuation path — several pages per stage instead of one. */
async function finalizePaged(
  t: ReturnType<typeof convexTest>,
  userId: Id<'profiles'>,
  pageSize: number,
) {
  await t.run((ctx) => ctx.db.patch(userId, { deletionRequestedAt: Date.now() }));
  await t.mutation(internal.accountDeletion.finalizeAccount, { userId, pageSize });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe('the grace window', () => {
  test('requesting deletion changes nothing but the stamp — the account still works', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');

    const { scheduledFor } = await user.as.mutation(api.accountDeletion.requestDeletion, {});
    const profile = await t.run((ctx) => ctx.db.get(user.id));

    expect(profile?.status).toBe('active'); // NOT 'deleted' — status is the security gate
    expect(profile?.displayName).toBe('leaver');
    expect(profile?.deletionRequestedAt).toBeDefined();
    expect(scheduledFor).toBe((profile?.deletionRequestedAt ?? 0) + DELETION_GRACE_MS);
    // The whole point of the window: they can still call authenticated functions, which is how they
    // get back in to cancel.
    expect(await user.as.query(api.profiles.current, {})).not.toBeNull();
  });

  test('asking twice does not restart the clock', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');

    const first = await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: T0 - 5 * 24 * 3600_000 }));
    const second = await user.as.mutation(api.accountDeletion.requestDeletion, {});

    expect(second.scheduledFor).toBeLessThan(first.scheduledFor);
  });

  test('cancelling clears the stamp', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await user.as.mutation(api.accountDeletion.requestDeletion, {});

    expect(await user.as.mutation(api.accountDeletion.cancelDeletion, {})).toEqual({
      cancelled: true,
    });
    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.deletionRequestedAt).toBeUndefined();
    // Idempotent: cancelling twice is not an error.
    expect(await user.as.mutation(api.accountDeletion.cancelDeletion, {})).toEqual({
      cancelled: false,
    });
  });

  test('the sweep only finalizes accounts past the window', async () => {
    const t = harness();
    const fresh = await seedUser(t, 'fresh');
    const due = await seedUser(t, 'due');
    await t.run(async (ctx) => {
      await ctx.db.patch(fresh.id, { deletionRequestedAt: Date.now() });
      await ctx.db.patch(due.id, { deletionRequestedAt: Date.now() - DELETION_GRACE_MS - 1000 });
    });

    const result = await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    expect(result).toMatchObject({ due: 1, started: 1 });
  });

  /**
   * The bug this suite exists for, caught only by running the cron against dev.
   *
   * A Convex index on an *optional* field is **not sparse**: rows without the field are in it, and
   * `undefined` sorts before every number. So `lte('deletionRequestedAt', cutoff)` matched every
   * profile that had never asked to be deleted, and the first real tick reported `due: 2, started: 2`
   * on a deployment where nobody had requested anything. Only `finalizeAccount`'s re-check of the
   * stamp stopped it from scrubbing both accounts.
   *
   * Both guards are asserted here — the range bound *and* the per-account re-check — because the
   * failure mode is "delete every user", which is not a place to depend on one of them.
   */
  test('the sweep never picks up an account that never asked (the undefined-sorts-first trap)', async () => {
    const t = harness();
    const untouched = await seedUser(t, 'never_asked');
    await seedUser(t, 'also_never_asked');

    const result = await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    expect(result).toEqual({ due: 0, started: 0, skipped: 0 });

    // And the second guard, independently: even handed the id directly, finalize declines.
    const direct = await t.mutation(internal.accountDeletion.finalizeAccount, {
      userId: untouched.id,
    });
    expect(direct).toEqual({ stopped: 'cancelled' });
    const profile = await t.run((ctx) => ctx.db.get(untouched.id));
    expect(profile?.status).toBe('active');
    expect(profile?.displayName).toBe('never_asked');
  });

  test('cancelling mid-flight stops the job before anything irreversible happens', async () => {
    const t = harness();
    const user = await seedUser(t, 'waverer');
    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: T0 }));

    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: undefined }));
    const result = await t.mutation(internal.accountDeletion.finalizeAccount, { userId: user.id });

    expect(result).toEqual({ stopped: 'cancelled' });
    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.status).toBe('active');
    expect(profile?.displayName).toBe('waverer');
  });
});

describe('the tombstone', () => {
  test('scrubs every PII field and keeps the row', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile).not.toBeNull();
    expect(profile?.status).toBe('deleted');
    expect(profile?.deletedAt).toBeDefined();
    expect(profile?.deletionRequestedAt).toBeUndefined();
    expect(profile?.displayName).toBe(DELETED_DISPLAY_NAME);
    expect(profile?.username).toBe(deletedUsername(user.id));
    expect(profile?.clerkUserId).toBe(deletedClerkUserId(user.id));
    expect(profile?.homeCoord).toBeUndefined();
    expect(profile?.homeTownLabel).toBeUndefined();
    expect(profile?.bio).toBeUndefined();
    expect(profile?.profileImageUrl).toBeUndefined();
    expect(profile?.outerRadiusMeters).toBeUndefined();
  });

  /**
   * The landmine this feature turns on. `by_clerk_user_id` and `by_username` are both read with
   * `.unique()`, which throws on more than one match — so a shared 'deleted' sentinel would work for
   * the first deleted account and break sign-in for the entire app on the second.
   */
  test('a SECOND deleted account does not break authentication', async () => {
    const t = harness();
    const first = await seedUser(t, 'first');
    const second = await seedUser(t, 'second');
    await finalize(t, first.id);
    await finalize(t, second.id);

    const rows = await t.run((ctx) => ctx.db.query('profiles').collect());
    expect(new Set(rows.map((r) => r.clerkUserId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.username)).size).toBe(2);

    // The actual failure mode: a live user signing in walks by_clerk_user_id with .unique().
    const live = await seedUser(t, 'still_here');
    expect(await live.as.query(api.profiles.current, {})).not.toBeNull();
  });

  test('a tombstone cannot call authenticated functions', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    // The Clerk subject is scrubbed, so the old identity resolves to nothing at all.
    expect(await user.as.query(api.profiles.current, {})).toBeNull();
  });

  /**
   * The reason `lib/authorView` exists. A tombstone is a profile row that still has its
   * `reputationPoints`, so every hand-rolled copy of the author shape happily derived a trust ring for
   * someone with no account — and `publicByIds` had been fixed by hand while the feed and the comment
   * thread hadn't. A deleted skater ringed as "trusted" on a card and unringed on their profile is the
   * kind of inconsistency nobody files and everybody sees.
   */
  test('every surface renders the tombstone identically — name, no ring, flagged deleted', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');
    const bodyId = await seedBody(t);
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    await user.as.mutation(api.comments.create, { reportId, body: 'Still good.' });
    // Enough points that a live author would definitely carry a ring — so "no ring" is a real
    // assertion rather than an artifact of a fresh account scoring null anyway.
    await t.run((ctx) => ctx.db.patch(user.id, { reputationPoints: 500 }));

    await finalize(t, user.id);

    const feed = await viewer.as.query(api.reports.listFeed, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    const thread = await viewer.as.query(api.comments.listByReport, { reportId });
    const byIds = await viewer.as.query(api.profiles.publicByIds, { profileIds: [user.id] });

    const surfaces = [feed.page[0]?.author, thread[0]?.comment?.author, byIds[user.id]];
    for (const author of surfaces) {
      expect(author?.displayName).toBe(DELETED_DISPLAY_NAME);
      expect(author?.trustClass ?? null).toBeNull();
      expect(author?.deleted).toBe(true);
    }
  });

  test('publicByIds renders a tombstone without a linkable handle or a trust ring', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    const map = await t.query(api.profiles.publicByIds, { profileIds: [user.id] });
    expect(map[user.id]?.displayName).toBe(DELETED_DISPLAY_NAME);
    expect(map[user.id]?.deleted).toBe(true);
    expect(map[user.id]?.trustClass).toBeNull();
    expect(map[user.id]?.profileImageUrl).toBeUndefined();
  });
});

describe('bucket 1 — erase (private artifacts)', () => {
  test('deletes tokens, notifications, favorites, queue rows and blocks in both directions', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const other = await seedUser(t, 'other');
    const bodyId = await seedBody(t);

    const reportId = (await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: other.id,
        waterBodyId: bodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        hazardIdsCreated: [],
        moderationStatus: 'visible' as const,
        createdAt: T0,
        updatedAt: T0,
      }),
    )) as Id<'reports'>;

    await t.run(async (ctx) => {
      await ctx.db.insert('activityConnections', {
        userId: user.id,
        provider: 'strava' as const,
        externalUserId: 'athlete-1',
        accessToken: 'secret',
        refreshToken: 'secret',
        scopes: ['activity:write'],
        connectedAt: T0,
      });
      await ctx.db.insert('notifications', {
        userId: user.id,
        type: 'favorite_report' as const,
        payload: {},
        createdAt: T0,
      });
      await ctx.db.insert('notificationQueue', {
        userId: user.id,
        waterBodyId: bodyId,
        kind: 'digest' as const,
        type: 'nearby_report_digest' as const,
        coalesceKey: `${user.id}:${bodyId}:digest`,
        latestReportId: reportId,
        count: 1,
        flushAfter: T0,
        createdAt: T0,
      });
      await ctx.db.insert('waterBodyFavorites', {
        userId: user.id,
        waterBodyId: bodyId,
        createdAt: T0,
      });
      await ctx.db.insert('blocks', { blockerId: user.id, blockedId: other.id, createdAt: T0 });
      await ctx.db.insert('blocks', { blockerId: other.id, blockedId: user.id, createdAt: T0 });
      await ctx.db.insert('supportTickets', {
        userId: user.id,
        clerkUserId: 'leaver',
        category: 'account' as const,
        body: 'my real name is …',
        status: 'open' as const,
        createdAt: T0,
      });
    });

    await finalize(t, user.id);

    const counts = await t.run(async (ctx) => ({
      connections: (await ctx.db.query('activityConnections').collect()).length,
      notifications: (await ctx.db.query('notifications').collect()).length,
      queue: (await ctx.db.query('notificationQueue').collect()).length,
      favorites: (await ctx.db.query('waterBodyFavorites').collect()).length,
      blocks: (await ctx.db.query('blocks').collect()).length,
      tickets: (await ctx.db.query('supportTickets').collect()).length,
    }));
    expect(counts).toEqual({
      connections: 0,
      notifications: 0,
      queue: 0,
      favorites: 0,
      blocks: 0, // both directions — a block against a tombstone would filter forever
      tickets: 0,
    });
  });

  /**
   * An unattached photo whose blob won't go (PR #29 review). The row has to stay — it's the only
   * pointer the orphan cron could ever find those bytes by — but it must stop being a record *of a
   * person*, and the field that matters is `coord`: a photo taken at home, placed on the map, is the
   * home coordinate D62 goes out of its way to erase everywhere else.
   */
  test('a photo that cannot be reclaimed keeps its pointer and loses its identity', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const stuck = await t.run(async (ctx) => {
      const thumbStorageId = await ctx.storage.store(new Blob(['thumb']));
      return ctx.db.insert('photos', {
        storageId: 'not-a-storage-id', // storage refuses to resolve it — the reclaim can't succeed
        thumbStorageId,
        uploaderId: user.id,
        caption: 'the pond behind my house',
        takenAt: T0,
        coord: { lat: 44.5, lng: -73.2 },
        placeOnMap: true,
        createdAt: T0,
      });
    });

    await finalize(t, user.id);

    const row = await t.run((ctx) => ctx.db.get(stuck));
    expect(row).not.toBeNull(); // kept: nothing else can name that blob
    expect(row?.storageId).toBe('not-a-storage-id');
    expect(row?.caption).toBeUndefined();
    expect(row?.takenAt).toBeUndefined();
    expect(row?.coord).toBeUndefined();
    expect(row?.placeOnMap).toBe(false);
  });
});

describe('bucket 2 — anonymize (the public ice record)', () => {
  test('reports and comments survive intact, now authored by the tombstone', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);

    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      notes: 'Glass from shore to shore.',
    });
    await user.as.mutation(api.comments.create, { reportId, body: 'Still good this morning.' });

    await finalize(t, user.id);

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report).not.toBeNull();
    expect(report?.notes).toBe('Glass from shore to shore.');
    expect(report?.authorId).toBe(user.id); // the pointer stands; it just names nobody now
    const comments = await t.run((ctx) => ctx.db.query('comments').collect());
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe('Still good this morning.');
  });
});

describe('bucket 3 — keep, severed from identity (D62)', () => {
  const trackPath = {
    type: 'LineString' as const,
    coordinates: Array.from({ length: 20 }, (_, i) => [0.2 + i * 0.03, 0.5]) as number[][],
  };

  async function seedTrack(user: SeededUser, key: string) {
    return user.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: key,
      path: trackPath,
      startTime: T0 - 3600_000,
      endTime: T0,
      elapsedSeconds: 3600,
    });
  }

  test('a published track is KEPT and keeps drawing on the aggregate map', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');
    const bodyId = await seedBody(t);
    const activityId = await seedTrack(user, 'published');
    await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });

    await finalize(t, user.id);

    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity).not.toBeNull();
    expect(activity?.path).toBeDefined();
    // Severed from the person: the provider handle no longer points at a real external activity.
    expect(activity?.providerActivityId.startsWith('severed:')).toBe(true);
    expect(activity?.photoUrls).toBeUndefined();

    // The contribution the founder asked to preserve: it still draws.
    const { tracks } = await viewer.as.query(api.gpsActivities.listTracksForBody, {
      waterBodyId: bodyId,
    });
    expect(tracks).toHaveLength(1);
  });

  test('an UNPUBLISHED recording is erased — it was never shared', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await seedBody(t);
    const activityId = await seedTrack(user, 'private');

    await finalize(t, user.id);

    expect(await t.run((ctx) => ctx.db.get(activityId))).toBeNull();
  });

  test('a track whose report was hidden by a moderator is erased, not kept', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);
    const activityId = await seedTrack(user, 'hidden');
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' as const }));

    await finalize(t, user.id);

    // Publish-is-consent (D58 gate 1): a hidden report is not a published one.
    expect(await t.run((ctx) => ctx.db.get(activityId))).toBeNull();
  });

  /**
   * The continuation path, forced with a tiny page size.
   *
   * This is the stage machine's real hazard, and it's silent: a stage that keeps some of what it reads
   * can't just re-`take()` the first page (it would loop on the same kept rows forever), and one that
   * paginates has to actually resume from its cursor or a heavy account's deletion stops partway
   * through — reporting success while leaving private rows behind. Five tracks over pages of two
   * exercises both, at a size a test can afford.
   */
  test('a stage that spans several pages finishes all of them', async () => {
    const t = harness();
    const user = await seedUser(t, 'prolific');
    const bodyId = await seedBody(t);

    // Two published (kept + severed), three unpublished (erased) — so the page boundaries fall across
    // a mix of both outcomes rather than a run of one.
    const publishedIds: Id<'gpsActivities'>[] = [];
    for (let i = 0; i < 5; i++) {
      const activityId = await seedTrack(user, `paged-${i}`);
      if (i < 2) {
        await user.as.mutation(api.reports.create, {
          waterBodyId: bodyId,
          activityId,
          skateEndTime: T0 + i,
          iceTypes: ['black_ice' as const],
          surfaceTags: [],
        });
        publishedIds.push(activityId);
      }
    }

    await finalizePaged(t, user.id, 2);

    const remaining = await t.run((ctx) => ctx.db.query('gpsActivities').collect());
    expect(remaining).toHaveLength(2);
    expect(new Set(remaining.map((a) => a._id))).toEqual(new Set(publishedIds));
    // Every survivor severed — not just the ones that happened to land on the first page.
    for (const a of remaining) expect(a.providerActivityId.startsWith('severed:')).toBe(true);
    // And the machine still reached its last stage.
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('deleted');
  });

  /**
   * The prohibition in D62, as a test. Setting `excludeTracksFromAggregate` during finalize would look
   * like the careful privacy choice and would silently delete the contribution the whole
   * keep-but-sever bucket exists to preserve — with no error and nothing in the diff to notice.
   */
  test('finalize does NOT set excludeTracksFromAggregate', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.excludeTracksFromAggregate).toBeUndefined();
  });

  test('a user who HAD opted out stays opted out — their choice survives them', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await t.run((ctx) => ctx.db.patch(user.id, { excludeTracksFromAggregate: true }));
    await finalize(t, user.id);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.excludeTracksFromAggregate).toBe(true);
  });
});
