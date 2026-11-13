/**
 * Ledger editing (D227): a per-person grant on an admin, given and taken only by a holder, never left
 * with no holder, cleared by a demotion, seeded for the founder, undoable (D226), and read on the
 * People page.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
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

    await founder.as.mutation(api.admin.grantRole, {
      userId: other.id,
      role: 'admin',
      reason: 'x',
    });
    expect((await profile(t, other.id))?.canEditLedger).toBe(true);
    await founder.as.mutation(api.admin.revokeRole, { userId: mod.id, reason: 'x' });
    expect((await rowsOn(t, mod.id)).map((r) => r.action)).toEqual(['revoke_role']);
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

  test('only a holder undoes either, and History offers it only to a holder', async () => {
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
    expect(forAdmin[0]?.undo.state).toBe('unavailable');
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
