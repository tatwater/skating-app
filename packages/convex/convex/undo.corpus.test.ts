/**
 * Undo (D226, B01 §11) for roles, access alerts, approaches, posted rules, known features,
 * recurrence and hazard merges: each verb acted through its real mutation, undone through
 * `api.undo.run`, and the state read back — side effects included.
 */

import { isPubliclyVisible } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

type T = ReturnType<typeof convexTest>;

const NOTIF_PREFS = {
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

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: T) {
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

async function seedPutIn(t: T, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 0.5, lng: 0.001 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: Date.now(),
    }),
  );
}

async function seedLot(t: T, name = 'Town lot') {
  return t.run((ctx) =>
    ctx.db.insert('parkingAreas', {
      coord: { lat: 0.5, lng: -0.0005 },
      name,
      source: 'official' as const,
      status: 'visible' as const,
      amenities: [],
      createdAt: Date.now(),
    }),
  );
}

/** A row written before undo existed — the shape `writeAudit` produces, minus what undo now needs. */
async function seedOldRow(
  t: T,
  actorId: Id<'profiles'>,
  row: {
    action:
      | 'grant_role'
      | 'pin_access_alert'
      | 'unpin_access_alert'
      | 'set_approach_kind'
      | 'set_posted_access'
      | 'unsuppress_recurrence'
      | 'merge_hazards';
    targetType: 'user' | 'accessAlert' | 'putIn' | 'waterbody' | 'hazardRecurrence' | 'hazard';
    targetId: string;
    metadata?: Record<string, unknown>;
  },
) {
  return t.run((ctx) =>
    ctx.db.insert('moderationActions', {
      actorId,
      reason: 'an older action',
      createdAt: Date.now(),
      ...row,
    }),
  );
}

/** The newest audit row on a target. */
async function newestOn(t: T, targetType: string, targetId: string) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}

// ── Roles ─────────────────────────────────────────────────────────────────────────────────────────

describe('undo: roles (D226)', () => {
  test('a grant undoes back to member, asks a reason, and names what it undid', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const user = await seedUser(t, 'u');
    await admin.as.mutation(api.admin.grantRole, {
      userId: user.id,
      role: 'moderator',
      reason: 'runs the Shelburne crew',
    });
    const grant = await newestOn(t, 'user', user.id);

    await expect(admin.as.mutation(api.undo.run, { actionId: grant._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await admin.as.mutation(api.undo.run, { actionId: grant._id, reason: 'wrong person' });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.role).toBe('member');
    const undoRow = await newestOn(t, 'user', user.id);
    expect(undoRow.action).toBe('revoke_role');
    expect(undoRow.undoesActionId).toBe(grant._id);
    expect(undoRow.actorId).toBe(admin.id);
  });

  test('a grant over an earlier role puts that role back; a revoke puts the role back', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const user = await seedUser(t, 'u', 'moderator');
    await admin.as.mutation(api.admin.grantRole, { userId: user.id, role: 'admin', reason: 'x' });
    const grant = await newestOn(t, 'user', user.id);
    await admin.as.mutation(api.undo.run, { actionId: grant._id, reason: 'too much' });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.role).toBe('moderator');

    await admin.as.mutation(api.admin.revokeRole, { userId: user.id, reason: 'stepped back' });
    const revoke = await newestOn(t, 'user', user.id);
    await admin.as.mutation(api.undo.run, { actionId: revoke._id, reason: 'came back' });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.role).toBe('moderator');
    const undoRow = await newestOn(t, 'user', user.id);
    expect(undoRow.action).toBe('grant_role');
    expect(undoRow.undoesActionId).toBe(revoke._id);
  });

  test('a moderator cannot undo a role change', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const mod = await seedUser(t, 'mod', 'moderator');
    const user = await seedUser(t, 'u');
    await admin.as.mutation(api.admin.grantRole, {
      userId: user.id,
      role: 'moderator',
      reason: 'x',
    });
    const grant = await newestOn(t, 'user', user.id);
    await expect(
      mod.as.mutation(api.undo.run, { actionId: grant._id, reason: 'no' }),
    ).rejects.toThrow(/requires admin/i);
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.role).toBe('moderator');
  });

  test('nobody undoes a role change on themselves', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const other = await seedUser(t, 'other');
    await admin.as.mutation(api.admin.grantRole, { userId: other.id, role: 'admin', reason: 'x' });
    const grant = await newestOn(t, 'user', other.id);
    await expect(
      other.as.mutation(api.undo.run, { actionId: grant._id, reason: 'step down' }),
    ).rejects.toThrow(/your own role/i);
    expect((await t.run((ctx) => ctx.db.get(other.id)))?.role).toBe('admin');
    // History doesn't offer it in the first place: the viewer reaches `blocked`.
    const history = await other.as.query(api.moderation.listActions, {
      targetType: 'user',
      targetId: other.id,
    });
    expect(history[0]?.undo).toEqual({
      state: 'unavailable',
      why: expect.stringMatching(/your own role/),
    });
    const forAdmin = await admin.as.query(api.moderation.listActions, {
      targetType: 'user',
      targetId: other.id,
    });
    expect(forAdmin[0]?.undo.state).toBe('available');
  });

  test('a grant recorded before undo, and a revoke of a member, say why they cannot undo', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const user = await seedUser(t, 'u');
    const old = await seedOldRow(t, admin.id, {
      action: 'grant_role',
      targetType: 'user',
      targetId: user.id,
      metadata: { role: 'moderator' },
    });
    await expect(admin.as.mutation(api.undo.run, { actionId: old, reason: 'r' })).rejects.toThrow(
      /before undo existed/i,
    );

    await admin.as.mutation(api.admin.revokeRole, { userId: user.id, reason: 'tidy' });
    const revoke = await newestOn(t, 'user', user.id);
    await expect(
      admin.as.mutation(api.undo.run, { actionId: revoke._id, reason: 'r' }),
    ).rejects.toThrow(/already a member/i);
  });
});

