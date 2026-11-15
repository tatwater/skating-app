/**
 * The People reads (B01 §5.7): the lanes and their pages, a person's page and its `can`, history,
 * a staffer's figures and decisions, and the reports trend. The `can` property holds every lever the
 * page draws to the write's own answer, for any viewer and any state the person can be in.
 */
import { MAX_OPEN_BOUNTIES_PER_DAY } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { staffTenure } from './lib/staffTenure';
import { lowerMedian, mergeSources, monthsBetween } from './people';
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

async function seed(
  t: T,
  subject: string,
  over: Partial<Doc<'profiles'>> = {},
): Promise<Id<'profiles'>> {
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

async function ready(t: T) {
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

const BODY = {
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
};

async function report(
  t: T,
  authorId: Id<'profiles'>,
  over: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return t.run(async (ctx) => {
    const waterBodyId = await ctx.db.insert('waterBodies', { ...BODY, createdAt: Date.now() });
    return ctx.db.insert('reports', {
      authorId,
      waterBodyId,
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
      ...over,
    });
  });
}

// ── Pure pieces ──

describe('mergeSources', () => {
  const row = (id: string, createdAt: number) =>
    ({ _id: id, createdAt }) as unknown as Doc<'moderationActions'>;

  test('a capped source never lets an older row in ahead of one it did not read', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.nat(1000), { maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 5 }),
        (times, limit) => {
          // Each source holds rows at its times, newest first; each reads at most `limit` of them.
          let k = 0;
          const all = times.map((ts) =>
            [...ts].sort((a, b) => b - a).map((at) => row(`r${k++}`, at)),
          );
          const sources = all.map((rows) => ({
            rows: rows.slice(0, limit),
            horizon:
              rows.length > limit ? (rows[limit - 1] as Doc<'moderationActions'>).createdAt : null,
          }));
          const merged = mergeSources(sources, limit);
          const truth = all
            .flat()
            .sort((a, b) => b.createdAt - a.createdAt || (a._id < b._id ? 1 : -1));
          // Whatever it returns is a prefix of the true order (ties aside): nothing missing in between.
          merged.rows.forEach((r, i) => {
            expect(r.createdAt).toBe((truth[i] as Doc<'moderationActions'>).createdAt);
          });
          if (!merged.capped) expect(merged.rows.length).toBe(truth.length);
        },
      ),
    );
  });

  test('lowerMedian and monthsBetween', () => {
    expect(lowerMedian([])).toBeNull();
    expect(lowerMedian([5, 1, 3, 9])).toBe(3);
    expect(monthsBetween(Date.UTC(2026, 10, 20), Date.UTC(2027, 1, 2))).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });
});

