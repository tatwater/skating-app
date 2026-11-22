/**
 * Ledger editing (D227): a per-person grant on an admin, given and taken only by a holder, never left
 * with no holder, cleared by a demotion, seeded for the founder, undoable (D226), and read on the
 * People page.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { LAST_EDITOR_MESSAGE } from './lib/ledgerEditors';
import { disciplineRefusal, LEDGER_NEUTRAL_REFUSAL } from './lib/peopleCan';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { undoState } from './lib/undo';
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
  moderatorDecision: false,
};

async function seedUser(
  t: T,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
  extra: {
    canEditLedger?: boolean;
    deletionRequestedAt?: number;
    status?: 'active' | 'suspended';
    suspendedUntil?: number;
  } = {},
) {
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
      ...extra,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const editor = (t: T, subject: string) => seedUser(t, subject, 'admin', { canEditLedger: true });

const profile = (t: T, id: Id<'profiles'>) => t.run((ctx) => ctx.db.get(id));

/** Every audit row on a person, oldest first. */
async function rowsOn(t: T, userId: Id<'profiles'>) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').collect());
  return rows.filter((r) => r.targetType === 'user' && r.targetId === userId);
}

async function newestOn(t: T, userId: Id<'profiles'>) {
  const rows = await rowsOn(t, userId);
  const row = rows.at(-1);
  if (!row) throw new Error(`no audit row on ${userId}`);
  return row;
}

describe('ledger.seedEditor (D227: the founder holds it from the start)', () => {
  test('seeds an admin by handle, as the system, once', async () => {
    const t = convexTest(schema, modules);
    const founder = await seedUser(t, 'teagan', 'admin');

    expect(await t.mutation(internal.ledger.seedEditor, { username: '@Teagan' })).toEqual({
      seeded: true,
    });
    expect((await profile(t, founder.id))?.canEditLedger).toBe(true);
    const row = await newestOn(t, founder.id);
    expect(row).toMatchObject({
      action: 'grant_ledger_editor',
      metadata: { seeded: true },
    });
    expect(row.actorId).toBeUndefined();

    // Idempotent: a second run changes nothing and writes nothing.
    expect(await t.mutation(internal.ledger.seedEditor, { username: 'teagan' })).toEqual({
      seeded: false,
    });
    expect(await rowsOn(t, founder.id)).toHaveLength(1);
  });

  test('refuses a handle nobody has, and a profile that is not an admin', async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, 'mod', 'moderator');
    await expect(t.mutation(internal.ledger.seedEditor, { username: 'nobody' })).rejects.toThrow(
      /no profile has the handle/i,
    );
    await expect(t.mutation(internal.ledger.seedEditor, { username: 'mod' })).rejects.toThrow(
      /not an admin/i,
    );
  });
});

