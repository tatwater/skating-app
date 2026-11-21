/**
 * The Inbox's decisions on a flagged item (B01-5): each write's gate and refusals (D217, D269, D283,
 * D289), what it closes — a dismissal only its item's flags, a takedown every flag on the content in
 * every lane — who it tells, and its one undo putting everything back: the content, the flags, their
 * holds and today's disposition count, the items and their counts. A verdict message still settling
 * when the undo lands is never sent.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { DISMISS_DEFAULT_REASON } from './inboxWrites';
import { fileMember, flagSource } from './lib/inboxItems';
import {
  ALERT_PINNED_ALREADY,
  ALERT_RETRACTED_NO_PIN,
  DECIDED_REFUSAL,
  NOT_A_CHOICE_REFUSAL,
  OWN_FILING_REFUSAL,
} from './lib/inboxRules';
import { UNDO_WITH_ITS_DECISION } from './lib/undoHandlersCorpus';
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

const counts = (t: T) =>
  t.run(async (ctx) =>
    Object.fromEntries(
      (await ctx.db.query('inboxCounts').collect())
        .filter((c) => c.count !== 0)
        .map((c) => [c.key, c.count]),
    ),
  );

const dispositions = (t: T) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('metricSnapshots').collect();
    const meta = rows.find((r) => r.metric === 'flag_dispositions')?.meta ?? {};
    return Object.fromEntries(Object.entries(meta).filter(([, n]) => n !== 0));
  });

/** Make every queued notification due and flush it — the settle window, fast-forwarded. */
async function flushAllDue(t: T) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('notificationQueue').collect()) {
      await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    }
  });
  await t.mutation(internal.notifications.flushNotificationQueue, {});
  return t.run((ctx) => ctx.db.query('notifications').collect());
}

