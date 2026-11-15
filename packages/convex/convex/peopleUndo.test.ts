/**
 * What is offered is what the write accepts — one rule (`lib/peopleCan.writeRefusal`). Over any
 * sequence of person actions, role changes, ledger grants and account-state changes (the deletion
 * window, the finalization lock, the tombstone, the last ledger editor): every undo History offers
 * succeeds when run, and every one it doesn't offer is refused; and every lever `people.person`
 * draws is accepted by its forward write, every one it doesn't draw refused.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
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

type Actor = 'adm' | 'mod';
type Step =
  | { kind: 'right'; by: Actor; permission: 'reports' | 'flagging'; allowed: boolean }
  | { kind: 'limit'; by: Actor; limit: number | undefined }
  | { kind: 'suspend' | 'ban' | 'lift'; by: Actor }
  | { kind: 'role'; role: 'member' | 'moderator' | 'admin' }
  | { kind: 'ledgerGrant' | 'ledgerRevoke' | 'admStepsDown' }
  | { kind: 'state'; state: 'leave' | 'cancel' | 'lock' | 'tombstone' | 'flagOff' };

const actor = fc.constantFrom<Actor>('adm', 'mod');
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('right' as const),
    by: actor,
    permission: fc.constantFrom('reports' as const, 'flagging' as const),
    allowed: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('limit' as const),
    by: actor,
    limit: fc.constantFrom(undefined, 0, 1, 5),
  }),
  fc.record({
    kind: fc.constantFrom('suspend' as const, 'ban' as const, 'lift' as const),
    by: actor,
  }),
  fc.record({
    kind: fc.constant('role' as const),
    role: fc.constantFrom('member' as const, 'moderator' as const, 'admin' as const),
  }),
  fc.record({
    kind: fc.constantFrom('ledgerGrant' as const, 'ledgerRevoke' as const, 'admStepsDown' as const),
  }),
  fc.record({
    kind: fc.constant('state' as const),
    state: fc.constantFrom(
      'leave' as const,
      'cancel' as const,
      'lock' as const,
      'tombstone' as const,
      'flagOff' as const,
    ),
  }),
);

async function apply(t: T, target: Id<'profiles'>, admId: Id<'profiles'>, s: Step): Promise<void> {
  const as = (who: Actor) => t.withIdentity({ subject: who });
  const now = Date.now();
  const run = async (p: Promise<unknown>) => {
    await p.catch(() => undefined);
  };
  switch (s.kind) {
    case 'right':
      return run(
        as(s.by).mutation(api.moderation.setPostingPermission, {
          userId: target,
          permission: s.permission,
          allowed: s.allowed,
          reason: 'r',
        }),
      );
    case 'limit':
      return run(
        as(s.by).mutation(api.moderation.setBountyPostLimit, {
          userId: target,
          ...(s.limit !== undefined ? { limit: s.limit } : {}),
          reason: 'r',
        }),
      );
    case 'suspend':
      return run(
        as(s.by).mutation(api.moderation.suspendUser, {
          userId: target,
          reason: 'r',
          suspendedUntil: now + DAY,
        }),
      );
    case 'ban':
      return run(as(s.by).mutation(api.moderation.banUser, { userId: target, reason: 'r' }));
    case 'lift':
      return run(as(s.by).mutation(api.moderation.unbanUser, { userId: target, reason: 'r' }));
    case 'role':
      return run(
        s.role === 'member'
          ? as('adm').mutation(api.admin.revokeRole, { userId: target, reason: 'r' })
          : as('adm').mutation(api.admin.grantRole, { userId: target, role: s.role, reason: 'r' }),
      );
    case 'ledgerGrant':
      return run(as('adm').mutation(api.ledger.grantEditor, { userId: target }));
    case 'ledgerRevoke':
      return run(as('adm').mutation(api.ledger.revokeEditor, { userId: target, reason: 'r' }));
    case 'admStepsDown':
      return run(as('adm').mutation(api.ledger.revokeEditor, { userId: admId, reason: 'r' }));
    case 'state': {
      const patch: Partial<Doc<'profiles'>> =
        s.state === 'leave'
          ? { deletionRequestedAt: now }
          : s.state === 'cancel'
            ? { deletionRequestedAt: undefined }
            : s.state === 'lock'
              ? { status: 'deleting', deletionRequestedAt: now - 31 * DAY }
              : s.state === 'tombstone'
                ? { status: 'deleted', deletedAt: now, deletionRequestedAt: undefined }
                : { canFlag: false };
      await t.run(async (ctx) => {
        await ctx.db.patch(target, patch);
        await refreshPersonRow(ctx, target);
      });
    }
  }
}

describe('offered is accepted, for undo and for can', () => {
  test('over any sequence of actions on a person', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 8 }),
        actor,
        fc.nat(50),
        fc.constantFrom(
          'undo' as const,
          'restrict',
          'flaggingOff',
          'suspend',
          'ban',
          'lift',
          'promote',
        ),
        async (steps, viewer, pick, check) => {
          const t = convexTest(schema, modules);
          const admId = await seed(t, 'adm', { role: 'admin', canEditLedger: true });
          await seed(t, 'adm2', { role: 'admin' });
          await seed(t, 'mod', { role: 'moderator' });
          const target = await seed(t, 'target');
          await t.run(async (ctx) => {
            await markReady(ctx, 'rows');
            await markReady(ctx, 'flagSubjects');
          });
          for (const s of steps) await apply(t, target, admId, s);
          const v = t.withIdentity({ subject: viewer });

          if (check === 'undo') {
            const history = await v.query(api.people.history, { userId: target });
            const rows = history?.rows ?? [];
            fc.pre(rows.length > 0);
            const row = rows[pick % rows.length];
            if (!row) return;
            const ran = await v.mutation(api.undo.run, { actionId: row.id, reason: 'r' }).then(
              () => true,
              () => false,
            );
            expect(ran, `${row.action} ${JSON.stringify(row.undo)}`).toBe(
              row.undo.state === 'available',
            );
            return;
          }

          const page = await v.query(api.people.person, { userId: target });
          if (!page) throw new Error('no page');
          const can = {
            restrict: page.can.restrict,
            flaggingOff: page.can.flaggingOff,
            suspend: page.can.suspend,
            ban: page.can.ban,
            lift: page.can.lift,
            promote: page.can.role.moderator,
          }[check];
          const write = () => {
            switch (check) {
              case 'restrict':
                return v.mutation(api.moderation.setPostingPermission, {
                  userId: target,
                  permission: 'reports',
                  allowed: false,
                  reason: 'r',
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
                  suspendedUntil: Date.now() + 2 * DAY,
                });
              case 'ban':
                return v.mutation(api.moderation.banUser, { userId: target, reason: 'r' });
              case 'lift':
                return v.mutation(api.moderation.unbanUser, { userId: target });
              case 'promote':
                // A reason exactly when the page would ask one.
                return v.mutation(api.admin.grantRole, {
                  userId: target,
                  role: 'moderator',
                  ...(can.ok && can.needsReason ? { reason: 'r' } : {}),
                });
            }
          };
          const accepted = await write().then(
            () => true,
            () => false,
          );
          expect(can.ok, `${check}: ${JSON.stringify(can)}`).toBe(accepted);
        },
      ),
      {
        numRuns: 60,
        examples: [
          // A member's flagging switched off, then promoted, then given flagging back: undoing that
          // would switch it off on staff, which the write refuses — so it is never offered.
          [
            [
              { kind: 'state', state: 'flagOff' },
              { kind: 'role', role: 'moderator' },
              { kind: 'right', by: 'adm', permission: 'flagging', allowed: true },
            ],
            'adm',
            0,
            'undo',
          ],
        ],
      },
    );
  });
});
