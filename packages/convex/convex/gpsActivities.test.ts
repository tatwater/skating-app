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

const ADULT_DOB = Date.UTC(1990, 0, 1);
const MINOR_DOB = Date.UTC(2015, 0, 1);
const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  overrides: { dateOfBirth?: number; role?: 'member' | 'moderator' | 'admin' } = {},
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

/**
 * A square lake spanning lat/lng 0..1. The geospatial component is registered, and the body is
 * `isLarge` so the resolver's tier-2 index lookup finds it without depending on centroid indexing
 * inside the test harness.
 */
async function seedBody(
  t: ReturnType<typeof convexTest>,
  overrides: { name?: string; offset?: number } = {},
) {
  const o = overrides.offset ?? 0;
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: overrides.name ?? 'Shelburne Pond',
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [o, o],
            [o, o + 1],
            [o + 1, o + 1],
            [o + 1, o],
            [o, o],
          ],
        ],
      },
      bbox: { minLat: o, minLng: o, maxLat: o + 1, maxLng: o + 1 },
      centroid: { lat: o + 0.5, lng: o + 0.5 },
      isLarge: true,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

/** A believable recorded path across the seeded lake. */
function trackPath(offset = 0) {
  return {
    type: 'LineString' as const,
    coordinates: Array.from({ length: 20 }, (_, i) => [
      offset + 0.2 + i * 0.03,
      offset + 0.5,
    ]) as number[][],
  };
}

function ingestArgs(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'session-1',
    path: trackPath(),
    startTime: T0,
    endTime: T0 + 45 * 60_000,
    elapsedSeconds: 2400,
    ...over,
  };
}

describe('gpsActivities.ingestTrack', () => {
  test('stores a native track and resolves it to the lake it was skated on (D44)', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);

    const activityId = await user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    const activity = await t.run((ctx) => ctx.db.get(activityId));

    expect(activity?.provider).toBe('native');
    expect(activity?.providerActivityId).toBe('session-1');
    expect(activity?.sportType).toBe('IceSkate');
    expect(activity?.waterBodyId).toBe(bodyId);
    expect(activity?.promptState).toBe('pending');
    expect(activity?.linkedReportId).toBeUndefined();
    // A single-body skate stores no `waterBodyIds` array — it would be noise on every ordinary row.
    expect(activity?.waterBodyIds).toBeUndefined();
  });

  test('is idempotent on the session key — a re-flushed skate returns the original row', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedBody(t);

    const first = await user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    const second = await user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    expect(second).toBe(first);

    const all = await t.run((ctx) => ctx.db.query('gpsActivities').collect());
    expect(all).toHaveLength(1);
  });

  test("another user's replay of the same key is rejected, not silently handed the track", async () => {
    const t = harness();
    const owner = await seedUser(t, 'owner');
    const other = await seedUser(t, 'other');
    await seedBody(t);

    await owner.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    await expect(other.as.mutation(api.gpsActivities.ingestTrack, ingestArgs())).rejects.toThrow(
      /Idempotency key conflict/,
    );
  });

  test('a track matching NO known body still ingests — that is the D14 new-water case, not an error', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedBody(t); // lake at 0..1; the track below is far away

    const activityId = await user.as.mutation(
      api.gpsActivities.ingestTrack,
      ingestArgs({ path: trackPath(40) }),
    );
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity).not.toBeNull();
    expect(activity?.waterBodyId).toBeUndefined();
  });

  test('a minor may record for themselves — the recorder is not a publishing surface (D41/D58)', async () => {
    const t = harness();
    const minor = await seedUser(t, 'teen', { dateOfBirth: MINOR_DOB });
    await seedBody(t);

    const activityId = await minor.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    // It exists, it's theirs, and it is linked to no report — so it can never reach the aggregate.
    expect(activity?.userId).toBe(minor.id);
    expect(activity?.linkedReportId).toBeUndefined();
  });

  test('rejects geometry that is not a LineString, and a track that ends before it starts', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedBody(t);

    await expect(
      user.as.mutation(
        api.gpsActivities.ingestTrack,
        ingestArgs({ path: { type: 'Point', coordinates: [0.5, 0.5] } }),
      ),
    ).rejects.toThrow(/LineString/);
    await expect(
      user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs({ endTime: T0 - 1000 })),
    ).rejects.toThrow(/ends before it starts/);
    await expect(
      user.as.mutation(
        api.gpsActivities.ingestTrack,
        ingestArgs({ path: { type: 'LineString', coordinates: [[0.5, 0.5]] } }),
      ),
    ).rejects.toThrow(/too few points/);
  });

  test('a stale client-supplied body hint is re-resolved rather than trusted', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const realBody = await seedBody(t);
    // A body the device cached that has since been removed — `isListed` is false, so the hint is
    // dropped and the track re-resolves from its own geometry.
    const removedBody = await seedBody(t, { name: 'Removed Pond', offset: 10 });
    await t.run((ctx) => ctx.db.patch(removedBody, { removedAt: Date.now() }));

    const activityId = await user.as.mutation(
      api.gpsActivities.ingestTrack,
      ingestArgs({ waterBodyId: removedBody }),
    );
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.waterBodyId).toBe(realBody);
  });

  test('requires a signed-in user', async () => {
    const t = harness();
    await seedBody(t);
    await expect(t.mutation(api.gpsActivities.ingestTrack, ingestArgs())).rejects.toThrow();
  });
});