describe('staffTenure', () => {
  type R = Doc<'moderationActions'>;
  const grant = (at: number, role: string, priorRole?: string, chain: Partial<R> = {}) =>
    ({
      _id: `g${at}`,
      action: 'grant_role',
      createdAt: at,
      metadata: { role, ...(priorRole !== undefined ? { priorRole } : {}) },
      ...chain,
    }) as unknown as R;
  const revoke = (at: number, priorRole: string, chain: Partial<R> = {}) =>
    ({
      _id: `r${at}`,
      action: 'revoke_role',
      createdAt: at,
      metadata: { priorRole },
      ...chain,
    }) as unknown as R;
  /** The rows' chain roots, from the rows themselves. */
  const tenure = (rows: R[], role: 'member' | 'moderator' | 'admin') => {
    const byId = new Map(rows.map((r) => [r._id as string, r]));
    return staffTenure(rows, (r) => byId.get(r.undoRoot ?? r._id) ?? r, role);
  };

  test('a recorded entry is staff since; the newest move is role since', () => {
    expect(
      tenure([grant(5, 'admin', 'moderator'), grant(2, 'moderator', 'member')], 'admin'),
    ).toEqual({
      staffSince: { at: 2, role: 'moderator' },
      roleSince: { at: 5, role: 'admin' },
    });
  });

  test('an unrecorded entry, then a promotion: staff since is not recorded, never the promotion', () => {
    expect(tenure([grant(5, 'admin', 'moderator')], 'admin')).toEqual({
      staffSince: null,
      roleSince: { at: 5, role: 'admin' },
    });
  });

  test('revoked, then granted again: staff since is the new entry', () => {
    expect(
      tenure(
        [grant(9, 'admin', 'member'), grant(1, 'moderator', 'member'), revoke(4, 'moderator')],
        'admin',
      ),
    ).toEqual({ staffSince: { at: 9, role: 'admin' }, roleSince: { at: 9, role: 'admin' } });
    expect(tenure([grant(1, 'moderator', 'member'), revoke(4, 'moderator')], 'moderator')).toEqual({
      staffSince: null,
      roleSince: null,
    });
  });

  test('undone once is gone, undone twice is back with its own time', () => {
    // A revoke undone (the undo a grant at depth 1): the first entry stands.
    expect(
      tenure(
        [
          grant(1, 'moderator', 'member'),
          revoke(5, 'moderator', { undoTop: 1 } as Partial<R>),
          grant(6, 'moderator', 'member', { undoRoot: 'r5', undoDepth: 1 } as Partial<R>),
        ],
        'moderator',
      ),
    ).toEqual({
      staffSince: { at: 1, role: 'moderator' },
      roleSince: { at: 1, role: 'moderator' },
    });
    // A grant undone, then the undo undone: the grant stands again.
    expect(
      tenure(
        [
          grant(3, 'moderator', 'member', { undoTop: 2 } as Partial<R>),
          revoke(4, 'moderator', { undoRoot: 'g3', undoDepth: 1 } as Partial<R>),
          grant(5, 'moderator', 'member', { undoRoot: 'g3', undoDepth: 2 } as Partial<R>),
        ],
        'moderator',
      ),
    ).toEqual({
      staffSince: { at: 3, role: 'moderator' },
      roleSince: { at: 3, role: 'moderator' },
    });
  });

  test('a grant with no priorRole (from before it was recorded) can’t be told from an entry: not recorded', () => {
    expect(tenure([grant(3, 'moderator')], 'moderator')).toEqual({
      staffSince: null,
      roleSince: { at: 3, role: 'moderator' },
    });
  });

  test('a newest move to a role they no longer hold means the change to the present one went unrecorded', () => {
    expect(tenure([grant(3, 'moderator', 'member')], 'admin')).toEqual({
      staffSince: { at: 3, role: 'moderator' },
      roleSince: null,
    });
  });
});

// ── Lanes and pages ──

