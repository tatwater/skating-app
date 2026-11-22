/**
 * The Inbox writes' review findings (B01-5, the fourth pass), each reproduced before its fix: a flag
 * the actor filed in another lane, the drawer's undo of their drawing's review, a parent undo beside a
 * reporter's newer flag, a decision from before the Inbox undone, the per-flag D289/D269 check, an
 * undo offered then refused, the undo of a reopen, and a verb outside an item's choices.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { reopenFlagsClosedBy } from './lib/inboxFlags';
import { bodySource, fileMember, requestSource } from './lib/inboxItems';
import { inboxCan, NOT_A_CHOICE_REFUSAL, OWN_FILING_REFUSAL } from './lib/inboxRules';
import { approveNamedLandmarkRequest } from './lib/requestDecisions';
import { undoState } from './lib/undo';
import { undoHandlers } from './lib/undoHandlers';
import type { UndoWriters } from './lib/undoTypes';
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

type Role = 'member' | 'moderator' | 'admin';

async function person(t: T, subject: string, role: Role = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
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

const POLYGON = {
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
};

async function lake(t: T) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: POLYGON,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

async function report(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: now,
      reportTime: now,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function world() {
  const t = convexTest(schema, modules);
  const author = await person(t, 'author');
  const f1 = await person(t, 'f1');
  const f2 = await person(t, 'f2');
  const f3 = await person(t, 'f3');
  const member = await person(t, 'member');
  const mod = await person(t, 'mod', 'moderator');
  const mod2 = await person(t, 'mod2', 'moderator');
  const waterBodyId = await lake(t);
  const reportId = await report(t, author.id, waterBodyId);
  const flag = (
    who: { as: ReturnType<T['withIdentity']> },
    reason: Doc<'contentFlags'>['reason'] = 'spam',
    id = reportId,
  ) => who.as.mutation(api.contentFlags.flag, { targetType: 'report', targetId: id, reason });
  return { t, author, f1, f2, f3, member, mod, mod2, waterBodyId, reportId, flag };
}

/** The item a source flag belongs to. */
async function itemOf(t: T, flagId: Id<'contentFlags'>): Promise<Doc<'inboxItems'>> {
  return t.run(async (ctx) => {
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
      .first();
    const item = m ? await ctx.db.get(m.itemId) : null;
    if (!item) throw new Error('no item');
    return item;
  });
}

const flagsOf = (t: T, ids: Id<'contentFlags'>[]) =>
  t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));

/** Undo state for `who` on a row, as History reads it. */
const undoFor = (t: T, who: Id<'profiles'>, actionId: Id<'moderationActions'>) =>
  t.run(async (ctx) => {
    const viewer = (await ctx.db.get(who)) as Doc<'profiles'>;
    const row = (await ctx.db.get(actionId)) as Doc<'moderationActions'>;
    return undoState(ctx, viewer, row, 'one');
  });

/** Strip every Inbox stamp, as the backfill files a decision made before the Inbox existed. */
const asIfBackfilled = (t: T) =>
  t.run(async (ctx) => {
    for (const m of await ctx.db.query('inboxItemMembers').collect()) {
      if (m.closedByActionId) await ctx.db.patch(m._id, { closedByActionId: undefined });
    }
    for (const i of await ctx.db.query('inboxItems').collect()) {
      if (i.decisionActionId) await ctx.db.patch(i._id, { decisionActionId: undefined });
    }
  });

const actions = (t: T) => t.run((ctx) => ctx.db.query('moderationActions').collect());

