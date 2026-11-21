/**
 * The Inbox's backfill and drift repair (B01-5): bounded on bytes as well as rows, resumable from any
 * cursor, idempotent, and never wedged — an item that can't be done is recorded in `jobFailures` and
 * stepped past, and retried by the repair until it goes through.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { BACKFILL_PHASES, ITEM_BYTES } from './inboxItems';
import { ROW_MAX } from './lib/readBudget';
import * as recurringWork from './lib/recurringWork';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

afterEach(() => vi.restoreAllMocks());

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
};

/** Source rows written raw, as before the hooks: nothing files an item for them. */
async function seedRaw(t: T) {
  return t.run(async (ctx) => {
    const person = (n: string) =>
      ctx.db.insert('profiles', {
        clerkUserId: n,
        displayName: `${n} Test-Person`,
        username: n,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: 1,
      });
    const [a, b, c] = [await person('a'), await person('b'), await person('c')];
    const flag = (flaggerId: Id<'profiles'>, status: Doc<'contentFlags'>['status'], at: number) =>
      ctx.db.insert('contentFlags', {
        flaggerId,
        targetType: 'user',
        targetId: c,
        reason: 'spam',
        status,
        origin: 'user',
        subjectUserId: c,
        createdAt: at,
        ...(status === 'actioned' ? { resolvedAt: at + 10, resolvedByUserId: b } : {}),
      });
    await flag(a, 'open', 100);
    await flag(b, 'open', 200);
    await flag(a, 'actioned', 50);
    await ctx.db.insert('waterBodyRequests', {
      kind: 'admit',
      status: 'open',
      requesterId: a,
      coord: { lat: 1, lng: 1 },
      createdAt: 300,
    });
    await ctx.db.insert('waterBodyRequests', {
      kind: 'admit',
      status: 'declined',
      requesterId: b,
      coord: { lat: 2, lng: 2 },
      createdAt: 40,
      decidedAt: 60,
      decidedByUserId: c,
    });
    await ctx.db.insert('supportTickets', {
      userId: a,
      category: 'bug',
      body: 'x',
      status: 'in_progress',
      createdAt: 400,
    });
    await ctx.db.insert('supportTickets', {
      userId: b,
      category: 'other',
      body: 'y',
      status: 'resolved',
      createdAt: 30,
      resolvedAt: 35,
    });
    return { a, b, c };
  });
}

async function runToDone(t: T, args: { pageCap?: number; budgetBytes?: number } = {}) {
  let passes = 0;
  for (;;) {
    const r = await t.mutation(internal.inboxItems.backfill, args);
    passes++;
    if (r.done) return passes;
    if (passes > 200) throw new Error('the backfill did not finish');
  }
}

/** The stored Inbox as comparable data: items, members and counts, without ids or clocks. */
async function snapshot(t: T) {
  return t.run(async (ctx) => {
    const items = await ctx.db.query('inboxItems').collect();
    const members = await ctx.db.query('inboxItemMembers').collect();
    const keyOf = new Map(items.map((i) => [i._id as string, i.key]));
    return {
      items: items
        .map((i) => `${i.key}|${i.status}|${i.memberCount}|${i.filedAt}|${i.decision ?? ''}`)
        .sort(),
      members: members
        .map((m) => `${keyOf.get(m.itemId)}|${m.sourceTable}|${m.status}|${m.filedByUserId ?? ''}`)
        .sort(),
      counts: (await ctx.db.query('inboxCounts').collect())
        .filter((c) => c.count !== 0)
        .map((c) => `${c.key}=${c.count}`)
        .sort(),
    };
  });
}

