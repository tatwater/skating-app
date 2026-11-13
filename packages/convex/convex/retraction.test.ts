/**
 * Retraction until decided (D248, founder ruling 2026-11-13): "If a user reports an access issue,
 * asks for a body to be included in the corpus, reports a body as not accessible to the public, or
 * any of those kinds of actions, they should be able to retract them at any time (up until the
 * action is determined/taken)." And the access-alert ruling of the same day: the author's own "it's
 * open" resolves their alert, pinned or not; their "it never existed" is refused once a moderator
 * pinned it.
 */
import { RETRACT_REFUSALS, WITHDRAWN_ERASE_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { WITHDRAWN_BY_ASKER } from './corpusRequests';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2027, 0, 14, 12);
const DAY = 24 * 60 * 60 * 1000;
type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' = 'member') {
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

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const t = convexTest(schema, modules);
  const skater = await seedUser(t, 'skater');
  const other = await seedUser(t, 'other');
  const mod = await seedUser(t, 'mod', 'moderator');
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
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
  return { t, skater, other, mod, waterBodyId };
}

const get = (t: T, id: string) =>
  t.run((ctx) => ctx.db.get(id as never)) as Promise<Record<string, unknown> | null>;
const literally = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

afterEach(() => vi.useRealTimers());

describe('a request to a moderator', () => {
  async function seedRequest(
    t: T,
    requesterId: Id<'profiles'>,
    waterBodyId: Id<'waterBodies'>,
    status: 'open' | 'approved' | 'declined' = 'open',
  ) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'activate',
        status,
        requesterId,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId,
        note: 'we skate it every winter',
        createdAt: Date.now(),
      }),
    );
  }

  test('is retracted by its asker while open, leaves the queue, and no moderator decides it after', async () => {
    const { t, skater, mod, waterBodyId } = await setup();
    const requestId = await seedRequest(t, skater.id, waterBodyId);
    await skater.as.mutation(api.corpusRequests.retract, { requestId });
    await skater.as.mutation(api.corpusRequests.retract, { requestId }); // twice is once
    expect(await get(t, requestId)).toMatchObject({ status: 'retracted', retractedAt: T0 });
    expect(await get(t, requestId)).toMatchObject({ eraseAt: T0 + WITHDRAWN_ERASE_MS });
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(JSON.stringify(queue)).not.toContain(requestId);
    expect(await t.query(api.corpusRequests.openCountsForBody, { waterBodyId })).toEqual({});
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      literally(WITHDRAWN_BY_ASKER),
    );
    await expect(
      mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'no' }),
    ).rejects.toThrow(literally(WITHDRAWN_BY_ASKER));
    // The asker reads that they withdrew it; a moderator mid-review reads it left the queue.
    const mine = await skater.as.query(api.corpusRequests.listMineForBody, { waterBodyId });
    expect(mine).toEqual([expect.objectContaining({ status: 'retracted' })]);
    const review = await mod.as.query(api.corpusRequests.reviewState, { requestIds: [requestId] });
    expect(review.requests).toEqual([{ requestId, status: 'gone' }]);
    // Erased 30 days on.
    vi.setSystemTime(T0 + 31 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await get(t, requestId)).toBeNull();
  });

  test('is refused once decided, and to anyone but its asker', async () => {
    const { t, skater, other, waterBodyId } = await setup();
    for (const status of ['approved', 'declined'] as const) {
      const requestId = await seedRequest(t, skater.id, waterBodyId, status);
      await expect(skater.as.mutation(api.corpusRequests.retract, { requestId })).rejects.toThrow(
        literally(RETRACT_REFUSALS.decided),
      );
    }
    const requestId = await seedRequest(t, skater.id, waterBodyId);
    await expect(other.as.mutation(api.corpusRequests.retract, { requestId })).rejects.toThrow(
      literally(RETRACT_REFUSALS.notYours),
    );
  });
});

describe('a flag', () => {
  test('is retracted while open or picked up, leaves the queue, and stops holding content', async () => {
    const { t, skater, other, mod, waterBodyId } = await setup();
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason: 'no_public_access',
      note: 'posted no trespassing',
    });
    expect(await skater.as.query(api.contentFlags.myAccessFlags, {})).toEqual([waterBodyId]);
    await skater.as.mutation(api.contentFlags.retract, { flagId });
    expect(await get(t, flagId)).toMatchObject({ status: 'retracted', retractedAt: T0 });
    expect(await skater.as.query(api.contentFlags.myAccessFlags, {})).toEqual([]);
    const lanes = await mod.as.query(api.moderation.listFlags, {});
    expect(lanes.accessReports).toEqual([]);
    await expect(
      mod.as.mutation(api.moderation.resolveFlag, { flagId, resolution: 'dismissed', reason: 'x' }),
    ).rejects.toThrow(/withdrew/);

    // A flag holding a deleted comment back from erasure lets go when it is retracted.
    const reportId = await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: other.id,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    const commentId = await other.as.mutation(api.comments.create, { reportId, body: 'rude' });
    const held = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'comment',
      targetId: commentId,
      reason: 'harassment',
    });
    await other.as.mutation(api.comments.remove, { commentId });
    expect((await get(t, commentId))?.eraseAt).toBeUndefined();
    await t.run((ctx) => ctx.db.patch(held, { status: 'reviewing' }));
    await skater.as.mutation(api.contentFlags.retract, { flagId: held });
    expect((await get(t, commentId))?.eraseAt).toBe(T0 + WITHDRAWN_ERASE_MS);
  });

  test("is refused once decided, when it is someone else's, and when the system filed or shares it", async () => {
    const { t, skater, other, mod, waterBodyId } = await setup();
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason: 'no_public_access',
    });
    await expect(other.as.mutation(api.contentFlags.retract, { flagId })).rejects.toThrow(
      literally(RETRACT_REFUSALS.notYours),
    );
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'actioned',
      reason: 'confirmed',
    });
    await expect(skater.as.mutation(api.contentFlags.retract, { flagId })).rejects.toThrow(
      literally(RETRACT_REFUSALS.decided),
    );
    const auto = await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: skater.id,
        targetType: 'waterbody',
        targetId: waterBodyId,
        reason: 'auto_low_quality',
        status: 'open',
        origin: 'auto',
        createdAt: T0,
      }),
    );
    await expect(skater.as.mutation(api.contentFlags.retract, { flagId: auto })).rejects.toThrow(
      literally(RETRACT_REFUSALS.notYours),
    );
    await t.run((ctx) => ctx.db.patch(auto, { origin: 'user', occurrences: 3 }));
    await expect(skater.as.mutation(api.contentFlags.retract, { flagId: auto })).rejects.toThrow(
      literally(RETRACT_REFUSALS.sharedFlag),
    );
  });
});

