import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import {
  actorCoalesceKey,
  mergeTriggers,
  type NotificationTrigger,
  settleTrigger,
  triggerCount,
} from './notificationQueue';
import { parsePayload } from './notificationResolve';

const p = (s: string) => s as Id<'profiles'>;
const r = (s: string) => s as Id<'reports'>;
const c = (s: string) => s as Id<'comments'>;

describe('mergeTriggers / triggerCount (D169 coalescing)', () => {
  test('id lists union without duplicates; scalar state is overwritten by the newer trigger', () => {
    const thumb: NotificationTrigger = {
      kind: 'thumb',
      targetType: 'report',
      targetId: 'r',
      actorIds: [p('a')],
    };
    const merged = mergeTriggers(thumb, { ...thumb, actorIds: [p('a'), p('b')] });
    expect(merged).toEqual({ ...thumb, actorIds: [p('a'), p('b')] });
    expect(triggerCount(merged)).toBe(2);

    const corr: NotificationTrigger = {
      kind: 'corroboration',
      reportId: r('r'),
      byReportIds: [r('x')],
    };
    expect(triggerCount(mergeTriggers(corr, { ...corr, byReportIds: [r('y')] }))).toBe(2);

    const comment: NotificationTrigger = {
      kind: 'comment',
      reportId: r('r'),
      commentIds: [c('1')],
      actorIds: [p('a')],
    };
    const reply: NotificationTrigger = {
      kind: 'reply',
      reportId: r('r'),
      commentIds: [c('2')],
      actorIds: [p('b')],
    };
    expect(mergeTriggers(comment, reply)).toEqual(reply); // different kinds never merge
    expect(triggerCount(mergeTriggers(comment, { ...comment, commentIds: [c('2')] }))).toBe(2);

    const answered: NotificationTrigger = {
      kind: 'bounty_answered',
      bountyId: 'b' as Id<'bounties'>,
      waterBodyId: 'w' as Id<'waterBodies'>,
      reportIds: [r('1')],
    };
    expect(triggerCount(mergeTriggers(answered, { ...answered, reportIds: [r('2')] }))).toBe(2);

    const phase: NotificationTrigger = {
      kind: 'hazard_lifecycle',
      hazardId: 'h' as Id<'hazards'>,
      phase: 'confirmed',
      actorIds: [p('v')],
    };
    expect(mergeTriggers(phase, { ...phase, phase: 'archived' })).toEqual({
      ...phase,
      phase: 'archived',
    });
    expect(triggerCount(phase)).toBe(1);
    const flag: NotificationTrigger = {
      kind: 'flag_resolved',
      flagId: 'f' as Id<'contentFlags'>,
      resolution: 'actioned',
    };
    expect(mergeTriggers(flag, { ...flag, resolution: 'dismissed' })).toEqual({
      ...flag,
      resolution: 'dismissed',
    });
    const activity: NotificationTrigger = {
      kind: 'activity',
      activityId: 'a' as Id<'gpsActivities'>,
    };
    expect(triggerCount(activity)).toBe(1);
    const request: NotificationTrigger = {
      kind: 'bounty_request',
      bountyId: 'b' as Id<'bounties'>,
      waterBodyId: 'w' as Id<'waterBodies'>,
      requesterId: p('q'),
    };
    expect(triggerCount(request)).toBe(1);
  });

  test('the coalesce key is (recipient, target, kind)', () => {
    expect(actorCoalesceKey(p('u'), 't', 'thumb')).toBe('u:t:thumb');
  });
});