// ── Access alerts ─────────────────────────────────────────────────────────────────────────────────

async function alertSetup() {
  const t = convexTest(schema, modules);
  const waterBodyId = await seedBody(t);
  const putInId = await seedPutIn(t, waterBodyId);
  const author = await seedUser(t, 'author');
  const mod = await seedUser(t, 'mod', 'moderator');
  const alertId = await author.as.mutation(api.accessAlerts.create, {
    targetType: 'put_in',
    reason: 'gate_locked',
    putInId,
  });
  return { t, author, mod, alertId };
}

describe('undo: access alert pins (D226)', () => {
  test('a pin undoes to a live community alert, with no reason asked', async () => {
    const { t, mod, alertId } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'town confirmed',
    });
    const pin = await newestOn(t, 'accessAlert', alertId);
    expect(pin.metadata?.prev).toMatchObject({ status: 'active' });

    await mod.as.mutation(api.undo.run, { actionId: pin._id });
    const alert = await t.run((ctx) => ctx.db.get(alertId));
    expect(alert?.status).toBe('active');
    expect(alert?.pinnedByUserId).toBeUndefined();
    expect(alert?.expiresAt).toBeGreaterThan(Date.now());
    const undoRow = await newestOn(t, 'accessAlert', alertId);
    expect(undoRow.action).toBe('unpin_access_alert');
    expect(undoRow.undoesActionId).toBe(pin._id);
  });

  test('an unpin undoes to pinned, and the undo of that undo releases it again', async () => {
    const { t, mod, alertId } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'town confirmed',
    });
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: false,
      reason: 'gate is open now',
    });
    const unpin = await newestOn(t, 'accessAlert', alertId);
    await mod.as.mutation(api.undo.run, { actionId: unpin._id });
    const alert = await t.run((ctx) => ctx.db.get(alertId));
    expect(alert?.status).toBe('official');
    expect(alert?.expiresAt).toBeUndefined();
    expect(alert?.pinnedByUserId).toBe(mod.id);

    const repin = await newestOn(t, 'accessAlert', alertId);
    expect(repin.undoesActionId).toBe(unpin._id);
    await mod.as.mutation(api.undo.run, { actionId: repin._id });
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('active');
  });

  test('a pin over a lapsed alert cannot be released back to live', async () => {
    const { t, mod, alertId } = await alertSetup();
    await t.run((ctx) => ctx.db.patch(alertId, { status: 'expired' }));
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'still locked',
    });
    const pin = await newestOn(t, 'accessAlert', alertId);
    await expect(mod.as.mutation(api.undo.run, { actionId: pin._id })).rejects.toThrow(/lapsed/);

    // And a live alert whose clock would have run out meanwhile is refused the same way.
    const { t: t2, mod: mod2, alertId: alert2 } = await alertSetup();
    await t2.run((ctx) => ctx.db.patch(alert2, { expiresAt: Date.now() - 1 }));
    await mod2.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alert2,
      official: true,
      reason: 'still locked',
    });
    const pin2 = await newestOn(t2, 'accessAlert', alert2);
    await expect(mod2.as.mutation(api.undo.run, { actionId: pin2._id })).rejects.toThrow(
      /expired by now/,
    );
  });

  test('a pin over a claim the community resolved cannot be released back to live', async () => {
    const { t, mod, alertId } = await alertSetup();
    await t.run((ctx) => ctx.db.patch(alertId, { status: 'resolved' }));
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'still locked',
    });
    const pin = await newestOn(t, 'accessAlert', alertId);
    await expect(mod.as.mutation(api.undo.run, { actionId: pin._id })).rejects.toThrow(
      /had resolved it before the pin/,
    );
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('official');
  });

  test('an unpinned alert its author retracted since is not pinned back', async () => {
    const { t, author, mod, alertId } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'x',
    });
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: false,
      reason: 'y',
    });
    const unpin = await newestOn(t, 'accessAlert', alertId);
    await author.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await expect(mod.as.mutation(api.undo.run, { actionId: unpin._id })).rejects.toThrow(
      /retracted since/,
    );
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('retracted');
  });

  test('an unpinned alert that has expired since is not pinned back', async () => {
    const { t, mod, alertId } = await alertSetup();
    for (const official of [true, false]) {
      await mod.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: alertId,
        official,
        reason: official ? 'x' : 'y',
      });
    }
    const unpin = await newestOn(t, 'accessAlert', alertId);
    // The expiry sweep's write, which leaves no audit row.
    await t.run((ctx) => ctx.db.patch(alertId, { status: 'expired' }));
    await expect(mod.as.mutation(api.undo.run, { actionId: unpin._id })).rejects.toThrow(
      /expired since/,
    );
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('expired');
  });

  test('an unpinned alert the community resolved, or whose clock ran out unswept, is not pinned back', async () => {
    // Neither writes an audit row — votes resolve a claim, and an expiry is a time the sweep has
    // not reached yet — so the undo has to read the claim's live state itself.
    for (const after of [
      { status: 'resolved' as const },
      { expiresAt: Date.now() - 1 }, // still `active` as stored; lapsed by the clock
    ]) {
      const { t, mod, alertId } = await alertSetup();
      for (const official of [true, false]) {
        await mod.as.mutation(api.accessAlerts.setOfficial, {
          accessAlertId: alertId,
          official,
          reason: official ? 'x' : 'y',
        });
      }
      const unpin = await newestOn(t, 'accessAlert', alertId);
      await t.run((ctx) => ctx.db.patch(alertId, after));
      await expect(mod.as.mutation(api.undo.run, { actionId: unpin._id })).rejects.toThrow(
        /resolved by the people who checked it since|expired since/,
      );
      expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).not.toBe('official');
    }
  });

  test('pins and unpins recorded before undo, and an unpin of an unpinned alert, are refused', async () => {
    const { t, mod, alertId } = await alertSetup();
    for (const action of ['pin_access_alert', 'unpin_access_alert'] as const) {
      const old = await seedOldRow(t, mod.id, {
        action,
        targetType: 'accessAlert',
        targetId: alertId,
      });
      await expect(mod.as.mutation(api.undo.run, { actionId: old })).rejects.toThrow(
        /before undo existed/i,
      );
    }
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: false,
      reason: 'restart the clock',
    });
    const unpin = await newestOn(t, 'accessAlert', alertId);
    await expect(mod.as.mutation(api.undo.run, { actionId: unpin._id })).rejects.toThrow(
      /was not pinned/,
    );
  });

  test('a member cannot undo a pin', async () => {
    const { t, author, mod, alertId } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'x',
    });
    const pin = await newestOn(t, 'accessAlert', alertId);
    await expect(author.as.mutation(api.undo.run, { actionId: pin._id })).rejects.toThrow(
      /requires moderator/i,
    );
  });
});

