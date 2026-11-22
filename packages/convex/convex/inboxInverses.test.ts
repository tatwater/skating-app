/**
 * The Inbox's inverses (B01-5, *Undo: the inverses this wave owes*) that stand on today's code: a
 * drawn body's review back to pending (`return_to_review`), a moderator's retraction of an access
 * alert put back (`unretract_access_alert`), and the approval's body-side row recorded on the request
 * (what `reopen_request` will undo first). Each acted through its real mutation, undone through
 * `api.undo.run`, the state read back — side effects included — and each refusal in its own words.
 */

import { standingOf } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { bodySource, fileMember, requestSource } from './lib/inboxItems';
import { OWN_FILING_REFUSAL } from './lib/inboxRules';
import {
  approveNamedBayRequest,
  approveNamedLandmarkRequest,
  closeRow,
} from './lib/requestDecisions';
import { RETRACTION_IS_A_VERDICT } from './lib/undoHandlersCorpus';
import { PREDATES } from './lib/undoTypes';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

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
  moderatorDecision: false,
};

const POLYGON: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};
const INSIDE = { lat: 0.5, lng: 0.5 };
const BBOX = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };

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

/** The newest audit row on a target. */
async function newestOn(t: T, targetType: string, targetId: string) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}

const cellsOf = async (t: T, waterBodyId: Id<'waterBodies'>) =>
  (await t.run((ctx) => ctx.db.query('waterBodyCells').collect())).filter(
    (c) => c.waterBodyId === waterBodyId,
  );

// ── A drawn body's review ↔ back to review ──────────────────────────────────────────────────────

async function drawnSetup() {
  const t = convexTest(schema, modules);
  const drawer = await seedUser(t, 'drawer');
  const mod = await seedUser(t, 'mod', 'moderator');
  const mod2 = await seedUser(t, 'mod2', 'moderator');
  const member = await seedUser(t, 'member');
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Back Forty Pond',
      searchText: 'Back Forty Pond',
      type: 'lakePond' as const,
      source: 'user' as const,
      reviewStatus: 'pending' as const,
      createdByUserId: drawer.id,
      polygon: POLYGON,
      bbox: BBOX,
      centroid: INSIDE,
      surfaceAreaSqM: 40_000,
      minVisibleZoom: 12,
      dedupStatus: 'clean' as const,
      createdAt: Date.now() - 86_400_000,
    }),
  );
  await t.mutation(internal.waterBodies.backfillCells, {});
  return { t, drawer, mod, mod2, member, waterBodyId };
}

