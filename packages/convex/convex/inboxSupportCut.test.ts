/**
 * **Support is never served to a viewer without its read** (D37, B01-5): with Support tickets open and
 * decided beside other items, a moderator's every read and every filter — *All open*, *Decided*, each
 * `filter` kind, each lane's tail, the day so far, the lanes' counts and age options, the item and its
 * map, the Overview's card — carries none of them, nor counts them; an admin's does.
 */

import { INBOX_LANES } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
const NOW = Date.now();
const DAY = 86_400_000;
const DAY_START = NOW - 3_600_000;

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

async function world() {
  const t = harness();
  const person = async (subject: string, role: 'member' | 'moderator' | 'admin') => {
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
        role,
        status: 'active' as const,
        createdAt: NOW - 40 * DAY,
      }),
    );
    return { id, as: t.withIdentity({ subject }) };
  };
  const mod = await person('mod', 'moderator');
  const admin = await person('admin', 'admin');
  const skater = await person('skater', 'member');
  const other = await person('other', 'member');
  // Beside the tickets: a flag about the same skater, so a by-person filter has a row to show.
  await other.as.mutation(api.contentFlags.flag, {
    targetType: 'user',
    targetId: skater.id,
    reason: 'spam',
  });
  const open = await skater.as.mutation(api.support.create, { category: 'bug', body: 'Broken' });
  const decided = await skater.as.mutation(api.support.create, {
    category: 'account',
    body: 'Locked out',
  });
  await admin.as.mutation(api.support.resolve, { ticketId: decided });
  // Old enough for every age option, so an age filter would reach them.
  await t.run(async (ctx) => {
    for (const item of await ctx.db.query('inboxItems').collect()) {
      if (item.lane === 'support') {
        await ctx.db.patch(item._id, { filedAt: NOW - 40 * DAY, rankKey: NOW - 40 * DAY });
      }
    }
    await ctx.db.insert('inboxJobRuns', {
      job: 'backfill',
      phase: 'done',
      cursor: null,
      done: true,
      startedAt: 1,
      updatedAt: 1,
    });
  });
  return { t, mod, admin, skater, open, decided };
}

const lanesOf = (rows: { lane: string }[]) => [...new Set(rows.map((r) => r.lane))];

describe('a moderator is served no Support', () => {
  test('in every list and every filter', async () => {
    const w = await world();
    const reads = [
      { lane: 'all' as const },
      { lane: 'decided' as const },
      { lane: 'all' as const, filter: { subjectUserId: w.skater.id } },
      { lane: 'decided' as const, filter: { subjectUserId: w.skater.id } },
      { lane: 'all' as const, filter: { minAgeDays: 30 } },
      { lane: 'decided' as const, filter: { minAgeDays: 30 } },
    ];
    for (const args of reads) {
      const page = await w.mod.as.query(api.inbox.listPage, { ...args, now: NOW });
      expect(lanesOf(page.rows), JSON.stringify(args)).not.toContain('support');
      const asAdmin = await w.admin.as.query(api.inbox.listPage, { ...args, now: NOW });
      expect(lanesOf(asAdmin.rows), `admin ${JSON.stringify(args)}`).toContain('support');
    }
    // The by-person filter still shows the skater's flag to the moderator: the cut is Support's alone.
    const mine = await w.mod.as.query(api.inbox.listPage, {
      lane: 'all',
      filter: { subjectUserId: w.skater.id },
    });
    expect(lanesOf(mine.rows)).toEqual(['contentFlags']);
    await expect(w.mod.as.query(api.inbox.listPage, { lane: 'support' })).rejects.toThrow(
      /Support tickets/,
    );
  });

  test('in the tails, the day, the counts and the age options', async () => {
    const w = await world();
    for (const lane of INBOX_LANES.filter((l) => l !== 'support')) {
      const tail = await w.mod.as.query(api.inbox.tail, { lane, now: NOW });
      expect(lanesOf(tail.rows)).not.toContain('support');
    }
    await expect(w.mod.as.query(api.inbox.tail, { lane: 'support' })).rejects.toThrow(
      /Support tickets/,
    );
    const day = await w.mod.as.query(api.inbox.today, { now: NOW, dayStart: DAY_START });
    expect([...day.filed, ...day.decided].map((d) => d.lane)).not.toContain('support');
    const lanes = await w.mod.as.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    expect(lanes.lanes.map((l) => l.lane)).not.toContain('support');
    expect(lanes.allOpen).toBe(1);
    expect(lanes.decided).toBe(0);
    expect(lanes.today).toEqual({ count: 0, capped: false });
    const adminLanes = await w.admin.as.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    expect(adminLanes.decided).toBe(1);
    expect(
      adminLanes.lanes.find((l) => l.lane === 'support')?.olderThan.find((o) => o.days === 30)
        ?.count.count,
    ).toBe(1);
    expect((await w.mod.as.query(api.console.overview, {})).inbox.support).toBeNull();
  });

  test('by any ref to a ticket, for the item and its map', async () => {
    const w = await world();
    const itemId = await w.t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'supportTickets').eq('sourceId', w.open))
        .first();
      return m?.itemId as Id<'inboxItems'>;
    });
    for (const ref of [`ticket:${w.open}`, w.open, itemId]) {
      await expect(w.mod.as.query(api.inbox.item, { ref })).rejects.toThrow(/Support tickets/);
      await expect(w.mod.as.query(api.inbox.itemMap, { ref })).rejects.toThrow(/Support tickets/);
    }
  });
});