// ── Approaches, parking and posted rules ──────────────────────────────────────────────────────────

describe('undo: approach kind and posted rules (D226)', () => {
  test('an approach kind undoes to the override it replaced, and the lake’s chip follows', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const putInId = await seedPutIn(t, waterBodyId);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      approachKindOverride: 'short_walk',
      reason: 'a path from the road',
    });
    const before = await t.run(async (ctx) => ({
      override: (await ctx.db.get(putInId))?.approachKindOverride,
      accessKind: (await ctx.db.get(waterBodyId))?.accessKind,
    }));
    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      approachKindOverride: 'hike_in',
      reason: 'the road is gated in winter',
    });
    const set = await newestOn(t, 'putIn', putInId);
    expect(set.action).toBe('set_approach_kind');
    expect(set.metadata?.prev).toEqual({ parkingAreaId: null, approachKindOverride: 'short_walk' });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.accessKind).toBe('hike_in');

    await mod.as.mutation(api.undo.run, { actionId: set._id });
    const after = await t.run(async (ctx) => ({
      override: (await ctx.db.get(putInId))?.approachKindOverride,
      accessKind: (await ctx.db.get(waterBodyId))?.accessKind,
    }));
    expect(after).toEqual(before);
    const undoRow = await newestOn(t, 'putIn', putInId);
    expect(undoRow.action).toBe('set_approach_kind');
    expect(undoRow.undoesActionId).toBe(set._id);

    // Undoing that puts `hike_in` back; the first override's own row is long overtaken.
    await mod.as.mutation(api.undo.run, { actionId: undoRow._id });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachKindOverride).toBe('hike_in');
  });

  test('an override set where there was none undoes to none', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const putInId = await seedPutIn(t, waterBodyId);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      approachKindOverride: 'hike_in',
    });
    const set = await newestOn(t, 'putIn', putInId);
    await mod.as.mutation(api.undo.run, { actionId: set._id });
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.approachKindOverride).toBeUndefined();
  });

  test('a change that also moved the parking, or predates undo, is refused', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const putInId = await seedPutIn(t, waterBodyId);
    const lotId = await seedLot(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessPoints.setPutInAccess, {
      putInId,
      parkingAreaId: lotId,
      approachKindOverride: 'hike_in',
    });
    const set = await newestOn(t, 'putIn', putInId);
    await expect(mod.as.mutation(api.undo.run, { actionId: set._id })).rejects.toThrow(/parking/);

    const old = await seedOldRow(t, mod.id, {
      action: 'set_approach_kind',
      targetType: 'putIn',
      targetId: putInId,
      metadata: { approachKindOverride: 'drive_up' },
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: old })).rejects.toThrow(
      /before undo existed/i,
    );
  });

  test('an edit to an official lot records what it replaced, for the Access tab’s undo', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const lotId = await seedLot(t, 'Old name');
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.accessPoints.setOfficialParking, {
      parkingAreaId: lotId,
      coord: { lat: 0.5, lng: -0.001 },
      name: 'New name',
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    const edit = await newestOn(t, 'parkingArea', lotId);
    expect(edit.metadata?.prev).toMatchObject({
      name: 'Old name',
      coord: { lat: 0.5, lng: -0.0005 },
    });

    const fresh = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      coord: { lat: 0.5, lng: -0.002 },
      amenities: [],
      waterBodyIds: [waterBodyId],
    });
    expect((await newestOn(t, 'parkingArea', fresh)).metadata?.prev).toBeNull();
  });

  test('a posted rule undoes to the rule it replaced, then to none', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const target = { type: 'waterbody' as const, id: waterBodyId };

    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target,
      postedAccess: { permitRequired: true },
    });
    const first = await newestOn(t, 'waterbody', waterBodyId);
    await mod.as.mutation(api.postedAccess.setPostedAccess, {
      target,
      postedAccess: { dailyWindow: { kind: 'daylight', offsetMinutes: 30 } },
    });
    const second = await newestOn(t, 'waterbody', waterBodyId);

    await mod.as.mutation(api.undo.run, { actionId: second._id });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.postedAccess).toEqual({
      permitRequired: true,
    });
    const undoRow = await newestOn(t, 'waterbody', waterBodyId);
    expect(undoRow.action).toBe('set_posted_access');
    expect(undoRow.undoesActionId).toBe(second._id);
    expect(undoRow.reason).toMatch(/^Set posted rules.*— Undid set posted access/);

    // The first rule's row was overtaken by the second.
    await expect(mod.as.mutation(api.undo.run, { actionId: first._id })).rejects.toThrow(
      /changed this since/i,
    );
    // Undoing the undo is the second rule again; and undoing a rule set from nothing clears it.
    const clearT = convexTest(schema, modules);
    const body2 = await seedBody(clearT);
    const mod2 = await seedUser(clearT, 'mod', 'moderator');
    await mod2.as.mutation(api.postedAccess.setPostedAccess, {
      target: { type: 'waterbody', id: body2 },
      postedAccess: { permitRequired: true },
    });
    const set = await newestOn(clearT, 'waterbody', body2);
    await mod2.as.mutation(api.undo.run, { actionId: set._id });
    expect((await clearT.run((ctx) => ctx.db.get(body2)))?.postedAccess).toBeUndefined();
  });

  test('a posted rule recorded before undo is refused', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const old = await seedOldRow(t, mod.id, {
      action: 'set_posted_access',
      targetType: 'waterbody',
      targetId: waterBodyId,
      metadata: { postedAccess: { permitRequired: true } },
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: old })).rejects.toThrow(
      /before undo existed/i,
    );
  });
});