describe('people.lanes and people.listPage', () => {
  test('a moderator’s lanes lack Appeals open; an admin’s carry it, counted in people', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    await ready(t);
    for (let i = 0; i < 2; i++) {
      await t.run((ctx) =>
        ctx.db.insert('supportTickets', {
          userId: skater,
          clerkUserId: 'skater',
          category: 'account',
          status: 'open',
          body: 'Appeal',
          createdAt: Date.now() + i,
        }),
      );
    }
    const mod = await as(t, 'mod').query(api.people.lanes, {});
    expect(mod.lanes.map((l) => l.lane)).not.toContain('appeals');
    await expect(as(t, 'mod').query(api.people.listPage, { lane: 'appeals' })).rejects.toThrow(
      'only an admin',
    );
    const adm = await as(t, 'adm').query(api.people.lanes, {});
    expect(adm.lanes.find((l) => l.lane === 'appeals')?.count).toEqual({ count: 1, capped: false });
    const page = await as(t, 'adm').query(api.people.listPage, { lane: 'appeals' });
    expect(page.rows.map((r) => r.userId)).toEqual([skater]);
    expect(page.rows[0]?.appeals).toBe(2);
    await expect(as(t, 'adm').query(api.people.listPage, { lane: 'vips' })).rejects.toThrow(
      'no such list',
    );
    await expect(as(t, 'skater').query(api.people.lanes, {})).rejects.toThrow();
  });

  test('each lane in the board’s order', async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await seed(t, 'viewer', { role: 'admin', displayName: 'Zed' });
    await seed(t, 'amod', { role: 'moderator', displayName: 'Amy' });
    await seed(t, 'badmin', { role: 'admin', displayName: 'Bea' });
    const soon = await seed(t, 'soon', { status: 'suspended', suspendedUntil: now + DAY });
    const later = await seed(t, 'later', { status: 'suspended', suspendedUntil: now + 5 * DAY });
    const open = await seed(t, 'open', { status: 'suspended' });
    await seed(t, 'lapsed', { status: 'suspended', suspendedUntil: now - DAY });
    const old = await seed(t, 'old', { createdAt: now - 30 * DAY });
    await seed(t, 'gone', { status: 'deleted', deletedAt: now });
    const leaveLate = await seed(t, 'leaveLate', { deletionRequestedAt: now - DAY });
    const leaveSoon = await seed(t, 'leaveSoon', { deletionRequestedAt: now - 20 * DAY });
    await ready(t);
    const v = as(t, 'viewer');
    const ids = async (lane: string) =>
      (await v.query(api.people.listPage, { lane, now })).rows.map((r) => r.username);
    expect(await ids('staff')).toEqual(['badmin', 'viewer', 'amod']);
    expect(
      (await v.query(api.people.listPage, { lane: 'suspended', now })).rows.map((r) => r.userId),
    ).toEqual([soon, later, open]);
    const susp = (await v.query(api.people.listPage, { lane: 'suspended', now })).rows;
    expect(susp[2]?.suspension).toEqual({ until: null });
    expect(await ids('newest')).not.toContain('old');
    expect(await ids('newest')).not.toContain('gone');
    expect(await ids('everyone')).not.toContain('gone');
    expect(await ids('deleted')).toEqual(['gone']);
    expect(
      (await v.query(api.people.listPage, { lane: 'leaving', now })).rows.map((r) => r.userId),
    ).toEqual([leaveSoon, leaveLate]);
    const found = await v.query(api.people.listPage, { lane: 'everyone', search: '@old', now });
    expect(found.rows.map((r) => r.userId)).toEqual([old]);
  });

  test('Flagged lists the person flagged and the author of flagged content, oldest flag first', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const target = await seed(t, 'target');
    const author = await seed(t, 'author');
    await ready(t);
    const reportId = await report(t, author);
    // Two filings a millisecond apart could share a clock reading, and then the order falls to the
    // ids: the clock is held so the first is strictly older.
    const at = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at);
      await as(t, 'filer').mutation(api.contentFlags.flag, {
        targetType: 'report',
        targetId: reportId,
        reason: 'spam',
      });
      vi.setSystemTime(at + 1_000);
      await as(t, 'filer').mutation(api.contentFlags.flag, {
        targetType: 'user',
        targetId: target,
        reason: 'harassment',
      });
    } finally {
      // A throw above must not leave the file's later tests on a frozen clock.
      vi.useRealTimers();
    }
    const page = await as(t, 'mod').query(api.people.listPage, { lane: 'flagged' });
    expect(page.rows.map((r) => r.userId)).toEqual([author, target]);
    expect(page.rows[0]?.openFlags).toEqual({ onUser: 0, onContent: 1 });
    expect(page.rows[1]?.openFlags).toEqual({ onUser: 1, onContent: 0 });
    expect(page).toMatchObject({ partial: false, reasons: [] });
    const paged = await as(t, 'mod').query(api.people.listPage, { lane: 'flagged', pageSize: 1 });
    expect(paged.isDone).toBe(false);
    const rest = await as(t, 'mod').query(api.people.listPage, {
      lane: 'flagged',
      pageSize: 1,
      cursor: paged.continueCursor,
    });
    expect(rest.rows.map((r) => r.userId)).toEqual([target]);
    expect(rest.isDone).toBe(true);
    void filer;
  });

  test('before the rows backfill finishes, every lane says not ready — not capped', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const { lanes, pending } = await as(t, 'mod').query(api.people.lanes, {});
    expect(pending).toEqual(['rows', 'flagSubjects']);
    const everyone = lanes.find((l) => l.lane === 'everyone');
    expect(everyone).toMatchObject({ count: { count: 1, capped: false }, pending: ['rows'] });
    expect(everyone?.reasons).toEqual([]);
  });
});

// ── A person ──