describe('ledger.grantEditor', () => {
  test('a holder gives it to another admin, with no reason asked', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await seedUser(t, 'other', 'admin');

    await founder.as.mutation(api.ledger.grantEditor, { userId: other.id });
    expect((await profile(t, other.id))?.canEditLedger).toBe(true);
    expect(await newestOn(t, other.id)).toMatchObject({
      action: 'grant_ledger_editor',
      actorId: founder.id,
      reason: 'Can edit the ledger',
    });

    // And now they can give it on.
    const third = await seedUser(t, 'third', 'admin');
    await other.as.mutation(api.ledger.grantEditor, { userId: third.id, reason: 'books' });
    expect((await profile(t, third.id))?.canEditLedger).toBe(true);
    expect((await newestOn(t, third.id)).reason).toBe('books');
  });

  test('an admin who does not hold it cannot give it, to anyone or themselves', async () => {
    const t = convexTest(schema, modules);
    await editor(t, 'founder');
    const admin = await seedUser(t, 'admin', 'admin');
    const other = await seedUser(t, 'other', 'admin');
    await expect(admin.as.mutation(api.ledger.grantEditor, { userId: other.id })).rejects.toThrow(
      /given ledger editing/i,
    );
    await expect(admin.as.mutation(api.ledger.grantEditor, { userId: admin.id })).rejects.toThrow(
      /given ledger editing/i,
    );
    expect((await profile(t, other.id))?.canEditLedger).toBeUndefined();
    expect((await profile(t, admin.id))?.canEditLedger).toBeUndefined();
  });

  test('a flag on a moderator is inert: they still cannot give it', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator', { canEditLedger: true });
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(mod.as.mutation(api.ledger.grantEditor, { userId: admin.id })).rejects.toThrow(
      /requires admin/i,
    );
  });

  test('only an active admin can be given it, and not twice', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const mod = await seedUser(t, 'mod', 'moderator');
    const member = await seedUser(t, 'member');
    const leaving = await seedUser(t, 'leaving', 'admin', { deletionRequestedAt: Date.now() });

    await expect(founder.as.mutation(api.ledger.grantEditor, { userId: mod.id })).rejects.toThrow(
      /only an admin/i,
    );
    await expect(
      founder.as.mutation(api.ledger.grantEditor, { userId: member.id }),
    ).rejects.toThrow(/only an admin/i);
    await expect(
      founder.as.mutation(api.ledger.grantEditor, { userId: leaving.id }),
    ).rejects.toThrow(/not active/i);
    await expect(
      founder.as.mutation(api.ledger.grantEditor, { userId: founder.id }),
    ).rejects.toThrow(/already edit the ledger/i);
  });

  test('a holder on their way out loses the write', async () => {
    const t = convexTest(schema, modules);
    const leaving = await seedUser(t, 'leaving', 'admin', {
      canEditLedger: true,
      deletionRequestedAt: Date.now(),
    });
    const other = await seedUser(t, 'other', 'admin');
    await expect(leaving.as.mutation(api.ledger.grantEditor, { userId: other.id })).rejects.toThrow(
      /scheduled for deletion/i,
    );
  });
});