// ── Known features and recurrence ─────────────────────────────────────────────────────────────────

const POINT = { type: 'Point' as const, coordinates: [0.5, 0.5] };

async function seedHazardRow(
  t: T,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  firstReportedAt: number,
) {
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type: 'pressure_ridge' as const,
      geometryKind: 'point_radius' as const,
      geometry: POINT,
      radiusMeters: 30,
      bbox: { minLat: 0.4995, minLng: 0.4995, maxLat: 0.5005, maxLng: 0.5005 },
      createdByUserId: authorId,
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt,
      lastConfirmedAt: firstReportedAt,
      confirmCount: 0,
      goneCount: 0,
      createdAt: firstReportedAt,
    }),
  );
}

/** A three-winter ridge cluster, in the shape the recurrence pass writes. */
async function seedCluster(t: T) {
  const waterBodyId = await seedBody(t);
  const author = await seedUser(t, 'author');
  const year = 365 * 86_400_000;
  const now = Date.now();
  const memberHazardIds = [
    await seedHazardRow(t, waterBodyId, author.id, now - 2 * year),
    await seedHazardRow(t, waterBodyId, author.id, now - year),
    await seedHazardRow(t, waterBodyId, author.id, now),
  ];
  const seasonsObserved = [2028, 2029, 2030];
  const recurrenceId = await t.run((ctx) =>
    ctx.db.insert('hazardRecurrence', {
      waterBodyId,
      family: 'ridge' as const,
      geometryKind: 'point_radius' as const,
      geometry: POINT,
      radiusMeters: 30,
      bbox: { minLat: 0.4995, minLng: 0.4995, maxLat: 0.5005, maxLng: 0.5005 },
      memberHazardIds,
      representativeHazardId: memberHazardIds[1] as Id<'hazards'>,
      seasonsObserved,
      windowSeasons: 5,
      firstReportedDayOfSeasonP25: 180,
      firstReportedDayOfSeasonP75: 200,
      distinctAuthorCount: 1,
      priority: 1,
      publiclyVisible: isPubliclyVisible({ family: 'ridge', seasonsObserved }),
      computedAt: now,
      computedForSeason: 2030,
    }),
  );
  return { waterBodyId, memberHazardIds, recurrenceId };
}

