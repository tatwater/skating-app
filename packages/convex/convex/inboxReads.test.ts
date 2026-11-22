/**
 * The Inbox's reads (B01-5) on real data filed through the real mutations: the `endCursor` chain,
 * *All open*'s flow-through with Support cut for a moderator, each filter and the scan's budget, the
 * Decided list and a lane's tail, the lanes equal to the Overview's Inbox card, an item by every ref
 * form, the day so far, *Around it*'s bounds, *That night*'s figures equal to the Ice calibration
 * instrument's, and `notifications.list`'s `knows`.
 */

import {
  approximateUtcOffsetSeconds,
  INBOX_LANE_ORDER,
  INBOX_LANES,
  localDayMsAt,
} from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { AROUND_SCAN, SCAN_ROWS } from './inbox';
import { fileMember, flagSource } from './lib/inboxItems';
import * as readBudget from './lib/readBudget';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const DAY = 86_400_000;

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

async function person(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
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
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const square = (x: number, y = 0, half = 0.5): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x - half, y - half],
      [x - half, y + half],
      [x + half, y + half],
      [x + half, y - half],
      [x - half, y - half],
    ],
  ],
});

async function lake(t: T, externalId: string, x: number) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond',
        polygon: square(x),
        bbox: { minLat: -0.5, minLng: x - 0.5, maxLat: 0.5, maxLng: x + 0.5 },
        centroid: { lat: 0, lng: x },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!row) throw new Error('seed failed');
  return row._id;
}

async function report(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  extra: Partial<Doc<'reports'>> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0, lng: 0 },
      skateEndTime,
      reportTime: skateEndTime,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: skateEndTime,
      updatedAt: skateEndTime,
      ...extra,
    }),
  );
}

/** The backfill finished: the reads stop saying `pending`. */
const backfilled = (t: T) =>
  t.run((ctx) =>
    ctx.db.insert('inboxJobRuns', {
      job: 'backfill',
      phase: 'done',
      cursor: null,
      done: true,
      startedAt: 1,
      updatedAt: 1,
    }),
  );

const NOW = Date.now();
const DAY_START = NOW - 3_600_000;