describe('the gates', () => {
  test('a member is refused by every write', async () => {
    const { member, f1, flag, t } = await world();
    const itemId = (await itemOf(t, await flag(f1)))._id;
    for (const run of [
      () => member.as.mutation(api.inboxWrites.dismissFlags, { itemId }),
      () => member.as.mutation(api.inboxWrites.takeDown, { itemId, status: 'hidden', reason: 'x' }),
      () =>
        member.as.mutation(api.inboxWrites.alertVerdict, { itemId, verb: 'retract', reason: 'x' }),
      () => member.as.mutation(api.inboxWrites.restoreAndDismiss, { itemId }),
    ]) {
      await expect(run()).rejects.toThrow('Requires moderator role');
    }
  });

  test('a staffer can’t decide a flag they filed (D289), nor take down their own content (D269)', async () => {
    const { t, mod, mod2, flag, waterBodyId } = await world();
    const itemId = (await itemOf(t, await flag(mod)))._id;
    await expect(mod.as.mutation(api.inboxWrites.dismissFlags, { itemId })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
    const own = await report(t, mod2.id, waterBodyId);
    const ownItem = (await itemOf(t, await flag(mod, 'spam', own)))._id;
    await expect(
      mod2.as.mutation(api.inboxWrites.takeDown, {
        itemId: ownItem,
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow('This is yours, so another moderator decides on it.');
  });

  test('a decided item takes no further decision (D283); a takedown needs its reason', async () => {
    const { t, mod, mod2, f1, flag } = await world();
    const itemId = (await itemOf(t, await flag(f1)))._id;
    await expect(
      mod.as.mutation(api.inboxWrites.takeDown, { itemId, status: 'hidden', reason: ' ' }),
    ).rejects.toThrow('A reason is required');
    await mod.as.mutation(api.inboxWrites.dismissFlags, { itemId });
    await expect(mod2.as.mutation(api.inboxWrites.dismissFlags, { itemId })).rejects.toThrow(
      DECIDED_REFUSAL,
    );
  });
});

describe('dismissFlags', () => {
  test('closes only its item’s flags, the first row the toast’s; its undo reopens them all', async () => {
    const { t, mod, f1, f2, f3, flag } = await world();
    const a = await flag(f1);
    const b = await flag(f2);
    const safety = await flag(f3, 'unsafe_false_report');
    const item = await itemOf(t, a);
    expect(item._id).toBe((await itemOf(t, b))._id);
    const before = await counts(t);

    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, { itemId: item._id });
    expect(out).toMatchObject({ itemId: item._id, flagsClosed: 2, undoable: true });
    expect(out.undoable && out.undoNeedsReason).toBe(false);
    const [fa, fb, fs] = await flagsOf(t, [a, b, safety]);
    expect([fa?.status, fb?.status, fs?.status]).toEqual(['dismissed', 'dismissed', 'open']);
    expect(await itemOf(t, a)).toMatchObject({
      status: 'decided',
      decision: 'dismissed',
      decisionActionId: out.actionId,
    });
    expect(await dispositions(t)).toEqual({ 'spam:dismissed': 2 });
    const rows = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    const lead = rows.find((r) => r._id === out.actionId);
    expect(lead).toMatchObject({ action: 'dismiss_flag', reason: DISMISS_DEFAULT_REASON });
    const other = rows.find((r) => r.action === 'dismiss_flag' && r._id !== out.actionId);
    expect(other?.metadata?.withActionId).toBe(out.actionId);
    // The later flag's own row undoes with the decision.
    await expect(
      mod.as.mutation(api.undo.run, { actionId: other?._id as Id<'moderationActions'> }),
    ).rejects.toThrow(UNDO_WITH_ITS_DECISION);

    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    const [ra, rb] = await flagsOf(t, [a, b]);
    expect([ra?.status, rb?.status]).toEqual(['open', 'open']);
    expect(ra?.resolvedAt).toBeUndefined();
    expect((await itemOf(t, a)).status).toBe('open');
    expect(await counts(t)).toEqual(before);
    expect(await dispositions(t)).toEqual({});
    const reopens = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
      (r) => r.action === 'reopen_flag',
    );
    expect(reopens).toHaveLength(2);

    // A reopened flag's own undo closes it again, as the decision had it.
    await mod.as.mutation(api.undo.run, { actionId: reopens[0]?._id as Id<'moderationActions'> });
    expect(
      (await t.run((ctx) => ctx.db.get(reopens[0]?.targetId as Id<'contentFlags'>)))?.status,
    ).toBe('dismissed');
  });

  test('a withdrawn report’s erasure hold goes with the dismissal and comes back with its undo', async () => {
    const { t, mod, f1, flag, reportId } = await world();
    const a = await flag(f1);
    await t.run((ctx) => ctx.db.patch(reportId, { authorDeletedAt: Date.now() - 40 * 86_400_000 }));
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, a))._id,
    });
    // The hold cleared: erasure is due (the 30 days ran out long ago).
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.eraseAt).toBeDefined();
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    // An open flag holds it again.
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.eraseAt).toBeUndefined();
  });

  test('an undo inside the settle window drops the verdict; without one it is sent', async () => {
    const { t, mod, f1, f2, flag, author, waterBodyId } = await world();
    const item = await itemOf(t, await flag(f1));
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, { itemId: item._id });
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    expect(await flushAllDue(t)).toHaveLength(0);

    const elsewhere = await report(t, author.id, waterBodyId);
    const other = await itemOf(t, await flag(f2, 'harassment', elsewhere));
    await mod.as.mutation(api.inboxWrites.dismissFlags, { itemId: other._id, reason: 'Fine' });
    const sent = await flushAllDue(t);
    expect(sent.map((n) => [n.userId, n.type])).toEqual([[f2.id, 'content_flag_resolved']]);
  });

  test('another reporter’s open flag beside it is no bar; the same person’s is', async () => {
    const { t, mod, f1, f2, flag } = await world();
    const a = await flag(f1);
    const out = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, a))._id,
    });
    await flag(f2);
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await flagsOf(t, [a]))[0]?.status).toBe('open');

    const again = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, a))._id,
    });
    await flag(f1);
    await expect(mod.as.mutation(api.undo.run, { actionId: again.actionId })).rejects.toThrow(
      'The same person has flagged this again since, so this one can’t be reopened beside it.',
    );
  });

  test('an automatic flag beside an open one of its reason, or a superseded flag, refuses', async () => {
    const { t, mod, f1, f2, flag, reportId } = await world();
    const auto = (status: 'open' | 'dismissed', extra: Partial<Doc<'contentFlags'>> = {}) =>
      t.run((ctx) =>
        ctx.db.insert('contentFlags', {
          flaggerId: f2.id,
          targetType: 'report' as const,
          targetId: reportId,
          reason: 'auto_low_quality' as const,
          status,
          origin: 'auto' as const,
          createdAt: Date.now(),
          ...extra,
        }),
      );
    const first = await auto('open');
    await t.run((ctx) => fileMember(ctx, flagSource(first)));
    const out = await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: first,
      resolution: 'dismissed',
      reason: 'Fine',
    });
    expect(out).toBe(first);
    const row = await t.run(async (ctx) =>
      (await ctx.db.query('moderationActions').collect()).find((r) => r.targetId === first),
    );
    await auto('open');
    await expect(
      mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> }),
    ).rejects.toThrow(
      'A flag of the same kind is open on this now, so this one can’t be reopened beside it.',
    );

    const a = await flag(f1);
    const dismissal = await mod.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: (await itemOf(t, a))._id,
    });
    await auto('dismissed', { supersedesFlagId: a });
    await expect(mod.as.mutation(api.undo.run, { actionId: dismissal.actionId })).rejects.toThrow(
      'A newer flag has taken this one’s place, so it can’t be reopened.',
    );
  });
});