describe('an access alert', () => {
  async function alertSetup() {
    const base = await setup();
    const putInId = await base.t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: base.waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const alertId = await base.skater.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      putInId,
      reason: 'not_plowed',
    });
    const pin = () =>
      base.mod.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: alertId,
        official: true,
        reason: 'the town confirmed',
      });
    return { ...base, alertId, pin };
  }

  test('its author\'s "it\'s open" resolves a pinned alert, releases the pin, and says so in its history', async () => {
    const { t, skater, mod, waterBodyId, alertId, pin } = await alertSetup();
    await pin();
    await skater.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' });
    const alert = await get(t, alertId);
    expect(alert).toMatchObject({ status: 'resolved' });
    expect(alert?.pinnedByUserId).toBeUndefined();
    // Resolved is not a warning and not an all-clear: it simply leaves the lake's live alerts.
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId })).toEqual([]);
    const history = await mod.as.query(api.moderation.listActions, {
      targetType: 'accessAlert',
      targetId: alertId,
    });
    expect(history[0]).toMatchObject({
      action: 'author_resolve_access_alert',
      reason: 'The person who reported it marked it open again',
      actor: expect.objectContaining({ userId: skater.id }),
    });
    // The moderator can pin it again if it still stands.
    await pin();
    expect(await get(t, alertId)).toMatchObject({ status: 'official' });
  });

  test('a pin placed after the author\'s "it\'s open" holds until the author says it again', async () => {
    const { t, skater, other, alertId, pin } = await alertSetup();
    await skater.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' });
    expect(await get(t, alertId)).toMatchObject({ status: 'resolved' });
    await pin();
    // Anyone else's vote leaves the pin where the moderator put it.
    await other.as.mutation(api.accessAlerts.vote, {
      accessAlertId: alertId,
      verdict: 'still_blocked',
    });
    expect(await get(t, alertId)).toMatchObject({ status: 'official' });
    // The author's own word, said again, releases it.
    await skater.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' });
    expect(await get(t, alertId)).toMatchObject({ status: 'resolved' });
  });

  test('anyone else\'s "it\'s open" on a pinned alert still does nothing', async () => {
    const { t, other, alertId, pin } = await alertSetup();
    await pin();
    await other.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' });
    expect(await get(t, alertId)).toMatchObject({ status: 'official' });
  });

  test("its author's retraction: allowed while live, refused once pinned, a no-op once closed", async () => {
    const { t, skater, alertId, pin } = await alertSetup();
    await pin();
    await expect(
      skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId }),
    ).rejects.toThrow(literally(RETRACT_REFUSALS.decided));
    // Resolving is always theirs, and after it there is nothing left to retract.
    await skater.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' });
    await expect(
      skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId }),
    ).rejects.toThrow(literally(RETRACT_REFUSALS.closed));
    expect(await get(t, alertId)).toMatchObject({ status: 'resolved' });
  });

  test('retracted by its author, it reads as before, starts its clock, and no moderator pins it back', async () => {
    const { t, skater, mod, waterBodyId, alertId } = await alertSetup();
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId }); // no-op
    expect(await get(t, alertId)).toMatchObject({
      status: 'retracted',
      retractedByUserId: skater.id,
      retractedAt: T0,
      eraseAt: T0 + WITHDRAWN_ERASE_MS,
    });
    expect(await t.query(api.accessAlerts.listForBody, { waterBodyId })).toEqual([]);
    await expect(
      mod.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: alertId,
        official: true,
        reason: 'x',
      }),
    ).rejects.toThrow(/retracted/);
    // Nor released back into the community lifecycle.
    await expect(
      mod.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: alertId,
        official: false,
        reason: 'x',
      }),
    ).rejects.toThrow(/retracted/);
    expect(await get(t, alertId)).toMatchObject({ status: 'retracted' });
  });

  test("a moderator's second retraction can't turn the author's final one into a moderator's", async () => {
    const { t, skater, mod, alertId } = await alertSetup();
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'bogus' });
    expect(await get(t, alertId)).toMatchObject({
      retractedByUserId: skater.id,
      eraseAt: T0 + WITHDRAWN_ERASE_MS,
    });
  });

  test("a moderator's own retraction is unchanged, pinned or not, and starts no clock", async () => {
    const { t, mod, alertId, pin } = await alertSetup();
    await pin();
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'bogus' });
    const alert = await get(t, alertId);
    expect(alert).toMatchObject({ status: 'retracted', retractedByUserId: mod.id });
    expect(alert?.eraseAt).toBeUndefined();
  });
});
