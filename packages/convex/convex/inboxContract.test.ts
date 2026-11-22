/**
 * The Inbox reads' published contract (B01-5): each query's gate, and the honest empty answer it
 * gives before anything is stored — an empty page, zero counts, `pending` while no backfill has run,
 * no such item. Nothing here is fake data.
 */

import { INBOX_LANES } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import { heldDayStart } from './inbox';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

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

type Role = 'member' | 'moderator' | 'admin';

async function world() {
  const t = convexTest(schema, modules);
  const as = async (role: Role) => {
    const subject = `user_${role}`;
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: `${role} Test-Person`,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: Date.now(),
      }),
    );
    return t.withIdentity({ subject });
  };
  return { member: await as('member'), moderator: await as('moderator'), admin: await as('admin') };
}

const NOW = Date.now();
const DAY_START = NOW - 3_600_000;

describe('inbox.listPage', () => {
  test('refuses a member; a moderator gets an empty, pending page for every lane but Support', async () => {
    const { member, moderator } = await world();
    await expect(member.query(api.inbox.listPage, { lane: 'all' })).rejects.toThrow();
    for (const lane of ['all', 'decided', ...INBOX_LANES.filter((l) => l !== 'support')] as const) {
      expect(await moderator.query(api.inbox.listPage, { lane, now: NOW })).toEqual({
        rows: [],
        isDone: true,
        continueCursor: expect.any(String),
        scanBudgetSpent: false,
        pending: true,
      });
    }
  });

  test("Support's lane is refused to a moderator, in the read's own words, and read by an admin", async () => {
    const { moderator, admin } = await world();
    await expect(moderator.query(api.inbox.listPage, { lane: 'support' })).rejects.toThrow(
      'Support tickets are read only by staff who answer them',
    );
    const page = await admin.query(api.inbox.listPage, {
      lane: 'support',
      facet: 'bug',
      filter: { minAgeDays: 3 },
      cursor: null,
      endCursor: null,
      pageSize: 10,
    });
    expect(page.rows).toEqual([]);
  });
});

describe('inbox.lanes', () => {
  test('zero counts and pending; Support only for a viewer who may read it', async () => {
    const { member, moderator, admin } = await world();
    await expect(member.query(api.inbox.lanes, { dayStart: DAY_START })).rejects.toThrow();
    const mod = await moderator.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    expect(mod.lanes.map((l) => l.lane)).toEqual(INBOX_LANES.filter((l) => l !== 'support'));
    expect(mod.lanes.every((l) => l.open === 0 && l.oldestFiledAt === null)).toBe(true);
    expect(mod).toMatchObject({
      allOpen: 0,
      decided: 0,
      today: { count: 0, capped: false },
      medianFiledAt: null,
      pending: true,
    });
    const adm = await admin.query(api.inbox.lanes, { dayStart: DAY_START });
    expect(adm.lanes.map((l) => l.lane)).toEqual([...INBOX_LANES]);
  });
});

describe('inbox.tail', () => {
  test("empty and pending; Support's tail refused to a moderator", async () => {
    const { member, moderator, admin } = await world();
    await expect(member.query(api.inbox.tail, { lane: 'safety' })).rejects.toThrow();
    expect(await moderator.query(api.inbox.tail, { lane: 'safety', now: NOW })).toEqual({
      rows: [],
      capped: false,
      pending: true,
    });
    await expect(moderator.query(api.inbox.tail, { lane: 'support' })).rejects.toThrow(
      'Support tickets are read only by staff who answer them',
    );
    expect((await admin.query(api.inbox.tail, { lane: 'support' })).rows).toEqual([]);
  });
});

describe('inbox.item', () => {
  test('no such item (pending while no backfill has run); a ticket ref needs support', async () => {
    const { member, moderator, admin } = await world();
    await expect(member.query(api.inbox.item, { ref: 'flag:abc' })).rejects.toThrow();
    for (const ref of ['flag:abc', 'request:abc', 'body:abc', 'not-an-id', '']) {
      expect(await moderator.query(api.inbox.item, { ref })).toEqual({ item: null, pending: true });
    }
    await expect(moderator.query(api.inbox.item, { ref: 'ticket:abc' })).rejects.toThrow(
      'Support tickets are read only by staff who answer them',
    );
    expect(await admin.query(api.inbox.item, { ref: 'ticket:abc' })).toEqual({
      item: null,
      pending: true,
    });
  });
});

describe('inbox.today', () => {
  test('nothing filed or decided, from the held day start', async () => {
    const { member, moderator } = await world();
    await expect(member.query(api.inbox.today, { dayStart: DAY_START })).rejects.toThrow();
    const day = await moderator.query(api.inbox.today, { now: NOW, dayStart: DAY_START });
    expect(day).toEqual({
      since: DAY_START,
      filed: [],
      filedCapped: false,
      decided: [],
      decidedCapped: false,
      // Nothing open now, nothing filed or decided today: none open as the day began.
      openAtStart: 0,
      pending: true,
    });
  });

  test('a day start is held to the 36 hours before now', () => {
    const now = 1_800_000_000_000;
    expect(heldDayStart(now - 3_600_000, now)).toBe(now - 3_600_000);
    expect(heldDayStart(0, now)).toBe(now - 1.5 * 86_400_000);
    expect(heldDayStart(now + 86_400_000, now)).toBe(now);
  });
});

describe('inbox.aroundIt and inbox.claimWeather', () => {
  test('gated on content.read; a report that is not there answers null', async () => {
    const { member, moderator } = await world();
    await expect(member.query(api.inbox.aroundIt, { reportId: 'x' })).rejects.toThrow();
    await expect(member.query(api.inbox.claimWeather, { reportId: 'x' })).rejects.toThrow();
    expect(await moderator.query(api.inbox.aroundIt, { reportId: 'x', days: 3 })).toBeNull();
    expect(await moderator.query(api.inbox.claimWeather, { reportId: 'x' })).toBeNull();
  });
});

describe('inbox.itemMap', () => {
  test('gated as inbox.item is, plus the body read; no such item is a null map', async () => {
    const { member, moderator, admin } = await world();
    await expect(member.query(api.inbox.itemMap, { ref: 'flag:abc' })).rejects.toThrow();
    expect(await moderator.query(api.inbox.itemMap, { ref: 'flag:abc' })).toEqual({
      map: null,
      pending: true,
    });
    await expect(moderator.query(api.inbox.itemMap, { ref: 'ticket:abc' })).rejects.toThrow(
      'Support tickets are read only by staff who answer them',
    );
    expect(await admin.query(api.inbox.itemMap, { ref: 'ticket:abc' })).toEqual({
      map: null,
      pending: true,
    });
  });
});