describe('ledger.revokeEditor', () => {
  test('a holder takes it from another holder, with a reason', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');

    await expect(
      founder.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: ' ' }),
    ).rejects.toThrow(/reason is required/i);
    await founder.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: 'done' });
    expect((await profile(t, other.id))?.canEditLedger).toBeUndefined();
    expect(await newestOn(t, other.id)).toMatchObject({
      action: 'revoke_ledger_editor',
      actorId: founder.id,
      reason: 'done',
    });

    // And now they cannot act on it.
    await expect(other.as.mutation(api.ledger.grantEditor, { userId: other.id })).rejects.toThrow(
      /given ledger editing/i,
    );
  });

  test('the last holder cannot be revoked; a holder steps down once another exists', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await seedUser(t, 'other', 'admin');

    await expect(
      founder.as.mutation(api.ledger.revokeEditor, { userId: founder.id, reason: 'step down' }),
    ).rejects.toThrow(/last person who can edit the ledger/i);

    await founder.as.mutation(api.ledger.grantEditor, { userId: other.id });
    await founder.as.mutation(api.ledger.revokeEditor, {
      userId: founder.id,
      reason: 'step down',
    });
    expect((await profile(t, founder.id))?.canEditLedger).toBeUndefined();

    // `other` is now the last one, and can't step down either.
    await expect(
      other.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: 'me too' }),
    ).rejects.toThrow(/last person/i);
  });

  test('a holder on their way out does not count toward the last one', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    await seedUser(t, 'leaving', 'admin', {
      canEditLedger: true,
      deletionRequestedAt: Date.now(),
    });
    await expect(
      founder.as.mutation(api.ledger.revokeEditor, { userId: founder.id, reason: 'x' }),
    ).rejects.toThrow(/last person/i);
  });

  test('a suspended holder does not count toward the last one; a lapsed suspension does', async () => {
    // `requireProfile` refuses a suspended holder's every write, so they can neither edit nor pass
    // the grant on: counting them would let the one holder who can act step down and strand it.
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const away = await seedUser(t, 'away', 'admin', {
      canEditLedger: true,
      status: 'suspended',
      suspendedUntil: Date.now() + 86_400_000,
    });
    await expect(
      founder.as.mutation(api.ledger.revokeEditor, { userId: founder.id, reason: 'x' }),
    ).rejects.toThrow(/last person/i);

    await t.run((ctx) => ctx.db.patch(away.id, { suspendedUntil: Date.now() - 1 }));
    await founder.as.mutation(api.ledger.revokeEditor, { userId: founder.id, reason: 'x' });
    expect((await profile(t, founder.id))?.canEditLedger).toBeUndefined();
  });

  test('once the People rows exist, a holder the row shows cannot act never takes a confirmation from one who can', async () => {
    // The check confirms only a few holders' profiles, in name order. Three that sort first and
    // can't act — suspended, on their way out, banned — are passed over on their rows alone, so the
    // fourth, who can, is still found.
    const t = convexTest(schema, modules);
    const day = 86_400_000;
    const ids = [
      (
        await seedUser(t, 'a1', 'admin', {
          canEditLedger: true,
          status: 'suspended',
          suspendedUntil: Date.now() + day,
        })
      ).id,
      (await seedUser(t, 'a2', 'admin', { canEditLedger: true, deletionRequestedAt: Date.now() }))
        .id,
      (await seedUser(t, 'a3', 'admin', { canEditLedger: true })).id,
    ];
    const target = await editor(t, 'target');
    const zed = await editor(t, 'zed');
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[2] as Id<'profiles'>, { status: 'banned' });
      for (const id of [...ids, target.id, zed.id]) await refreshPersonRow(ctx, id);
      await markReady(ctx, 'rows');
    });
    await zed.as.mutation(api.ledger.revokeEditor, { userId: target.id, reason: 'x' });
    expect((await profile(t, target.id))?.canEditLedger).toBeUndefined();
    // The revoke refreshed the row, so the next check reads it as no longer a holder.
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', target.id))
        .first(),
    );
    expect(row?.ledgerEditor).toBe(false);
    await expect(
      zed.as.mutation(api.ledger.revokeEditor, { userId: zed.id, reason: 'x' }),
    ).rejects.toThrow(/last person/i);
  });

  test('refuses someone who does not hold it', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(
      founder.as.mutation(api.ledger.revokeEditor, { userId: admin.id, reason: 'x' }),
    ).rejects.toThrow(/cannot edit the ledger/i);
  });

  test('refuses a profile that no longer exists, either way', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const gone = await seedUser(t, 'gone', 'admin');
    await t.run((ctx) => ctx.db.delete(gone.id));
    await expect(founder.as.mutation(api.ledger.grantEditor, { userId: gone.id })).rejects.toThrow(
      /user not found/i,
    );
    await expect(
      founder.as.mutation(api.ledger.revokeEditor, { userId: gone.id, reason: 'x' }),
    ).rejects.toThrow(/user not found/i);
  });
});