describe('parsePayload (the typed boundary over notifications.payload)', () => {
  test('rejects shapes this code never wrote, per type', () => {
    expect(parsePayload('report_rated', null)).toBeNull();
    expect(
      parsePayload('report_rated', { kind: 'thumb', targetType: 'photo', targetId: 'x' }),
    ).toBeNull();
    expect(parsePayload('report_rated', { kind: 'corroboration' })).toBeNull();
    expect(
      parsePayload('report_rated', { targetType: 'report', targetId: 'x', raterId: 'y' }),
    ).toBeNull();
    expect(parsePayload('report_commented', {})).toBeNull();
    expect(parsePayload('hazard_confirmation', { hazardId: 'h', phase: 'gone' })).toBeNull();
    expect(parsePayload('content_flag_resolved', { resolution: 'maybe' })).toBeNull();
    expect(parsePayload('bounty_request', { bountyId: 'b' })).toBeNull();
    expect(parsePayload('bounty_answered', { waterBodyId: 'w' })).toBeNull();
    expect(parsePayload('favorite_report', { waterBodyId: 'w' })).toBeNull();
    expect(parsePayload('nearby_report_digest', { bodies: 'nope' })).toBeNull();
    expect(parsePayload('nearby_report_digest', { bodies: [{ waterBodyId: 'w' }] })).toBeNull();
    expect(parsePayload('activity_detected', { activityId: 'a' })).toBeNull();
  });

  test('accepts each written shape and defaults the count and the digest total', () => {
    expect(
      parsePayload('report_rated', {
        kind: 'thumb',
        targetType: 'hazard',
        targetId: 'h',
        actorIds: ['a'],
      }),
    ).toEqual({
      kind: 'thumb',
      targetType: 'hazard',
      targetId: 'h',
      actorIds: ['a'],
      count: 1,
    });
    expect(
      parsePayload('report_rated', { kind: 'corroboration', reportId: 'r', count: 3 }),
    ).toEqual({
      kind: 'corroboration',
      reportId: 'r',
      count: 3,
    });
    expect(parsePayload('report_commented', { reportId: 'r', reply: true })).toMatchObject({
      reply: true,
      actorIds: [],
    });
    expect(parsePayload('hazard_confirmation', { hazardId: 'h', phase: 'archived' })).toEqual({
      kind: 'hazard_lifecycle',
      hazardId: 'h',
      phase: 'archived',
    });
    expect(parsePayload('content_flag_resolved', { resolution: 'dismissed' })).toEqual({
      kind: 'flag_resolved',
      resolution: 'dismissed',
    });
    expect(parsePayload('bounty_request', { bountyId: 'b', waterBodyId: 'w' })).toEqual({
      kind: 'bounty_request',
      bountyId: 'b',
      waterBodyId: 'w',
    });
    expect(
      parsePayload('bounty_answered', { bountyId: 'b', waterBodyId: 'w', count: 2 }),
    ).toMatchObject({ count: 2 });
    expect(parsePayload('great_report_nearby', { waterBodyId: 'w', reportId: 'r' })).toEqual({
      kind: 'report_bucket',
      waterBodyId: 'w',
      reportId: 'r',
      count: 1,
    });
    expect(
      parsePayload('nearby_report_digest', {
        bodies: [
          { waterBodyId: 'w', reportId: 'r', count: 2 },
          { waterBodyId: 'x', reportId: 'y' },
          { bad: true },
        ],
      }),
    ).toEqual({
      kind: 'digest',
      bodies: [
        { waterBodyId: 'w', reportId: 'r', count: 2 },
        { waterBodyId: 'x', reportId: 'y', count: 1 },
      ],
      totalCount: 3,
    });
    expect(
      parsePayload('activity_detected', { activityId: 'a', startTime: 5, waterBodyId: 'w' }),
    ).toEqual({
      kind: 'activity',
      activityId: 'a',
      waterBodyId: 'w',
      startTime: 5,
    });
  });
});

// ── The "still true?" table, negatives (A08 §5.2 / D169) ─────────────────────────────────────────────
//
// The producer tests pin the common drops — a retracted thumb, a removed comment, a canceled
// bounty, a converted skate. These are the rest of the table, driven through `settleTrigger`
// directly: every "deliver only if" clause has a row here whose answer is `null`, so a future
// reader who loosens one finds a red test rather than a phantom notification.