describe('return_to_review: a drawn body back to pending (B01-5)', () => {
  test('an approval undoes to pending, still listed, asking no reason; its undo approves again', async () => {
    const { t, mod, waterBodyId } = await drawnSetup();
    const cellsBefore = (await cellsOf(t, waterBodyId)).length;
    expect(cellsBefore).toBeGreaterThan(0);
    await mod.as.mutation(api.waterBodies.approve, { waterBodyId });
    const approval = await newestOn(t, 'waterbody', waterBodyId);
    expect(approval.action).toBe('approve_waterbody');

    await mod.as.mutation(api.undo.run, { actionId: approval._id });
    const body = await t.run((ctx) => ctx.db.get(waterBodyId));
    expect(body?.reviewStatus).toBe('pending');
    expect((await cellsOf(t, waterBodyId)).length).toBe(cellsBefore);
    const back = await newestOn(t, 'waterbody', waterBodyId);
    expect(back).toMatchObject({
      action: 'return_to_review',
      undoesActionId: approval._id,
      metadata: { prev: { reviewStatus: 'approved' } },
    });

    // The undo of the undo approves again, and asks no reason (approving takes nothing away).
    await mod.as.mutation(api.undo.run, { actionId: back._id });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.reviewStatus).toBe('approved');
    expect((await newestOn(t, 'waterbody', waterBodyId)).action).toBe('approve_waterbody');
  });

  test('a rejection undoes to pending and puts the drawing back on the map; re-rejecting asks why', async () => {
    const { t, mod, waterBodyId } = await drawnSetup();
    const cellsBefore = (await cellsOf(t, waterBodyId)).length;
    await mod.as.mutation(api.waterBodies.reject, { waterBodyId, reason: 'A field' });
    expect(await cellsOf(t, waterBodyId)).toEqual([]);
    const rejection = await newestOn(t, 'waterbody', waterBodyId);

    // Undoing a rejection gives back, so it needs no reason.
    await mod.as.mutation(api.undo.run, { actionId: rejection._id });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.reviewStatus).toBe('pending');
    expect((await cellsOf(t, waterBodyId)).length).toBe(cellsBefore);

    // Its undo rejects again, which takes the drawing off the map: a reason is required.
    const back = await newestOn(t, 'waterbody', waterBodyId);
    await expect(mod.as.mutation(api.undo.run, { actionId: back._id })).rejects.toThrow(
      /needs a reason/,
    );
    await mod.as.mutation(api.undo.run, { actionId: back._id, reason: 'Still a field' });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.reviewStatus).toBe('rejected');
    expect(await cellsOf(t, waterBodyId)).toEqual([]);
  });

  test('another moderator may undo it from History; a member may not', async () => {
    const { t, mod, mod2, member, waterBodyId } = await drawnSetup();
    await mod.as.mutation(api.waterBodies.approve, { waterBodyId });
    const approval = await newestOn(t, 'waterbody', waterBodyId);
    await expect(member.as.mutation(api.undo.run, { actionId: approval._id })).rejects.toThrow(
      /moderator/,
    );
    await mod2.as.mutation(api.undo.run, { actionId: approval._id });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.reviewStatus).toBe('pending');
  });

  test('a later write on the body overtakes the review', async () => {
    const { t, mod, waterBodyId } = await drawnSetup();
    await mod.as.mutation(api.waterBodies.approve, { waterBodyId });
    const approval = await newestOn(t, 'waterbody', waterBodyId);
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId, curatedBoost: 2 });
    await expect(mod.as.mutation(api.undo.run, { actionId: approval._id })).rejects.toThrow(
      'Something changed this since; open its history to see what',
    );
  });

  test('a review changed or a merge made with no row of its own refuses, in its own words', async () => {
    const { t, mod, waterBodyId } = await drawnSetup();
    await mod.as.mutation(api.waterBodies.approve, { waterBodyId });
    const approval = await newestOn(t, 'waterbody', waterBodyId);

    await t.run((ctx) => ctx.db.patch(waterBodyId, { reviewStatus: 'rejected' }));
    const state = await mod.as.query(api.undo.latestOwn, {
      targetType: 'waterbody',
      targetId: waterBodyId,
    });
    expect(state?.undo).toEqual({
      state: 'unavailable',
      why: 'It has been reviewed again since, so this review can’t be taken back.',
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: approval._id })).rejects.toThrow(
      'It has been reviewed again since',
    );

    await t.run((ctx) =>
      ctx.db.patch(waterBodyId, { reviewStatus: 'approved', dedupStatus: 'merged' }),
    );
    await expect(mod.as.mutation(api.undo.run, { actionId: approval._id })).rejects.toThrow(
      'It has been merged into another body since, so it can’t go back to review.',
    );
  });

  test('a return to review recorded without the review it took back can’t say what to put back', async () => {
    const { t, mod, waterBodyId } = await drawnSetup();
    const row = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'return_to_review',
        targetType: 'waterbody',
        targetId: waterBodyId,
        reason: 'an older action',
        createdAt: Date.now(),
      }),
    );
    await expect(mod.as.mutation(api.undo.run, { actionId: row })).rejects.toThrow(PREDATES);
  });
});

// ── A moderator's retraction of an access alert ↔ its unretraction ──────────────────────────────

async function alertSetup() {
  const t = convexTest(schema, modules);
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      searchText: 'Shelburne Pond',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: POLYGON,
      bbox: BBOX,
      centroid: INSIDE,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
  const putInId = await t.run((ctx) =>
    ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 0.5, lng: 0.001 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: Date.now(),
    }),
  );
  const author = await seedUser(t, 'author');
  const mod = await seedUser(t, 'mod', 'moderator');
  const mod2 = await seedUser(t, 'mod2', 'moderator');
  const member = await seedUser(t, 'member');
  const alertId = await author.as.mutation(api.accessAlerts.create, {
    targetType: 'put_in',
    reason: 'gate_locked',
    putInId,
  });
  const alert = () => t.run((ctx) => ctx.db.get(alertId));
  return { t, author, mod, mod2, member, alertId, alert };
}