describe('undo: known features (D226)', () => {
  test('a promotion undoes by demoting, which frees the source hazard; it asks a reason', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const author = await seedUser(t, 'author');
    const mod = await seedUser(t, 'mod', 'moderator');
    const hazardId = await author.as.mutation(api.hazards.create, {
      waterBodyId,
      type: 'pressure_ridge',
      geometryKind: 'point_radius',
      geometry: POINT,
      radiusMeters: 25,
    });
    const featureId = await mod.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'reforms every winter',
    });
    const promote = await newestOn(t, 'bodyFeature', featureId);
    expect((await t.run((ctx) => ctx.db.get(hazardId)))?.promotedToFeatureId).toBe(featureId);

    await expect(mod.as.mutation(api.undo.run, { actionId: promote._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: promote._id, reason: 'one-off ridge' });
    expect((await t.run((ctx) => ctx.db.get(featureId)))?.active).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(hazardId)))?.promotedToFeatureId).toBeUndefined();
    expect(await mod.as.query(api.bodyFeatures.listForBody, { waterBodyId })).toEqual([]);
    const undoRow = await newestOn(t, 'bodyFeature', featureId);
    expect(undoRow.action).toBe('demote_body_feature');
    expect(undoRow.undoesActionId).toBe(promote._id);

    // The demotion's own undo (reactivate) lands with §3.
    await expect(
      mod.as.mutation(api.undo.run, { actionId: undoRow._id, reason: 'r' }),
    ).rejects.toThrow(/lands with §3/);
  });

  test('a cluster promotion undoes back into the recurrence queue, backlinks cleared', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { memberHazardIds, recurrenceId } = await seedCluster(t);
    const before = await t.run((ctx) => ctx.db.get(recurrenceId));

    const featureId = await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId,
      type: 'recurring_pressure_ridge',
      reason: 'three winters',
    });
    const promote = await newestOn(t, 'bodyFeature', featureId);
    expect(promote.action).toBe('promote_recurrence');

    await mod.as.mutation(api.undo.run, { actionId: promote._id, reason: 'not a pattern yet' });
    const after = await t.run((ctx) => ctx.db.get(recurrenceId));
    expect(after?.promotedToFeatureId).toBeUndefined();
    expect(after?.publiclyVisible).toBe(before?.publiclyVisible);
    for (const id of memberHazardIds) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.promotedToFeatureId).toBeUndefined();
    }
    expect((await t.run((ctx) => ctx.db.get(featureId)))?.active).toBe(false);
    const { page } = await mod.as.query(api.recurrence.listQueue, {
      paginationOpts: { numItems: 10, cursor: null },
      // The seeded cluster is computed for 2030; the queue reads the season it is asked for.
      season: 2030,
    });
    expect(page.map((r) => r._id)).toContain(recurrenceId);
    expect((await newestOn(t, 'bodyFeature', featureId)).undoesActionId).toBe(promote._id);
  });

  test('a member cannot undo a promotion', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const member = await seedUser(t, 'm');
    const { recurrenceId } = await seedCluster(t);
    const featureId = await mod.as.mutation(api.recurrence.promoteFromRecurrence, {
      recurrenceId,
      type: 'recurring_pressure_ridge',
      reason: 'three winters',
    });
    const promote = await newestOn(t, 'bodyFeature', featureId);
    await expect(
      member.as.mutation(api.undo.run, { actionId: promote._id, reason: 'r' }),
    ).rejects.toThrow(/requires moderator/i);
  });
});

