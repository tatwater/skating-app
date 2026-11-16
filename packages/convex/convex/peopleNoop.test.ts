/**
 * **A write that changes nothing writes nothing** (D270, B01-4f). A person write that would leave the
 * person exactly as they were writes no audit row, offers no undo and returns `changed: false`; a
 * write that is refused or throws leaves no audit row and no partial write.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { NOTHING_TO_UNDO } from './lib/undoTypes';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

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
      createdAt: T0 - 30 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
  return t;
}

const as = (t: T, subject: string) => t.withIdentity({ subject });
const auditRows = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('moderationActions').collect()).length);
/** The person as a write could change them: everything but the bookkeeping of who touched them. */
const personOf = (t: T, id: Id<'profiles'>) =>
  t.run(async (ctx) => {
    const p = (await ctx.db.get(id)) as Doc<'profiles'>;
    const { _creationTime, moderatedByUserId, ...rest } = p;
    void _creationTime;
    void moderatedByUserId;
    return rest;
  });

// biome-ignore lint/suspicious/noExplicitAny: each write's own answer
type Write = (a: ReturnType<typeof as>, id: Id<'profiles'>) => Promise<any>;

/** Each person write, with the state of a person it would leave exactly as they were. */
const NO_OPS: Array<{ name: string; state: Partial<Doc<'profiles'>>; write: Write }> = [
  {
    name: 'a right set to the value it has',
    state: { canPostComments: false },
    write: (a, id) =>
      a.mutation(api.moderation.setPostingPermission, {
        userId: id,
        permission: 'comments',
        allowed: false,
        reason: 'r',
      }),
  },
  {
    name: 'a right given back that was never taken',
    state: {},
    write: (a, id) =>
      a.mutation(api.moderation.setPostingPermission, {
        userId: id,
        permission: 'reports',
        allowed: true,
      }),
  },
  {
    name: 'a bounty limit set to the one in force',
    state: { activeBountyPostLimit: 1 },
    write: (a, id) =>
      a.mutation(api.moderation.setBountyPostLimit, { userId: id, limit: 1, reason: 'r' }),
  },
  {
    name: 'a bounty limit cleared that was never set',
    state: {},
    write: (a, id) => a.mutation(api.moderation.setBountyPostLimit, { userId: id }),
  },
  {
    name: 'the same ban again, same reason',
    state: { status: 'banned', statusReason: 'spam' },
    write: (a, id) => a.mutation(api.moderation.banUser, { userId: id, reason: 'spam' }),
  },
  {
    name: 'the same suspension again, same end and reason',
    state: { status: 'suspended', statusReason: 'cool off', suspendedUntil: T0 + 2 * DAY },
    write: (a, id) =>
      a.mutation(api.moderation.suspendUser, {
        userId: id,
        reason: 'cool off',
        suspendedUntil: T0 + 2 * DAY,
      }),
  },
  {
    name: 'a lift of an account that is active',
    state: {},
    write: (a, id) => a.mutation(api.moderation.unbanUser, { userId: id }),
  },
];