describe('linking a track to a report', () => {
  const reportArgs = (waterBodyId: Id<'waterBodies'>, activityId: Id<'gpsActivities'>) => ({
    waterBodyId,
    activityId,
    skateEndTime: T0 + 45 * 60_000,
    skateStartTime: T0,
    iceTypes: ['black_ice' as const],
    surfaceTags: [],
  });

  test('reports.create back-links both sides in one transaction and flips source to activity', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const activityId = await user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());

    const reportId = await user.as.mutation(api.reports.create, reportArgs(bodyId, activityId));

    const report = await t.run((ctx) => ctx.db.get(reportId));
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(report?.source).toBe('activity');
    expect(report?.activityId).toBe(activityId);
    expect(activity?.linkedReportId).toBe(reportId);
    // Linking is what "converted" means — the report prompt is answered.
    expect(activity?.promptState).toBe('converted');
  });

  test("a user cannot attach someone else's skate to their report", async () => {
    const t = harness();
    const owner = await seedUser(t, 'owner');
    const thief = await seedUser(t, 'thief');
    const bodyId = await seedBody(t);
    const activityId = await owner.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());

    await expect(
      thief.as.mutation(api.reports.create, reportArgs(bodyId, activityId)),
    ).rejects.toThrow(/Not your activity/);
  });

  test('a skate cannot be attached to two different reports', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const activityId = await user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());

    await user.as.mutation(api.reports.create, reportArgs(bodyId, activityId));
    await expect(
      user.as.mutation(api.reports.create, reportArgs(bodyId, activityId)),
    ).rejects.toThrow(/already attached/);
  });

  test('a report without a track is still perfectly valid (D24) and stays source: native', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.source).toBe('native');
    expect(report?.activityId).toBeUndefined();
  });
});

describe('gpsActivities.getForReport (the report-detail path render)', () => {
  test('returns the linked path to any viewer — publishing the report is the consent (D58)', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const stranger = await seedUser(t, 'stranger');
    const bodyId = await seedBody(t);
    const activityId = await author.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });

    const view = await stranger.as.query(api.gpsActivities.getForReport, { reportId });
    expect(view?.path.type).toBe('LineString');
    expect(view?.path.coordinates.length).toBeGreaterThan(1);
    expect(view?.startTime).toBe(T0);
  });

  test('returns null for a report with no track', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    expect(await user.as.query(api.gpsActivities.getForReport, { reportId })).toBeNull();
  });

  test('a moderation-hidden report does not leak its path to strangers, but the author still sees it', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const stranger = await seedUser(t, 'stranger');
    const bodyId = await seedBody(t);
    const activityId = await author.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' as const }));

    expect(await stranger.as.query(api.gpsActivities.getForReport, { reportId })).toBeNull();
    expect(await author.as.query(api.gpsActivities.getForReport, { reportId })).not.toBeNull();
  });
});

describe('gpsActivities.listMine (owner-scoped by construction)', () => {
  test('returns only the signed-in user’s own skates', async () => {
    const t = harness();
    const me = await seedUser(t, 'me');
    const them = await seedUser(t, 'them');
    await seedBody(t);
    await me.as.mutation(api.gpsActivities.ingestTrack, ingestArgs({ idempotencyKey: 'mine' }));
    await them.as.mutation(api.gpsActivities.ingestTrack, ingestArgs({ idempotencyKey: 'theirs' }));

    const mine = await me.as.query(api.gpsActivities.listMine, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]?.waterBodyName).toBe('Shelburne Pond');
  });

  test('returns nothing when signed out', async () => {
    const t = harness();
    expect(await t.query(api.gpsActivities.listMine, {})).toEqual([]);
  });
});

describe('gpsActivities.setPromptState', () => {
  test('the owner can advance the prompt lifecycle; a stranger cannot touch it', async () => {
    const t = harness();
    const owner = await seedUser(t, 'owner');
    const stranger = await seedUser(t, 'stranger');
    await seedBody(t);
    const activityId = await owner.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());

    await owner.as.mutation(api.gpsActivities.setPromptState, {
      activityId,
      promptState: 'dismissed',
    });
    expect(await t.run((ctx) => ctx.db.get(activityId))).toMatchObject({
      promptState: 'dismissed',
    });

    await expect(
      stranger.as.mutation(api.gpsActivities.setPromptState, {
        activityId,
        promptState: 'converted',
      }),
    ).rejects.toThrow(/Not your activity/);
  });
});