describe('a demotion clears it (D227)', () => {
  test('revoking an editor to member clears the grant, audited before the role row', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');

    await founder.as.mutation(api.admin.revokeRole, { userId: other.id, reason: 'left the team' });
    const after = await profile(t, other.id);
    expect(after?.role).toBe('member');
    expect(after?.canEditLedger).toBeUndefined();

    const rows = await rowsOn(t, other.id);
    expect(rows.map((r) => r.action)).toEqual(['revoke_ledger_editor', 'revoke_role']);
    expect(rows[0]).toMatchObject({
      actorId: founder.id,
      metadata: { cause: 'role_change', role: 'member' },
    });
    // The People row is refreshed once, after the role patch: no holder, no longer staff.
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', other.id))
        .first(),
    );
    expect(row).toMatchObject({ role: 'member', staffRank: 2, ledgerEditor: false });
  });

  test('moving an editor down to moderator clears it too; a promotion back does not restore it', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');

    await founder.as.mutation(api.admin.grantRole, {
      userId: other.id,
      role: 'moderator',
      reason: 'less to do',
    });
    expect((await profile(t, other.id))?.canEditLedger).toBeUndefined();

    await founder.as.mutation(api.admin.grantRole, {
      userId: other.id,
      role: 'admin',
      reason: 'back',
    });
    const after = await profile(t, other.id);
    expect(after?.role).toBe('admin');
    expect(after?.canEditLedger).toBeUndefined();
  });

  test('undoing the demotion gives the role back, not the grant; the cleared row says why', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');

    await founder.as.mutation(api.admin.revokeRole, { userId: other.id, reason: 'oops' });
    const [cleared, demotion] = await rowsOn(t, other.id);
    if (!cleared || !demotion) throw new Error('expected two rows');

    // The role row is the newest on the person, so it keeps its undo.
    await founder.as.mutation(api.undo.run, { actionId: demotion._id, reason: 'misclick' });
    const after = await profile(t, other.id);
    expect(after?.role).toBe('admin');
    expect(after?.canEditLedger).toBeUndefined();

    // The cleared grant isn't undone on its own.
    const history = await founder.as.query(api.moderation.listActions, {
      targetType: 'user',
      targetId: other.id,
    });
    const clearedView = history.find((h) => h.id === cleared._id);
    expect(clearedView?.undo.state).toBe('overtaken');
  });

  test('the cleared row refuses its own undo even when nothing overtook it', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');
    // A cascade row as the demotion writes it, with nothing after it on the person.
    const rowId = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: founder.id,
        action: 'revoke_ledger_editor',
        targetType: 'user',
        targetId: other.id,
        reason: 'No longer an admin (now member)',
        metadata: { cause: 'role_change', role: 'member' },
        createdAt: Date.now(),
      }),
    );
    await expect(founder.as.mutation(api.undo.run, { actionId: rowId })).rejects.toThrow(
      /went with a role change/i,
    );
  });

  test('the last editor cannot be demoted out of admin', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const admin = await seedUser(t, 'admin', 'admin');

    await expect(
      admin.as.mutation(api.admin.revokeRole, { userId: founder.id, reason: 'x' }),
    ).rejects.toThrow(/last person who can edit the ledger/i);
    await expect(
      admin.as.mutation(api.admin.grantRole, {
        userId: founder.id,
        role: 'moderator',
        reason: 'x',
      }),
    ).rejects.toThrow(/last person/i);
    const after = await profile(t, founder.id);
    expect(after?.role).toBe('admin');
    expect(after?.canEditLedger).toBe(true);
    expect(await rowsOn(t, founder.id)).toEqual([]);
  });

  test('a role change that keeps admin, or touches a non-holder, leaves the grant alone', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');
    const mod = await seedUser(t, 'mod', 'moderator');

    // Granting the role they hold is refused as no change at all (the People page's role menu, one
    // rule), and the grant is untouched.
    await expect(
      founder.as.mutation(api.admin.grantRole, { userId: other.id, role: 'admin', reason: 'x' }),
    ).rejects.toThrow('This is their role now.');
    expect((await profile(t, other.id))?.canEditLedger).toBe(true);
    await founder.as.mutation(api.admin.revokeRole, { userId: mod.id, reason: 'x' });
    expect((await rowsOn(t, mod.id)).map((r) => r.action)).toEqual(['revoke_role']);
  });
});