/** The fields a retraction moves, and its undo puts back. */
const lifecycle = (a: Doc<'accessAlerts'> | null) => ({
  status: a?.status,
  expiresAt: a?.expiresAt,
  pinnedByUserId: a?.pinnedByUserId,
  retractedByUserId: a?.retractedByUserId,
  retractedAt: a?.retractedAt,
  eraseAt: a?.eraseAt,
});

describe('unretract_access_alert: a moderator’s retraction put back (B01-5)', () => {
  test('a retraction records prev; its undo puts a live alert back exactly, asking no reason', async () => {
    const { t, mod, alertId, alert } = await alertSetup();
    const before = lifecycle(await alert());
    expect(before.status).toBe('active');
    await mod.as.mutation(api.accessAlerts.retract, {
      accessAlertId: alertId,
      reason: 'Wrong lot',
    });
    const retraction = await newestOn(t, 'accessAlert', alertId);
    expect(retraction).toMatchObject({
      action: 'retract_access_alert',
      reason: 'Wrong lot',
      metadata: { prev: { status: 'active', expiresAt: before.expiresAt, pinnedByUserId: null } },
    });
    expect((await alert())?.status).toBe('retracted');

    await mod.as.mutation(api.undo.run, { actionId: retraction._id });
    expect(lifecycle(await alert())).toEqual(before);
    const back = await newestOn(t, 'accessAlert', alertId);
    expect(back).toMatchObject({
      action: 'unretract_access_alert',
      undoesActionId: retraction._id,
    });

    // Its undo retracts again — taking the claim away, so it asks why — and records prev anew.
    await expect(mod.as.mutation(api.undo.run, { actionId: back._id })).rejects.toThrow(
      /needs a reason/,
    );
    await mod.as.mutation(api.undo.run, { actionId: back._id, reason: 'It was wrong' });
    expect((await alert())?.status).toBe('retracted');
    expect((await newestOn(t, 'accessAlert', alertId)).metadata?.prev).toMatchObject({
      status: 'active',
    });
  });

  test('a pinned alert retracted comes back pinned, by the same pin', async () => {
    const { t, mod, mod2, alertId, alert } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'Town confirmed',
    });
    const before = lifecycle(await alert());
    expect(before).toMatchObject({ status: 'official', pinnedByUserId: mod.id });
    await mod2.as.mutation(api.accessAlerts.retract, {
      accessAlertId: alertId,
      reason: 'Reopened',
    });
    const retraction = await newestOn(t, 'accessAlert', alertId);
    await mod2.as.mutation(api.undo.run, { actionId: retraction._id });
    expect(lifecycle(await alert())).toEqual(before);
  });

  test('another person’s alert takes the alert lever to retract; a member is refused', async () => {
    const { member, alertId, alert } = await alertSetup();
    await expect(
      member.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'x' }),
    ).rejects.toThrow('Only the author or a moderator can retract an alert');
    expect((await alert())?.status).toBe('active');
  });

  test('a member can’t undo it; the alert’s own author can’t either (D269)', async () => {
    const { t, mod, author, alertId } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'Wrong' });
    const retraction = await newestOn(t, 'accessAlert', alertId);
    await expect(author.as.mutation(api.undo.run, { actionId: retraction._id })).rejects.toThrow(
      /moderator/,
    );
    // A moderator who wrote the alert is its author, and a decision on it is never theirs.
    await t.run((ctx) => ctx.db.patch(author.id, { role: 'moderator' }));
    await expect(author.as.mutation(api.undo.run, { actionId: retraction._id })).rejects.toThrow(
      'This is yours, so another moderator decides on it.',
    );
  });

  test('a claim that would have lapsed by now is not put back', async () => {
    const { t, mod, alertId, alert } = await alertSetup();
    await t.run((ctx) => ctx.db.patch(alertId, { expiresAt: Date.now() + 60_000 }));
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'Wrong' });
    const retraction = await newestOn(t, 'accessAlert', alertId);
    // The recorded expiry is in the past now.
    await t.run((ctx) =>
      ctx.db.patch(retraction._id, {
        metadata: {
          ...retraction.metadata,
          prev: { status: 'active', expiresAt: Date.now() - 1, pinnedByUserId: null },
        },
      }),
    );
    await expect(mod.as.mutation(api.undo.run, { actionId: retraction._id })).rejects.toThrow(
      'It would have expired by now; putting it back would show a lapsed claim on the map.',
    );
    expect((await alert())?.status).toBe('retracted');
  });

  test('an alert changed with no row of its own since refuses', async () => {
    const { t, mod, mod2, alertId } = await alertSetup();
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'Wrong' });
    const retraction = await newestOn(t, 'accessAlert', alertId);
    await t.run((ctx) => ctx.db.patch(alertId, { retractedByUserId: mod2.id }));
    await expect(mod.as.mutation(api.undo.run, { actionId: retraction._id })).rejects.toThrow(
      'The alert has changed since this retraction, so it can’t be put back.',
    );
  });

  test('a retraction from before prev, and a verdict on an author-retracted alert, have no undo', async () => {
    const { t, mod, author, alertId } = await alertSetup();
    const old = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'retract_access_alert',
        targetType: 'accessAlert',
        targetId: alertId,
        reason: 'an older action',
        metadata: { alertReason: 'gate_locked' },
        createdAt: Date.now(),
      }),
    );
    await expect(mod.as.mutation(api.undo.run, { actionId: old })).rejects.toThrow(PREDATES);

    await author.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId });
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'Pattern' });
    const verdict = await newestOn(t, 'accessAlert', alertId);
    expect(verdict.metadata?.onAuthorWithdrawn).toBe(true);
    await expect(mod.as.mutation(api.undo.run, { actionId: verdict._id })).rejects.toThrow(
      RETRACTION_IS_A_VERDICT,
    );
  });
});