describe('inbox.listPage', () => {
  test('the endCursor chain: a decision on page one moves nothing on page two', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const filer = await person(t, 'filer');
    const a = await lake(t, 'osm/A', 0);
    const flags: Id<'contentFlags'>[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await report(t, mod.id, a, NOW - (10 - i) * DAY);
      flags.push(
        await filer.as.mutation(api.contentFlags.flag, {
          targetType: 'report',
          targetId: r,
          reason: 'spam',
        }),
      );
    }
    await backfilled(t);
    const one = await mod.as.query(api.inbox.listPage, { lane: 'contentFlags', pageSize: 3 });
    expect(one.rows).toHaveLength(3);
    expect(one.pending).toBe(false);
    const two = await mod.as.query(api.inbox.listPage, {
      lane: 'contentFlags',
      pageSize: 3,
      cursor: one.continueCursor,
    });
    const pinned = {
      lane: 'contentFlags' as const,
      pageSize: 3,
      cursor: one.continueCursor,
      endCursor: two.continueCursor,
    };
    const before = await mod.as.query(api.inbox.listPage, pinned);
    // A colleague decides the first row's flag.
    const other = await person(t, 'other', 'moderator');
    await other.as.mutation(api.moderation.resolveFlag, {
      flagId: flags[0] as Id<'contentFlags'>,
      resolution: 'dismissed',
      reason: 'fine',
    });
    const after = await mod.as.query(api.inbox.listPage, pinned);
    expect(after.rows.map((r) => r.itemId)).toEqual(before.rows.map((r) => r.itemId));
    // Rows carry their labels, real names and `can` (the moderator didn't file or write them).
    const row = one.rows[0];
    expect(row).toMatchObject({
      kind: 'flag',
      lane: 'contentFlags',
      facet: 'reports',
      memberCount: 1,
    });
    if (row?.kind === 'flag') {
      expect(row.firstFiler?.displayName).toBe('filer Test-Person');
      expect(row.reasons).toEqual(['spam']);
      expect(row.target.exists).toBe(true);
    }
    // The moderator authored the reports: the own-content rule refuses them (D269).
    expect(row?.can.dismiss).toMatch(/yours/);
  });

  test('All open flows lane by lane; Support is cut for a moderator and drawn for an admin', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const admin = await person(t, 'admin', 'admin');
    const s = await person(t, 's');
    const victim = await person(t, 'victim');
    await s.as.mutation(api.support.create, { category: 'bug', body: 'broken' });
    await s.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: victim.id,
      reason: 'spam',
    });
    // One open flag per filer and target: a second person files the safety flag.
    const s2 = await person(t, 's2');
    await s2.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: victim.id,
      reason: 'unsafe_false_report',
    });
    await backfilled(t);
    const modAll = await mod.as.query(api.inbox.listPage, { lane: 'all' });
    expect(modAll.rows.map((r) => r.lane)).toEqual(['safety', 'contentFlags']);
    const adminAll = await admin.as.query(api.inbox.listPage, { lane: 'all' });
    expect(adminAll.rows.map((r) => r.lane)).toEqual(['safety', 'contentFlags', 'support']);
    const ticket = adminAll.rows[2];
    if (ticket?.kind === 'ticket')
      expect(ticket).toMatchObject({ category: 'bug', snippet: 'broken' });
    await expect(
      mod.as.query(api.inbox.listPage, { lane: 'all', facet: 'reports' }),
    ).rejects.toThrow(/tab/);
    await expect(
      mod.as.query(api.inbox.listPage, { lane: 'safety', facet: 'bays' }),
    ).rejects.toThrow(/tab/);
  });

  test('each filter: a body, a person, an age floor; and the Decided list newest first', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const [s1, s2] = [await person(t, 's1'), await person(t, 's2')];
    const [a, b] = [await lake(t, 'osm/A', 0), await lake(t, 'osm/B', 3)];
    await s1.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: a,
      reason: 'no_public_access',
    });
    await s2.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: b,
      reason: 'no_public_access',
    });
    await s1.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: s2.id,
      reason: 'spam',
    });
    await backfilled(t);
    const byBody = await mod.as.query(api.inbox.listPage, {
      lane: 'accessReports',
      filter: { waterBodyId: a },
    });
    expect(byBody.rows.map((r) => r.body?.waterBodyId)).toEqual([a]);
    const byPerson = await mod.as.query(api.inbox.listPage, {
      lane: 'all',
      filter: { subjectUserId: s2.id },
    });
    expect(byPerson.rows.map((r) => r.kind)).toEqual(['flag']);
    // Nothing is a day old yet.
    const aged = await mod.as.query(api.inbox.listPage, { lane: 'all', filter: { minAgeDays: 1 } });
    expect(aged.rows).toEqual([]);
    expect(
      (
        await mod.as.query(api.inbox.listPage, {
          lane: 'all',
          filter: { waterBodyId: 'not-an-id' },
        })
      ).rows,
    ).toEqual([]);
    // Decide both access items; the Decided list is newest first, each row with who and what.
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: a, verdict: 'none' });
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: b, verdict: 'open' });
    const decided = await mod.as.query(api.inbox.listPage, { lane: 'decided' });
    expect(decided.rows.map((r) => r.decided?.decision)).toEqual([
      'ruled_accessible',
      'ruled_closed',
    ]);
    expect(decided.rows[0]?.decided).toMatchObject({
      byMe: true,
      by: { displayName: 'mod Test-Person' },
    });
    expect(decided.rows[0]?.can).toMatchObject({ ruleClosed: 'This has already been decided.' });
  });

  test('a filtered scan that runs out before the page fills says scanBudgetSpent', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      for (let i = 0; i < SCAN_ROWS + 5; i++) {
        await ctx.db.insert('inboxItems', {
          key: `flag:contentFlags:report:r${i}`,
          kind: 'flag',
          lane: 'contentFlags',
          laneOrder: 5,
          facet: 'reports',
          status: 'open',
          rankKey: NOW - i,
          filedAt: NOW - i,
          lastActivityAt: NOW,
          memberCount: 1,
          refreshedAt: NOW,
        });
      }
    });
    const page = await mod.as.query(api.inbox.listPage, {
      lane: 'contentFlags',
      filter: { minAgeDays: 30 },
    });
    expect(page.rows).toEqual([]);
    expect(page.isDone).toBe(false);
    expect(page.scanBudgetSpent).toBe(true);
  });
});

