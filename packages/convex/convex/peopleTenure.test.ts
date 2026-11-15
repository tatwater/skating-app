/**
 * A staffer's tenure and role dates read the audit log's undo chains one way (`lib/undoChains`): over
 * any sequence of grants, revokes, role moves and undos of any depth — an undo, an undo of that undo,
 * and on — the dates `people.staffStats` reports equal what a plain replay of the writes produces.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, READY_ROWS, refreshPersonRow } from './lib/peopleRows';
import { cancelledRows } from './lib/undoChains';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;
type Role = 'member' | 'moderator' | 'admin';

beforeEach(() => {
  vi.useFakeTimers();
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

async function seed(t: T, subject: string, role: Role) {
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
      role,
      status: 'active' as const,
      createdAt: 0,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

describe('cancelledRows', () => {
  const row = (id: string, at: number, undoes?: string) =>
    ({
      _id: id,
      createdAt: at,
      _creationTime: at,
      ...(undoes ? { undoesActionId: undoes } : {}),
    }) as unknown as Doc<'moderationActions'>;
  test('pairs cancel from the newest end: undone once is gone, twice is back', () => {
    expect([...cancelledRows([row('a', 1), row('b', 2, 'a')])].sort()).toEqual(['a', 'b']);
    expect([...cancelledRows([row('a', 1), row('b', 2, 'a'), row('c', 3, 'b')])].sort()).toEqual([
      'b',
      'c',
    ]);
    expect(
      [
        ...cancelledRows([row('a', 1), row('b', 2, 'a'), row('c', 3, 'b'), row('d', 4, 'c')]),
      ].sort(),
    ).toEqual(['a', 'b', 'c', 'd']);
    // An undo of a row not read cancels nothing it can see.
    expect(cancelledRows([row('b', 2, 'x')]).size).toBe(0);
  });
});

/** The plain replay: the person's role and dates after each write, an undo putting back the state before. */
interface State {
  role: Role;
  staffSince: number | null;
  roleSince: number | null;
}
type Op = { kind: 'set'; role: Role } | { kind: 'undo' };

describe('tenure equals the replay', () => {
  test('over grants, revokes, moves and undos of any depth', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('set' as const),
              role: fc.constantFrom<Role>('member', 'moderator', 'admin'),
            }),
            fc.constant({ kind: 'undo' as const }),
          ),
          { minLength: 1, maxLength: 7 },
        ),
        async (ops: Op[]) => {
          vi.setSystemTime(T0);
          const t = convexTest(schema, modules);
          await seed(t, 'adm', 'admin');
          const target = await seed(t, 'target', 'member');
          await t.run((ctx) => markReady(ctx, READY_ROWS));
          const adm = t.withIdentity({ subject: 'adm' });
          let state: State = { role: 'member', staffSince: null, roleSince: null };
          // Each row on the person as written: the state before and after it.
          const rows: Array<{ id: Id<'moderationActions'>; before: State; after: State }> = [];
          for (const op of ops) {
            vi.advanceTimersByTime(1_000);
            const now = Date.now();
            if (op.kind === 'set') {
              if (op.role === state.role) continue;
              const ok = await (op.role === 'member'
                ? adm.mutation(api.admin.revokeRole, { userId: target, reason: 'r' })
                : adm.mutation(api.admin.grantRole, { userId: target, role: op.role, reason: 'r' })
              ).then(
                () => true,
                () => false,
              );
              if (!ok) continue;
              const after: State = {
                role: op.role,
                staffSince:
                  op.role === 'member' ? null : state.role === 'member' ? now : state.staffSince,
                roleSince: op.role === 'member' ? null : now,
              };
              const [newest] = await t.run((ctx) =>
                ctx.db
                  .query('moderationActions')
                  .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', target))
                  .order('desc')
                  .take(1),
              );
              rows.push({ id: newest?._id as Id<'moderationActions'>, before: state, after });
              state = after;
            } else {
              const last = rows[rows.length - 1];
              if (!last) continue;
              const ok = await adm.mutation(api.undo.run, { actionId: last.id, reason: 'r' }).then(
                () => true,
                () => false,
              );
              if (!ok) continue;
              const [newest] = await t.run((ctx) =>
                ctx.db
                  .query('moderationActions')
                  .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', target))
                  .order('desc')
                  .take(1),
              );
              rows.push({
                id: newest?._id as Id<'moderationActions'>,
                before: last.after,
                after: last.before,
              });
              state = last.before;
            }
          }
          const stats = await adm.query(api.people.staffStats, { userId: target });
          if (state.role === 'member') {
            expect(stats).toBeNull();
            return;
          }
          expect(stats?.staffSince?.at ?? null).toBe(state.staffSince);
          expect(stats?.roleSince?.at ?? null).toBe(state.roleSince);
        },
      ),
      { numRuns: 30 },
    );
  });
});