// ── The approval's body-side row, recorded on the request ───────────────────────────────────────

async function requestSetup(patch: Partial<Doc<'waterBodies'>> = {}) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId: 'osm/1',
        osmId: 'osm/1',
        name: 'Quiet Pond',
        type: 'lakePond',
        polygon: POLYGON,
        bbox: BBOX,
        centroid: INSIDE,
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0];
  if (!body) throw new Error('seed failed');
  if (Object.keys(patch).length > 0) {
    await t.run((ctx) => ctx.db.patch(body._id, patch));
    await t.mutation(internal.waterBodies.backfillCells, {});
  }
  const skater = await seedUser(t, 'skater');
  const skater2 = await seedUser(t, 'skater2');
  const mod = await seedUser(t, 'mod', 'moderator');
  const admin = await seedUser(t, 'admin', 'admin');
  return { t, waterBodyId: body._id, skater, skater2, mod, admin };
}

/** The `approve_request` row on a request. */
const approvalOf = (t: T, requestId: Id<'waterBodyRequests'>) =>
  newestOn(t, 'waterBodyRequest', requestId);

describe('approve records the body-side row on the request it answers (B01-5)', () => {
  test('activate: the activation’s row, on the primary only — the sibling names the primary', async () => {
    const { t, waterBodyId, skater, skater2, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const ask = { kind: 'activate' as const, coord: INSIDE, waterBodyId };
    const first = await skater.as.mutation(api.corpusRequests.create, ask);
    const second = await skater2.as.mutation(api.corpusRequests.create, ask);
    await tick();
    await mod.as.mutation(api.corpusRequests.approve, { requestId: first });

    const activation = await newestOn(t, 'waterbody', waterBodyId);
    expect(activation.action).toBe('activate_body');
    expect((await approvalOf(t, first)).metadata?.bodyActionId).toBe(activation._id);
    const sibling = await approvalOf(t, second);
    expect(sibling.metadata?.withRequestId).toBe(first);
    expect(sibling.metadata?.bodyActionId).toBeUndefined();
    const after = await t.run((ctx) => ctx.db.get(waterBodyId));
    expect(after && standingOf(after).standing).toBe('active');
  });

  test('contest_access: the ruling’s row', async () => {
    const { t, waterBodyId, skater, mod } = await requestSetup();
    await mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId,
      verdict: 'none',
      reason: 'Posted private',
    });
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'contest_access',
      coord: INSIDE,
      waterBodyId,
      note: 'There is a town beach',
    });
    await mod.as.mutation(api.corpusRequests.approve, { requestId });
    const ruling = await newestOn(t, 'waterbody', waterBodyId);
    expect(ruling.action).toBe('set_public_access');
    expect((await approvalOf(t, requestId)).metadata?.bodyActionId).toBe(ruling._id);
  });

  test('restore and takedown: the restore’s and the removal’s rows, each needing body.remove', async () => {
    const { t, waterBodyId, skater, mod, admin } = await requestSetup();
    const takedown = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: INSIDE,
      waterBodyId,
      note: 'My land',
    });
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: takedown }),
    ).rejects.toThrow(/admin/);
    await admin.as.mutation(api.corpusRequests.approve, { requestId: takedown });
    const removal = await newestOn(t, 'waterbody', waterBodyId);
    expect(removal.action).toBe('remove');
    expect((await approvalOf(t, takedown)).metadata?.bodyActionId).toBe(removal._id);

    const restore = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'restore',
      coord: INSIDE,
      waterBodyId,
    });
    await admin.as.mutation(api.corpusRequests.approve, { requestId: restore });
    const restored = await newestOn(t, 'waterbody', waterBodyId);
    expect(restored.action).toBe('restore');
    expect((await approvalOf(t, restore)).metadata?.bodyActionId).toBe(restored._id);
  });

  test('an act that wrote nothing records nothing: a restore already undone elsewhere', async () => {
    const { t, waterBodyId, skater, admin } = await requestSetup({
      removedAt: Date.now(),
      removalReason: 'other',
    });
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'restore',
      coord: INSIDE,
      waterBodyId,
    });
    await admin.as.mutation(api.waterBodies.restore, { waterBodyId });
    await admin.as.mutation(api.corpusRequests.approve, { requestId });
    expect((await approvalOf(t, requestId)).metadata?.bodyActionId).toBeUndefined();
  });

  test('a decline records none', async () => {
    const { t, waterBodyId, skater, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId,
    });
    await mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'Private pond' });
    const row = await approvalOf(t, requestId);
    expect(row.action).toBe('decline_request');
    expect(row.metadata?.bodyActionId).toBeUndefined();
  });
});

