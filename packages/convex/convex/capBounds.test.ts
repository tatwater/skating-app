/**
 * Counts at the cap (B01-3b): every read probes one past its cap, so exactly the cap is whole and one
 * more is capped — the library's asks and reports, the place-name queue, a lake's open names and bay
 * asks — and the re-count job for rows stored under the old meaning.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { openAsksFor, REPORT_SCAN, reportFactsFor } from './lib/bodyLibrary';
import { QUEUE_CAP } from './lib/requestDecisions';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();
const ASK_CAP = 100;
const NAME_QUEUE_CAP = 400;

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
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.01, 43.99],
      [-71.99, 43.99],
      [-71.99, 44.01],
      [-72.01, 44.01],
      [-72.01, 43.99],
    ],
  ],
};

async function seed(t: T) {
  return t.run(async (ctx) => {
    const mod = await ctx.db.insert('profiles', {
      clerkUserId: 'caps-mod',
      displayName: 'M',
      username: 'caps-m',
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role: 'moderator',
      status: 'active',
      createdAt: NOW,
    });
    const body = await ctx.db.insert('waterBodies', {
      name: 'Capped',
      searchText: 'capped',
      type: 'lakePond',
      source: 'osm',
      polygon: square,
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44, lng: -72 },
      dedupStatus: 'clean',
      createdAt: NOW,
    });
    return { mod, body };
  });
}

const placeName = (waterBodyId: Id<'waterBodies'>, i: number) => ({
  name: `Name ${i}`,
  askKey: `name ${i}`,
  aliases: [],
  messages: 1,
  skatedMessages: 0,
  states: [],
  waterBodyId,
  status: 'open' as const,
  createdAt: NOW + i,
  updatedAt: NOW + i,
});

describe('exactly the cap is whole; one more is capped', () => {
  test('the library’s open asks', async () => {
    const t = harness();
    const { body } = await seed(t);
    const asks = () => t.run((ctx) => openAsksFor(ctx, body));
    await t.run(async (ctx) => {
      for (let i = 0; i < ASK_CAP; i++) await ctx.db.insert('corpusPlaceNames', placeName(body, i));
    });
    expect(await asks()).toEqual({ count: ASK_CAP, waiting: false, capped: false });
    await t.run((ctx) => ctx.db.insert('corpusPlaceNames', placeName(body, ASK_CAP)));
    expect(await asks()).toEqual({ count: ASK_CAP, waiting: false, capped: true });
  });

  test('the library’s season reports', async () => {
    const t = harness();
    const { mod, body } = await seed(t);
    const report = (i: number) => ({
      authorId: mod,
      waterBodyId: body,
      point: { lat: 44, lng: -72 },
      skateEndTime: NOW - 3_600_000 - i,
      reportTime: NOW,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      hazardIdsCreated: [],
      moderationStatus: 'visible' as const,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const facts = () => t.run((ctx) => reportFactsFor(ctx, body, NOW));
    await t.run(async (ctx) => {
      for (let i = 0; i < REPORT_SCAN; i++) await ctx.db.insert('reports', report(i));
    });
    const whole = await facts();
    // Whether the season's record is open depends on today's date; the cap flag follows it.
    const open = whole.reports > 0;
    expect(whole).toMatchObject({ reportsCapped: false, everReported: true });
    expect(whole.newest).toHaveLength(REPORT_SCAN);
    await t.run((ctx) => ctx.db.insert('reports', report(REPORT_SCAN)));
    const more = await facts();
    expect(more).toMatchObject({ reportsCapped: open, everReported: true });
    expect(more.newest).toHaveLength(REPORT_SCAN);
  });

  test('a lake’s open names, and the place-name queue', async () => {
    const t = harness();
    const { body } = await seed(t);
    const as = t.withIdentity({ subject: 'caps-mod' });
    await t.run(async (ctx) => {
      for (let i = 0; i < NAME_QUEUE_CAP; i++) {
        await ctx.db.insert('corpusPlaceNames', placeName(body, i));
      }
    });
    const onLake = await as.query(api.corpusPlaceNames.openForBody, { waterBodyId: body });
    expect({ n: onLake.names.length, more: onLake.more }).toEqual({
      n: NAME_QUEUE_CAP,
      more: false,
    });
    expect((await as.query(api.corpusPlaceNames.listQueue, {})).capped).toBe(false);
    await t.run((ctx) => ctx.db.insert('corpusPlaceNames', placeName(body, NAME_QUEUE_CAP)));
    const past = await as.query(api.corpusPlaceNames.openForBody, { waterBodyId: body });
    expect({ n: past.names.length, more: past.more }).toEqual({ n: NAME_QUEUE_CAP, more: true });
    const queue = await as.query(api.corpusPlaceNames.listQueue, {});
    expect({ n: queue.rows.length, capped: queue.capped }).toEqual({
      n: NAME_QUEUE_CAP,
      capped: true,
    });
  });

  test('a lake’s open bay asks', async () => {
    const t = harness();
    const { mod, body } = await seed(t);
    const as = t.withIdentity({ subject: 'caps-mod' });
    const ask = (i: number) => ({
      kind: 'name_bay' as const,
      status: 'open' as const,
      requesterId: mod,
      coord: { lat: 44, lng: -72 },
      waterBodyId: body,
      name: `Bay ${i}`,
      nameKey: `bay ${i}`,
      createdAt: NOW + i,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < QUEUE_CAP; i++) await ctx.db.insert('waterBodyRequests', ask(i));
    });
    const whole = await as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: body });
    expect({ n: whole.bays.length, more: whole.more }).toEqual({ n: QUEUE_CAP, more: false });
    await t.run((ctx) => ctx.db.insert('waterBodyRequests', ask(QUEUE_CAP)));
    const past = await as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: body });
    expect({ n: past.bays.length, more: past.more }).toEqual({ n: QUEUE_CAP, more: true });
  });
});

describe('the re-count of rows stored under the old meaning', () => {
  test('queues exactly the bodies whose row says capped, and refreshes them whole', async () => {
    const t = harness();
    const { body } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < ASK_CAP; i++) await ctx.db.insert('corpusPlaceNames', placeName(body, i));
    });
    await t.mutation(internal.bodyLibrary.refreshOne, { waterBodyId: body });
    // The row as the old read stored it: exactly the cap, called capped.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', body).eq('scope', '*'))
        .first();
      if (row) await ctx.db.patch(row._id, { asksCapped: true });
    });
    expect(await t.mutation(internal.bodyLibrary.requeueCapped, {})).toMatchObject({
      queued: 1,
      isDone: true,
    });
    await t.mutation(internal.bodyLibrary.drainQueue, {});
    const row = await t.run((ctx) =>
      ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', body).eq('scope', '*'))
        .first(),
    );
    expect(row).toMatchObject({ asks: ASK_CAP, asksCapped: false });
    expect(await t.mutation(internal.bodyLibrary.requeueCapped, {})).toMatchObject({ queued: 0 });
  });
});
