/**
 * Every delete of an Inbox source takes its member with it (B01-5): the erasers of a withdrawn flag
 * and a withdrawn ask (30 days on), and an account's tickets at finalization (`accountDeletion.test`).
 * A member left behind by a missed hook is the case each eraser's `leaveMember` exists for.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 15, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const PREFS = {
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

async function person(t: T, subject: string) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/** A member left behind for `sourceId`, as a missed hook would leave it. */
async function strayMember(
  t: T,
  sourceTable: 'contentFlags' | 'waterBodyRequests',
  sourceId: string,
) {
  await t.run(async (ctx) => {
    const itemId = await ctx.db.insert('inboxItems', {
      key: `stray:${sourceId}`,
      kind: 'flag',
      lane: 'contentFlags',
      laneOrder: 5,
      facet: 'all',
      status: 'open',
      rankKey: T0,
      filedAt: T0,
      lastActivityAt: T0,
      memberCount: 1,
      refreshedAt: T0,
    });
    await ctx.db.insert('inboxItemMembers', {
      itemId,
      sourceTable,
      sourceId,
      status: 'open',
      filedAt: T0,
    });
  });
}

describe('the erasers', () => {
  test('a withdrawn flag and a withdrawn ask, erased 30 days on, take their members', async () => {
    const t = harness();
    const [a, b] = [await person(t, 'a'), await person(t, 'b')];
    const flagId = await a.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: b.id,
      reason: 'spam',
    });
    await a.as.mutation(api.contentFlags.retract, { flagId });
    const requestId = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: a.id,
        coord: { lat: 1, lng: 1 },
        createdAt: T0,
      }),
    );
    await a.as.mutation(api.corpusRequests.retract, { requestId });
    // The retractions' own hooks already took the members; leave strays, as a missed hook would.
    await strayMember(t, 'contentFlags', flagId);
    await strayMember(t, 'waterBodyRequests', requestId);
    vi.setSystemTime(T0 + 31 * DAY);
    await t.mutation(internal.erasure.eraseDue, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      flag: await ctx.db.get(flagId),
      request: await ctx.db.get(requestId as Id<'waterBodyRequests'>),
      members: (await ctx.db.query('inboxItemMembers').collect()).length,
      items: (await ctx.db.query('inboxItems').collect()).length,
    }));
    expect(left).toEqual({ flag: null, request: null, members: 0, items: 0 });
  });
});