describe('1. a takedown or an alert verdict never closes a flag the actor filed, in any lane (D289)', () => {
  test('the content item’s takedown is refused, and its rule says so', async () => {
    const { t, mod, f1, flag, reportId } = await world();
    const mine = await flag(mod, 'unsafe_false_report');
    const theirs = await flag(f1);
    const item = await itemOf(t, theirs);
    const can = await t.run(async (ctx) =>
      inboxCan(ctx, (await ctx.db.get(mod.id)) as Doc<'profiles'>, item),
    );
    expect(can).toMatchObject({
      dismiss: null,
      hide: OWN_FILING_REFUSAL,
      remove: OWN_FILING_REFUSAL,
    });
    await expect(
      mod.as.mutation(api.inboxWrites.takeDown, {
        itemId: item._id,
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    expect((await flagsOf(t, [mine]))[0]?.status).toBe('open');
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('visible');
  });

  test('an alert verdict from another lane’s item is refused too', async () => {
    const { t, mod, f1, author, waterBodyId } = await world();
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.001 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const alertId = await author.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      reason: 'gate_locked',
      putInId,
    });
    const onAlert = (
      who: { as: ReturnType<T['withIdentity']> },
      reason: 'unsafe_false_report' | 'other',
    ) =>
      who.as.mutation(api.contentFlags.flag, {
        targetType: 'accessAlert',
        targetId: alertId,
        reason,
      });
    await onAlert(mod, 'unsafe_false_report');
    const theirs = await onAlert(f1, 'other');
    await expect(
      mod.as.mutation(api.inboxWrites.alertVerdict, {
        itemId: (await itemOf(t, theirs))._id,
        verb: 'retract',
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    // A pin closes them too (dismissed): the same refusal.
    await expect(
      mod.as.mutation(api.inboxWrites.alertVerdict, {
        itemId: (await itemOf(t, theirs))._id,
        verb: 'pin',
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('active');
  });
});

describe('2. the drawer never undoes a colleague’s review of their drawing (D289)', () => {
  test('History doesn’t offer it, and the write refuses it', async () => {
    const t = harness();
    const drawer = await person(t, 'drawer', 'moderator');
    const mod = await person(t, 'mod', 'moderator');
    const waterBodyId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodies', {
        name: 'Back Forty',
        searchText: 'Back Forty',
        type: 'lakePond' as const,
        source: 'user' as const,
        reviewStatus: 'pending' as const,
        createdByUserId: drawer.id,
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      });
      await fileMember(ctx, bodySource(id));
      return id;
    });
    await mod.as.mutation(api.waterBodies.reject, { waterBodyId, reason: 'A field' });
    const rejection = (await actions(t)).find((r) => r.action === 'reject_waterbody');
    const id = rejection?._id as Id<'moderationActions'>;
    expect(await undoFor(t, drawer.id, id)).toEqual({
      state: 'unavailable',
      why: OWN_FILING_REFUSAL,
    });
    await expect(drawer.as.mutation(api.undo.run, { actionId: id })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.reviewStatus).toBe('rejected');
  });
});

describe('3. a parent undo runs beside a flag that can’t reopen, and names it', () => {
  test('a ruling undone after a reporter filed again: the ruling goes, their old report stays closed', async () => {
    const { t, mod, f1, f2, waterBodyId } = await world();
    const admin = await person(t, 'boss', 'admin');
    const fileAccess = (who: { as: ReturnType<T['withIdentity']> }, note?: string) =>
      who.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: waterBodyId,
        reason: 'no_public_access',
        ...(note ? { note } : {}),
      });
    const first = await fileAccess(f1);
    const other = await fileAccess(f2);
    const out = await mod.as.mutation(api.inboxWrites.ruleAccess, {
      itemId: (await itemOf(t, first))._id,
      verdict: 'open',
    });
    const again = await fileAccess(f1, 'Gated after all');
    expect(await undoFor(t, admin.id, out.actionId)).toMatchObject({ state: 'available' });

    await admin.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await t.run((ctx) => ctx.db.get(waterBodyId)))?.publicAccess).toBeUndefined();
    const [f, o, a] = await flagsOf(t, [first, other, again]);
    expect([f?.status, o?.status, a?.status]).toEqual(['dismissed', 'open', 'open']);
    const undoRow = (await actions(t)).find(
      (r) => r.undoesActionId === out.actionId && r.action === 'set_public_access',
    );
    expect(undoRow?.metadata?.flagsLeftClosed).toEqual([
      {
        flagId: first,
        why: 'The same person has flagged this again since, so this one can’t be reopened beside it.',
      },
    ]);
  });
});

describe('3b. flagsLeftClosed lands on the undo’s lead row, not the newest', () => {
  test('a ruling that woke a shelved body: its undo shelves it again, and the lead row names the skip', async () => {
    const { t, mod, f1, waterBodyId } = await world();
    const admin = await person(t, 'boss2', 'admin');
    await t.run((ctx) =>
      ctx.db.patch(waterBodyId, { dormant: { since: Date.now(), reason: 'inactive' as const } }),
    );
    const fileAccess = (note?: string) =>
      f1.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: waterBodyId,
        reason: 'no_public_access',
        ...(note ? { note } : {}),
      });
    const first = await fileAccess();
    const out = await mod.as.mutation(api.inboxWrites.ruleAccess, {
      itemId: (await itemOf(t, first))._id,
      verdict: 'open',
    });
    await fileAccess('Gated after all');
    await admin.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Too soon' });
    const tagged = (await actions(t)).filter((r) => r.undoesActionId === out.actionId);
    const lead = tagged.find((r) => r.action === 'set_public_access');
    const shelve = tagged.find((r) => r.action === 'set_standing');
    expect(shelve).toBeDefined();
    expect(lead?.metadata?.flagsLeftClosed).toEqual([
      {
        flagId: first,
        why: 'The same person has flagged this again since, so this one can’t be reopened beside it.',
      },
    ]);
    expect(shelve?.metadata?.flagsLeftClosed).toBeUndefined();
  });
});