// ── reopen_request: a request decision undone (B01-5) ───────────────────────────────────────────

/** A request's status, and its Inbox item's. */
async function requestState(t: T, requestId: Id<'waterBodyRequests'>) {
  return t.run(async (ctx) => {
    const r = await ctx.db.get(requestId);
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) =>
        q.eq('sourceTable', 'waterBodyRequests').eq('sourceId', requestId),
      )
      .first();
    const item = m ? await ctx.db.get(m.itemId) : null;
    return {
      status: r?.status,
      decidedAt: r?.decidedAt,
      item: item?.status,
      decision: item?.decision,
    };
  });
}

/**
 * A millisecond's step: a decision closes the siblings that existed when it was made (`_creationTime`
 * ≤ its `now`), and convex-test stamps an insert in the same millisecond a hair past it.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

const standing = async (t: T, id: Id<'waterBodies'>) => {
  const b = await t.run((ctx) => ctx.db.get(id));
  return b ? standingOf(b) : null;
};

describe('reopen_request: the decision undone, the body-side act first (B01-5)', () => {
  test('an activation undoes: the body shelved again, the ask and its sibling open, the item open', async () => {
    const { t, waterBodyId, skater, skater2, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const before = await standing(t, waterBodyId);
    const ask = { kind: 'activate' as const, coord: INSIDE, waterBodyId };
    const first = await skater.as.mutation(api.corpusRequests.create, ask);
    const second = await skater2.as.mutation(api.corpusRequests.create, ask);
    await tick();
    await mod.as.mutation(api.corpusRequests.approve, { requestId: first });
    expect(await requestState(t, second)).toMatchObject({ status: 'approved', item: 'decided' });
    const approval = await approvalOf(t, first);

    // Shelving the body again takes something away: a reason is asked.
    await expect(mod.as.mutation(api.undo.run, { actionId: approval._id })).rejects.toThrow(
      /needs a reason/,
    );
    await mod.as.mutation(api.undo.run, { actionId: approval._id, reason: 'Approved too soon' });
    expect(await standing(t, waterBodyId)).toMatchObject({
      standing: before?.standing,
      reason: 'inactive',
    });
    for (const id of [first, second]) {
      expect(await requestState(t, id)).toEqual({
        status: 'open',
        decidedAt: undefined,
        item: 'open',
        decision: undefined,
      });
    }
    const reopen = await newestOn(t, 'waterBodyRequest', first);
    expect(reopen).toMatchObject({ action: 'reopen_request', undoesActionId: approval._id });
    // A reopened approval isn't re-run by an undo.
    await expect(mod.as.mutation(api.undo.run, { actionId: reopen._id })).rejects.toThrow(
      'An approval acts on the body; approve it again from the Inbox.',
    );
  });

  test('a decline undoes with no reason; its undo declines the same asks again, with the same note', async () => {
    const { t, waterBodyId, skater, skater2, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const ask = { kind: 'activate' as const, coord: INSIDE, waterBodyId };
    const first = await skater.as.mutation(api.corpusRequests.create, ask);
    const second = await skater2.as.mutation(api.corpusRequests.create, ask);
    await tick();
    await mod.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'Private pond' });
    const decline = await approvalOf(t, first);
    await mod.as.mutation(api.undo.run, { actionId: decline._id });
    expect((await requestState(t, second)).status).toBe('open');
    const reopen = await newestOn(t, 'waterBodyRequest', first);
    await mod.as.mutation(api.undo.run, { actionId: reopen._id, reason: 'Still private' });
    for (const id of [first, second]) {
      const r = await t.run((ctx) => ctx.db.get(id));
      expect(r).toMatchObject({ status: 'declined', decisionNote: 'Private pond' });
      expect(await requestState(t, id), id).toMatchObject({ item: 'decided' });
    }
  });

  test('a sibling’s row undoes with the primary’s; a decision changed since refuses', async () => {
    const { t, waterBodyId, skater, skater2, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const ask = { kind: 'activate' as const, coord: INSIDE, waterBodyId };
    const first = await skater.as.mutation(api.corpusRequests.create, ask);
    const second = await skater2.as.mutation(api.corpusRequests.create, ask);
    await tick();
    await mod.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'No' });
    const sibling = await approvalOf(t, second);
    await expect(mod.as.mutation(api.undo.run, { actionId: sibling._id })).rejects.toThrow(
      'This closed with another request’s decision; undo that one.',
    );
    const primary = await approvalOf(t, first);
    await t.run((ctx) => ctx.db.patch(first, { decidedAt: Date.now() + 5 }));
    await expect(mod.as.mutation(api.undo.run, { actionId: primary._id })).rejects.toThrow(
      'The request has changed since this decision, so it can’t be reopened.',
    );
  });

  test('an approval whose body-side row was overtaken is refused with History’s sentence', async () => {
    const { t, waterBodyId, skater, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId,
    });
    await mod.as.mutation(api.corpusRequests.approve, { requestId });
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId, curatedBoost: 2 });
    await expect(
      mod.as.mutation(api.undo.run, {
        actionId: (await approvalOf(t, requestId))._id,
        reason: 'x',
      }),
    ).rejects.toThrow('Something changed this since; open its history to see what');
    expect((await requestState(t, requestId)).status).toBe('approved');
  });

  test('a takedown approval’s undo needs body.remove, as the act did', async () => {
    const { t, waterBodyId, skater, mod, admin } = await requestSetup();
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: INSIDE,
      waterBodyId,
      note: 'My land',
    });
    await admin.as.mutation(api.corpusRequests.approve, { requestId });
    const approval = await approvalOf(t, requestId);
    await expect(mod.as.mutation(api.undo.run, { actionId: approval._id })).rejects.toThrow(
      'Undoing this takes a role you do not hold.',
    );
    await admin.as.mutation(api.undo.run, { actionId: approval._id });
    expect((await standing(t, waterBodyId))?.standing).toBe('active');
    expect((await requestState(t, requestId)).status).toBe('open');
  });

  test('an admit of a known active body records its flag’s prev; the undo puts it back exactly', async () => {
    const { t, waterBodyId, skater, mod } = await requestSetup();
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 20, lng: 20 },
    });
    await t.run((ctx) =>
      ctx.db.patch(requestId, {
        candidate: {
          source: '3dhp' as const,
          externalId: 'X1',
          name: 'Quiet Pond',
          cls: 'lakePond',
          featureType: 3,
          polygon: POLYGON,
          bbox: BBOX,
          centroid: INSIDE,
          surfaceAreaSqM: 1_000_000,
          serviceUrl: 'https://hydro.nationalmap.gov/…',
          fetchedAt: Date.now(),
        },
        candidateExternalId: 'X1',
      }),
    );
    await mod.as.mutation(api.corpusRequests.approve, { requestId });
    const admission = await newestOn(t, 'waterbody', waterBodyId);
    expect(admission).toMatchObject({
      action: 'set_included_by_request',
      metadata: { requestId, prev: { includedByRequest: false } },
    });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.includedByRequest).toBe(true);
    // The admission's own undo is the request's.
    await expect(mod.as.mutation(api.undo.run, { actionId: admission._id })).rejects.toThrow(
      /reopening the request/,
    );
    await mod.as.mutation(api.undo.run, {
      actionId: (await approvalOf(t, requestId))._id,
      reason: 'Wrong pond',
    });
    const body = await t.run((ctx) => ctx.db.get(waterBodyId));
    expect(body?.includedByRequest).toBeUndefined();
    expect(body && standingOf(body).standing).toBe('active');
    expect((await requestState(t, requestId)).status).toBe('open');
  });
});

// ── The drain race ──────────────────────────────────────────────────────────────────────────────

describe('the sibling drain stops once its decision is undone (B01-5)', () => {
  test('a reopen between two drain pages leaves the next page closing nothing', async () => {
    const { t, waterBodyId, skater, skater2, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const ask = { kind: 'activate' as const, coord: INSIDE, waterBodyId };
    const first = await skater.as.mutation(api.corpusRequests.create, ask);
    const second = await skater2.as.mutation(api.corpusRequests.create, ask);
    await tick();
    const now = Date.now();
    const decision = {
      requestId: first,
      status: 'declined' as const,
      actorId: mod.id,
      now,
      note: 'No',
    };
    // The first page closes only the primary (a page boundary right after it).
    await t.run(async (ctx) => {
      const primary = (await ctx.db.get(first)) as Doc<'waterBodyRequests'>;
      await closeRow(ctx, primary, decision);
    });
    await mod.as.mutation(api.undo.run, { actionId: (await approvalOf(t, first))._id });
    expect((await requestState(t, first)).status).toBe('open');
    // The page scheduled before the undo runs now: its decision no longer stands.
    await t.mutation(internal.corpusRequests.closeSiblings, decision);
    expect((await requestState(t, second)).status).toBe('open');
  });
});

// ── D289: no staffer decides an ask they filed; a script's ask is exempt ────────────────────────

describe('D289 at every path that decides an ask', () => {
  test('the queue: the filer is refused approve and decline; another staffer decides it', async () => {
    const { t, waterBodyId, mod, admin } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const requestId = await mod.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId,
    });
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
    await expect(
      mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'x' }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    await admin.as.mutation(api.corpusRequests.approve, { requestId });
    expect((await requestState(t, requestId)).status).toBe('approved');
    // The filer can't undo it either: an undo is a decision too.
    await expect(
      mod.as.mutation(api.undo.run, {
        actionId: (await approvalOf(t, requestId))._id,
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
  });

  test('a script’s ask (origin seed) is decided by any staffer, its requester included', async () => {
    const { t, waterBodyId, mod } = await requestSetup({
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const requestId = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'activate' as const,
        status: 'open' as const,
        requesterId: mod.id,
        coord: INSIDE,
        waterBodyId,
        origin: 'seed' as const,
        createdAt: Date.now(),
      }),
    );
    await mod.as.mutation(api.corpusRequests.approve, { requestId });
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('approved');
  });

  async function landmarkAsk(origin: 'app' | 'seed') {
    const w = await requestSetup();
    const requestId = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark' as const,
        status: 'open' as const,
        requesterId: w.mod.id,
        coord: INSIDE,
        waterBodyId: w.waterBodyId,
        name: 'Long Point',
        origin,
        createdAt: Date.now(),
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    const landmarkId = await w.t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId: w.waterBodyId,
        name: 'Long Point',
        kind: 'point' as const,
        point: INSIDE,
        source: 'moderator' as const,
        externalIds: [],
        aliases: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    return { ...w, requestId, landmarkId };
  }

  test('the old editor’s landmark path refuses the filer, and lets a script’s ask through', async () => {
    const app = await landmarkAsk('app');
    await expect(
      app.t.run(async (ctx) => {
        const actor = (await ctx.db.get(app.mod.id)) as Doc<'profiles'>;
        await approveNamedLandmarkRequest(
          ctx,
          app.requestId,
          app.waterBodyId,
          actor,
          app.landmarkId,
        );
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);

    const seed = await landmarkAsk('seed');
    await seed.t.run(async (ctx) => {
      const actor = (await ctx.db.get(seed.mod.id)) as Doc<'profiles'>;
      await approveNamedLandmarkRequest(
        ctx,
        seed.requestId,
        seed.waterBodyId,
        actor,
        seed.landmarkId,
      );
    });
    expect((await seed.t.run((ctx) => ctx.db.get(seed.requestId)))?.status).toBe('approved');
  });

  test('the old editor’s bay path refuses the filer', async () => {
    const w = await requestSetup();
    const requestId = await w.t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay' as const,
        status: 'open' as const,
        requesterId: w.mod.id,
        coord: INSIDE,
        waterBodyId: w.waterBodyId,
        name: 'North Bay',
        nameKey: 'north bay',
        createdAt: Date.now(),
      }),
    );
    const subAreaId = await w.t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: w.waterBodyId,
        name: 'North Bay',
        searchText: 'North Bay',
        polygon: POLYGON,
        bbox: BBOX,
        centroid: INSIDE,
        surfaceAreaSqM: 1000,
        displayScore: 0,
        minVisibleZoom: 12,
        createdByUserId: w.mod.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      w.t.run(async (ctx) => {
        const actor = (await ctx.db.get(w.mod.id)) as Doc<'profiles'>;
        await approveNamedBayRequest(ctx, requestId, w.waterBodyId, actor, subAreaId);
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
  });
});

// ── A drawn body's item: decided by the review, reopened by its undo ────────────────────────────

describe('the drawn review moves its Inbox item (B01-5)', () => {
  test('approve decides it; return_to_review reopens it; the drawer can’t review their own', async () => {
    const { t, drawer, mod, waterBodyId } = await drawnSetup();
    await t.run((ctx) => fileMember(ctx, bodySource(waterBodyId)));
    const item = () =>
      t.run(async (ctx) => {
        const m = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) =>
            q.eq('sourceTable', 'waterBodies').eq('sourceId', waterBodyId),
          )
          .first();
        return m ? ctx.db.get(m.itemId) : null;
      });
    expect((await item())?.status).toBe('open');
    await t.run((ctx) => ctx.db.patch(drawer.id, { role: 'moderator' }));
    await expect(drawer.as.mutation(api.waterBodies.approve, { waterBodyId })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );

    await mod.as.mutation(api.waterBodies.approve, { waterBodyId });
    const approval = await newestOn(t, 'waterbody', waterBodyId);
    expect(await item()).toMatchObject({
      status: 'decided',
      decision: 'approved',
      decisionActionId: approval._id,
    });
    await mod.as.mutation(api.undo.run, { actionId: approval._id });
    expect((await item())?.status).toBe('open');
  });
});