describe('undo: recurrence suppression (D226)', () => {
  test('a suppression undoes with no reason; undoing that suppresses again, with one', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { recurrenceId } = await seedCluster(t);
    const before = await t.run((ctx) => ctx.db.get(recurrenceId));

    await mod.as.mutation(api.recurrence.suppress, { recurrenceId, reason: 'a shadow' });
    const suppress = await newestOn(t, 'hazardRecurrence', recurrenceId);
    await mod.as.mutation(api.undo.run, { actionId: suppress._id });
    const after = await t.run((ctx) => ctx.db.get(recurrenceId));
    expect(after?.suppressedAt).toBeUndefined();
    expect(after?.suppressReason).toBeUndefined();
    expect(after?.publiclyVisible).toBe(before?.publiclyVisible);
    const lift = await newestOn(t, 'hazardRecurrence', recurrenceId);
    expect(lift.action).toBe('unsuppress_recurrence');
    expect(lift.undoesActionId).toBe(suppress._id);

    await expect(mod.as.mutation(api.undo.run, { actionId: lift._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: lift._id, reason: 'it was a shadow' });
    const again = await t.run((ctx) => ctx.db.get(recurrenceId));
    expect(again?.suppressedAt).toBeGreaterThan(0);
    expect(again?.suppressReason).toBe('it was a shadow');
    expect(again?.publiclyVisible).toBe(false);
  });

  test('a re-suppression, an unsuppress from before undo, and a suppress from before undo', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { recurrenceId } = await seedCluster(t);

    const oldLift = await seedOldRow(t, mod.id, {
      action: 'unsuppress_recurrence',
      targetType: 'hazardRecurrence',
      targetId: recurrenceId,
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: oldLift, reason: 'r' })).rejects.toThrow(
      /before undo existed/i,
    );

    await mod.as.mutation(api.recurrence.suppress, { recurrenceId, reason: 'first' });
    await mod.as.mutation(api.recurrence.suppress, { recurrenceId, reason: 'second' });
    const second = await newestOn(t, 'hazardRecurrence', recurrenceId);
    await expect(mod.as.mutation(api.undo.run, { actionId: second._id })).rejects.toThrow(
      /already suppressed/,
    );

    // A suppression recorded before `prev` existed assumes the cluster was not suppressed.
    const t2 = convexTest(schema, modules);
    const mod2 = await seedUser(t2, 'mod', 'moderator');
    const { recurrenceId: r2 } = await seedCluster(t2);
    await mod2.as.mutation(api.recurrence.suppress, { recurrenceId: r2, reason: 'shadow' });
    const row = await newestOn(t2, 'hazardRecurrence', r2);
    await t2.run((ctx) => ctx.db.patch(row._id, { metadata: { waterBodyId: 'x' } }));
    await mod2.as.mutation(api.undo.run, { actionId: row._id });
    expect((await t2.run((ctx) => ctx.db.get(r2)))?.suppressedAt).toBeUndefined();
  });

  test('an unsuppress of a cluster that was not suppressed has nothing to put back', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { recurrenceId } = await seedCluster(t);
    await mod.as.mutation(api.recurrence.unsuppress, { recurrenceId, reason: 'tidy' });
    const lift = await newestOn(t, 'hazardRecurrence', recurrenceId);
    await expect(
      mod.as.mutation(api.undo.run, { actionId: lift._id, reason: 'r' }),
    ).rejects.toThrow(/nothing to put back/);
  });
});