describe('the undo of a reopen asks the item’s rule in its write, not only in its offer', () => {
  test('a staffer whose flag joined the item after the reopen can’t close it again (D289)', async () => {
    const { t, mod, mod2, f1, flag } = await world();
    const a = await flag(f1);
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, a))._id,
    });
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    await flag(mod2, 'harassment');
    const reopen = (await actions(t)).find((r) => r.action === 'reopen_flag');
    // The handler's write itself, past the engine's offer: the same rule answers.
    await expect(
      t.run(async (ctx) => {
        const actor = (await ctx.db.get(mod2.id)) as Doc<'profiles'>;
        const row = (await ctx.db.get(
          reopen?._id as Id<'moderationActions'>,
        )) as Doc<'moderationActions'>;
        await undoHandlers().reopen_flag?.run({
          ctx,
          actor,
          row,
          reason: 'x',
          writers: {} as UndoWriters,
        });
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
  });
});

describe('4. a decision from before the Inbox, undone, reopens its item too', () => {
  test('a flag dismissed before the stamps', async () => {
    const { t, mod, f1, flag } = await world();
    const a = await flag(f1);
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: a,
      resolution: 'dismissed',
      reason: 'Fine',
    });
    await asIfBackfilled(t);
    const row = (await actions(t)).find((r) => r.action === 'dismiss_flag');
    await mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> });
    expect((await flagsOf(t, [a]))[0]?.status).toBe('open');
    expect((await itemOf(t, a)).status).toBe('open');
  });

  test('a request declined before the stamps', async () => {
    const { t, mod, f1, waterBodyId } = await world();
    await t.run((ctx) =>
      ctx.db.patch(waterBodyId, { dormant: { since: Date.now(), reason: 'inactive' } }),
    );
    const requestId = await f1.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: { lat: 0.5, lng: 0.5 },
      waterBodyId,
    });
    await mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    await asIfBackfilled(t);
    const row = (await actions(t)).find((r) => r.action === 'decline_request');
    await mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> });
    expect(await requestItem(t, requestId)).toEqual({ status: 'open', item: 'open' });
  });

  test('a landmark ask approved from the old editor before the stamps', async () => {
    const { t, mod, f1, waterBodyId } = await world();
    const requestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark' as const,
        status: 'open' as const,
        requesterId: f1.id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId,
        name: 'Long Point',
        createdAt: Date.now(),
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    const landmarkId = await t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId,
        name: 'Long Point',
        kind: 'point' as const,
        point: { lat: 0.5, lng: 0.5 },
        source: 'moderator' as const,
        externalIds: [],
        aliases: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.run(async (ctx) => {
      const actor = (await ctx.db.get(mod.id)) as Doc<'profiles'>;
      await approveNamedLandmarkRequest(ctx, requestId, waterBodyId, actor, landmarkId);
    });
    await asIfBackfilled(t);
    const row = (await actions(t)).find((r) => r.action === 'approve_request');
    await mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> });
    expect(await requestItem(t, requestId)).toEqual({ status: 'open', item: 'open' });
  });
});

describe('5. reopening checks every flag’s filer and subject (D289, D269)', () => {
  test('inside a ruling’s undo, the undoer’s own report is left closed and named', async () => {
    const { t, mod, mod2, f1, waterBodyId } = await world();
    const fileAccess = (who: { as: ReturnType<T['withIdentity']> }) =>
      who.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: waterBodyId,
        reason: 'no_public_access',
      });
    const theirs = await fileAccess(f1);
    const mine = await fileAccess(mod2);
    // The Body console's lever: a staff change made directly (D289's principle), so it closes all.
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId, verdict: 'open' });
    const ruling = (await actions(t)).find((r) => r.action === 'set_public_access');
    await mod2.as.mutation(api.undo.run, { actionId: ruling?._id as Id<'moderationActions'> });
    const [a, b] = await flagsOf(t, [theirs, mine]);
    expect([a?.status, b?.status]).toEqual(['open', 'dismissed']);
    const undoRow = (await actions(t)).find(
      (r) => r.undoesActionId === ruling?._id && r.action === 'set_public_access',
    );
    expect(undoRow?.metadata?.flagsLeftClosed).toEqual([{ flagId: mine, why: OWN_FILING_REFUSAL }]);
  });

  test('a decision’s own reopen refuses the filer and the subject outright', async () => {
    const { t, mod, mod2, f1, flag, author } = await world();
    const filed = await flag(mod2, 'harassment');
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, filed))._id,
    });
    await expect(
      t.run(async (ctx) => {
        const actor = (await ctx.db.get(mod2.id)) as Doc<'profiles'>;
        await reopenFlagsClosedBy(ctx, actor, out.actionId, 'x', { alsoFlagId: filed });
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    // About them: a flag on the author's content, the author on staff.
    await t.run((ctx) => ctx.db.patch(author.id, { role: 'moderator' }));
    const about = await flag(f1, 'spam', await report(t, author.id, await lake(t)));
    const out2 = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, about))._id,
    });
    await expect(
      t.run(async (ctx) => {
        const actor = (await ctx.db.get(author.id)) as Doc<'profiles'>;
        await reopenFlagsClosedBy(ctx, actor, out2.actionId, 'x', { alsoFlagId: about });
      }),
    ).rejects.toThrow('This is yours, so another moderator decides on it.');
  });
});