describe('inbox.lanes and the Overview’s Inbox card', () => {
  test('pending until the backfill concludes, exact after, and equal to the lanes in both', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const [s1, s2] = [await person(t, 's1'), await person(t, 's2')];
    const a = await lake(t, 'osm/A', 0);
    // Filed live: an item from the first moment.
    await s1.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: await report(t, s2.id, a, NOW - DAY),
      reason: 'spam',
    });
    // From before the deploy: a row the backfill hasn't reached, so no item yet.
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: s1.id,
        targetType: 'user',
        targetId: s2.id,
        reason: 'unsafe_false_report',
        status: 'open',
        createdAt: NOW - 2 * DAY,
      }),
    );
    const read = async () => ({
      lanes: await mod.as.query(api.inbox.lanes, { dayStart: DAY_START }),
      card: (await mod.as.query(api.console.overview, {})).inbox,
    });
    const agree = ({ lanes, card }: Awaited<ReturnType<typeof read>>) => {
      for (const l of lanes.lanes) expect(card[l.lane]).toEqual({ count: l.open, capped: false });
      expect(card.pending).toBe(lanes.pending);
    };

    const before = await read();
    expect(before.card.pending).toBe(true);
    expect(before.card.safety.count).toBe(0);
    agree(before);

    for (let i = 0; i < 100; i++) {
      const pass = await t.mutation(internal.inboxItems.backfill, i === 0 ? { restart: true } : {});
      if (pass.done) break;
    }
    const after = await read();
    expect(after.card.pending).toBe(false);
    expect(after.card.safety).toEqual({ count: 1, capped: false });
    expect(after.card.contentFlags).toEqual({ count: 1, capped: false });
    agree(after);
  });

  test('equal on the same data; a seed-origin ask moves neither', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const admin = await person(t, 'admin', 'admin');
    const [s1, s2] = [await person(t, 's1'), await person(t, 's2')];
    const a = await lake(t, 'osm/A', 0);
    await s1.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: a,
      reason: 'no_public_access',
    });
    await s2.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: a,
      reason: 'no_public_access',
    });
    await s1.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: s2.id,
      reason: 'unsafe_false_report',
    });
    await s1.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0, lng: 0 },
      waterBodyId: a,
    });
    await s2.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0, lng: 0 },
      waterBodyId: a,
    });
    await s1.as.mutation(api.support.create, { category: 'account', body: 'help' });
    await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: admin.id,
      apply: true,
      rows: [
        {
          name: 'Seed Bay',
          parentName: 'Pond osm/A',
          state: 'NH',
          coord: { lat: 0.1, lng: 0.1 },
          note: 'x',
        },
      ],
    });
    await backfilled(t);
    for (const who of [mod, admin]) {
      const lanes = await who.as.query(api.inbox.lanes, { dayStart: DAY_START });
      const card = (await who.as.query(api.console.overview, {})).inbox;
      for (const l of lanes.lanes) expect(card[l.lane]).toEqual({ count: l.open, capped: false });
      const oldest = Math.min(
        ...lanes.lanes.map((l) => l.oldestFiledAt ?? Number.POSITIVE_INFINITY),
      );
      expect(card.oldestOpenAt).toBe(oldest);
      expect(card.medianOpenedAt).toBe(lanes.medianFiledAt);
      expect(lanes.pending).toBe(false);
    }
    const modLanes = await mod.as.query(api.inbox.lanes, { dayStart: DAY_START });
    expect(modLanes.lanes.map((l) => l.lane)).toEqual(INBOX_LANES.filter((l) => l !== 'support'));
    expect(Object.fromEntries(modLanes.lanes.map((l) => [l.lane, l.open]))).toEqual({
      safety: 1,
      accessReports: 1,
      requests: 1,
      // The seed's bay ask is no item (D289, amended).
      placesAsked: 0,
      drawnBodies: 0,
      contentFlags: 0,
    });
    expect((await mod.as.query(api.console.overview, {})).inbox.support).toBeNull();
    expect(modLanes.allOpen).toBe(3);
    expect(modLanes.lanes.find((l) => l.lane === 'requests')?.facets).toMatchObject({
      all: 1,
      takedown: 1,
    });
  });

  test('Today counts decisions since the console’s midnight; a viewer without support never counts its', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const admin = await person(t, 'admin', 'admin');
    const s = await person(t, 's');
    const ticket = await s.as.mutation(api.support.create, { category: 'bug', body: 'x' });
    const f = await s.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: admin.id,
      reason: 'spam',
    });
    await admin.as.mutation(api.support.resolve, { ticketId: ticket });
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: f,
      resolution: 'dismissed',
      reason: 'ok',
    });
    expect((await mod.as.query(api.inbox.lanes, { dayStart: DAY_START })).today).toEqual({
      count: 1,
      capped: false,
    });
    expect((await mod.as.query(api.inbox.lanes, { dayStart: DAY_START })).decided).toBe(1);
    expect((await admin.as.query(api.inbox.lanes, { dayStart: DAY_START })).today).toEqual({
      count: 2,
      capped: false,
    });
    const day = await admin.as.query(api.inbox.today, { dayStart: DAY_START });
    expect(day.decided.map((d) => d.lane).sort()).toEqual(['contentFlags', 'support']);
    expect(day.filed).toHaveLength(2);
    expect(day.openAtStart).toBe(0);
    const tail = await mod.as.query(api.inbox.tail, { lane: 'contentFlags' });
    expect(tail.rows.map((r) => r.decided?.decision)).toEqual(['dismissed']);
  });
});