describe('inboxItems:backfill', () => {
  test('files every open source and the decided history, then says done', async () => {
    const t = harness();
    await seedRaw(t);
    await runToDone(t);
    const s = await snapshot(t);
    expect(s.counts).toEqual(
      [
        'decided=3',
        'decided:support=1',
        'open:contentFlags=1',
        'open:contentFlags:people=1',
        'open:requests=1',
        'open:requests:admit=1',
        'open:support=1',
        'open:support:bug=1',
      ].sort(),
    );
    // Two open flags on one person are one question; the resolved one is its own decided item.
    expect(
      s.items.filter((i) => i.startsWith('flag:')).map((i) => i.split('|').slice(1).join('|')),
    ).toEqual(['decided|1|50|actioned', 'open|2|100|']);
    const run = await t.run((ctx) => ctx.db.query('inboxJobRuns').first());
    expect(run).toMatchObject({ job: 'backfill', done: true, phase: BACKFILL_PHASES.at(-1) });
  });

  test('idempotent: a second run, from the start, changes nothing', async () => {
    const t = harness();
    await seedRaw(t);
    await runToDone(t);
    const first = await snapshot(t);
    expect(await t.mutation(internal.inboxItems.backfill, {})).toMatchObject({ done: true });
    await t.mutation(internal.inboxItems.backfill, { restart: true });
    await runToDone(t);
    expect(await snapshot(t)).toEqual(first);
  });

  test('resumable from any cursor: a page of one row at a time ends where one pass does', async () => {
    const whole = harness();
    await seedRaw(whole);
    await runToDone(whole);
    const paged = harness();
    await seedRaw(paged);
    const passes = await runToDone(paged, { pageCap: 1 });
    expect(passes).toBeGreaterThan(BACKFILL_PHASES.length);
    expect(await snapshot(paged)).toEqual(await snapshot(whole));
  });

  test('bounded on bytes: a budget that holds one row and its work ends the pass and reschedules', async () => {
    const t = harness();
    await seedRaw(t);
    // One flag row at its worst plus one item's work, and not two.
    const budgetBytes = ROW_MAX.contentFlag + ITEM_BYTES + 1;
    const pass = await t.mutation(internal.inboxItems.backfill, { budgetBytes });
    expect(pass).toMatchObject({ phase: 'flags:open', read: 1, done: false });
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(
      scheduled.some((s) => s.name.includes('inboxItems') && s.name.includes('backfill')),
    ).toBe(true);
    expect(scheduled.at(-1)?.args[0]).toMatchObject({ budgetBytes });
  });

  test('an item that cannot be done is recorded and stepped past; the repair retries it', async () => {
    const t = harness();
    await seedRaw(t);
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    const poisoned = `contentFlags:${flags[0]?._id}`;
    const real = recurringWork.asItem;
    const spy = vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    await runToDone(t, { pageCap: 1 });
    const failures = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(failures.map((f) => [f.job, f.key])).toEqual([['inboxBackfill', poisoned]]);
    // The rest went through: the other open flag is filed.
    expect((await snapshot(t)).counts).toContain('open:contentFlags=1');
    spy.mockRestore();
    // The repair's pass retries it, and clears it once it goes through.
    await t.mutation(internal.inboxItems.repair, {});
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
    const flagItem = (await snapshot(t)).items.find(
      (i) => i.startsWith('flag:') && i.includes('|open|'),
    );
    expect(flagItem).toMatch(/\|open\|2\|/);
  });
});

describe('inboxItems:repair', () => {
  test('re-derives drifted items, then finds nothing; a failing item is recorded and moved back', async () => {
    const t = harness();
    const { a } = await seedRaw(t);
    await runToDone(t);
    const good = await snapshot(t);
    // Drift three ways: a wrong count, a member whose flag was closed unhooked, a lost member.
    await t.run(async (ctx) => {
      const items = await ctx.db.query('inboxItems').collect();
      const flagItem = items.find(
        (i) => i.kind === 'flag' && i.status === 'open',
      ) as Doc<'inboxItems'>;
      await ctx.db.patch(flagItem._id, { memberCount: 7 });
      const ticket = items.find(
        (i) => i.kind === 'ticket' && i.status === 'open',
      ) as Doc<'inboxItems'>;
      await ctx.db.patch(ticket._id, { rankKey: 1 });
    });
    const first = await t.mutation(internal.inboxItems.repair, {});
    expect(first.fixed).toBeGreaterThanOrEqual(2);
    expect(await snapshot(t)).toEqual(good);
    expect((await t.mutation(internal.inboxItems.repair, {})).fixed).toBe(0);

    // A source closed without its hook: the repair closes its member.
    await t.run(async (ctx) => {
      const open = (await ctx.db.query('contentFlags').collect()).filter(
        (f) => f.status === 'open',
      );
      for (const f of open) await ctx.db.patch(f._id, { status: 'dismissed', resolvedAt: 900 });
    });
    await t.mutation(internal.inboxItems.repair, {});
    expect((await snapshot(t)).counts).not.toContain('open:contentFlags=1');

    // An item whose repair throws: recorded, and moved to the back of the walk.
    const item = await t.run(async (ctx) =>
      (await ctx.db.query('inboxItems').collect()).find((i) => i.status === 'open'),
    );
    if (!item) throw new Error('no open item');
    const real = recurringWork.asItem;
    vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === item._id) throw new Error('too heavy');
      return real(key, work);
    });
    const failed = await t.mutation(internal.inboxItems.repair, {});
    expect(failed.failed).toBe(1);
    const after = await t.run((ctx) => ctx.db.get(item._id));
    expect(after?.refreshedAt).toBeGreaterThan(item.refreshedAt);
    expect(
      (await t.run((ctx) => ctx.db.query('jobFailures').collect())).map((f) => [f.job, f.key]),
    ).toEqual([['inboxRepair', item._id]]);
    void a;
  });

  test('the retry’s read is charged: a pass whose walk spent the budget retries none, the next does', async () => {
    const t = harness();
    await seedRaw(t);
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    const poisoned = `contentFlags:${flags[0]?._id}`;
    const real = recurringWork.asItem;
    const spy = vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      if (key === poisoned) throw new Error('too heavy');
      return real(key, work);
    });
    await runToDone(t);
    spy.mockRestore();
    // One open item's worth and a little: the walk reads it, the decided walk and the retry none.
    const tight = await t.mutation(internal.inboxItems.repair, {
      pageCap: 1,
      budgetBytes: ROW_MAX.small + 100,
    });
    expect(tight).toMatchObject({ checked: 1, decidedChecked: 0, retried: 0 });
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toHaveLength(1);
    expect((await t.mutation(internal.inboxItems.repair, {})).retried).toBe(1);
  });

  test('a bounded pass: a page cap of one checks one item', async () => {
    const t = harness();
    await seedRaw(t);
    await runToDone(t);
    expect((await t.mutation(internal.inboxItems.repair, { pageCap: 1 })).checked).toBe(1);
  });
});