describe('discipline never leaves the ledger without an editor (the governor’s ruling on D227)', () => {
  /** A stand-in admin acting: the last-editor refusal turns on the target alone (`lib/peopleCan`). */
  const ACTOR = { _id: 'acting-admin' as Id<'profiles'>, role: 'admin' as const };
  const refusal = (t: T, id: Id<'profiles'>, lever: 'suspend' | 'ban') =>
    t.run(async (ctx) => {
      const target = await ctx.db.get(id);
      return target ? disciplineRefusal(ctx, ACTOR, target, lever) : 'no such profile';
    });

  test('suspending or banning the last editor who can act is refused, with the demotion’s message', async () => {
    const t = convexTest(schema, modules);
    const only = await editor(t, 'only');
    expect(await refusal(t, only.id, 'suspend')).toBe(LAST_EDITOR_MESSAGE);
    expect(await refusal(t, only.id, 'ban')).toBe(LAST_EDITOR_MESSAGE);
  });

  test('allowed once another editor can act, and for anyone who does not hold it', async () => {
    const t = convexTest(schema, modules);
    const first = await editor(t, 'first');
    await editor(t, 'second');
    const plain = await seedUser(t, 'plain', 'admin');
    for (const id of [first.id, plain.id]) {
      expect(await refusal(t, id, 'suspend')).toBeNull();
      expect(await refusal(t, id, 'ban')).toBeNull();
    }
  });

  test('a suspended second editor does not count: the first is still the last who can act', async () => {
    const t = convexTest(schema, modules);
    const first = await editor(t, 'first');
    await seedUser(t, 'benched', 'admin', {
      canEditLedger: true,
      status: 'suspended',
      suspendedUntil: Date.now() + 86_400_000,
    });
    expect(await refusal(t, first.id, 'suspend')).toBe(LAST_EDITOR_MESSAGE);
  });

  const DAY = 86_400_000;

  test('the ban and suspend writers refuse the last editor who can act, and change nothing', async () => {
    const t = convexTest(schema, modules);
    const only = await editor(t, 'only');
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(
      admin.as.mutation(api.moderation.banUser, { userId: only.id, reason: 'x' }),
    ).rejects.toThrow(LAST_EDITOR_MESSAGE);
    await expect(
      admin.as.mutation(api.moderation.suspendUser, {
        userId: only.id,
        reason: 'x',
        suspendedUntil: Date.now() + DAY,
      }),
    ).rejects.toThrow(LAST_EDITOR_MESSAGE);
    expect((await profile(t, only.id))?.status).toBe('active');
    expect(await rowsOn(t, only.id)).toEqual([]);
  });

  test('with a second editor who can act, both go through', async () => {
    const t = convexTest(schema, modules);
    const first = await editor(t, 'first');
    const second = await editor(t, 'second');
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.moderation.suspendUser, {
      userId: first.id,
      reason: 'x',
      suspendedUntil: Date.now() + DAY,
    });
    expect((await profile(t, first.id))?.status).toBe('suspended');
    // `first` is benched now, so `second` is the last who can act: their ban is refused.
    await expect(
      admin.as.mutation(api.moderation.banUser, { userId: second.id, reason: 'x' }),
    ).rejects.toThrow(LAST_EDITOR_MESSAGE);
    await admin.as.mutation(api.moderation.banUser, { userId: first.id, reason: 'x' });
    expect((await profile(t, first.id))?.status).toBe('banned');
  });

  for (const verb of ['ban', 'suspend'] as const) {
    test(`an undo that puts a ${verb} back is refused once they are the last editor`, async () => {
      const t = convexTest(schema, modules);
      const target = await editor(t, 'target');
      const other = await editor(t, 'other');
      const admin = await seedUser(t, 'admin', 'admin');
      if (verb === 'ban') {
        await admin.as.mutation(api.moderation.banUser, { userId: target.id, reason: 'x' });
      } else {
        await admin.as.mutation(api.moderation.suspendUser, {
          userId: target.id,
          reason: 'x',
          suspendedUntil: Date.now() + DAY,
        });
      }
      await admin.as.mutation(api.moderation.unbanUser, { userId: target.id, reason: 'appeal' });
      const unban = await newestOn(t, target.id);
      // `other` steps down, so `target` is the only editor who can act.
      await target.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: 'x' });

      await expect(
        admin.as.mutation(api.undo.run, { actionId: unban._id, reason: 'appeal overturned' }),
      ).rejects.toThrow(LAST_EDITOR_MESSAGE);
      expect((await profile(t, target.id))?.status).toBe('active');
    });
  }

  test('a page reads that undo’s last-editor refusal masked unless it holds the grant, and the undo itself in full — with or without a People row', async () => {
    const t = convexTest(schema, modules);
    const target = await editor(t, 'target');
    const other = await editor(t, 'other');
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.moderation.banUser, { userId: target.id, reason: 'x' });
    await admin.as.mutation(api.moderation.unbanUser, { userId: target.id, reason: 'appeal' });
    const unban = await newestOn(t, target.id);
    await target.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: 'x' });

    const states = () =>
      t.run(async (ctx) => {
        const viewer = await ctx.db.get(admin.id);
        const row = await ctx.db.get(unban._id as Id<'moderationActions'>);
        if (!viewer || !row) throw new Error('seeded rows missing');
        return {
          // History and Decisions (`list`), read by an admin who doesn't hold the grant.
          page: await undoState(ctx, viewer, row),
          // The toast, in its own scope (`one`): masked the same.
          toast: await undoState(ctx, viewer, row, 'one'),
          // The same page, read by a holder: the sentence is theirs to read.
          holder: await undoState(ctx, { ...viewer, canEditLedger: true }, row),
          // The undo's own write keeps its words for whoever presses it.
          write: await undoState(ctx, viewer, row, 'one', 'write'),
        };
      });
    const want = {
      page: { state: 'unavailable', why: LEDGER_NEUTRAL_REFUSAL },
      toast: { state: 'unavailable', why: LEDGER_NEUTRAL_REFUSAL },
      holder: { state: 'unavailable', why: LAST_EDITOR_MESSAGE },
      write: { state: 'unavailable', why: LAST_EDITOR_MESSAGE },
    };
    expect(await states()).toEqual(want);
    // Before the rows backfill reaches them, their profile is read instead (`afterRowlessProfile`):
    // the same three answers.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', target.id))
        .first();
      if (!row) throw new Error('the writes should have built their row');
      await ctx.db.delete(row._id);
    });
    expect(await states()).toEqual(want);
  });
});