describe('people.person', () => {
  test('the head, the status note with who and when, the strip, the rights', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator', displayName: 'Matt' });
    await seed(t, 'adm', { role: 'admin' });
    const rob = await seed(t, 'rob', { canPostComments: false, contradictionCount: 3 });
    await ready(t);
    const until = Date.now() + 5 * DAY;
    await as(t, 'mod').mutation(api.moderation.suspendUser, {
      userId: rob,
      reason: 'Cooling off',
      suspendedUntil: until,
    });
    const p = await as(t, 'mod').query(api.people.person, { userId: rob });
    expect(p?.statusNote).toMatchObject({
      action: 'suspend',
      reason: 'Cooling off',
      suspendedUntil: until,
      lapsed: false,
      via: null,
    });
    expect(p?.statusNote?.by?.displayName).toBe('Matt');
    expect(p?.strip.contradictions).toBe(3);
    // Raw trust points are an admin's (D50) on this read.
    expect(p?.strip.trustPoints).toBeNull();
    expect((await as(t, 'adm').query(api.people.person, { userId: rob }))?.strip.trustPoints).toBe(
      0,
    );
    expect(p?.rights).toMatchObject({
      comments: false,
      flagging: true,
      bountyLimit: null,
      effectiveBountyLimit: MAX_OPEN_BOUNTIES_PER_DAY,
      restrictions: ['comments'],
    });
    expect(p?.ledger).toBeNull();
    expect(p?.can.role.admin).toEqual({ ok: false, why: 'Only an admin can change roles.' });
    const never = await seed(t, 'never');
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: never }))?.strip.contradictions,
    ).toBeNull();
    // Not a profile id: no such person, not a validator error.
    expect(await as(t, 'mod').query(api.people.person, { userId: 'x' })).toBeNull();
  });

  test('open flags on the person and on their content, and the hidden content counts', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const rob = await seed(t, 'rob');
    await ready(t);
    const r1 = await report(t, rob);
    const r2 = await report(t, rob);
    await as(t, 'filer').mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: r1,
      reason: 'spam',
    });
    await as(t, 'filer').mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: rob,
      reason: 'spam',
    });
    await as(t, 'mod').mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: r2,
      status: 'hidden',
      reason: 'Unsafe claim',
    });
    const p = await as(t, 'mod').query(api.people.person, { userId: rob });
    expect(p?.strip.openFlags).toEqual({
      onUser: { count: 1, capped: false },
      onContent: { count: 1, capped: false },
    });
    expect(p?.open.flags.map((f) => f.targetType)).toEqual(['report', 'user']);
    // "N filed" is what they filed: an automatic flag naming them as the rater is not one of theirs.
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer,
        targetType: 'report',
        targetId: r2,
        reason: 'spam',
        status: 'open',
        origin: 'auto',
        createdAt: Date.now(),
      }),
    );
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: filer }))?.rights.flagsFiled,
    ).toEqual({ count: 2, capped: false });
    expect(p?.open.appeals).toBeNull();
    expect(p?.hidden).toMatchObject({ total: 1, capped: false });
    expect(p?.hidden.byKind.report).toBe(1);
    const verdicts = await as(t, 'mod').query(api.contentRecord.personVerdicts, {
      userId: rob,
      targetType: 'report',
    });
    expect(verdicts.page[0]?.waterBodyId).not.toBeNull();
    expect(
      (
        await as(t, 'mod').query(api.contentRecord.personVerdicts, {
          userId: rob,
          targetType: 'comment',
        })
      ).page,
    ).toEqual([]);
  });

  test('the ledger row reaches a holder only', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'holder', { role: 'admin', canEditLedger: true });
    await seed(t, 'plain', { role: 'admin' });
    const other = await seed(t, 'other', { role: 'admin' });
    await ready(t);
    const seen = await as(t, 'holder').query(api.people.person, { userId: other });
    expect(seen?.ledger).toEqual({ editor: false, last: false, since: null, sinceCapped: false });
    expect(seen?.can.ledger?.grant).toEqual({ ok: true, needsReason: false });
    expect(seen?.can.ledger?.revoke.ok).toBe(false);
    expect((await as(t, 'plain').query(api.people.person, { userId: other }))?.ledger).toBeNull();
  });
});

// ── can is the write's answer ──

type State =
  | 'member'
  | 'moderator'
  | 'admin'
  | 'lastEditor'
  | 'suspended'
  | 'banned'
  | 'leaving'
  | 'deleting'
  | 'deleted';