describe('takeDown', () => {
  test('hides the content and closes every flag on it, every lane, each flagger told', async () => {
    const { t, mod, f1, f2, f3, flag, reportId } = await world();
    const a = await flag(f1);
    const b = await flag(f2);
    const s = await flag(f3, 'unsafe_false_report');
    const content = await itemOf(t, a);
    const safety = await itemOf(t, s);
    expect(safety._id).not.toBe(content._id);

    const out = await mod.as.mutation(api.inboxWrites.takeDown, {
      itemId: content._id,
      status: 'hidden',
      reason: 'Abusive',
    });
    expect(out).toMatchObject({ status: 'hidden', flagsClosed: 3, undoable: true });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('hidden');
    const flags = await flagsOf(t, [a, b, s]);
    expect(flags.map((f) => f?.status)).toEqual(['actioned', 'actioned', 'actioned']);
    expect((await itemOf(t, a)).decision).toBe('hidden');
    expect((await itemOf(t, s)).decision).toBe('hidden');
    const told = (await flushAllDue(t)).map((n) => n.userId).sort();
    expect(told).toEqual([f1.id, f2.id, f3.id].sort());
  });

  test('its one undo restores the content and reopens every flag and item', async () => {
    const { t, mod, f1, f3, flag, reportId } = await world();
    const a = await flag(f1);
    const s = await flag(f3, 'unsafe_false_report');
    const before = await counts(t);
    const out = await mod.as.mutation(api.inboxWrites.takeDown, {
      itemId: (await itemOf(t, a))._id,
      status: 'removed',
      reason: 'Abusive',
    });
    // The undo gives the content back: no reason asked.
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('visible');
    expect((await flagsOf(t, [a, s])).map((f) => f?.status)).toEqual(['open', 'open']);
    expect((await itemOf(t, a)).status).toBe('open');
    expect((await itemOf(t, s)).status).toBe('open');
    expect(await counts(t)).toEqual(before);
    // Inside the settle window: nobody hears a verdict that was taken back.
    expect(await flushAllDue(t)).toHaveLength(0);
    // A flag reopened with the content goes back with the content, never on its own.
    const reopen = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).find(
      (r) => r.action === 'reopen_flag',
    );
    await expect(
      mod.as.mutation(api.undo.run, { actionId: reopen?._id as Id<'moderationActions'> }),
    ).rejects.toThrow(UNDO_WITH_ITS_DECISION);
  });
});