describe('a person write that changes nothing writes nothing', () => {
  test.each(NO_OPS)(
    '$name: no audit row, no undo, changed: false, the person as they were',
    async ({ state, write }) => {
      const t = await setup();
      await seed(t, 'adm', { role: 'admin' });
      const id = await seed(t, 'them', state);
      const before = await personOf(t, id);
      const rows = await auditRows(t);
      const out = await write(as(t, 'adm'), id);
      expect(out).toEqual({ userId: id, changed: false, undoable: false });
      expect(await auditRows(t)).toBe(rows);
      expect(await personOf(t, id)).toEqual(before);
      // Nothing for the toast to offer either.
      expect(
        await as(t, 'adm').query(api.undo.latestOwn, { targetType: 'user', targetId: id }),
      ).toBeNull();
    },
  );

  test('a role already held, or ledger editing already held or not held, is refused: nothing written', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    await seed(t, 'other', { role: 'admin', canEditLedger: true });
    const mod = await seed(t, 'mod', { role: 'moderator' });
    const plain = await seed(t, 'plain', { role: 'admin' });
    const member = await seed(t, 'member');
    const holder = await seed(t, 'holder', { role: 'admin', canEditLedger: true });
    const a = as(t, 'adm');
    const rows = await auditRows(t);
    await expect(
      a.mutation(api.admin.grantRole, { userId: mod, role: 'moderator' }),
    ).rejects.toThrow();
    await expect(a.mutation(api.admin.revokeRole, { userId: member })).rejects.toThrow();
    await expect(a.mutation(api.ledger.grantEditor, { userId: holder })).rejects.toThrow();
    await expect(
      a.mutation(api.ledger.revokeEditor, { userId: plain, reason: 'r' }),
    ).rejects.toThrow();
    expect(await auditRows(t)).toBe(rows);
  });

  /**
   * The rule across writes × states: a write writes a row exactly when it changes the person, says
   * so in `changed`, and never leaves a row behind when it is refused.
   */
  test('over writes × states: a row exactly when the person changed (property)', async () => {
    const STATES: Record<string, Partial<Doc<'profiles'>>> = {
      active: {},
      suspended: { status: 'suspended', statusReason: 'r', suspendedUntil: T0 + 2 * DAY },
      lapsed: { status: 'suspended', statusReason: 'r', suspendedUntil: T0 - DAY },
      banned: { status: 'banned', statusReason: 'r' },
      restricted: { canPostComments: false, activeBountyPostLimit: 0 },
      moderator: { role: 'moderator' },
      admin: { role: 'admin' },
    };
    const WRITES: Record<string, Write> = {
      ban: (a, id) => a.mutation(api.moderation.banUser, { userId: id, reason: 'r' }),
      banOther: (a, id) => a.mutation(api.moderation.banUser, { userId: id, reason: 'again' }),
      suspend: (a, id) =>
        a.mutation(api.moderation.suspendUser, {
          userId: id,
          reason: 'r',
          suspendedUntil: T0 + 2 * DAY,
        }),
      lift: (a, id) => a.mutation(api.moderation.unbanUser, { userId: id }),
      commentsOff: (a, id) =>
        a.mutation(api.moderation.setPostingPermission, {
          userId: id,
          permission: 'comments',
          allowed: false,
          reason: 'r',
        }),
      commentsOn: (a, id) =>
        a.mutation(api.moderation.setPostingPermission, {
          userId: id,
          permission: 'comments',
          allowed: true,
        }),
      bountyZero: (a, id) =>
        a.mutation(api.moderation.setBountyPostLimit, { userId: id, limit: 0, reason: 'r' }),
      bountyClear: (a, id) => a.mutation(api.moderation.setBountyPostLimit, { userId: id }),
      promote: (a, id) => a.mutation(api.admin.grantRole, { userId: id, role: 'moderator' }),
      demote: (a, id) => a.mutation(api.admin.revokeRole, { userId: id, reason: 'r' }),
    };
    const check = async (state: string, write: string) => {
      vi.setSystemTime(T0);
      const t = await setup();
      await seed(t, 'adm', { role: 'admin', canEditLedger: true });
      const id = await seed(t, 'them', STATES[state]);
      const before = await personOf(t, id);
      const rows = await auditRows(t);
      const at = `${state}/${write}`;
      const out = await (WRITES[write] as Write)(as(t, 'adm'), id).catch(() => null);
      const after = await personOf(t, id);
      const written = (await auditRows(t)) - rows;
      if (out === null) {
        // Refused: nothing written, nothing changed.
        expect(written, at).toBe(0);
        expect(after, at).toEqual(before);
        return;
      }
      const changed = JSON.stringify(after) !== JSON.stringify(before);
      expect(out.changed, at).toBe(changed);
      expect(written, at).toBe(changed ? 1 : 0);
      if (!changed) expect(out.undoable, at).toBe(false);
    };
    const same = fc.asyncProperty(
      fc.constantFrom(...Object.keys(STATES)),
      fc.constantFrom(...Object.keys(WRITES)),
      check,
    );
    // Pinned seeds, so a failure replays; then one run on a fresh seed.
    for (const seed of [20261116, 41]) await fc.assert(same, { seed, numRuns: 10 });
    await fc.assert(same, { numRuns: 5 });
  });
});

describe('a row written before D270 that changed nothing offers no undo', () => {
  test('a repeat ban, a repeat suspension and a right set to its own value: nothing to undo', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const banned = await seed(t, 'banned', { status: 'banned', statusReason: 'spam' });
    const suspended = await seed(t, 'suspended', {
      status: 'suspended',
      statusReason: 'cool off',
      suspendedUntil: T0 + 2 * DAY,
    });
    const restricted = await seed(t, 'restricted', { canPostComments: false });
    // As the writes recorded them before: each row's `prev` is what it set.
    const rows = await t.run(async (ctx) => {
      const insert = (
        action: 'ban' | 'suspend' | 'set_posting_permission',
        targetId: Id<'profiles'>,
        reason: string,
        metadata: Record<string, unknown>,
      ) =>
        ctx.db.insert('moderationActions', {
          actorId: adm,
          action,
          targetType: 'user',
          targetId,
          reason,
          metadata,
          createdAt: T0,
        });
      return [
        await insert('ban', banned, 'spam', {
          prev: { status: 'banned', statusReason: 'spam', suspendedUntil: null },
        }),
        await insert('suspend', suspended, 'cool off', {
          suspendedUntil: T0 + 2 * DAY,
          prev: { status: 'suspended', statusReason: 'cool off', suspendedUntil: T0 + 2 * DAY },
        }),
        await insert('set_posting_permission', restricted, 'r', {
          permission: 'comments',
          allowed: false,
          prev: { allowed: false },
        }),
      ];
    });
    const a = as(t, 'adm');
    for (const [i, targetId] of [banned, suspended, restricted].entries()) {
      const toast = await a.query(api.undo.latestOwn, { targetType: 'user', targetId });
      expect(toast?.actionId).toBe(rows[i]);
      expect(toast?.undo).toEqual({ state: 'unavailable', why: NOTHING_TO_UNDO });
      await expect(
        a.mutation(api.undo.run, { actionId: rows[i] as Id<'moderationActions'>, reason: 'r' }),
      ).rejects.toThrow(NOTHING_TO_UNDO);
    }
  });
});

