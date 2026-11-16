/**
 * **A write that is refused, or throws, leaves nothing** (D270, B01-4f): no audit row and no partial
 * write, for every person write and every record write. Each case is a refusal the write makes; the
 * test compares every table such a write touches, before and after.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, TableNames } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12);
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
      createdAt: T0 - 400 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

/** The world a case starts from: staff, a skater, a lake and a Report of theirs. */
async function world() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
  const ids = {
    adm: await seed(t, 'adm', { role: 'admin', canEditLedger: true }),
    plain: await seed(t, 'plain', { role: 'admin' }),
    mod: await seed(t, 'mod', { role: 'moderator' }),
    skater: await seed(t, 'skater'),
    gone: await seed(t, 'gone', { status: 'deleted', deletedAt: T0 - DAY }),
    member: await seed(t, 'member'),
  };
  const report = await t.run(async (ctx) => {
    const body = await ctx.db.insert('waterBodies', {
      name: 'Mascoma Lake',
      searchText: 'Mascoma Lake',
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
      createdAt: T0,
    });
    return ctx.db.insert('reports', {
      authorId: ids.skater,
      waterBodyId: body,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0,
      updatedAt: T0,
    });
  });
  return { t, ids, report };
}

/** Every table a person or record write touches, as it stands. */
const TABLES: TableNames[] = [
  'profiles',
  'peopleRows',
  'peopleCounts',
  'moderationActions',
  'auditSnapshots',
  'contentVerdicts',
  'reports',
  'jobFailures',
];
const snapshot = (t: T) =>
  t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return out;
  });

type World = Awaited<ReturnType<typeof world>>;
type Case = { name: string; write: (w: World) => Promise<unknown> };

const PERSON: Case[] = [
  {
    name: 'a moderator restricting themselves',
    write: ({ t, ids }) =>
      as(t, 'mod').mutation(api.moderation.setPostingPermission, {
        userId: ids.mod,
        permission: 'comments',
        allowed: false,
        reason: 'r',
      }),
  },
  {
    name: 'a moderator banning an admin',
    write: ({ t, ids }) =>
      as(t, 'mod').mutation(api.moderation.banUser, { userId: ids.plain, reason: 'r' }),
  },
  {
    name: 'a ban without a reason',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.moderation.banUser, { userId: ids.skater, reason: '  ' }),
  },
  {
    name: 'a ban of a deleted account',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.moderation.banUser, { userId: ids.gone, reason: 'r' }),
  },
  {
    name: 'a suspension ending in the past',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.moderation.suspendUser, {
        userId: ids.skater,
        reason: 'r',
        suspendedUntil: T0 - 1,
      }),
  },
  {
    name: 'a ban of the last ledger editor',
    write: ({ t, ids }) =>
      as(t, 'plain').mutation(api.moderation.banUser, { userId: ids.adm, reason: 'r' }),
  },
  {
    name: 'a lift of a deleted account',
    write: ({ t, ids }) => as(t, 'adm').mutation(api.moderation.unbanUser, { userId: ids.gone }),
  },
  {
    name: 'flagging switched off on staff',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.moderation.setPostingPermission, {
        userId: ids.mod,
        permission: 'flagging',
        allowed: false,
        reason: 'r',
      }),
  },
  {
    name: 'a bounty limit lowered without a reason',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.moderation.setBountyPostLimit, { userId: ids.skater, limit: 0 }),
  },
  {
    name: 'a reason past the cap',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.moderation.banUser, {
        userId: ids.skater,
        reason: 'x'.repeat(2_001),
      }),
  },
  {
    name: 'an admin changing their own role',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.admin.grantRole, { userId: ids.adm, role: 'moderator' }),
  },
  {
    name: 'a demotion of the last ledger editor',
    write: ({ t, ids }) =>
      as(t, 'plain').mutation(api.admin.revokeRole, { userId: ids.adm, reason: 'r' }),
  },
  {
    name: 'a moderator granting a role',
    write: ({ t, ids }) =>
      as(t, 'mod').mutation(api.admin.grantRole, { userId: ids.skater, role: 'moderator' }),
  },
  {
    name: 'ledger editing given to a member',
    write: ({ t, ids }) => as(t, 'adm').mutation(api.ledger.grantEditor, { userId: ids.skater }),
  },
  {
    name: 'the last ledger editor stepping down',
    write: ({ t, ids }) =>
      as(t, 'adm').mutation(api.ledger.revokeEditor, { userId: ids.adm, reason: 'r' }),
  },
  {
    name: 'a member pulling a person lever',
    write: ({ t, ids }) =>
      as(t, 'member').mutation(api.moderation.banUser, { userId: ids.skater, reason: 'r' }),
  },
];

const RECORD: Case[] = [
  {
    name: 'a restore of what is already up',
    write: ({ t, report }) =>
      as(t, 'adm').mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: report,
        status: 'visible',
      }),
  },
  {
    name: 'a hide without a reason',
    write: ({ t, report }) =>
      as(t, 'adm').mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: report,
        status: 'hidden',
      }),
  },
  {
    name: 'a keep on content its author still has up',
    write: ({ t, report }) =>
      as(t, 'adm').mutation(api.moderation.keepOnRecord, {
        targetType: 'report',
        targetId: report,
        reason: 'r',
      }),
  },
  {
    name: 'an overturn on content its author still has up',
    write: ({ t, report }) =>
      as(t, 'adm').mutation(api.moderation.overturnVerdict, {
        targetType: 'report',
        targetId: report,
      }),
  },
  {
    name: 'a member pulling a record lever',
    write: ({ t, report }) =>
      as(t, 'member').mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: report,
        status: 'hidden',
        reason: 'r',
      }),
  },
  {
    name: 'a record lever on something that does not exist',
    write: ({ t }) =>
      as(t, 'adm').mutation(api.moderation.keepOnRecord, {
        targetType: 'report',
        targetId: 'not-a-report',
        reason: 'r',
      }),
  },
];

describe('a refused write leaves nothing — no audit row, no partial write', () => {
  test.each([...PERSON, ...RECORD])('$name', async ({ write }) => {
    const w = await world();
    const before = await snapshot(w.t);
    await expect(write(w)).rejects.toThrow();
    expect(await snapshot(w.t)).toEqual(before);
  });

  test('every person write and every record write is in the table', () => {
    // A write added to the People writers without a refusal case here fails this.
    const names = (cases: Case[]) =>
      new Set(
        cases.map((c) =>
          String(c.write)
            .match(/api\.(\w+)\.(\w+)/)
            ?.slice(1)
            .join('.'),
        ),
      );
    expect([...names(PERSON)].sort()).toEqual(
      [
        'admin.grantRole',
        'admin.revokeRole',
        'ledger.grantEditor',
        'ledger.revokeEditor',
        'moderation.banUser',
        'moderation.setBountyPostLimit',
        'moderation.setPostingPermission',
        'moderation.suspendUser',
        'moderation.unbanUser',
      ].sort(),
    );
    expect([...names(RECORD)].sort()).toEqual(
      [
        'moderation.keepOnRecord',
        'moderation.overturnVerdict',
        'moderation.setModerationStatus',
      ].sort(),
    );
  });
});