// ── Hazard merges ─────────────────────────────────────────────────────────────────────────────────

describe('undo: hazard merges (D226)', () => {
  const eastOf = (meters: number) => ({
    type: 'Point' as const,
    coordinates: [0.5 + meters / 111_320, 0.5],
  });

  async function merged() {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const alex = await seedUser(t, 'alex');
    const sam = await seedUser(t, 'sam');
    const mod = await seedUser(t, 'mod', 'moderator');
    const args = {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      radiusMeters: 40,
    };
    const first = await alex.as.mutation(api.hazards.create, { ...args, geometry: POINT });
    const before = await t.run((ctx) => ctx.db.get(first));
    await sam.as.mutation(api.hazards.create, { ...args, geometry: eastOf(5) });
    const loser = (await t.run((ctx) => ctx.db.query('hazards').collect())).find(
      (h) => h.mergedIntoHazardId !== undefined,
    );
    if (!loser) throw new Error('the pins did not merge');
    const merge = await newestOn(t, 'hazard', loser._id);
    return { t, waterBodyId, alex, mod, first, before, loser, merge };
  }

  test('an automatic merge undoes by an operator: both pins back, the footprint and the card too', async () => {
    const { t, waterBodyId, alex, mod, first, before, loser, merge } = await merged();
    expect(merge.action).toBe('merge_hazards');
    expect(merge.actorId).toBeUndefined();
    expect(await alex.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(1);

    await mod.as.mutation(api.undo.run, { actionId: merge._id });
    expect((await t.run((ctx) => ctx.db.get(loser._id)))?.mergedIntoHazardId).toBeUndefined();
    expect(await alex.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(2);
    const survivor = await t.run((ctx) => ctx.db.get(first));
    expect(survivor?.clippedFootprint).toEqual(before?.clippedFootprint);
    expect(survivor?.bbox).toEqual(before?.bbox);
    const undoRow = await newestOn(t, 'hazard', loser._id);
    expect(undoRow.action).toBe('unmerge_hazards');
    expect(undoRow.actorId).toBe(mod.id);
    expect(undoRow.undoesActionId).toBe(merge._id);

    // Re-merging is §4's.
    await expect(mod.as.mutation(api.undo.run, { actionId: undoRow._id })).rejects.toThrow(
      /lands with §4/,
    );
  });

  test('a member cannot undo a merge; a merge recorded without its survivor is refused', async () => {
    const { t, alex, mod, merge } = await merged();
    await expect(alex.as.mutation(api.undo.run, { actionId: merge._id })).rejects.toThrow(
      /requires moderator/i,
    );
    await t.run((ctx) => ctx.db.patch(merge._id, { metadata: { automatic: true } }));
    await expect(mod.as.mutation(api.undo.run, { actionId: merge._id })).rejects.toThrow(
      /before undo existed/i,
    );
  });
});