describe('inbox.item', () => {
  test('every ref form resolves to the item that holds it; a ref to nothing is No such item', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const admin = await person(t, 'admin', 'admin');
    const s = await person(t, 's');
    const a = await lake(t, 'osm/A', 0);
    const r = await report(t, s.id, a, NOW - DAY, { notes: 'Black ice, held fine' });
    const flag = await mod.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: r,
      reason: 'unsafe_false_report',
    });
    const request = await s.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0, lng: 0 },
      waterBodyId: a,
    });
    const ticket = await s.as.mutation(api.support.create, { category: 'bug', body: 'x' });
    await backfilled(t);
    const flagItem = await mod.as.query(api.inbox.item, { ref: `flag:${flag}` });
    expect(flagItem.item?.kind).toBe('flag');
    expect((await mod.as.query(api.inbox.item, { ref: flag })).item?.itemId).toBe(
      flagItem.item?.itemId,
    );
    expect(
      (await mod.as.query(api.inbox.item, { ref: flagItem.item?.itemId as string })).item?.itemId,
    ).toBe(flagItem.item?.itemId);
    expect((await mod.as.query(api.inbox.item, { ref: `request:${request}` })).item?.kind).toBe(
      'request',
    );
    expect((await admin.as.query(api.inbox.item, { ref: `ticket:${ticket}` })).item?.kind).toBe(
      'ticket',
    );
    await expect(mod.as.query(api.inbox.item, { ref: ticket })).rejects.toThrow(/Support tickets/);
    expect(await mod.as.query(api.inbox.item, { ref: 'flag:nothing' })).toEqual({
      item: null,
      pending: false,
    });
    // The flag item: the report as 2.1 draws it, the flag, the author block; the filer can't decide it.
    const item = flagItem.item;
    if (
      item?.kind !== 'flag' ||
      item.target.exists !== true ||
      item.target.targetType !== 'report'
    ) {
      throw new Error('expected a flag on a report');
    }
    expect(item.target.report.notes).toBe('Black ice, held fine');
    expect(item.flags.map((f) => f.filer?.displayName)).toEqual(['mod Test-Person']);
    expect(item.author?.person.displayName).toBe('s Test-Person');
    expect(item.can).toMatchObject({
      dismiss: 'You filed this, so another staff member decides it.',
    });
    const forAdmin = (await admin.as.query(api.inbox.item, { ref: `flag:${flag}` })).item;
    expect(forAdmin?.can).toEqual({ dismiss: null, hide: null, remove: null });
    // A request item: a takedown is an admin's to decide, both ways (B01-5c, ruled).
    const req = (await mod.as.query(api.inbox.item, { ref: `request:${request}` })).item;
    expect(req?.can).toMatchObject({
      approve: 'Requires admin role',
      decline: 'Requires admin role',
    });
  });
});

