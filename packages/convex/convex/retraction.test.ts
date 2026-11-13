/**
 * Retraction until decided (D248, founder ruling 2026-11-13): "If a user reports an access issue,
 * asks for a body to be included in the corpus, reports a body as not accessible to the public, or
 * any of those kinds of actions, they should be able to retract them at any time (up until the
 * action is determined/taken)." And the access-alert ruling of the same day: the author's own "it's
 * open" resolves their alert, pinned or not; their "it never existed" is refused once a moderator
 * pinned it.
 */
import { RETRACT_REFUSALS, WITHDRAWN_ERASE_MS } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { MY_ALERTS_SCAN } from './accessAlerts';
import { WITHDRAWN_BY_ASKER } from './corpusRequests';
import schema from './schema';

/** The whole record, every page of it, as the People page will read it. */
async function readRecord(
  as: ReturnType<ReturnType<typeof convexTest>['withIdentity']>,
  userId: Id<'profiles'>,
) {
  type Verdict = FunctionReturnType<typeof api.contentRecord.personVerdicts>['page'][number];
  type Withdrawal = FunctionReturnType<typeof api.contentRecord.personWithdrawals>['page'][number];
  const verdicts: Verdict[] = [];
  for (let cursor: string | null = null; ; ) {
    const page: { page: Verdict[]; isDone: boolean; continueCursor: string } = await as.query(
      api.contentRecord.personVerdicts,
      { userId, cursor },
    );
    verdicts.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  const deleted: Withdrawal[] = [];
  for (const kind of ['post', 'report', 'comment', 'hazard', 'accessAlert'] as const) {
    for (let cursor: string | null = null; ; ) {
      const page: { page: Withdrawal[]; isDone: boolean; continueCursor: string } = await as.query(
        api.contentRecord.personWithdrawals,
        { userId, kind, cursor },
      );
      deleted.push(...page.page);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  deleted.sort((a, b) => b.deletedAt - a.deletedAt);
  return { verdicts, deleted };
}

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
  // Convex's real per-transaction limits, enforced: what passes here fits a deployment.
  const t = convexTest({ schema, modules, transactionLimits: true });
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
      reason: 'The person who reported it said it has cleared, which released the pin',
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

  test("its author's retraction is refused once a moderator ever pinned it, released or not", async () => {
    const { t, skater, mod, alertId, pin } = await alertSetup();
    await pin();
    const retract = () => skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await expect(retract()).rejects.toThrow(literally(RETRACT_REFUSALS.confirmed));
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: false,
      reason: 'back to the community',
    });
    expect(await get(t, alertId)).toMatchObject({ status: 'active' });
    // A moderator confirmed it existed; "never existed" is no longer the author's to say.
    await expect(retract()).rejects.toThrow(literally(RETRACT_REFUSALS.confirmed));
    // "It's over" always is.
    await skater.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' });
    expect(await get(t, alertId)).toMatchObject({ status: 'resolved' });
    // Closed now: nothing to retract, and no "mark it open" advice on a claim already over.
    await expect(retract()).rejects.toThrow(literally(RETRACT_REFUSALS.closed));
  });

  test('a pin a moderator undid does not count; a closed alert has nothing to retract', async () => {
    const { t, skater, mod, alertId, pin } = await alertSetup();
    await pin();
    const pinRow = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).find(
      (r) => r.action === 'pin_access_alert',
    );
    if (!pinRow) throw new Error('expected the pin row');
    await mod.as.mutation(api.undo.run, { actionId: pinRow._id, reason: 'pinned the wrong one' });
    expect(await get(t, alertId)).toMatchObject({ status: 'active' });
    await t.run((ctx) => ctx.db.patch(alertId, { status: 'expired' }));
    await expect(
      skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId }),
    ).rejects.toThrow(literally(RETRACT_REFUSALS.closed));
    await t.run((ctx) => ctx.db.patch(alertId, { status: 'active' }));
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    expect(await get(t, alertId)).toMatchObject({ status: 'retracted' });
  });

  test('the shared reads are the same for every viewer; the author learns which are theirs apart', async () => {
    const { t, skater, other, waterBodyId, alertId } = await alertSetup();
    // The lake page's shared reads carry nothing about who is looking.
    for (const read of [
      (as: typeof skater.as) => as.query(api.accessAlerts.listForBody, { waterBodyId }),
      (as: typeof skater.as) => as.query(api.accessPoints.accessForBody, { waterBodyId }),
    ]) {
      expect(await read(skater.as)).toEqual(await read(other.as));
      expect(await read(skater.as)).toEqual(await read(t as unknown as typeof skater.as));
    }
    expect(await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([
      alertId,
    ]);
    expect(await other.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([]);
    expect(await t.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([]);
    // An alert on a lot counts on every lake the lot serves, as the shared read shows it there.
    const otherLake = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Second Pond',
        searchText: 'Second Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [2, 2],
              [2, 3],
              [3, 3],
              [3, 2],
              [2, 2],
            ],
          ],
        },
        bbox: { minLat: 2, minLng: 2, maxLat: 3, maxLng: 3 },
        centroid: { lat: 2.5, lng: 2.5 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    const lotId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('parkingAreas', {
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        amenities: [],
        createdAt: Date.now(),
      });
      for (const body of [waterBodyId, otherLake]) {
        await ctx.db.insert('parkingAreaBodies', {
          parkingAreaId: id,
          waterBodyId: body,
          inferred: false,
          createdAt: Date.now(),
        });
      }
      return id;
    });
    const lotAlert = await skater.as.mutation(api.accessAlerts.create, {
      targetType: 'parking_area',
      parkingAreaId: lotId,
      reason: 'not_plowed',
    });
    expect(
      await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId: otherLake }),
    ).toEqual([lotAlert]);
    // A moderator narrowing the lot to the lakes it really serves takes it off the other one.
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query('parkingAreaBodies')
        .withIndex('by_parking_area_water_body', (q) =>
          q.eq('parkingAreaId', lotId).eq('waterBodyId', otherLake),
        )
        .unique();
      if (link) await ctx.db.delete(link._id);
    });
    expect(
      await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId: otherLake }),
    ).toEqual([]);
    // Lapsed but not yet swept is not live, so it is not listed.
    await t.run((ctx) => ctx.db.patch(lotAlert, { expiresAt: Date.now() - 1 }));
    expect(await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([
      alertId,
    ]);
    // Closed alerts are not offered a vote, so they are not listed.
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    expect(await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([]);
  });

  test('the own-alerts read names an alert only where the shared read shows it', async () => {
    const { t, skater, waterBodyId, alertId } = await alertSetup();
    const lotId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('parkingAreas', {
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        amenities: [],
        createdAt: Date.now(),
      });
      await ctx.db.insert('parkingAreaBodies', {
        parkingAreaId: id,
        waterBodyId,
        inferred: false,
        createdAt: Date.now(),
      });
      return id;
    });
    const lotAlert = await skater.as.mutation(api.accessAlerts.create, {
      targetType: 'parking_area',
      parkingAreaId: lotId,
      reason: 'not_plowed',
    });
    expect((await get(t, lotAlert))?.waterBodyId).toBe(waterBodyId);
    // The lot unlinked from the lake its column still names, and the launch moved off it: the
    // shared read shows neither there, so neither is the author's there.
    const elsewhere = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Third Pond',
        searchText: 'Third Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [4, 4],
              [4, 5],
              [5, 5],
              [5, 4],
              [4, 4],
            ],
          ],
        },
        bbox: { minLat: 4, minLng: 4, maxLat: 5, maxLng: 5 },
        centroid: { lat: 4.5, lng: 4.5 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    await t.run(async (ctx) => {
      for (const link of await ctx.db
        .query('parkingAreaBodies')
        .withIndex('by_parking_area_water_body', (q) => q.eq('parkingAreaId', lotId))
        .collect()) {
        await ctx.db.delete(link._id);
      }
      const alert = await ctx.db.get(alertId);
      if (alert?.putInId === undefined) throw new Error('expected a launch alert');
      await ctx.db.patch(alert.putInId, { waterBodyId: elsewhere });
    });
    for (const body of [waterBodyId, elsewhere]) {
      expect(await t.query(api.accessAlerts.listForBody, { waterBodyId: body })).toEqual([]);
      expect(
        await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId: body }),
      ).toEqual([]);
    }
  });

  test("a pin stays its author's to open, however many alerts they have filed since", async () => {
    const { t, skater, other, waterBodyId, alertId, pin } = await alertSetup();
    await pin();
    // Settled rows are never deleted, so a busy reporter's history outgrows any one scan of it.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(alertId);
      if (!row) throw new Error('the alert is gone');
      const { _id, _creationTime, pinnedByUserId, ...fields } = row;
      for (let i = 0; i <= MY_ALERTS_SCAN; i += 1) {
        await ctx.db.insert('accessAlerts', { ...fields, status: 'resolved' as const });
      }
    });
    expect(await skater.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([
      alertId,
    ]);
    expect(await other.as.query(api.accessAlerts.myAlertIdsForBody, { waterBodyId })).toEqual([]);
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

  test("a moderator's retraction of an alert its author retracted keeps it as evidence, until overturned", async () => {
    const { t, skater, other, mod, alertId } = await alertSetup();
    // Another skater's vote on it, and the author's own.
    await other.as.mutation(api.accessAlerts.vote, {
      accessAlertId: alertId,
      verdict: 'still_blocked',
    });
    await skater.as.mutation(api.accessAlerts.vote, {
      accessAlertId: alertId,
      verdict: 'still_blocked',
    });
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await mod.as.mutation(api.accessAlerts.retract, {
      accessAlertId: alertId,
      reason: 'third bogus closure from this account',
    });
    // The row is still the author's withdrawal, now held by the verdict, not counting.
    const alert = await get(t, alertId);
    expect(alert).toMatchObject({ status: 'retracted', retractedByUserId: skater.id });
    expect(alert?.eraseAt).toBeUndefined();
    const record = await readRecord(mod.as, skater.id);
    expect(record.verdicts).toEqual([
      expect.objectContaining({
        targetType: 'accessAlert',
        targetId: alertId,
        kind: 'retracted',
        reason: 'third bogus closure from this account',
        authorDeletedAt: T0,
      }),
    ]);
    expect(record.deleted.map((d) => d.targetId)).toEqual([alertId]);
    // The backfill rebuilds exactly that verdict from the history.
    const before = (await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).map(
      (v) => `${v.actionId} ${v.kind} ${v.standing}`,
    );
    await t.run(async (ctx) => {
      for (const v of await ctx.db.query('contentVerdicts').collect()) await ctx.db.delete(v._id);
    });
    await t.mutation(internal.contentRecord.backfillVerdicts, { clocks: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      (await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).map(
        (v) => `${v.actionId} ${v.kind} ${v.standing}`,
      ),
    ).toEqual(before);

    vi.setSystemTime(T0 + 45 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await get(t, alertId)).not.toBeNull();
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'accessAlert',
      targetId: alertId,
      reason: 'it was one mistake, not a pattern',
    });
    // Its 30 days ran out while held: due from the overturn.
    expect((await get(t, alertId))?.eraseAt).toBe(T0 + 45 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await get(t, alertId)).toBeNull();
    // The author's own vote went with it; the other skater's stays theirs.
    const votes = await t.run((ctx) => ctx.db.query('accessAlertVotes').collect());
    expect(votes.map((v) => v.userId)).toEqual([other.id]);
    await expect(
      other.as.mutation(api.accessAlerts.vote, { accessAlertId: alertId, verdict: 'open' }),
    ).rejects.toThrow(/not found/);
    // The author's export holds nothing of it.
    const bundle = await t.query(internal.dataExport.collect, { userId: skater.id });
    expect(bundle.accessAlerts).toEqual([]);
    expect(bundle.accessAlertVotes).toEqual([]);
  });

  test('an alert its author retracted is erased 30 days on; an open flag holds it', async () => {
    const { t, skater, other, mod, alertId } = await alertSetup();
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    const flagId = await other.as.mutation(api.contentFlags.flag, {
      targetType: 'accessAlert',
      targetId: alertId,
      reason: 'spam',
    });
    vi.setSystemTime(T0 + 31 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await get(t, alertId)).not.toBeNull();
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'dismissed',
      reason: 'nothing to it',
    });
    await t.mutation(internal.erasure.eraseDue, {});
    expect(await get(t, alertId)).toBeNull();
    const history = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
      (r) => r.targetId === alertId && r.action === 'erase',
    );
    expect(history).toHaveLength(1);
    // The flag that was about it stays in the queue's history, its target shown as gone.
    expect(await get(t, flagId)).not.toBeNull();
  });

  test('overturning on an alert needs the alert lever, and an alert its author withdrew', async () => {
    const { other, mod, alertId } = await alertSetup();
    const overturn = (as: typeof mod.as) =>
      as.mutation(api.moderation.overturnVerdict, {
        targetType: 'accessAlert',
        targetId: alertId,
        reason: 'x',
      });
    await expect(overturn(other.as)).rejects.toThrow();
    await expect(overturn(mod.as)).rejects.toThrow(/still has this up/);
  });

  test("a moderator's bare retract after the author's own records nothing; the author's list skips a moderator's", async () => {
    const { t, skater, mod, alertId } = await alertSetup();
    const putInId = await t.run(async (ctx) => (await ctx.db.get(alertId))?.putInId);
    if (putInId === undefined) throw new Error('expected a launch alert');
    const theirs = await skater.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      putInId,
      reason: 'gate_locked',
    });
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: theirs, reason: 'bogus' });
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    // The lake page's button sends no reason: a stale click on a claim its author just withdrew is
    // not a verdict on them, and the clock runs on.
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: '   ' });
    expect(await get(t, alertId)).toMatchObject({
      retractedByUserId: skater.id,
      eraseAt: T0 + WITHDRAWN_ERASE_MS,
    });
    expect(await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).toEqual([]);
    const record = await readRecord(mod.as, skater.id);
    expect(record.verdicts).toEqual([]);
    // Only their own withdrawal; the moderator's retraction of their other alert is not theirs.
    expect(record.deleted.map((d) => d.targetId)).toEqual([alertId]);
  });

  test("an author's repeat retraction of an old, timeless one gives it its clock from now", async () => {
    const { t, skater, alertId } = await alertSetup();
    // As the old writer left it: retracted by its author, no `retractedAt`.
    await t.run((ctx) =>
      ctx.db.patch(alertId, { status: 'retracted', retractedByUserId: skater.id }),
    );
    vi.setSystemTime(T0 + 5 * DAY);
    await skater.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    expect(await get(t, alertId)).toMatchObject({
      retractedAt: T0 + 5 * DAY,
      eraseAt: T0 + 5 * DAY + WITHDRAWN_ERASE_MS,
    });
  });

  test("a moderator's verdict on an old, timeless retraction is overturnable before the backfill gives it its clock", async () => {
    const { t, skater, mod, alertId } = await alertSetup();
    // As the old writer left it: retracted by its author, no `retractedAt`, no clock.
    await t.run((ctx) =>
      ctx.db.patch(alertId, {
        status: 'retracted',
        retractedByUserId: skater.id,
        expiresAt: undefined,
      }),
    );
    await mod.as.mutation(api.accessAlerts.retract, {
      accessAlertId: alertId,
      reason: 'a pattern of bogus closures',
    });
    expect(await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).toEqual([
      expect.objectContaining({ targetId: alertId, kind: 'retracted', standing: true }),
    ]);
    // The row is still its author's withdrawal, as they left it.
    expect(await get(t, alertId)).toMatchObject({ retractedByUserId: skater.id });
    expect((await get(t, alertId))?.retractedAt).toBeUndefined();
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'accessAlert',
      targetId: alertId,
      reason: 'one mistake, not a pattern',
    });
    expect(await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).toEqual([
      expect.objectContaining({ targetId: alertId, standing: false }),
    ]);
    // The backfill gives it its 30 days from its own run.
    vi.setSystemTime(T0 + 5 * DAY);
    await t.mutation(internal.erasure.backfillClocks, { kind: 'accessAlert' });
    expect(await get(t, alertId)).toMatchObject({
      retractedAt: T0 + 5 * DAY,
      eraseAt: T0 + 5 * DAY + WITHDRAWN_ERASE_MS,
    });
  });

  test('a moderator retracting their own alert does so by the author rule', async () => {
    const { t, mod, waterBodyId } = await alertSetup();
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const own = await mod.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      putInId,
      reason: 'not_plowed',
    });
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: own,
      official: true,
      reason: 'confirmed by the town',
    });
    await expect(
      mod.as.mutation(api.accessAlerts.retract, { accessAlertId: own, reason: 'x' }),
    ).rejects.toThrow(literally(RETRACT_REFUSALS.confirmed));
    expect(await get(t, own)).toMatchObject({ status: 'official' });
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