const modules = import.meta.glob('../**/*.*s');

const PREFS = {
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
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id: id as Id<'profiles'>, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId: 'osm/1',
        osmId: 'osm/1',
        name: 'Lake Morey',
        type: 'lakePond',
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
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0];
  if (!body) throw new Error('seed failed');
  return body._id;
}

const NOBODY: ReadonlySet<string> = new Set();

describe('settleTrigger — every "deliver only if" clause has a drop', () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const other = await seedUser(t, 'other');
    const waterBodyId = await seedBody(t);
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.UTC(2026, 0, 10),
    } as never);
    const settle = (trigger: NotificationTrigger, blocked: ReadonlySet<string> = NOBODY) =>
      t.run((ctx) => settleTrigger(ctx, trigger, blocked));
    return { t, author, other, waterBodyId, reportId, settle };
  }

  test('thumb: a hidden target, an unparseable id, and a rater blocked inside the window all drop', async () => {
    const { t, other, reportId, settle } = await setup();
    await other.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    const trigger: NotificationTrigger = {
      kind: 'thumb',
      targetType: 'report',
      targetId: reportId,
      actorIds: [other.id],
    };
    expect(await settle(trigger)).toMatchObject({ kind: 'thumb', count: 1 });
    expect(await settle(trigger, new Set([other.id]))).toBeNull();
    expect(await settle({ ...trigger, targetId: 'not-an-id' })).toBeNull();
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    expect(await settle(trigger)).toBeNull();
  });

  test('thumb on a hazard: the hazard table is the one consulted', async () => {
    const { t, author, other, waterBodyId, settle } = await setup();
    const hazardId = await author.as.mutation(api.hazards.create, {
      waterBodyId,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [0.5, 0.5] },
      radiusMeters: 40,
    });
    await other.as.mutation(api.ratings.rate, {
      targetType: 'hazard',
      targetId: hazardId,
      verdict: 'helpful',
    });
    const trigger: NotificationTrigger = {
      kind: 'thumb',
      targetType: 'hazard',
      targetId: hazardId,
      actorIds: [other.id],
    };
    expect(await settle(trigger)).toMatchObject({ kind: 'thumb', targetType: 'hazard' });
    await t.run((ctx) => ctx.db.patch(hazardId, { moderationStatus: 'hidden' }));
    expect(await settle(trigger)).toBeNull();
  });

  test('corroboration: your own report hidden drops it, as does every corroborator being blocked', async () => {
    const { t, other, waterBodyId, reportId, settle } = await setup();
    const byReportId = await other.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.UTC(2026, 0, 10),
    } as never);
    const trigger: NotificationTrigger = {
      kind: 'corroboration',
      reportId,
      byReportIds: [byReportId],
    };
    expect(await settle(trigger)).toMatchObject({ kind: 'corroboration', count: 1 });
    expect(await settle(trigger, new Set([other.id]))).toBeNull();
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    expect(await settle(trigger)).toBeNull();
  });

  test('comment: the report hidden drops it even though the comment stands', async () => {
    const { t, other, reportId, settle } = await setup();
    const commentId = await other.as.mutation(api.comments.create, { reportId, body: 'hi' });
    const trigger: NotificationTrigger = {
      kind: 'comment',
      reportId,
      commentIds: [commentId],
      actorIds: [other.id],
    };
    expect(await settle(trigger)).toMatchObject({ kind: 'comment', reply: false, count: 1 });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    expect(await settle(trigger)).toBeNull();
  });

  test('hazard lifecycle: hidden, merged away, or moved to another phase since — all quiet', async () => {
    const { t, author, other, waterBodyId, settle } = await setup();
    const hazardId = await author.as.mutation(api.hazards.create, {
      waterBodyId,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [0.5, 0.5] },
      radiusMeters: 40,
    });
    const trigger: NotificationTrigger = {
      kind: 'hazard_lifecycle',
      hazardId,
      phase: 'provisional',
      actorIds: [other.id],
    };
    // Freshly created: a single sighting, so the `provisional` phase is what's true right now.
    expect(await settle(trigger)).toMatchObject({ kind: 'hazard_lifecycle', phase: 'provisional' });
    // The window's news was a different phase than the pin is in now.
    expect(await settle({ ...trigger, phase: 'confirmed' })).toBeNull();
    // A merge tombstones the pin; the survivor's lifecycle is another row's story.
    await t.run((ctx) => ctx.db.patch(hazardId, { mergedIntoHazardId: hazardId }));
    expect(await settle(trigger)).toBeNull();
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { mergedIntoHazardId: undefined, moderationStatus: 'hidden' }),
    );
    expect(await settle(trigger)).toBeNull();
  });

  test('flag resolved: a verdict that changed since — or a flag that vanished — drops', async () => {
    const { t, other, reportId, settle } = await setup();
    const flagId = await other.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });
    await t.run((ctx) => ctx.db.patch(flagId, { status: 'actioned' }));
    const trigger: NotificationTrigger = { kind: 'flag_resolved', flagId, resolution: 'actioned' };
    expect(await settle(trigger)).toMatchObject({ kind: 'flag_resolved', resolution: 'actioned' });
    expect(await settle({ ...trigger, resolution: 'dismissed' })).toBeNull();
    await t.run((ctx) => ctx.db.delete(flagId));
    expect(await settle(trigger)).toBeNull();
  });

  test('bounty answered: every answering report hidden or from a blocked author drops it', async () => {
    const { t, other, waterBodyId, reportId, settle } = await setup();
    const bountyId = await other.as.action(api.bounties.create, { waterBodyId });
    const trigger: NotificationTrigger = {
      kind: 'bounty_answered',
      bountyId,
      waterBodyId,
      reportIds: [reportId],
    };
    expect(await settle(trigger)).toMatchObject({ kind: 'bounty_answered', count: 1 });
    // `reportId` is the author's; block them from the requester's side.
    const authorId = (await t.run((ctx) => ctx.db.get(reportId)))?.authorId ?? '';
    expect(await settle(trigger, new Set([authorId]))).toBeNull();
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    expect(await settle(trigger)).toBeNull();
  });

  test('activity: a skate that vanished, was linked, or was dismissed is not nudged', async () => {
    const { t, author, waterBodyId, reportId, settle } = await setup();
    const activityId = await author.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'session-1',
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, i) => [0.2 + i * 0.03, 0.5]),
      },
      startTime: Date.UTC(2026, 0, 15, 14, 0),
      endTime: Date.UTC(2026, 0, 15, 14, 45),
      elapsedSeconds: 2400,
    });
    const trigger: NotificationTrigger = { kind: 'activity', activityId };
    expect(await settle(trigger)).toMatchObject({ kind: 'activity', waterBodyId });
    await t.run((ctx) => ctx.db.patch(activityId, { promptState: 'dismissed' }));
    expect(await settle(trigger)).toBeNull();
    await t.run((ctx) =>
      ctx.db.patch(activityId, { promptState: 'pending', linkedReportId: reportId }),
    );
    expect(await settle(trigger)).toBeNull();
    await t.run((ctx) => ctx.db.delete(activityId));
    expect(await settle(trigger)).toBeNull();

    // A skate the recorder couldn't place on any lake still nudges — with no lake to name.
    const unplaced = await author.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'session-2',
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, i) => [40.2 + i * 0.03, 40.5]),
      },
      startTime: Date.UTC(2026, 0, 16, 14, 0),
      endTime: Date.UTC(2026, 0, 16, 14, 45),
      elapsedSeconds: 2400,
    });
    const payload = await settle({ kind: 'activity', activityId: unplaced });
    expect(payload).toMatchObject({ kind: 'activity', activityId: unplaced });
    expect(payload).not.toHaveProperty('waterBodyId');
  });
});