describe('inbox.aroundIt', () => {
  test('the body’s reports within ±days of the flagged skate, each side bounded, phrases from claims', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const a = await lake(t, 'osm/A', 0);
    const b = await lake(t, 'osm/B', 3);
    const end = NOW - 10 * DAY;
    const flagged = await report(t, s.id, a, end, {
      iceThickness: { readings: [{ valueCm: 9, method: 'measured' }] },
    });
    await report(t, s.id, a, end - DAY, {
      iceThickness: { readings: [{ valueCm: 4, method: 'measured' }] },
      sightings: [{ type: 'open' }],
    });
    await report(t, s.id, a, end + 2 * DAY, { suitability: 'dont_go' });
    await report(t, s.id, a, end + 5 * DAY, { suitability: 'dont_go' }); // past ±3 days
    await report(t, s.id, b, end, { suitability: 'dont_go' }); // another body
    const view = await mod.as.query(api.inbox.aroundIt, { reportId: flagged });
    expect(view?.reports).toHaveLength(2);
    expect(view?.window.days).toBe(3);
    expect(view?.phrases).toEqual([
      { key: 'measured_less', count: 1 },
      { key: 'open_water', count: 1 },
      { key: 'dont_go', count: 1 },
    ]);
    expect(
      (await mod.as.query(api.inbox.aroundIt, { reportId: flagged, days: 7 }))?.reports,
    ).toHaveLength(3);
    expect(await mod.as.query(api.inbox.aroundIt, { reportId: 'nope' })).toBeNull();
  });

  test('more than fifty reports on a side: capped, and the side holds its bound', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const a = await lake(t, 'osm/A', 0);
    const end = NOW - 10 * DAY;
    const flagged = await report(t, s.id, a, end);
    for (let i = 1; i <= 55; i++) await report(t, s.id, a, end - i * 60_000);
    const view = await mod.as.query(api.inbox.aroundIt, { reportId: flagged });
    expect(view?.cappedBefore).toBe(true);
    expect(view?.cappedAfter).toBe(false);
    expect(view?.reports.length).toBeLessThanOrEqual(51);
  });
});