describe('gpsActivities.listTracksForBody — the D58 privacy chain', () => {
  /** Record a skate, file a report on it, and return both ids. */
  async function skateAndReport(
    user: {
      id: Id<'profiles'>;
      as: ReturnType<typeof convexTest>['withIdentity'] extends (...a: never[]) => infer R
        ? R
        : never;
    },
    bodyId: Id<'waterBodies'>,
    over: { key?: string; showPutIn?: boolean; skateEndTime?: number } = {},
  ) {
    const activityId = await user.as.mutation(
      api.gpsActivities.ingestTrack,
      ingestArgs({ idempotencyKey: over.key ?? 'session-1' }),
    );
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      // Defaults to "just now" so the freshness assertions read a live value — T0 is a fixed
      // January instant, which is genuinely months stale and correctly renders at the floor.
      skateEndTime: over.skateEndTime ?? Date.now() - 60_000,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      ...(over.showPutIn !== undefined ? { showPutIn: over.showPutIn } : {}),
    });
    return { activityId, reportId };
  }

  test('a single public track renders — there is deliberately NO contributor-count gate (D58)', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    await skateAndReport(user, bodyId);

    const { tracks, truncated } = await t.query(api.gpsActivities.listTracksForBody, {
      waterBodyId: bodyId,
    });
    expect(tracks).toHaveLength(1);
    expect(truncated).toBe(0);
    expect(tracks[0]?.path.type).toBe('LineString');
    // Freshly skated ⇒ near-full opacity, and never above 1.
    expect(tracks[0]?.opacity).toBeGreaterThan(0.5);
    expect(tracks[0]?.opacity).toBeLessThanOrEqual(1);
  });

  test('an UNLINKED recording never aggregates — publishing the report IS the consent', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    await user.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());

    const { tracks } = await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId });
    expect(tracks).toEqual([]);
  });

  test("a minor's recording can never reach the layer — by construction, not by an age check", async () => {
    const t = harness();
    const minor = await seedUser(t, 'teen', { dateOfBirth: MINOR_DOB });
    const bodyId = await seedBody(t);
    await minor.as.mutation(api.gpsActivities.ingestTrack, ingestArgs());
    // The minor cannot file the report the track would need to aggregate (D41)...
    await expect(
      minor.as.mutation(api.reports.create, {
        waterBodyId: bodyId,
        skateEndTime: T0,
        iceTypes: ['black_ice' as const],
        surfaceTags: [],
      }),
    ).rejects.toThrow(/under 18/i);
    // ...so the layer is empty without anything having to check an age.
    const { tracks } = await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId });
    expect(tracks).toEqual([]);
  });

  test('a hidden report takes its track off the map with it', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const { reportId } = await skateAndReport(user, bodyId);

    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' as const }));
    const { tracks } = await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId });
    expect(tracks).toEqual([]);
  });

  test('withholding the put-in clips both ends — a skate from a back yard cannot point at the house', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const { activityId } = await skateAndReport(user, bodyId, { showPutIn: false });

    const { tracks } = await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.clipped).toBe(true);

    const stored = await t.run((ctx) => ctx.db.get(activityId));
    const full = (stored?.path as { coordinates: number[][] } | undefined)?.coordinates ?? [];
    const drawn = tracks[0]?.path.coordinates as number[][];
    expect(drawn.length).toBeLessThan(full.length);
    expect(drawn[0]).not.toEqual(full[0]);
    expect(drawn.at(-1)).not.toEqual(full.at(-1));
  });

  test('sharing the put-in leaves the path whole — it is a declared public access point', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const { activityId } = await skateAndReport(user, bodyId, { showPutIn: true });

    const { tracks } = await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId });
    expect(tracks[0]?.clipped).toBe(false);
    const stored = await t.run((ctx) => ctx.db.get(activityId));
    const full = (stored?.path as { coordinates: number[][] } | undefined)?.coordinates ?? [];
    expect(tracks[0]?.path.coordinates).toHaveLength(full.length);
  });

  test('the global opt-out drops a person’s tracks RETROACTIVELY (D58)', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    await skateAndReport(user, bodyId);

    expect(
      (await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId })).tracks,
    ).toHaveLength(1);

    // Flipping the person-level preference removes the track they already contributed — which is the
    // whole reason the flag lives on the profile rather than on each activity.
    await t.run((ctx) => ctx.db.patch(user.id, { excludeTracksFromAggregate: true }));
    expect(
      (await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId })).tracks,
    ).toEqual([]);
  });

  test('opacity fades with the linked report’s age, and never below the floor', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    const { reportId } = await skateAndReport(user, bodyId);

    const fresh = (await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId }))
      .tracks[0]?.opacity as number;

    // Age the report a year. The path fades — but it is still drawn, because an empty stretch of
    // lake would read as "nobody found a problem here" (D3).
    await t.run((ctx) =>
      ctx.db.patch(reportId, { skateEndTime: Date.now() - 365 * 24 * 3_600_000 }),
    );
    const stale = (await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId }))
      .tracks[0]?.opacity as number;

    expect(stale).toBeLessThan(fresh);
    expect(stale).toBeGreaterThan(0);
  });

  test('returns nothing for an unlisted body', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const bodyId = await seedBody(t);
    await skateAndReport(user, bodyId);
    await t.run((ctx) => ctx.db.patch(bodyId, { removedAt: Date.now() }));

    const { tracks } = await t.query(api.gpsActivities.listTracksForBody, { waterBodyId: bodyId });
    expect(tracks).toEqual([]);
  });
});
