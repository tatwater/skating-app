/**
 * The People rows and their counts (B01 §5.7): the row is the profile's, the counts are the rows'.
 * The property holds every lane's count to the rows its own list yields, over any history of writes —
 * the "count equals its list" rule, by construction, checked.
 */
import { DELETION_GRACE_MS, PEOPLE_LANES, type PeopleLane } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  derivePersonRow,
  markReady,
  notePoints,
  OPEN_ENDED,
  REASON_LINE_CHARS,
  reasonLine,
  refreshPersonRow,
  storedLanesOf,
} from './lib/peopleRows';
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

function profileDoc(over: Partial<Doc<'profiles'>> = {}): Doc<'profiles'> {
  return {
    _id: 'p1' as Id<'profiles'>,
    _creationTime: 0,
    clerkUserId: 'c',
    displayName: 'Rob Tremblay',
    username: 'rtremblay',
    driveTimePrefMinutes: 60,
    profileVisibility: 'public',
    notificationPrefs: NOTIF_PREFS,
    dateOfBirth: 0,
    reputationPoints: 12,
    role: 'member',
    status: 'active',
    createdAt: 1_000,
    ...over,
  } as Doc<'profiles'>;
}

describe('derivePersonRow', () => {
  test('a new row: name keys, no recorded status time, no lanes but Everyone', () => {
    const row = derivePersonRow(profileDoc(), null, 5_000);
    expect(row).toMatchObject({
      nameKey: 'rob tremblay',
      searchText: 'Rob Tremblay rtremblay',
      staffRank: 2,
      statusSince: 0,
      suspendedUntil: 0,
      restricted: false,
      leavingUntil: 0,
      live: true,
      refreshedAt: 5_000,
    });
    expect([...storedLanesOf(row)]).toEqual(['everyone']);
    expect(storedLanesOf(null).size).toBe(0);
  });

  test('a status change is stamped when seen, kept while it lasts', () => {
    const first = derivePersonRow(profileDoc(), null, 5_000);
    const banned = derivePersonRow(
      profileDoc({ status: 'banned', statusReason: ' x ' }),
      first,
      6_000,
    );
    expect(banned.statusSince).toBe(6_000);
    expect(banned.statusReason).toBe('x');
    const later = derivePersonRow(profileDoc({ status: 'banned' }), banned, 9_000);
    expect(later.statusSince).toBe(6_000);
    expect(later.statusReason).toBeUndefined();
  });

  test('a long reason is cut to a line, never through a surrogate pair', () => {
    const short = 'Spam';
    expect(reasonLine(short)).toBe(short);
    const exact = 'x'.repeat(REASON_LINE_CHARS);
    expect(reasonLine(exact)).toBe(exact);
    // An emoji (two UTF-16 units) straddling the cut: its high half would be the last unit kept.
    const straddling = `${'x'.repeat(REASON_LINE_CHARS - 1)}🧊 and more`;
    expect(reasonLine(straddling)).toBe('x'.repeat(REASON_LINE_CHARS - 1));
    const whole = `${'x'.repeat(REASON_LINE_CHARS - 2)}🧊 and more`;
    expect(reasonLine(whole)).toBe(`${'x'.repeat(REASON_LINE_CHARS - 2)}🧊`);
    const row = derivePersonRow(
      profileDoc({ status: 'banned', statusReason: straddling }),
      null,
      1,
    );
    expect(row.statusReason).toBe('x'.repeat(REASON_LINE_CHARS - 1));
  });

  test('an open-ended suspension sorts last; a restriction is stamped when it lands', () => {
    const first = derivePersonRow(profileDoc(), null, 1);
    const susp = derivePersonRow(
      profileDoc({ status: 'suspended', canPostComments: false }),
      first,
      2,
    );
    expect(susp.suspendedUntil).toBe(OPEN_ENDED);
    expect(susp.restrictedSince).toBe(2);
    expect(susp.restrictions).toEqual(['comments']);
    expect(derivePersonRow(profileDoc({ canPostComments: false }), susp, 3).restrictedSince).toBe(
      2,
    );
    expect(derivePersonRow(profileDoc({ canPostComments: false }), null, 3).restrictedSince).toBe(
      0,
    );
  });

  test('a tombstone is in Deleted only, whatever role, rights or window it kept', () => {
    const row = derivePersonRow(
      profileDoc({
        status: 'deleted',
        role: 'admin',
        canFlag: false,
        deletionRequestedAt: 10,
        deletedAt: 77,
      }),
      null,
      100,
    );
    expect([...storedLanesOf(row)]).toEqual(['deleted']);
    expect(row.statusSince).toBe(77);
    expect(row.deletedAt).toBe(77);
  });

  test('the window ends the grace after the request', () => {
    const row = derivePersonRow(profileDoc({ deletionRequestedAt: 10 }), null, 100);
    expect(row.leavingUntil).toBe(10 + DELETION_GRACE_MS);
    expect(storedLanesOf(row).has('leaving')).toBe(true);
  });
});

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