describe('an undo whose write would change nothing is refused, not silently empty', () => {
  test('an undo whose write would change nothing — the person already back as it was, with no row saying so — is refused', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    const a = as(t, 'adm');
    const banned = await a.mutation(api.moderation.banUser, { userId: id, reason: 'first' });
    if (!banned.changed || !banned.undoable) throw new Error('the ban is undoable');
    // Put back to active by a path that wrote no row of its own (as a repair by hand would).
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { status: 'active', statusReason: undefined });
    });
    const rows = await auditRows(t);
    await expect(a.mutation(api.undo.run, { actionId: banned.actionId })).rejects.toThrow(
      NOTHING_TO_UNDO,
    );
    expect(await auditRows(t)).toBe(rows);
  });

  test('undoing a reason change puts the prior reason back, whatever reason the undo gives', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    const a = as(t, 'adm');
    await a.mutation(api.moderation.banUser, { userId: id, reason: 'first' });
    vi.setSystemTime(T0 + 60_000);
    const changed = await a.mutation(api.moderation.banUser, { userId: id, reason: 'again' });
    if (!changed.changed || !changed.undoable) throw new Error('the reason change is undoable');
    await a.mutation(api.undo.run, { actionId: changed.actionId, reason: 'again' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.statusReason).toBe('first');
  });
});

describe('a person first given a row by a status write', () => {
  test('is dated by that write — the list row and the page note agree', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    // No People row yet (the rows backfill hasn't reached them).
    const id = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'rowless',
        displayName: 'rowless',
        username: 'rowless',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member' as const,
        status: 'active' as const,
        createdAt: T0 - 30 * DAY,
      }),
    );
    await as(t, 'adm').mutation(api.moderation.banUser, { userId: id, reason: 'spam' });
    const page = await as(t, 'adm').query(api.people.person, { userId: id });
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', id))
        .first(),
    );
    expect(page?.statusNote?.at).toBe(T0);
    expect(row?.statusSince).toBe(T0);
  });
});

describe('the Clerk mirror: nothing changed must be true of the whole effect', () => {
  /** The Clerk syncs scheduled so far, as `{ banned }` each. */
  const syncs = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((j) => j.name.includes('clerkAdmin') && j.name.includes('setBanned'))
        .map((j) => (j.args[0] as { banned: boolean }).banned),
    );

  test('a ban that lands, then the same ban again: the sync is sent again — no second audit row, no undo', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    const a = as(t, 'adm');
    await a.mutation(api.moderation.banUser, { userId: id, reason: 'spam' });
    expect(await syncs(t)).toEqual([true]);
    // Say the sync gave up: the mirror isn't known to be in step, and pressing again is how an
    // operator repairs it — so the same ban sends it again, and writes nothing else.
    const rows = await auditRows(t);
    const out = await a.mutation(api.moderation.banUser, { userId: id, reason: 'spam' });
    expect(out).toEqual({ userId: id, changed: false, undoable: false });
    expect(await auditRows(t)).toBe(rows);
    expect(await syncs(t)).toEqual([true, true]);
  });

  test('a lift of an active account sends the unlock again, and writes nothing else', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    const rows = await auditRows(t);
    const out = await as(t, 'adm').mutation(api.moderation.unbanUser, { userId: id });
    expect(out).toEqual({ userId: id, changed: false, undoable: false });
    expect(await auditRows(t)).toBe(rows);
    expect(await syncs(t)).toEqual([false]);
  });
});

describe('one normalizer at the write: a reason is compared and kept trimmed', () => {
  test('a raw call with spaces around the same reason changes nothing; a new one is kept trimmed', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    const a = as(t, 'adm');
    await a.mutation(api.moderation.banUser, { userId: id, reason: '  spam  ' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.statusReason).toBe('spam');
    const rows = await auditRows(t);
    const out = await a.mutation(api.moderation.banUser, { userId: id, reason: 'spam ' });
    expect(out).toMatchObject({ changed: false });
    expect(await auditRows(t)).toBe(rows);
    await a.mutation(api.moderation.suspendUser, {
      userId: id,
      reason: ' cool off\n',
      suspendedUntil: T0 + DAY,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.statusReason).toBe('cool off');
  });
});