describe('inbox.claimWeather', () => {
  async function weatherWorld(fdhPerDay: number, thawPerDay: number, days: number) {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Calibration Pond',
        searchText: 'Calibration Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: square(-72.0331, 44.0163, 0.01),
        bbox: { minLat: 43.99, minLng: -72.05, maxLat: 44.05, maxLng: -71.99 },
        centroid: { lat: 44.0163, lng: -72.0331 },
        interiorPoint: { lat: 44.0163, lng: -72.0331 },
        elevationM: 338,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    const today = localDayMsAt(Date.now(), approximateUtcOffsetSeconds(-72.0331));
    await t.run(async (ctx) => {
      for (let i = 0; i < days; i++) {
        const dayMs = today - i * DAY;
        await ctx.db.insert('weatherDays', {
          cellKey: 'b:880:-1441:3',
          tier: 'browse' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          hours: 24,
          freezingDegreeHours: fdhPerDay,
          thawDegreeHours: thawPerDay,
          nightMinTempC: i === 3 ? 1 : -5,
          fetchedAt: Date.now(),
        });
      }
    });
    const rep = await report(t, mod.id, body, Date.now() - DAY, {
      point: { lat: 44.0163, lng: -72.0331 },
      iceThickness: { readings: [{ valueCm: 25, method: 'measured' }] },
    });
    return { t, mod, body, rep };
  }

  test('equals the instrument’s predicted figure for the same report, with its low and freezing run', async () => {
    const { mod, rep } = await weatherWorld(120, 0, 40);
    const wx = await mod.as.query(api.inbox.claimWeather, { reportId: rep });
    const { pairs } = await mod.as.query(api.iceCalibration.calibrationPairs, {});
    const pair = pairs.find((p) => p.reportId === rep);
    if (!wx || !pair || 'declined' in wx.stefan) throw new Error('expected an estimate');
    expect(wx.stefan.thicknessIn * 2.54).toBeCloseTo(pair.predictedCm as number, 9);
    expect(wx.stefan.windowDays).toBe(60);
    expect(wx.lowC).toBe(-5);
    // Freezing nights back from the skate day stop at the warm night three days before today.
    expect(wx.freezingNights).toEqual({ run: 2, gapAfter: false });
    expect(wx.freezingDegreeDaysC.value).toBeGreaterThan(0);
  });

  test('each declined case is worded by its reason; a removed body is not recorded', async () => {
    const thaw = await weatherWorld(120, 30, 40);
    expect(
      (await thaw.mod.as.query(api.inbox.claimWeather, { reportId: thaw.rep }))?.stefan,
    ).toEqual({
      declined: 'thaw',
    });
    const cold = await weatherWorld(0.5, 0, 10);
    expect(
      (await cold.mod.as.query(api.inbox.claimWeather, { reportId: cold.rep }))?.stefan,
    ).toEqual({
      declined: 'too_little_cold',
    });
    const none = await weatherWorld(0, 0, 0);
    const wx = await none.mod.as.query(api.inbox.claimWeather, { reportId: none.rep });
    expect(wx?.stefan).toEqual({ declined: 'no_weather' });
    expect(wx?.lowC).toBeNull();
    expect(wx?.freezingNights).toEqual({ run: 0, gapAfter: true });
    await none.t.run((ctx) => ctx.db.patch(none.body, { removedAt: Date.now() }));
    expect(await none.mod.as.query(api.inbox.claimWeather, { reportId: none.rep })).toBeNull();
  });
});

describe('notifications.list’s knows', () => {
  test('a type outside what the client knows is served as the unknown row; with it, the view', async () => {
    const t = harness();
    const s = await person(t, 's');
    await t.run((ctx) =>
      ctx.db.insert('notifications', {
        userId: s.id,
        type: 'content_flag_resolved',
        payload: {
          kind: 'flag_resolved',
          flagId: 'f',
          resolution: 'dismissed',
          targetType: 'user',
        },
        createdAt: Date.now(),
      } as never),
    );
    const page = { numItems: 10, cursor: null };
    const before = await s.as.query(api.notifications.list, { paginationOpts: page });
    // The existing type is one every build knows: served as itself without `knows`.
    expect(before.page.map((v) => v.type)).not.toContain(undefined);
    const strict = await s.as.query(api.notifications.list, {
      paginationOpts: page,
      knows: ['report_rated'],
    });
    expect(strict.page.every((v) => v.type === 'unknown' || v.type === 'report_rated')).toBe(true);
    const full = await s.as.query(api.notifications.list, {
      paginationOpts: page,
      knows: ['content_flag_resolved'],
    });
    expect(full.page.map((v) => v.type)).toEqual(before.page.map((v) => v.type));
  });
});