describe('refreshPersonRow', () => {
  test('writes nothing when nothing changed, unless asked to touch; a gone profile leaves the counts', async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, 'a');
    const before = await t.run((ctx) => ctx.db.query('peopleRows').first());
    const changed = await t.run((ctx) => refreshPersonRow(ctx, id, { now: Date.now() + 5 }));
    expect(changed).toBe(false);
    expect((await t.run((ctx) => ctx.db.query('peopleRows').first()))?.refreshedAt).toBe(
      before?.refreshedAt,
    );
    const at = Date.now() + 9;
    await t.run((ctx) => refreshPersonRow(ctx, id, { touch: true, now: at }));
    expect((await t.run((ctx) => ctx.db.query('peopleRows').first()))?.refreshedAt).toBe(at);
    await t.run(async (ctx) => {
      await notePoints(ctx, id, 40);
      await notePoints(ctx, 'missing' as Id<'profiles'>, 1);
    });
    expect((await t.run((ctx) => ctx.db.query('peopleRows').first()))?.reputationPoints).toBe(40);
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.run((ctx) => refreshPersonRow(ctx, id))).toBe(true);
    expect(await t.run((ctx) => refreshPersonRow(ctx, id))).toBe(false);
    const counts = await t.run((ctx) => ctx.db.query('peopleCounts').collect());
    expect(counts.find((c) => c.key === 'everyone')?.count).toBe(0);
    await t.run(async (ctx) => {
      await markReady(ctx, 'rows');
      await markReady(ctx, 'rows');
    });
    expect(
      (await t.run((ctx) => ctx.db.query('peopleBackfills').collect())).filter(
        (c) => c.backfill === 'rows' && c.ready,
      ),
    ).toHaveLength(1);
  });
});

// ── The property: every lane's count is the rows its list yields ──

type Op =
  | {
      kind:
        | 'ban'
        | 'unban'
        | 'suspend'
        | 'suspendLapsed'
        | 'suspendOpen'
        | 'request'
        | 'cancel'
        | 'lock'
        | 'tombstone';
      who: number;
    }
  | { kind: 'role'; who: number; role: 'member' | 'moderator' | 'admin' }
  | { kind: 'right'; who: number; field: 'canPostReports' | 'canFlag'; allowed: boolean }
  | { kind: 'limit'; who: number; limit: number | undefined }
  | { kind: 'age'; who: number; days: number };

const PEOPLE = 4;
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constantFrom(
      'ban',
      'unban',
      'suspend',
      'suspendLapsed',
      'suspendOpen',
      'request',
      'cancel',
      'lock',
      'tombstone',
    ),
    who: fc.nat(PEOPLE - 1),
  }) as fc.Arbitrary<Op>,
  fc.record({
    kind: fc.constant('role' as const),
    who: fc.nat(PEOPLE - 1),
    role: fc.constantFrom('member' as const, 'moderator' as const, 'admin' as const),
  }),
  fc.record({
    kind: fc.constant('right' as const),
    who: fc.nat(PEOPLE - 1),
    field: fc.constantFrom('canPostReports' as const, 'canFlag' as const),
    allowed: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('limit' as const),
    who: fc.nat(PEOPLE - 1),
    limit: fc.option(fc.nat(5), { nil: undefined }),
  }),
  fc.record({ kind: fc.constant('age' as const), who: fc.nat(PEOPLE - 1), days: fc.nat(20) }),
);

function patchFor(o: Op, now: number): Partial<Doc<'profiles'>> {
  switch (o.kind) {
    case 'ban':
      return { status: 'banned', suspendedUntil: undefined };
    case 'unban':
      return { status: 'active', suspendedUntil: undefined };
    case 'suspend':
      return { status: 'suspended', suspendedUntil: now + 3 * DAY };
    case 'suspendLapsed':
      return { status: 'suspended', suspendedUntil: now - DAY };
    case 'suspendOpen':
      return { status: 'suspended', suspendedUntil: undefined };
    case 'request':
      return { deletionRequestedAt: now - DAY };
    case 'cancel':
      return { deletionRequestedAt: undefined };
    case 'lock':
      return { status: 'deleting' };
    case 'tombstone':
      return { status: 'deleted', deletedAt: now, deletionRequestedAt: undefined };
    case 'role':
      return { role: o.role };
    case 'right':
      return { [o.field]: o.allowed };
    case 'limit':
      return { activeBountyPostLimit: o.limit };
    case 'age':
      return { createdAt: now - o.days * DAY };
  }
}

/** Every row a lane's list yields, paged two at a time. */
async function pageAll(t: T, lane: PeopleLane, now: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: { rows: { userId: string }[]; isDone: boolean; continueCursor: string } = await t
      .withIdentity({ subject: 'viewer' })
      .query(api.people.listPage, { lane, cursor, pageSize: 2, now });
    ids.push(...page.rows.map((r) => r.userId));
    if (page.isDone) return ids;
    cursor = page.continueCursor;
  }
  throw new Error('a lane never ended');
}

describe('a lane’s count is the rows its list yields, over any history', () => {
  test('stored and time-bound lanes alike', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 14 }), async (ops) => {
        const t = convexTest(schema, modules);
        const now = Date.now();
        await seed(t, 'viewer', { role: 'admin' });
        const ids: Id<'profiles'>[] = [];
        for (let i = 0; i < PEOPLE; i++) ids.push(await seed(t, `p${i}`));
        await t.run(async (ctx) => {
          await markReady(ctx, 'rows');
          await markReady(ctx, 'flagSubjects');
        });
        for (const o of ops) {
          const id = ids[o.who] as Id<'profiles'>;
          await t.run(async (ctx) => {
            await ctx.db.patch(id, patchFor(o, now));
            await refreshPersonRow(ctx, id, { now });
          });
        }
        const { lanes } = await t
          .withIdentity({ subject: 'viewer' })
          .query(api.people.lanes, { now });
        for (const lane of PEOPLE_LANES) {
          if (lane === 'flagged' || lane === 'appeals') continue;
          const count = lanes.find((l) => l.lane === lane)?.count;
          const rows = await pageAll(t, lane, now);
          expect(new Set(rows).size, lane).toBe(rows.length);
          expect(count, lane).toEqual({ count: rows.length, capped: false });
        }
      }),
      { numRuns: 12 },
    );
  });
});