describe('undo (D226)', () => {
  test('undoing a grant takes it away, so it asks a reason', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await seedUser(t, 'other', 'admin');
    await founder.as.mutation(api.ledger.grantEditor, { userId: other.id });
    const grant = await newestOn(t, other.id);

    await expect(founder.as.mutation(api.undo.run, { actionId: grant._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await founder.as.mutation(api.undo.run, { actionId: grant._id, reason: 'wrong admin' });
    expect((await profile(t, other.id))?.canEditLedger).toBeUndefined();
    const undoRow = await newestOn(t, other.id);
    expect(undoRow).toMatchObject({
      action: 'revoke_ledger_editor',
      undoesActionId: grant._id,
      actorId: founder.id,
      reason: 'wrong admin',
    });
  });

  test('undoing a revoke gives it back, with no reason', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await editor(t, 'other');
    await founder.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: 'tidy' });
    const revoke = await newestOn(t, other.id);

    await founder.as.mutation(api.undo.run, { actionId: revoke._id });
    expect((await profile(t, other.id))?.canEditLedger).toBe(true);
    const undoRow = await newestOn(t, other.id);
    expect(undoRow).toMatchObject({ action: 'grant_ledger_editor', undoesActionId: revoke._id });
  });

  test('only a holder undoes either, and History shows it only to a holder', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const admin = await seedUser(t, 'admin', 'admin');
    const other = await seedUser(t, 'other', 'admin');
    await founder.as.mutation(api.ledger.grantEditor, { userId: other.id });
    const grant = await newestOn(t, other.id);

    await expect(
      admin.as.mutation(api.undo.run, { actionId: grant._id, reason: 'no' }),
    ).rejects.toThrow(/given ledger editing/i);
    const forAdmin = await admin.as.query(api.moderation.listActions, {
      targetType: 'user',
      targetId: other.id,
    });
    // Not offered, and not shown: a grant row names its holder, which only a holder learns (D227).
    expect(forAdmin.find((a) => a.id === grant._id)).toBeUndefined();
    const forFounder = await founder.as.query(api.moderation.listActions, {
      targetType: 'user',
      targetId: other.id,
    });
    expect(forFounder[0]?.undo).toEqual({ state: 'available', needsReason: true });
  });

  test("the seeded grant's undo is refused while its holder is the last editor", async () => {
    const t = convexTest(schema, modules);
    const founder = await seedUser(t, 'founder', 'admin');
    await t.mutation(internal.ledger.seedEditor, { username: 'founder' });
    const seed = await newestOn(t, founder.id);
    await expect(
      founder.as.mutation(api.undo.run, { actionId: seed._id, reason: 'test' }),
    ).rejects.toThrow(/last person/i);
    expect((await profile(t, founder.id))?.canEditLedger).toBe(true);
  });
});