describe('restoreAndDismiss', () => {
  test('restores content already down and dismisses the item’s flags; its undo puts both back', async () => {
    const { t, mod, mod2, f1, flag, reportId } = await world();
    const a = await flag(f1);
    await mod2.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'Hid it from the record sheet',
    });
    const item = await itemOf(t, a);
    await expect(
      mod.as.mutation(api.inboxWrites.takeDown, {
        itemId: item._id,
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow('This is already hidden.');

    const out = await mod.as.mutation(api.inboxWrites.restoreAndDismiss, { itemId: item._id });
    expect(out).toMatchObject({ flagsClosed: 1, undoable: true });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('visible');
    expect((await flagsOf(t, [a]))[0]?.status).toBe('dismissed');
    expect((await itemOf(t, a)).decision).toBe('restored');

    // Undoing a restore takes the content down again, so it asks why.
    await expect(mod.as.mutation(api.undo.run, { actionId: out.actionId })).rejects.toThrow(
      /needs a reason/,
    );
    await mod.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Back down' });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('hidden');
    expect((await flagsOf(t, [a]))[0]?.status).toBe('open');
    expect((await itemOf(t, a)).status).toBe('open');
  });
});

describe('alertVerdict', () => {
  async function alertWorld() {
    const w = await world();
    const putInId = await w.t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: w.waterBodyId,
        coord: { lat: 0.5, lng: 0.001 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const alertId = await w.author.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      reason: 'gate_locked',
      putInId,
    });
    const flagId = await w.f1.as.mutation(api.contentFlags.flag, {
      targetType: 'accessAlert',
      targetId: alertId,
      reason: 'other',
    });
    return { ...w, alertId, flagId };
  }

  test('a pin decides the item: the alert pinned, its flags dismissed, each flagger told once', async () => {
    const { t, mod, f1, alertId, flagId } = await alertWorld();
    const item = await itemOf(t, flagId);
    const out = await mod.as.mutation(api.inboxWrites.alertVerdict, {
      itemId: item._id,
      verb: 'pin',
      reason: 'Town confirmed',
    });
    expect(out).toMatchObject({ verb: 'pin', flagsClosed: 1, undoable: true });
    const alert = await t.run((ctx) => ctx.db.get(alertId));
    expect(alert).toMatchObject({ status: 'official', pinnedByUserId: mod.id });
    expect((await flagsOf(t, [flagId]))[0]?.status).toBe('dismissed');
    expect(await itemOf(t, flagId)).toMatchObject({
      status: 'decided',
      decision: 'pinned',
      decisionActionId: out.actionId,
    });
    const told = await flushAllDue(t);
    expect(told.map((n) => [n.userId, (n.payload as { resolution?: string }).resolution])).toEqual([
      [f1.id, 'dismissed'],
    ]);
  });

  test('a pin’s undo releases the alert and reopens its flags and item; a later write overtakes it', async () => {
    const { t, mod, alertId, flagId } = await alertWorld();
    const out = await mod.as.mutation(api.inboxWrites.alertVerdict, {
      itemId: (await itemOf(t, flagId))._id,
      verb: 'pin',
      reason: 'Town confirmed',
    });
    // Releasing gives nothing back that a reason guards: none asked.
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    const alert = await t.run((ctx) => ctx.db.get(alertId));
    expect(alert?.status).toBe('active');
    expect(alert?.pinnedByUserId).toBeUndefined();
    expect((await flagsOf(t, [flagId]))[0]?.status).toBe('open');
    expect((await itemOf(t, flagId)).status).toBe('open');
    expect(await flushAllDue(t)).toHaveLength(0);

    const again = await mod.as.mutation(api.inboxWrites.alertVerdict, {
      itemId: (await itemOf(t, flagId))._id,
      verb: 'pin',
      reason: 'Town confirmed',
    });
    await mod.as.mutation(api.accessAlerts.retract, { accessAlertId: alertId, reason: 'Wrong' });
    await expect(mod.as.mutation(api.undo.run, { actionId: again.actionId })).rejects.toThrow(
      'Something changed this since; open its history to see what',
    );
  });

  test('a pin is refused: a member, pinned already, retracted, the moderator’s own alert, a decided item', async () => {
    const w = await alertWorld();
    const { t, mod, mod2, member, alertId, flagId } = w;
    const itemId = (await itemOf(t, flagId))._id;
    const pin = (who: { as: ReturnType<T['withIdentity']> }, id = itemId) =>
      who.as.mutation(api.inboxWrites.alertVerdict, { itemId: id, verb: 'pin', reason: 'x' });
    await expect(pin(member)).rejects.toThrow('Requires moderator role');
    await mod2.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'Earlier',
    });
    await expect(pin(mod)).rejects.toThrow(ALERT_PINNED_ALREADY);
    await mod2.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: false,
      reason: 'Released',
    });
    // Its author's withdrawal (once pinned, only staff could retract it; set as a backfill would).
    await t.run((ctx) =>
      ctx.db.patch(alertId, {
        status: 'retracted',
        retractedByUserId: w.author.id,
        retractedAt: Date.now(),
      }),
    );
    await expect(pin(mod)).rejects.toThrow(ALERT_RETRACTED_NO_PIN);

    // The moderator's own alert (D269).
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: w.waterBodyId,
        coord: { lat: 0.5, lng: 0.002 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const own = await mod.as.mutation(api.accessAlerts.create, {
      targetType: 'put_in',
      reason: 'gate_locked',
      putInId,
    });
    const onOwn = await w.f2.as.mutation(api.contentFlags.flag, {
      targetType: 'accessAlert',
      targetId: own,
      reason: 'other',
    });
    const ownItem = (await itemOf(t, onOwn))._id;
    await expect(pin(mod, ownItem)).rejects.toThrow(
      'This is yours, so another moderator decides on it.',
    );
    await pin(mod2, ownItem);
    await expect(pin(mod2, ownItem)).rejects.toThrow(DECIDED_REFUSAL);
  });

  test('a retraction closes the alert’s flags; its undo puts the alert back and reopens them', async () => {
    const { t, mod, alertId, flagId } = await alertWorld();
    const item = await itemOf(t, flagId);
    const before = await t.run((ctx) => ctx.db.get(alertId));
    const out = await mod.as.mutation(api.inboxWrites.alertVerdict, {
      itemId: item._id,
      verb: 'retract',
      reason: 'Wrong lot',
    });
    expect(out).toMatchObject({ verb: 'retract', flagsClosed: 1 });
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('retracted');
    expect((await itemOf(t, flagId)).decision).toBe('retracted');

    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    const after = await t.run((ctx) => ctx.db.get(alertId));
    expect(after?.status).toBe(before?.status);
    expect(after?.expiresAt).toBe(before?.expiresAt);
    expect((await flagsOf(t, [flagId]))[0]?.status).toBe('open');
    expect((await itemOf(t, flagId)).status).toBe('open');
  });

  test('an unpin releases the pin and closes the flags; its undo pins again and reopens them', async () => {
    const { t, mod, mod2, alertId, flagId } = await alertWorld();
    await mod2.as.mutation(api.accessAlerts.setOfficial, {
      accessAlertId: alertId,
      official: true,
      reason: 'Town confirmed',
    });
    const item = await itemOf(t, flagId);
    const out = await mod.as.mutation(api.inboxWrites.alertVerdict, {
      itemId: item._id,
      verb: 'unpin',
      reason: 'Gate open again',
    });
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('active');
    expect((await itemOf(t, flagId)).decision).toBe('unpinned');
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await t.run((ctx) => ctx.db.get(alertId)))?.status).toBe('official');
    expect((await itemOf(t, flagId)).status).toBe('open');
  });

  test('an alert verdict is refused on an item that isn’t about an alert', async () => {
    const { t, mod, f1, flag } = await world();
    const itemId = (await itemOf(t, await flag(f1)))._id;
    await expect(
      mod.as.mutation(api.inboxWrites.alertVerdict, { itemId, verb: 'retract', reason: 'x' }),
    ).rejects.toThrow(NOT_A_CHOICE_REFUSAL);
  });
});

