/**
 * **A source the backfill hasn't reached gets the rule's answer all the same** (B01-5, D283, D289):
 * every deciding mutation asks the Inbox's rule through the source's item, filing it first through
 * the one writer when it has none — so the staffer who filed a ticket, a flag, an ask or a drawing is
 * refused, and a decided one takes no second decision, with or without a prior item; and a decision
 * on a source with no item lands on a decided item.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { DECIDED_REFUSAL, OWN_FILING_REFUSAL } from './lib/inboxRules';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

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
const SQUARE = {
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
};

/** Two admins and a skater, and no Inbox rows at all: every source below is written raw. */
async function world() {
  const t = harness();
  const ids = await t.run(async (ctx) => {
    const person = (n: string, role: 'member' | 'admin') =>
      ctx.db.insert('profiles', {
        clerkUserId: n,
        displayName: `${n} Test-Person`,
        username: n,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active',
        createdAt: 1,
      });
    return {
      me: await person('me', 'admin'),
      other: await person('other', 'admin'),
      skater: await person('skater', 'member'),
    };
  });
  return {
    t,
    ...ids,
    me: { id: ids.me, as: t.withIdentity({ subject: 'me' }) },
    other: t.withIdentity({ subject: 'other' }),
  };
}

const noItems = (t: T) => t.run((ctx) => ctx.db.query('inboxItems').collect());

async function itemOf(t: T, sourceId: string) {
  return t.run(async (ctx) => {
    const member = (await ctx.db.query('inboxItemMembers').collect()).find(
      (m) => m.sourceId === sourceId,
    );
    return member ? ctx.db.get(member.itemId) : null;
  });
}

describe('a deciding mutation on a source with no Inbox item', () => {
  test('support.resolve: the filer is refused, another resolves onto a decided item, and a second resolve is refused', async () => {
    const w = await world();
    const ticket = await w.t.run((ctx) =>
      ctx.db.insert('supportTickets', {
        userId: w.me.id,
        category: 'bug',
        body: 'x',
        status: 'open',
        createdAt: NOW - 1000,
      }),
    );
    expect(await noItems(w.t)).toEqual([]);
    await expect(w.me.as.mutation(api.support.resolve, { ticketId: ticket })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
    // The refusal rolled its filing back with it.
    expect(await noItems(w.t)).toEqual([]);
    await w.other.mutation(api.support.resolve, { ticketId: ticket });
    expect(await itemOf(w.t, ticket)).toMatchObject({ status: 'decided', decision: 'resolved' });
    await expect(w.other.mutation(api.support.resolve, { ticketId: ticket })).rejects.toThrow(
      DECIDED_REFUSAL,
    );
  });

  test('support.resolve: a ticket decided before the Inbox existed takes no second resolve', async () => {
    const w = await world();
    const ticket = await w.t.run((ctx) =>
      ctx.db.insert('supportTickets', {
        userId: w.skater,
        category: 'bug',
        body: 'x',
        status: 'resolved',
        resolvedAt: NOW - 500,
        createdAt: NOW - 1000,
      }),
    );
    await expect(w.other.mutation(api.support.resolve, { ticketId: ticket })).rejects.toThrow(
      DECIDED_REFUSAL,
    );
    expect((await w.t.run((ctx) => ctx.db.get(ticket)))?.resolvedByUserId).toBeUndefined();
  });

  test('moderation.resolveFlag: the flagger is refused; another decides onto a decided item', async () => {
    const w = await world();
    const flag = await w.t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: w.me.id,
        targetType: 'user',
        targetId: w.skater,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        subjectUserId: w.skater,
        createdAt: NOW - 1000,
      }),
    );
    const args = { flagId: flag, resolution: 'dismissed' as const, reason: 'fine' };
    await expect(w.me.as.mutation(api.moderation.resolveFlag, args)).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
    await w.other.mutation(api.moderation.resolveFlag, args);
    expect(await itemOf(w.t, flag)).toMatchObject({ status: 'decided', decision: 'dismissed' });
  });

  test('corpusRequests.decline: the asker is refused; another declines onto a decided item; again is refused', async () => {
    const w = await world();
    const ask = await w.t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: w.me.id,
        coord: { lat: 1, lng: 1 },
        createdAt: NOW - 1000,
      }),
    );
    await expect(
      w.me.as.mutation(api.corpusRequests.decline, { requestId: ask, note: 'no' }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    await w.other.mutation(api.corpusRequests.decline, { requestId: ask, note: 'no' });
    expect(await itemOf(w.t, ask)).toMatchObject({ status: 'decided', decision: 'declined' });
    await expect(
      w.other.mutation(api.corpusRequests.decline, { requestId: ask, note: 'no' }),
    ).rejects.toThrow();
  });

  test('waterBodies.approve: the drawer is refused; another approves onto a decided item', async () => {
    const w = await world();
    const body = await w.t.run(
      async (ctx) =>
        (await ctx.db.insert('waterBodies', {
          name: 'Drawn',
          searchText: 'Drawn',
          type: 'lakePond',
          source: 'user',
          dedupStatus: 'clean',
          reviewStatus: 'pending',
          createdByUserId: w.me.id,
          polygon: SQUARE,
          centroid: { lat: 0.5, lng: 0.5 },
          bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
          createdAt: NOW - 1000,
        } as never)) as Id<'waterBodies'>,
    );
    await expect(w.me.as.mutation(api.waterBodies.approve, { waterBodyId: body })).rejects.toThrow(
      OWN_FILING_REFUSAL,
    );
    await w.other.mutation(api.waterBodies.approve, { waterBodyId: body });
    expect(await itemOf(w.t, body)).toMatchObject({ status: 'decided', decision: 'approved' });
  });
});