describe('profiles.getAdmin: the People row (D227)', () => {
  const ROW = ['ledgerEditor', 'lastLedgerEditor'] as const;

  test('a holder sees the row on an admin, their own page included', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await seedUser(t, 'other', 'admin');

    const onOther = await founder.as.query(api.profiles.getAdmin, { userId: other.id });
    expect(onOther).toMatchObject({ ledgerEditor: false, lastLedgerEditor: false });
    const onSelf = await founder.as.query(api.profiles.getAdmin, { userId: founder.id });
    expect(onSelf).toMatchObject({ ledgerEditor: true, lastLedgerEditor: true });
  });

  test('an admin without it, or a moderator, sees no row and not who holds it', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const admin = await seedUser(t, 'admin', 'admin');
    const mod = await seedUser(t, 'mod', 'moderator');

    for (const viewer of [admin, mod]) {
      for (const userId of [founder.id, admin.id]) {
        const view = await viewer.as.query(api.profiles.getAdmin, { userId });
        for (const key of ROW) expect(view).not.toHaveProperty(key);
      }
    }
  });

  test('a holder on their way out sees no row', async () => {
    const t = convexTest(schema, modules);
    await editor(t, 'founder');
    const leaving = await seedUser(t, 'leaving', 'admin', {
      canEditLedger: true,
      deletionRequestedAt: Date.now(),
    });
    const other = await seedUser(t, 'other', 'admin');
    const view = await leaving.as.query(api.profiles.getAdmin, { userId: other.id });
    for (const key of ROW) expect(view).not.toHaveProperty(key);
  });

  test('History names a holder only to a holder: grant rows are left out for everyone else', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const other = await seedUser(t, 'other', 'admin');
    const admin = await seedUser(t, 'admin', 'admin');
    const mod = await seedUser(t, 'mod', 'moderator');
    await founder.as.mutation(api.ledger.grantEditor, { userId: other.id });
    await founder.as.mutation(api.ledger.revokeEditor, { userId: other.id, reason: 'not needed' });

    const LEDGER = ['grant_ledger_editor', 'revoke_ledger_editor'];
    const onOther = async (viewer: Awaited<ReturnType<typeof seedUser>>) => ({
      people: (
        (await viewer.as.query(api.profiles.getAdmin, { userId: other.id }))?.recentActions ?? []
      ).map((a) => a.action),
      history: (
        await viewer.as.query(api.moderation.listActions, {
          targetType: 'user',
          targetId: other.id,
        })
      ).map((a) => a.action),
      feed: (await viewer.as.query(api.moderation.listActions, {})).map((a) => a.action),
    });

    const seen = await onOther(founder);
    expect(seen.people).toEqual(expect.arrayContaining(LEDGER));
    expect(seen.history).toEqual(expect.arrayContaining(LEDGER));
    for (const viewer of [admin, mod]) {
      const view = await onOther(viewer);
      for (const list of [view.people, view.history, view.feed]) {
        for (const action of LEDGER) expect(list).not.toContain(action);
      }
    }
  });

  test('a moderator or member has no row at all', async () => {
    const t = convexTest(schema, modules);
    const founder = await editor(t, 'founder');
    const mod = await seedUser(t, 'mod', 'moderator', { canEditLedger: true });
    const member = await seedUser(t, 'member');
    for (const userId of [mod.id, member.id]) {
      const view = await founder.as.query(api.profiles.getAdmin, { userId });
      for (const key of ROW) expect(view).not.toHaveProperty(key);
    }
  });
});