describe('smaller: an undo is never offered to someone who couldn’t run it (D217)', () => {
  test('a flag decision’s undo, to the staffer who filed a flag in it', async () => {
    const { t, mod, mod2, f1, flag } = await world();
    await flag(f1);
    const filed = await flag(mod2, 'harassment');
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, filed))._id,
    });
    expect(await undoFor(t, mod2.id, out.actionId)).toEqual({
      state: 'unavailable',
      why: OWN_FILING_REFUSAL,
    });
  });

  test('a request decision’s undo, to the staffer who filed a sibling it closed', async () => {
    const { t, mod, mod2, f1, waterBodyId } = await world();
    await t.run((ctx) =>
      ctx.db.patch(waterBodyId, { dormant: { since: Date.now(), reason: 'inactive' } }),
    );
    const ask = { kind: 'activate' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId };
    const first = await f1.as.mutation(api.corpusRequests.create, ask);
    await mod2.as.mutation(api.corpusRequests.create, ask);
    await new Promise((resolve) => setTimeout(resolve, 2));
    // mod2 filed a sibling: the forward decision is refused to them, and so is its undo.
    await expect(
      mod2.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'x' }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    await mod.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'No' });
    const row = (await actions(t)).find(
      (r) => r.action === 'decline_request' && r.targetId === first,
    );
    const id = row?._id as Id<'moderationActions'>;
    expect(await undoFor(t, mod2.id, id)).toEqual({
      state: 'unavailable',
      why: OWN_FILING_REFUSAL,
    });
    await expect(mod2.as.mutation(api.undo.run, { actionId: id })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
  });
});

describe('smaller: the undo of a reopen closes every flag it reopened, in one act', () => {
  test('three flags dismissed, reopened, dismissed again', async () => {
    const { t, mod, f1, f2, f3, flag } = await world();
    const ids = [await flag(f1), await flag(f2), await flag(f3, 'harassment')];
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, ids[0] as Id<'contentFlags'>))._id,
    });
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    const reopens = (await actions(t)).filter((r) => r.action === 'reopen_flag');
    const lead = reopens.find((r) => r.targetId === ids[0]);
    for (const r of reopens.filter((x) => x._id !== lead?._id)) {
      expect(await undoFor(t, mod.id, r._id)).toMatchObject({ state: 'unavailable' });
    }
    await mod.as.mutation(api.undo.run, { actionId: lead?._id as Id<'moderationActions'> });
    expect((await flagsOf(t, ids)).map((f) => f?.status)).toEqual([
      'dismissed',
      'dismissed',
      'dismissed',
    ]);
    expect((await itemOf(t, ids[0] as Id<'contentFlags'>)).status).toBe('decided');
  });
});

describe('smaller: a verb outside an item’s choices is refused in plain words', () => {
  test('a takedown or a restore on a person’s flag', async () => {
    const { t, mod, f1, author } = await world();
    const onPerson = await f1.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: author.id,
      reason: 'harassment',
    });
    const itemId = (await itemOf(t, onPerson))._id;
    await expect(
      mod.as.mutation(api.inboxWrites.takeDown, { itemId, status: 'hidden', reason: 'x' }),
    ).rejects.toThrow(NOT_A_CHOICE_REFUSAL);
    await expect(mod.as.mutation(api.inboxWrites.restoreAndDismiss, { itemId })).rejects.toThrow(
      NOT_A_CHOICE_REFUSAL,
    );
  });
});

/** A request's status and its item's. */
const requestItem = (t: T, requestId: Id<'waterBodyRequests'>) =>
  t.run(async (ctx) => {
    const r = await ctx.db.get(requestId);
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) =>
        q.eq('sourceTable', 'waterBodyRequests').eq('sourceId', requestId),
      )
      .first();
    const item = m ? await ctx.db.get(m.itemId) : null;
    return { status: r?.status, item: item?.status };
  });