type Lever =
  | 'restrict'
  | 'restore'
  | 'flaggingOff'
  | 'suspend'
  | 'ban'
  | 'lift'
  | 'roleAdmin'
  | 'roleModerator'
  | 'roleMember';

function stateFields(state: State, now: number): Partial<Doc<'profiles'>> {
  switch (state) {
    case 'member':
      return {};
    case 'moderator':
      return { role: 'moderator' };
    case 'admin':
      return { role: 'admin' };
    case 'lastEditor':
      return { role: 'admin', canEditLedger: true };
    case 'suspended':
      return { status: 'suspended', suspendedUntil: now + DAY };
    case 'banned':
      return { status: 'banned' };
    case 'leaving':
      return { deletionRequestedAt: now - DAY };
    case 'deleting':
      return { status: 'deleting', deletionRequestedAt: now - 31 * DAY };
    case 'deleted':
      return { status: 'deleted', deletedAt: now };
  }
}

describe('can is what the write answers', () => {
  test('for any viewer, any state, any lever', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'moderator' | 'admin' | 'self'>('moderator', 'admin', 'self'),
        fc.constantFrom<State>(
          'member',
          'moderator',
          'admin',
          'lastEditor',
          'suspended',
          'banned',
          'leaving',
          'deleting',
          'deleted',
        ),
        fc.constantFrom<Lever>(
          'restrict',
          'restore',
          'flaggingOff',
          'suspend',
          'ban',
          'lift',
          'roleAdmin',
          'roleModerator',
          'roleMember',
        ),
        async (viewerKind, state, lever) => {
          // Your own page is a staffer's who can still sign in.
          fc.pre(viewerKind !== 'self' || ['moderator', 'admin', 'lastEditor'].includes(state));
          const t = convexTest(schema, modules);
          const now = Date.now();
          const target = await seed(t, 'target', stateFields(state, now));
          const viewerSubject = viewerKind === 'self' ? 'target' : 'viewer';
          if (viewerKind !== 'self') await seed(t, 'viewer', { role: viewerKind });
          await ready(t);
          const v = as(t, viewerSubject);
          const p = await v.query(api.people.person, { userId: target });
          if (!p) throw new Error('no page');
          const can = {
            restrict: p.can.restrict,
            restore: p.can.restrict,
            flaggingOff: p.can.flaggingOff,
            suspend: p.can.suspend,
            ban: p.can.ban,
            lift: p.can.lift,
            roleAdmin: p.can.role.admin,
            roleModerator: p.can.role.moderator,
            roleMember: p.can.role.member,
          }[lever];
          const write = () => {
            switch (lever) {
              case 'restrict':
                return v.mutation(api.moderation.setPostingPermission, {
                  userId: target,
                  permission: 'reports',
                  allowed: false,
                  reason: 'r',
                });
              case 'restore':
                return v.mutation(api.moderation.setPostingPermission, {
                  userId: target,
                  permission: 'reports',
                  allowed: true,
                });
              case 'flaggingOff':
                return v.mutation(api.moderation.setPostingPermission, {
                  userId: target,
                  permission: 'flagging',
                  allowed: false,
                  reason: 'r',
                });
              case 'suspend':
                return v.mutation(api.moderation.suspendUser, {
                  userId: target,
                  reason: 'r',
                  suspendedUntil: now + 2 * DAY,
                });
              case 'ban':
                return v.mutation(api.moderation.banUser, { userId: target, reason: 'r' });
              case 'lift':
                return v.mutation(api.moderation.unbanUser, { userId: target });
              case 'roleAdmin':
                return v.mutation(api.admin.grantRole, {
                  userId: target,
                  role: 'admin',
                  reason: 'r',
                });
              case 'roleModerator':
                return v.mutation(api.admin.grantRole, {
                  userId: target,
                  role: 'moderator',
                  reason: 'r',
                });
              case 'roleMember':
                return v.mutation(api.admin.revokeRole, { userId: target, reason: 'r' });
            }
          };
          const accepted = await write().then(
            () => true,
            () => false,
          );
          expect(can.ok, `${viewerKind} ${state} ${lever}`).toBe(accepted);
        },
      ),
      { numRuns: 60 },
    );
  });
});