describe('inbox.lanes’ age options', () => {
  test('each lane counts its open items filed at least 1, 3, 7 and 30 days ago', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const ages = [0.5, 2, 5, 40];
    await t.run(async (ctx) => {
      for (const [i, age] of ages.entries()) {
        const id = await ctx.db.insert('contentFlags', {
          flaggerId: s.id,
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'spam',
          status: 'open',
          origin: 'user',
          createdAt: NOW - age * DAY,
        });
        await fileMember(ctx, flagSource(id));
      }
    });
    const lanes = await mod.as.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    const content = lanes.lanes.find((l) => l.lane === 'contentFlags');
    expect(content?.olderThan.map((o) => [o.days, o.count.count])).toEqual([
      [1, 3],
      [3, 2],
      [7, 1],
      [30, 1],
    ]);
    expect(
      lanes.lanes.find((l) => l.lane === 'safety')?.olderThan.every((o) => o.count.count === 0),
    ).toBe(true);
  });
});

describe('inbox.aroundIt and withdrawn or moderated reports', () => {
  test('an author-deleted report is left out; a hidden one is listed, marked, and quoted by no phrase', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const a = await lake(t, 'osm/A', 0);
    const end = NOW - 10 * DAY;
    const flagged = await report(t, s.id, a, end, {
      iceThickness: { readings: [{ valueCm: 9, method: 'measured' }] },
    });
    const thin = { iceThickness: { readings: [{ valueCm: 3, method: 'measured' as const }] } };
    const deleted = await report(t, s.id, a, end - DAY, { ...thin, authorDeletedAt: end });
    const hidden = await report(t, s.id, a, end - 2 * DAY, { ...thin, moderationStatus: 'hidden' });
    const visible = await report(t, s.id, a, end + DAY, thin);
    const view = await mod.as.query(api.inbox.aroundIt, { reportId: flagged });
    expect(view?.reports.map((r) => r.reportId)).toEqual([hidden, visible]);
    expect(view?.reports.find((r) => r.reportId === hidden)?.moderationStatus).toBe('hidden');
    // Only the visible report's claim counts as context.
    expect(view?.phrases).toEqual([{ key: 'measured_less', count: 1 }]);
    void deleted;
  });

  /** A window whose nearer side is `n` reports their authors took back, then one standing report. */
  async function deletedWindow(n: number) {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const a = await lake(t, 'osm/A', 0);
    const end = NOW - 10 * DAY;
    const flagged = await report(t, s.id, a, end);
    await t.run(async (ctx) => {
      for (let i = 1; i <= n; i++) {
        await ctx.db.insert('reports', {
          authorId: s.id,
          waterBodyId: a,
          point: { lat: 0, lng: 0 },
          skateEndTime: end - i * 60_000,
          reportTime: end,
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          authorDeletedAt: end,
          createdAt: end,
          updatedAt: end,
        });
      }
    });
    const standing = await report(t, s.id, a, end - 2 * DAY);
    return { mod, flagged, standing };
  }

  test('reports an author took back count toward the scan’s bound: past it, the side says capped', async () => {
    const w = await deletedWindow(AROUND_SCAN + 5);
    const view = await w.mod.as.query(api.inbox.aroundIt, { reportId: w.flagged });
    expect(view?.reports).toEqual([]);
    expect(view?.cappedBefore).toBe(true);
    expect(view?.cappedAfter).toBe(false);
  });

  test('reports an author took back are charged: a small budget ends the scan, and says so', async () => {
    const w = await deletedWindow(20);
    // A report's worst case and 2 KB over: a few of these small reports' real weight, not twenty.
    vi.spyOn(readBudget, 'requestBudget').mockImplementation(
      () => new readBudget.ReadBudget(readBudget.ROW_MAX.report + 2_000),
    );
    const view = await w.mod.as.query(api.inbox.aroundIt, { reportId: w.flagged });
    expect(view?.reports).toEqual([]);
    expect(view?.cappedBefore).toBe(true);
  });

  test('under both bounds, a side read to its end is not capped', async () => {
    const w = await deletedWindow(30);
    const view = await w.mod.as.query(api.inbox.aroundIt, { reportId: w.flagged });
    expect(view?.reports.map((r) => r.reportId)).toEqual([w.standing]);
    expect(view?.cappedBefore).toBe(false);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('inbox.today’s Access lane', () => {
  test('past the 200 it reads, filed today says capped and the day’s start is not claimed', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert('inboxItems', {
          key: `access:b${i}`,
          kind: 'access',
          lane: 'accessReports',
          laneOrder: 1,
          facet: 'new',
          status: 'open',
          rankKey: 499 * 1e13 + (NOW - 2 * DAY),
          filedAt: NOW - 2 * DAY,
          lastActivityAt: NOW,
          memberCount: 1,
          refreshedAt: NOW,
        });
      }
    });
    const day = await mod.as.query(api.inbox.today, { now: NOW, dayStart: DAY_START });
    expect(day.filedCapped).toBe(true);
    expect(day.openAtStart).toBeNull();
  });
});