describe('moderation.resolveFlag through the item', () => {
  test('writes its row first, stamps the member, refuses its own filer; its undo reopens', async () => {
    const { t, mod, mod2, f1, flag, author, waterBodyId } = await world();
    const own = await flag(mod2, 'harassment', await report(t, author.id, waterBodyId));
    await expect(
      mod2.as.mutation(api.moderation.resolveFlag, {
        flagId: own,
        resolution: 'dismissed',
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);

    const a = await flag(f1);
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: a,
      resolution: 'actioned',
      reason: 'Spam',
    });
    const item = await itemOf(t, a);
    expect(item).toMatchObject({ status: 'decided', decision: 'actioned' });
    const row = await t.run((ctx) => ctx.db.get(item.decisionActionId as Id<'moderationActions'>));
    expect(row).toMatchObject({ action: 'resolve_flag', targetId: a });
    // Reopening an actioned flag takes nothing away, so no reason is asked.
    await mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> });
    expect((await flagsOf(t, [a]))[0]?.status).toBe('open');
    expect((await itemOf(t, a)).status).toBe('open');
  });
});

describe('ruleAccess', () => {
  async function accessWorld() {
    const w = await world();
    const fileAccess = (who: { as: ReturnType<T['withIdentity']> }) =>
      who.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: w.waterBodyId,
        reason: 'no_public_access',
      });
    const a = await fileAccess(w.f1);
    const b = await fileAccess(w.f2);
    const body = () => w.t.run((ctx) => ctx.db.get(w.waterBodyId));
    return { ...w, fileAccess, a, b, body, itemId: (await itemOf(w.t, a))._id };
  }

  test('no public access closes every report and decides the item; its undo puts both back', async () => {
    const { t, mod, a, b, itemId, body } = await accessWorld();
    const before = await counts(t);
    await expect(
      mod.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'none' }),
    ).rejects.toThrow('A reason is required');
    const out = await mod.as.mutation(api.inboxWrites.ruleAccess, {
      itemId,
      verdict: 'none',
      reason: 'Posted private',
    });
    expect(out).toMatchObject({ itemId, verdict: 'none', flagsClosed: 2, undoable: true });
    expect((await body())?.publicAccess?.verdict).toBe('none');
    expect((await flagsOf(t, [a, b])).map((f) => f?.status)).toEqual(['actioned', 'actioned']);
    expect(await itemOf(t, a)).toMatchObject({
      status: 'decided',
      decision: 'ruled_closed',
      decisionActionId: out.actionId,
    });

    // The undo gives the body back (no ruling): no reason asked.
    await mod.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await body())?.publicAccess).toBeUndefined();
    expect((await flagsOf(t, [a, b])).map((f) => f?.status)).toEqual(['open', 'open']);
    expect((await itemOf(t, a)).status).toBe('open');
    expect(await counts(t)).toEqual(before);
    expect(await flushAllDue(t)).toHaveLength(0);
  });

  test('accessible dismisses the reports (ruled_accessible); a clear leaves them open', async () => {
    const { t, mod, a, itemId, body } = await accessWorld();
    const out = await mod.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'open' });
    expect(out.flagsClosed).toBe(2);
    expect((await itemOf(t, a)).decision).toBe('ruled_accessible');
    // A dispute after the ruling is a new item, which may clear the ruling: its reports stay open.
    const disputer = await person(t, 'disputer');
    const dispute = await disputer.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: (await body())?._id as string,
      reason: 'no_public_access',
      note: 'Gated now',
    });
    const cleared = await mod.as.mutation(api.inboxWrites.ruleAccess, {
      itemId: (await itemOf(t, dispute))._id,
      verdict: null,
    });
    expect(cleared).toMatchObject({ verdict: null, flagsClosed: 0 });
    expect((await body())?.publicAccess).toBeUndefined();
    expect((await itemOf(t, dispute)).status).toBe('open');
  });

  test('refusals: a member, a reporter on staff (D289), a decided item (D283), no ruling to clear', async () => {
    const { t, mod, mod2, member, fileAccess, itemId, waterBodyId } = await accessWorld();
    await expect(
      member.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'open' }),
    ).rejects.toThrow('Requires moderator role');
    await fileAccess(mod2);
    await expect(
      mod2.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'open' }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    await expect(
      mod.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: null }),
    ).rejects.toThrow('There is no ruling to clear.');
    await mod.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'open' });
    await expect(
      mod.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'none', reason: 'x' }),
    ).rejects.toThrow(DECIDED_REFUSAL);
    // An item that isn't an access question.
    const spam = await mod2.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: await report(t, mod2.id, waterBodyId),
      reason: 'spam',
    });
    await expect(
      mod.as.mutation(api.inboxWrites.ruleAccess, {
        itemId: (await itemOf(t, spam))._id,
        verdict: 'open',
      }),
    ).rejects.toThrow('This item is not an access question.');
  });

  test('the Body console’s ruling closes an open Inbox item through the writer, with a decision', async () => {
    const { t, mod, a, waterBodyId } = await accessWorld();
    await mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId,
      verdict: 'none',
      reason: 'Posted private',
    });
    const item = await itemOf(t, a);
    expect(item).toMatchObject({ status: 'decided', decision: 'ruled_closed' });
    const row = await t.run((ctx) => ctx.db.get(item.decisionActionId as Id<'moderationActions'>));
    expect(row?.action).toBe('set_public_access');
    // Clearing a ruling that isn't there is refused on the Body console's lever too.
    await mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> });
    await expect(
      mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId, verdict: null }),
    ).rejects.toThrow('There is no ruling to clear.');
  });

  test('a later write on the body overtakes the ruling’s undo', async () => {
    const { mod, itemId, waterBodyId } = await accessWorld();
    const out = await mod.as.mutation(api.inboxWrites.ruleAccess, { itemId, verdict: 'open' });
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId, curatedBoost: 2 });
    await expect(mod.as.mutation(api.undo.run, { actionId: out.actionId })).rejects.toThrow(
      'Something changed this since; open its history to see what',
    );
  });
});
