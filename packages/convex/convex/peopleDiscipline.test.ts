/**
 * Discipline on the People page's rule (`lib/peopleCan`): a deletion is never overwritten — by a
 * write or by an undo — a reason is asked only when something is taken away, and flagging is a
 * per-person right staff are exempt from. Plus the flag's subject, stamped at filing.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { FLAGGING_RESTRICTED } from './contentFlags';
import { DISCIPLINE_REFUSALS } from './lib/peopleCan';
import { markReady, READY_ROWS, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
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

async function seed(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

const as = (t: T, subject: string) => t.withIdentity({ subject });
const get = (t: T, id: Id<'profiles'>) => t.run((ctx) => ctx.db.get(id));
const rowsOn = (t: T, id: Id<'profiles'>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('moderationActions').collect()).filter((r) => r.targetId === id),
  );

describe('a deletion is never overwritten by discipline', () => {
  const states = {
    leaving: (now: number) => ({ deletionRequestedAt: now - DAY }),
    deleting: (now: number) => ({
      status: 'deleting' as const,
      deletionRequestedAt: now - 31 * DAY,
    }),
    deleted: (now: number) => ({ status: 'deleted' as const, deletedAt: now }),
  };

  for (const [name, fields] of Object.entries(states)) {
    test(`suspend, ban and lift are refused on an account ${name}, and nothing moves`, async () => {
      const t = convexTest(schema, modules);
      await seed(t, 'mod', { role: 'moderator' });
      const target = await seed(t, 'target', fields(Date.now()));
      const before = await get(t, target);
      const m = as(t, 'mod');
      await expect(
        m.mutation(api.moderation.suspendUser, {
          userId: target,
          reason: 'r',
          suspendedUntil: Date.now() + DAY,
        }),
      ).rejects.toThrow(
        name === 'deleted' ? DISCIPLINE_REFUSALS.statusDeleted : DISCIPLINE_REFUSALS.statusLeaving,
      );
      await expect(
        m.mutation(api.moderation.banUser, { userId: target, reason: 'r' }),
      ).rejects.toThrow();
      await expect(m.mutation(api.moderation.unbanUser, { userId: target })).rejects.toThrow();
      expect(await get(t, target)).toEqual(before);
      expect(await rowsOn(t, target)).toEqual([]);
    });
  }

  test('restricting a right is refused on a tombstone or one being finalized, allowed in the window', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const gone = await seed(t, 'gone', states.deleted(Date.now()));
    const leaving = await seed(t, 'leaving', states.leaving(Date.now()));
    await expect(
      as(t, 'mod').mutation(api.moderation.setPostingPermission, {
        userId: gone,
        permission: 'comments',
        allowed: false,
        reason: 'r',
      }),
    ).rejects.toThrow(DISCIPLINE_REFUSALS.restrictGone);
    await as(t, 'mod').mutation(api.moderation.setPostingPermission, {
      userId: leaving,
      permission: 'comments',
      allowed: false,
      reason: 'r',
    });
    expect((await get(t, leaving))?.canPostComments).toBe(false);
    expect((await get(t, leaving))?.deletionRequestedAt).toBeDefined();
  });

  test('an undo that would put a ban, a suspension or a lift back is refused once the account is leaving — and never offered', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const target = await seed(t, 'target');
    const m = as(t, 'mod');
    await m.mutation(api.moderation.banUser, { userId: target, reason: 'abuse' });
    await m.mutation(api.moderation.unbanUser, { userId: target, reason: 'appeal' });
    const lift = (await rowsOn(t, target)).find((r) => r.action === 'unban');
    if (!lift) throw new Error('no lift row');
    // The person asks to leave; the lift's undo would ban them again mid-window.
    await t.run(async (ctx) => {
      await ctx.db.patch(target, { deletionRequestedAt: Date.now() });
      await refreshPersonRow(ctx, target);
    });
    const history = await m.query(api.people.history, { userId: target });
    const view = history?.rows.find((r) => r.id === lift._id);
    expect(view?.undo).toEqual({ state: 'unavailable', why: DISCIPLINE_REFUSALS.statusLeaving });
    await expect(m.mutation(api.undo.run, { actionId: lift._id, reason: 'oops' })).rejects.toThrow(
      DISCIPLINE_REFUSALS.statusLeaving,
    );
    const after = await get(t, target);
    expect(after?.status).toBe('active');
    expect(after?.deletionRequestedAt).toBeDefined();
  });

  test('a ban’s undo (a lift) is refused on an account being finalized; its status stays the lock', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const target = await seed(t, 'target');
    await as(t, 'mod').mutation(api.moderation.banUser, { userId: target, reason: 'abuse' });
    const ban = (await rowsOn(t, target)).find((r) => r.action === 'ban');
    if (!ban) throw new Error('no ban row');
    await t.run((ctx) => ctx.db.patch(target, { status: 'deleting', deletionRequestedAt: 1 }));
    await expect(as(t, 'mod').mutation(api.undo.run, { actionId: ban._id })).rejects.toThrow();
    expect((await get(t, target))?.status).toBe('deleting');
  });
});

describe('a reason is asked only when something is taken away', () => {
  test('give-backs default their reason, marked; take-aways refuse without one', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const target = await seed(t, 'target');
    const m = as(t, 'mod');
    await expect(
      m.mutation(api.moderation.setPostingPermission, {
        userId: target,
        permission: 'hazards',
        allowed: false,
      }),
    ).rejects.toThrow('A reason is required');
    await m.mutation(api.moderation.setPostingPermission, {
      userId: target,
      permission: 'hazards',
      allowed: false,
      reason: 'pins everywhere',
    });
    await m.mutation(api.moderation.setPostingPermission, {
      userId: target,
      permission: 'hazards',
      allowed: true,
    });
    await expect(
      m.mutation(api.moderation.setBountyPostLimit, { userId: target, limit: 1 }),
    ).rejects.toThrow('A reason is required');
    await m.mutation(api.moderation.setBountyPostLimit, {
      userId: target,
      limit: 1,
      reason: 'asks',
    });
    await m.mutation(api.moderation.setBountyPostLimit, { userId: target, limit: 2 });
    await m.mutation(api.moderation.setBountyPostLimit, { userId: target });
    await m.mutation(api.moderation.suspendUser, {
      userId: target,
      reason: 'cool off',
      suspendedUntil: Date.now() + DAY,
    });
    await m.mutation(api.moderation.unbanUser, { userId: target });
    const rows = await rowsOn(t, target);
    const defaulted = rows.filter((r) => r.metadata?.reasonDefaulted === true).map((r) => r.reason);
    expect(defaulted).toEqual([
      'Hazard posting restored',
      'Bounty limit raised',
      'Bounty limit raised',
      'Lifted',
    ]);
    const history = await m.query(api.people.history, { userId: target });
    expect(history?.rows.filter((r) => !r.reasonGiven)).toHaveLength(4);
  });

  test('a promotion asks no reason, a demotion one — and so do their undos', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'adm', { role: 'admin' });
    const target = await seed(t, 'target');
    const a = as(t, 'adm');
    await a.mutation(api.admin.grantRole, { userId: target, role: 'admin' });
    await expect(
      a.mutation(api.admin.grantRole, { userId: target, role: 'moderator' }),
    ).rejects.toThrow('A reason is required');
    await a.mutation(api.admin.grantRole, {
      userId: target,
      role: 'moderator',
      reason: 'weekdays',
    });
    await expect(a.mutation(api.admin.revokeRole, { userId: target })).rejects.toThrow(
      'A reason is required',
    );
    const history = await a.query(api.people.history, { userId: target });
    const demotion = history?.rows.find((r) => r.action === 'grant_role' && r.reasonGiven);
    // Undoing the demotion puts admin back: a promotion, no reason.
    expect(demotion?.undo).toEqual({ state: 'available', needsReason: false });
    await a.mutation(api.undo.run, { actionId: demotion?.id as Id<'moderationActions'> });
    expect((await get(t, target))?.role).toBe('admin');
    const again = await a.query(api.people.history, { userId: target });
    const undoRow = again?.rows[0];
    // Undoing that undo is a demotion again: it asks why.
    expect(undoRow?.undo).toEqual({ state: 'available', needsReason: true });
  });
});

describe('flagging is a right, and staff are exempt', () => {
  test('switched off, a member can’t flag; switched back without a reason; undo restores it', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const flooder = await seed(t, 'flooder');
    const other = await seed(t, 'other');
    const m = as(t, 'mod');
    await m.mutation(api.moderation.setPostingPermission, {
      userId: flooder,
      permission: 'flagging',
      allowed: false,
      reason: 'floods the queue',
    });
    await expect(
      as(t, 'flooder').mutation(api.contentFlags.flag, {
        targetType: 'user',
        targetId: other,
        reason: 'spam',
      }),
    ).rejects.toThrow(FLAGGING_RESTRICTED);
    const row = (await m.query(api.people.listPage, { lane: 'restricted' })).rows[0];
    expect(row?.restrictions).toEqual(['flagging']);
    const off = (await rowsOn(t, flooder)).find((r) => r.action === 'set_posting_permission');
    const state = (await m.query(api.people.history, { userId: flooder }))?.rows.find(
      (r) => r.id === off?._id,
    )?.undo;
    expect(state).toEqual({ state: 'available', needsReason: false });
    await m.mutation(api.undo.run, { actionId: off?._id as Id<'moderationActions'> });
    expect((await get(t, flooder))?.canFlag).toBe(true);
    await as(t, 'flooder').mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: other,
      reason: 'spam',
    });
  });

  test('switching it off on staff is refused, and a staffer whose flag is off still flags', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'adm', { role: 'admin' });
    const mod = await seed(t, 'mod', { role: 'moderator', canFlag: false });
    const other = await seed(t, 'other');
    await expect(
      as(t, 'adm').mutation(api.moderation.setPostingPermission, {
        userId: mod,
        permission: 'flagging',
        allowed: false,
        reason: 'r',
      }),
    ).rejects.toThrow(DISCIPLINE_REFUSALS.staffFlagging);
    await as(t, 'mod').mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: other,
      reason: 'spam',
    });
  });
});

describe('a flag names whose it is, at filing', () => {
  test('the person flagged; the author of a report; nobody behind a body', async () => {
    const t = convexTest(schema, modules);
    const filer = await seed(t, 'filer');
    const author = await seed(t, 'author');
    const { reportId, bodyId } = await t.run(async (ctx) => {
      const bodyId = await ctx.db.insert('waterBodies', {
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
              [0, 0],
            ],
          ],
        },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      });
      const reportId = await ctx.db.insert('reports', {
        authorId: author,
        waterBodyId: bodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: Date.now(),
        reportTime: Date.now(),
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { reportId, bodyId };
    });
    const f = as(t, 'filer');
    const onUser = await f.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: author,
      reason: 'spam',
    });
    const onReport = await f.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });
    const onBody = await f.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: bodyId,
      reason: 'no_public_access',
    });
    const subject = async (id: Id<'contentFlags'>) =>
      (await t.run((ctx) => ctx.db.get(id)))?.subjectUserId;
    expect(await subject(onUser)).toBe(author);
    expect(await subject(onReport)).toBe(author);
    expect(await subject(onBody)).toBeNull();
    void filer;
  });
});

describe('never no ledger editor, whatever a stale row says', () => {
  test('a write confirms the editors it counted, so a row that missed its refresh only ever refuses', async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => markReady(ctx, READY_ROWS));
    await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    const other = await seed(t, 'other', { role: 'admin', canEditLedger: true });
    const admId = (await t.run((ctx) => ctx.db.query('profiles').collect())).find(
      (p) => p.username === 'adm',
    )?._id as Id<'profiles'>;
    await seed(t, 'third', { role: 'admin', canEditLedger: true });
    await t
      .withIdentity({ subject: 'third' })
      .mutation(api.ledger.revokeEditor, { userId: admId, reason: 'r' });
    // `third` loses the grant on the profile without its row being refreshed, so the row still counts
    // them. A read answers from the rows; the write confirms from the profiles and refuses.
    await t.run(async (ctx) => {
      const third = (await ctx.db.query('profiles').collect()).find((p) => p.username === 'third');
      if (third) await ctx.db.patch(third._id, { canEditLedger: undefined });
    });
    await expect(
      t
        .withIdentity({ subject: 'other' })
        .mutation(api.ledger.revokeEditor, { userId: other, reason: 'r' }),
    ).rejects.toThrow('They are the last person who can edit the ledger');
  });
});