describe('the lanes’ and the day’s figures under a short budget', () => {
  /** Ten Content items decided today and ten open, filed a week ago. */
  async function figuresWorld() {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      const order = INBOX_LANE_ORDER.contentFlags;
      // The stored counts a writer would keep: the lane's figures read its range only when it's open.
      await ctx.db.insert('inboxCounts', { key: 'open:contentFlags', count: 10 });
      for (let i = 0; i < 10; i++) {
        const base = {
          kind: 'flag' as const,
          lane: 'contentFlags' as const,
          laneOrder: order,
          facet: 'people',
          memberCount: 1,
          lastActivityAt: NOW,
          refreshedAt: NOW,
        };
        await ctx.db.insert('inboxItems', {
          ...base,
          key: `flag:d${i}`,
          status: 'decided',
          decision: 'dismissed',
          decidedAt: NOW - 60_000 * (i + 1),
          rankKey: NOW - 7 * DAY,
          filedAt: NOW - 7 * DAY,
        });
        await ctx.db.insert('inboxItems', {
          ...base,
          key: `flag:o${i}`,
          status: 'open',
          rankKey: NOW - 7 * DAY,
          filedAt: NOW - 7 * DAY,
        });
      }
    });
    return mod;
  }
  const short = () =>
    vi
      .spyOn(readBudget, 'requestBudget')
      .mockImplementation(() => new readBudget.ReadBudget(4 * readBudget.ROW_MAX.small));

  test('lanes: a range the budget cut short says capped, never a short count as whole', async () => {
    const mod = await figuresWorld();
    const whole = await mod.as.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    const content = (v: typeof whole) => v.lanes.find((l) => l.lane === 'contentFlags');
    expect(whole.today).toEqual({ count: 10, capped: false });
    expect(content(whole)?.olderThan.find((o) => o.days === 1)?.count).toEqual({
      count: 10,
      capped: false,
    });
    short();
    const cut = await mod.as.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    expect(cut.today.capped).toBe(true);
    expect(content(cut)?.olderThan.find((o) => o.days === 1)?.count.capped).toBe(true);
    expect(cut.medianFiledAt).toBeNull();
  });

  test('lanes: a median over a range the budget cut short is not given', async () => {
    const mod = await figuresWorld();
    // Room for every range but the last whole: the lane's oldest (1), its age floors (10 each at one,
    // three and seven days; none at thirty), decided today (10), and five of the ten the median reads.
    vi.spyOn(readBudget, 'requestBudget').mockImplementation(
      () => new readBudget.ReadBudget(46 * readBudget.ROW_MAX.small),
    );
    const cut = await mod.as.query(api.inbox.lanes, { now: NOW, dayStart: DAY_START });
    expect(cut.today).toEqual({ count: 10, capped: false });
    expect(cut.medianFiledAt).toBeNull();
  });

  test('today: decided cut short says capped, and the day’s start is not claimed', async () => {
    const mod = await figuresWorld();
    const whole = await mod.as.query(api.inbox.today, { now: NOW, dayStart: DAY_START });
    expect(whole.decidedCapped).toBe(false);
    expect(whole.openAtStart).not.toBeNull();
    short();
    const cut = await mod.as.query(api.inbox.today, { now: NOW, dayStart: DAY_START });
    expect(cut.decidedCapped).toBe(true);
    expect(cut.filedCapped).toBe(true);
    expect(cut.openAtStart).toBeNull();
  });
});
