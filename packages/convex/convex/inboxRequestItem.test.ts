/**
 * **What a request's and a place's item read serves its handler** (B01-5c, the server asks from the
 * request handler's build), through the public `inbox.item`:
 *
 * - a *contest access* ask carries the standing ruling it contests, as the Access item serves it;
 * - an *activate* ask carries its body's dormancy, as the body stores it;
 * - an ask from a recorded skate carries the skate's times (no distance: no row stores one);
 * - asks are served newest first, the newest of each status to the cap, with the ask a decision is
 *   sent for named (`primaryRequestId`);
 * - none of it reaches a viewer who may not read the Inbox — the asker included.
 */

import { requestNameKeyFor } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { type InboxItemView, MAP_OUTLINE_BYTES, MAP_RING_POINTS } from './inbox';
import { fileMember, flagSource, requestSource } from './lib/inboxItems';
import {
  DISMISSED_BY_RULING_READ,
  DRAWN_SKATE_PAGE,
  InboxReader,
  VIEW_ASKER_COUNTS,
  VIEW_MEMBERS,
  VIEW_SKATES,
} from './lib/inboxViews';
import * as readBudget from './lib/readBudget';
import { undoState } from './lib/undo';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type As = ReturnType<T['withIdentity']>;
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
  moderatorDecision: true,
};

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, -0.5],
    ],
  ],
};

async function person(
  t: T,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
): Promise<{ id: Id<'profiles'>; as: As }> {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function world() {
  const t = harness();
  const mod = await person(t, 'mod', 'moderator');
  const admin = await person(t, 'admin', 'admin');
  const asker = await person(t, 'asker');
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId: 'osm/A',
        osmId: 'osm/A',
        name: 'Pond A',
        type: 'lakePond',
        polygon: SQUARE,
        bbox: { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 },
        centroid: { lat: 0, lng: 0 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const lake = (await t.run((ctx) => ctx.db.query('waterBodies').first()))
    ?._id as Id<'waterBodies'>;
  return { t, mod, admin, asker, lake };
}
type W = Awaited<ReturnType<typeof world>>;

/** The item as a moderator reads it. */
async function itemOf(w: W, requestId: Id<'waterBodyRequests'>, as: As = w.mod.as) {
  const { item } = await as.query(api.inbox.item, { ref: `request:${requestId}` });
  return item as InboxItemView;
}
type RequestView = Extract<InboxItemView, { kind: 'request' }>;
type PlaceView = Extract<InboxItemView, { kind: 'place' }>;

/** A recorded skate of `who`'s, its track `points` long (a track is what an activity row weighs). */
async function skate(w: W, who: Id<'profiles'>, i: number, points = 20) {
  return w.t.run((ctx) =>
    ctx.db.insert('gpsActivities', {
      userId: who,
      provider: 'native',
      providerActivityId: `skate-${i}`,
      sportType: 'IceSkate',
      startTime: NOW - 7_200_000 - i,
      endTime: NOW - 3_600_000 - i,
      elapsedSeconds: 3_000,
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: points }, (_, k) => [30 + k * 1e-5, 30 + i * 1e-3]),
      },
      promptState: 'pending',
      detectedAt: NOW,
    } as never),
  );
}

describe('a contest access ask carries the ruling it contests', () => {
  test('the standing none ruling, as the Access item serves its ruling event', async () => {
    const w = await world();
    await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: w.lake,
      verdict: 'none',
      note: 'Gated private road',
      reason: 'Owner called',
    });
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'contest_access',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
      note: 'Town lot off Route 5',
    });
    const item = (await itemOf(w, requestId)) as RequestView;
    const access = await w.t.run(async (ctx) =>
      (await ctx.db.query('inboxItems').collect()).find((i) => i.kind === 'access'),
    );
    expect(item.ruling).toEqual({
      verdict: 'none',
      ruledAt: expect.any(Number),
      by: expect.objectContaining({ userId: w.mod.id, isStaff: true }),
      note: 'Gated private road',
      reason: 'Owner called',
    });
    // The same event the Access item draws, where one stands.
    if (access) {
      const a = (await w.mod.as.query(api.inbox.item, { ref: access._id })).item as Extract<
        InboxItemView,
        { kind: 'access' }
      >;
      expect(a.ruling).toEqual(item.ruling);
    }
    // Another kind on the same lake carries none.
    expect(item.dormancy).toBeNull();
  });

  test('another kind carries no ruling, even on a ruled body', async () => {
    const w = await world();
    await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: w.lake,
      verdict: 'open',
    });
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
      note: 'Mine',
    });
    expect(((await itemOf(w, requestId)) as RequestView).ruling).toBeNull();
  });
});

describe('an activate ask carries its body’s dormancy', () => {
  test('a moderator’s shelving: the reason, when, their note, who', async () => {
    const w = await world();
    const since = NOW - 86_400_000;
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, {
        dormant: { since, reason: 'moderator', byUserId: w.admin.id, note: 'Drained for a dam' },
      }),
    );
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
    });
    const item = (await itemOf(w, requestId)) as RequestView;
    expect(item.dormancy).toEqual({
      reason: 'moderator',
      since,
      note: 'Drained for a dam',
      by: expect.objectContaining({ userId: w.admin.id }),
    });
    expect(item.ruling).toBeNull();
  });

  test('the machine’s own: the reason and when, no note and no one', async () => {
    const w = await world();
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, { dormant: { since: NOW, reason: 'inactive' as const } }),
    );
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
    });
    expect(((await itemOf(w, requestId)) as RequestView).dormancy).toEqual({
      reason: 'inactive',
      since: NOW,
      note: null,
      by: null,
    });
  });
});

describe('an ask from a recorded skate carries its times', () => {
  test('start, end and moving time as the row stores them; an ask with none carries null', async () => {
    const w = await world();
    const activityId = await skate(w, w.asker.id, 0);
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 30, lng: 30 },
      activityId,
    });
    const item = (await itemOf(w, requestId)) as RequestView;
    expect(item.asks[0]).toMatchObject({
      activityId,
      skate: { startTime: NOW - 7_200_000, endTime: NOW - 3_600_000, elapsedSeconds: 3_000 },
    });
    const plain = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 35, lng: 35 },
    });
    expect(((await itemOf(w, plain)) as RequestView).asks[0]?.skate).toBeNull();
  });

  test('an item reads at most VIEW_SKATES skates, the newest asks’; the rest carry null', async () => {
    const w = await world();
    const ids: Id<'waterBodyRequests'>[] = [];
    for (let i = 0; i < VIEW_SKATES + 2; i++) {
      const who = (await person(w.t, `l${i}`)).id;
      const activityId = await skate(w, who, i);
      ids.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: who,
            coord: { lat: 0.2, lng: 0.2 },
            waterBodyId: w.lake,
            name: 'North Bay',
            nameKey: requestNameKeyFor('name_bay', 'North Bay'),
            activityId,
            createdAt: NOW - 10_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as PlaceView;
    expect(item.asks.map((a) => a.skate !== null)).toEqual([
      ...Array.from({ length: VIEW_SKATES }, () => true),
      false,
      false,
    ]);
  });

  test('skates are read after the rule: heavy tracks never leave a lever unchecked, and stop at the cap', async () => {
    const w = await world();
    // Twelve askers of one question, each from a recorded skate whose track weighs ~900 KiB — more
    // than the item's budget holds together. The moderator has an ask of their own elsewhere, so the
    // rule's own-filing check has reads to make (with the Inbox pending, an ask row at a time).
    await w.t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: w.mod.id,
        coord: { lat: 40, lng: 40 },
        createdAt: NOW - 50_000,
      }),
    );
    const askers: Id<'profiles'>[] = [];
    for (let i = 0; i < VIEW_SKATES + 2; i++) askers.push((await person(w.t, `s${i}`)).id);
    const asks: Id<'waterBodyRequests'>[] = [];
    for (const [i, who] of askers.entries()) {
      const activityId = await skate(w, who, i, 50_000);
      asks.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: who,
            coord: { lat: 0.2, lng: 0.2 },
            waterBodyId: w.lake,
            name: 'North Bay',
            nameKey: requestNameKeyFor('name_bay', 'North Bay'),
            activityId,
            createdAt: NOW - 10_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    // The item read on a budget of four documents: enough for the rule's reads, not for the tracks too.
    const spy = vi
      .spyOn(readBudget, 'requestBudget')
      .mockImplementation(() => new readBudget.ReadBudget(4 * readBudget.DOC_MAX));
    const item = (await itemOf(w, asks[0] as Id<'waterBodyRequests'>)) as PlaceView & {
      can: Record<string, string | null>;
    };
    spy.mockRestore();
    // The rule had its reads first: the decline is offered, not "couldn't check".
    expect(item.can.decline).toBeNull();
    const read = item.asks.filter((a) => a.skate !== null).length;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThanOrEqual(VIEW_SKATES);
    // Past what fit, a skate reads null — never a throw.
    expect(item.asks.filter((a) => a.activityId !== null)).toHaveLength(askers.length);
  }, 60_000);
});

describe('asks are served newest first, the newest to the cap, with the decision’s ask named', () => {
  const crowd = async (w: W, n: number, kind: 'activate' | 'name_bay') => {
    const askers: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) askers.push((await person(w.t, `c${i}`)).id);
    return w.t.run(async (ctx) => {
      const ids: Id<'waterBodyRequests'>[] = [];
      for (const [i, who] of askers.entries()) {
        const id = await ctx.db.insert('waterBodyRequests', {
          kind,
          status: 'open',
          requesterId: who,
          coord: { lat: 0.2, lng: 0.2 },
          waterBodyId: w.lake,
          ...(kind === 'name_bay'
            ? { name: 'North Bay', nameKey: requestNameKeyFor('name_bay', 'North Bay') }
            : {}),
          createdAt: NOW - 100_000 + i * 10,
        });
        await fileMember(ctx, requestSource(id));
        ids.push(id);
      }
      return ids;
    });
  };

  test.each(['activate', 'name_bay'] as const)(
    'a %s item past the cap: the newest fifty, newest first; the primary its newest open ask',
    async (kind) => {
      const w = await world();
      if (kind === 'activate') {
        await w.t.run((ctx) =>
          ctx.db.patch(w.lake, { dormant: { since: NOW, reason: 'inactive' as const } }),
        );
      }
      const ids = await crowd(w, VIEW_MEMBERS + 10, kind);
      const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as RequestView | PlaceView;
      const served = item.asks.map((a) => a.requestId);
      expect(served).toEqual([...ids].reverse().slice(0, VIEW_MEMBERS));
      expect(item.primaryRequestId).toBe(served[0]);
    },
  );

  test('the primary is the newest open ask, past newer closed ones; the decision on it closes them all', async () => {
    const w = await world();
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, { dormant: { since: NOW, reason: 'inactive' as const } }),
    );
    const ids = await crowd(w, 4, 'activate');
    // The newest ask left (closed in its item): the newest open one is now the decision's.
    await w.t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) =>
          q.eq('sourceTable', 'waterBodyRequests').eq('sourceId', ids[3] as string),
        )
        .first();
      if (m) await ctx.db.patch(m._id, { status: 'closed' });
    });
    const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as RequestView;
    // Newest first whatever their status, as the Access item's reports are.
    expect(item.asks.map((a) => [a.requestId, a.status])).toEqual([
      [ids[3], 'closed'],
      [ids[2], 'open'],
      [ids[1], 'open'],
      [ids[0], 'open'],
    ]);
    expect(item.primaryRequestId).toBe(ids[2]);
    await w.mod.as.mutation(api.corpusRequests.decline, {
      requestId: item.primaryRequestId,
      note: 'No',
    });
    const statuses = await w.t.run(async (ctx) =>
      Promise.all(ids.slice(0, 3).map(async (id) => (await ctx.db.get(id))?.status)),
    );
    expect(statuses).toEqual(['declined', 'declined', 'declined']);
  });
});

describe('who reads it', () => {
  test('the asker and any skater are refused the item; a moderator reads it', async () => {
    const w = await world();
    await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: w.lake,
      verdict: 'none',
      reason: 'Owner called',
    });
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'contest_access',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
    });
    const stranger = await person(w.t, 'stranger');
    for (const as of [w.asker.as, stranger.as]) {
      await expect(as.query(api.inbox.item, { ref: `request:${requestId}` })).rejects.toThrow();
    }
    const item = (await itemOf(w, requestId)) as RequestView;
    expect(item.ruling?.reason).toBe('Owner called');
  });
});

const OBSERVED = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };

describe('a drawn item serves its skate, the report it became, and the drawer’s count', () => {
  let tracks = 0;
  /** A skate recorded by `by`, drawn into a new body. */
  const draw = async (_w: W, by: { as: As }) => {
    const i = tracks++;
    // Hours ago, so its report is in time (a week at most).
    const T0 = NOW - (6 + i) * 3_600_000;
    const activityId = await by.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: `draw-${i}`,
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, k) => [40 + i + k * 0.01, 40.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    const waterBodyId = await by.as.mutation(api.waterBodies.create, {
      name: 'Hidden Pond',
      type: 'lakePond',
      activityId,
      confirmedNew: true,
    });
    return { activityId, waterBodyId, T0 };
  };
  const drawnItem = async (w: W, waterBodyId: Id<'waterBodies'>) =>
    (await w.mod.as.query(api.inbox.item, { ref: `body:${waterBodyId}` })).item as Extract<
      InboxItemView,
      { kind: 'drawn' }
    >;

  test('the creating skate with its track, the report it became excerpted, the drawer’s stored count', async () => {
    const w = await world();
    const { activityId, waterBodyId, T0 } = await draw(w, w.asker);
    const notes = `Black ice from the north cove. ${'Long note. '.repeat(30)}`;
    const reportId = await w.asker.as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId,
      skateEndTime: T0 + 45 * 60_000,
      activityId,
      notes,
    } as never);
    const item = await drawnItem(w, waterBodyId);
    expect(item.skate).toEqual({
      activityId,
      startTime: T0,
      endTime: T0 + 45 * 60_000,
      elapsedSeconds: null,
      hasTrack: true,
    });
    expect(item.fromReport).toMatchObject({
      reportId,
      skateEndTime: T0 + 45 * 60_000,
      author: expect.objectContaining({ userId: w.asker.id }),
    });
    expect(item.fromReport?.excerpt?.startsWith('Black ice from the north cove.')).toBe(true);
    expect(item.fromReport?.excerpt?.length).toBeLessThanOrEqual(101);
    const profile = await w.t.run((ctx) => ctx.db.get(w.asker.id));
    expect(item.drawerReports).toBe(profile?.reportCount ?? null);
    expect(item.drawerReports).toBe(1);
  });

  test('a skate with no report: the skate, and no report; its track gone, no track for the map', async () => {
    const w = await world();
    const { activityId, waterBodyId } = await draw(w, w.asker);
    const item = await drawnItem(w, waterBodyId);
    expect(item.skate?.activityId).toBe(activityId);
    expect(item.skate?.hasTrack).toBe(true);
    expect(item.fromReport).toBeNull();
    await w.t.run((ctx) => ctx.db.patch(activityId, { path: undefined }));
    expect((await drawnItem(w, waterBodyId)).skate?.hasTrack).toBe(false);
  });

  test('another skater’s late-synced skate is the latest before the drawing: the drawer’s own is still found', async () => {
    const w = await world();
    const { activityId, waterBodyId } = await draw(w, w.asker);
    const body = await w.t.run((ctx) => ctx.db.get(waterBodyId));
    const interlopers = async (k: number) => {
      for (let i = 0; i < k; i++) {
        const other = await person(w.t, `other${i}-${Math.random()}`);
        await w.t.run((ctx) =>
          ctx.db.insert('gpsActivities', {
            userId: other.id,
            provider: 'native',
            providerActivityId: `theirs-${i}-${Math.random()}`,
            sportType: 'IceSkate',
            startTime: (body?.createdAt ?? NOW) - 1 - i,
            waterBodyId,
            promptState: 'pending',
            detectedAt: NOW,
          } as never),
        );
      }
    };
    await interlopers(1);
    expect((await drawnItem(w, waterBodyId)).skate?.activityId).toBe(activityId);
    // Past the page it reads (the latest few before the drawing), none is claimed — never another's.
    await interlopers(DRAWN_SKATE_PAGE);
    const item = await drawnItem(w, waterBodyId);
    expect(item.skate).toBeNull();
    expect(item.fromReport).toBeNull();
  });

  test('a skate begun after the drawing is never its skate', async () => {
    const w = await world();
    const { activityId, waterBodyId } = await draw(w, w.asker);
    const body = await w.t.run((ctx) => ctx.db.get(waterBodyId));
    await w.t.run((ctx) =>
      ctx.db.insert('gpsActivities', {
        userId: w.asker.id,
        provider: 'native',
        providerActivityId: 'later',
        sportType: 'IceSkate',
        startTime: (body?.createdAt ?? NOW) + 60_000,
        waterBodyId,
        promptState: 'pending',
        detectedAt: NOW,
      } as never),
    );
    expect((await drawnItem(w, waterBodyId)).skate?.activityId).toBe(activityId);
  });

  test('a drawer who has left: no count claimed', async () => {
    const w = await world();
    const { waterBodyId } = await draw(w, w.asker);
    expect((await drawnItem(w, waterBodyId)).drawerReports).toBeNull();
    await w.t.run((ctx) => ctx.db.patch(w.asker.id, { reportCount: 4 }));
    expect((await drawnItem(w, waterBodyId)).drawerReports).toBe(4);
    await w.t.run((ctx) => ctx.db.patch(w.asker.id, { deletionRequestedAt: NOW }));
    expect((await drawnItem(w, waterBodyId)).drawerReports).toBeNull();
  });
});

describe('a landmark ask’s byline carries its asker’s landmark asks', () => {
  const ready = (t: T) =>
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
  /** A landmark ask by `who` on the lake, at its own spot (another place per `i`), filed. */
  const landmarkAsk = (w: W, who: Id<'profiles'>, i: number, name = `Point ${i}`) =>
    w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark',
        status: 'open',
        requesterId: who,
        coord: { lat: -0.4 + i * 0.01, lng: -0.4 },
        waterBodyId: w.lake,
        name,
        nameKey: requestNameKeyFor('name_landmark', name),
        createdAt: NOW - 100_000 + i,
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
  const placeItem = async (w: W, requestId: Id<'waterBodyRequests'>) =>
    (await itemOf(w, requestId)) as PlaceView;

  test('the landmarks they asked for, this one counted, and how many were added', async () => {
    const w = await world();
    await ready(w.t);
    const decided = await landmarkAsk(w, w.asker.id, 1);
    await landmarkAsk(w, w.asker.id, 2);
    // A bay ask is not a landmark ask.
    await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: { lat: 0.2, lng: 0.2 },
      waterBodyId: w.lake,
      name: 'Shaker Cove',
    });
    // One of them added: its item decided approved.
    await w.t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) =>
          q.eq('sourceTable', 'waterBodyRequests').eq('sourceId', decided),
        )
        .first();
      if (!m) throw new Error('no member');
      await ctx.db.patch(m._id, { status: 'closed' });
      await ctx.db.patch(m.itemId, { status: 'decided', decision: 'approved', decidedAt: NOW });
    });
    const asked = await landmarkAsk(w, w.asker.id, 3);
    const item = await placeItem(w, asked);
    expect(item.asks[0]?.landmarkAsks).toEqual({ asked: 3, added: 1, capped: false });
  });

  test('past the filings it reads, the counts are floors and say so', async () => {
    const w = await world();
    await ready(w.t);
    let last: Id<'waterBodyRequests'> | undefined;
    for (let i = 0; i <= 51; i++) last = await landmarkAsk(w, w.asker.id, i);
    const item = await placeItem(w, last as Id<'waterBodyRequests'>);
    expect(item.asks[0]?.landmarkAsks).toMatchObject({ asked: 50, capped: true });
  });

  test('at most VIEW_ASKER_COUNTS askers an item, newest first; while the backfill runs, none', async () => {
    const w = await world();
    const askers: Id<'profiles'>[] = [];
    for (let i = 0; i < VIEW_ASKER_COUNTS + 1; i++) askers.push((await person(w.t, `a${i}`)).id);
    const ids: Id<'waterBodyRequests'>[] = [];
    // One place, four people: one item.
    for (const [i, who] of askers.entries()) {
      ids.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_landmark',
            status: 'open',
            requesterId: who,
            coord: { lat: 0.3, lng: 0.3 },
            waterBodyId: w.lake,
            name: 'Long Point',
            nameKey: requestNameKeyFor('name_landmark', 'Long Point'),
            createdAt: NOW - 10_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    const pending = await placeItem(w, ids[0] as Id<'waterBodyRequests'>);
    expect(pending.asks.map((a) => a.landmarkAsks)).toEqual([null, null, null, null]);
    await ready(w.t);
    const item = await placeItem(w, ids[0] as Id<'waterBodyRequests'>);
    expect(item.asks.map((a) => a.landmarkAsks)).toEqual([
      ...Array.from({ length: VIEW_ASKER_COUNTS }, () => ({ asked: 1, added: 0, capped: false })),
      null,
    ]);
  });

  test('a bay ask’s byline carries none', async () => {
    const w = await world();
    await ready(w.t);
    const id = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: { lat: 0.2, lng: 0.2 },
      waterBodyId: w.lake,
      name: 'Shaker Cove',
    });
    expect((await placeItem(w, id)).asks[0]?.landmarkAsks).toBeNull();
  });
});

describe('Same place answers its own row and undo offer', () => {
  test('approve with sameAs: the primary’s approve_request, undoable by the moderator', async () => {
    const w = await world();
    const landmarkId = await w.t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId: w.lake,
        name: 'Long Point',
        kind: 'point',
        point: { lat: -0.3, lng: -0.3 },
        source: 'moderator',
        externalIds: [],
        aliases: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const requestId = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark',
        status: 'open',
        requesterId: w.asker.id,
        coord: { lat: 0.2, lng: 0.2 },
        waterBodyId: w.lake,
        name: 'Long Point',
        nameKey: requestNameKeyFor('name_landmark', 'Long Point'),
        createdAt: NOW - 1000,
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    const out = await w.mod.as.mutation(api.corpusRequests.approve, {
      requestId,
      sameAs: { landmarkId, name: 'Long Point', point: { lat: -0.3, lng: -0.3 } },
    });
    expect(out).toMatchObject({ requestId, undoable: true, undoNeedsReason: false });
    expect(out.itemId).not.toBeNull();
    const row = await w.t.run((ctx) => ctx.db.get(out.actionId));
    expect(row).toMatchObject({ action: 'approve_request', targetId: requestId });
    await w.mod.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Checked' });
    expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('open');
  });
});

describe('a restore or takedown ask is an admin’s to decide, both ways (B01-5c, ruled)', () => {
  test.each(['takedown', 'restore'] as const)(
    'a %s ask: a moderator is refused decline, in the item and the write, in one sentence; an admin declines',
    async (kind) => {
      const w = await world();
      if (kind === 'restore') {
        await w.t.run((ctx) =>
          ctx.db.patch(w.lake, { removedAt: NOW, removalReason: 'landowner_request' }),
        );
        await w.t.mutation(internal.waterBodies.backfillCells, {});
      }
      const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
        kind,
        coord: { lat: 0.1, lng: 0.1 },
        waterBodyId: w.lake,
      });
      const item = (await itemOf(w, requestId)) as RequestView & {
        can: Record<string, string | null>;
      };
      expect(item.can).toEqual({ approve: 'Requires admin role', decline: 'Requires admin role' });
      await expect(
        w.mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' }),
      ).rejects.toThrow('Requires admin role');
      const asAdmin = (await w.admin.as.query(api.inbox.item, { ref: `request:${requestId}` }))
        .item as RequestView & { can: Record<string, string | null> };
      expect(asAdmin.can.decline).toBeNull();
      await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
      expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('declined');
    },
  );

  test('reopening a takedown’s decline is an admin’s too: the offer and the run refuse a moderator', async () => {
    const w = await world();
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
    });
    const out = await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    const row = await w.t.run((ctx) => ctx.db.get(out.actionId));
    const offer = await w.t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(w.mod.id)) as Doc<'profiles'>,
        row as Doc<'moderationActions'>,
        'one',
      ),
    );
    expect(offer).toEqual({ state: 'unavailable', why: 'Requires admin role' });
    await expect(
      w.mod.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Checked' }),
    ).rejects.toThrow('Requires admin role');
    await w.admin.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Checked' });
    expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('open');
  });

  test('every other kind stays a moderator’s to decline, and to reopen', async () => {
    const w = await world();
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, { dormant: { since: NOW, reason: 'inactive' as const } }),
    );
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: { lat: 0.1, lng: 0.1 },
      waterBodyId: w.lake,
    });
    const item = (await itemOf(w, requestId)) as RequestView & {
      can: Record<string, string | null>;
    };
    expect(item.can.decline).toBeNull();
    const out = await w.mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    expect(out.undoable).toBe(true);
    await w.mod.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Checked' });
  });
});

describe('an item’s lists are read whole, member by member: never a silent drop', () => {
  test.each([1, VIEW_MEMBERS, VIEW_MEMBERS + 10])(
    'an item of %i asks: served to the cap by count, the true total beside it',
    async (n) => {
      const w = await world();
      const ids = await w.t.run(async (ctx) => {
        const out: Id<'waterBodyRequests'>[] = [];
        for (let i = 0; i < n; i++) {
          const who = await ctx.db.insert('profiles', {
            clerkUserId: `n${i}`,
            displayName: `n${i} Test-Person`,
            username: `n${i}`,
            driveTimePrefMinutes: 60,
            profileVisibility: 'public',
            notificationPrefs: PREFS,
            dateOfBirth: Date.UTC(1990, 0, 1),
            reputationPoints: 0,
            role: 'member',
            status: 'active',
            createdAt: NOW,
          });
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: who,
            coord: { lat: 0.2, lng: 0.2 },
            waterBodyId: w.lake,
            name: 'North Bay',
            nameKey: requestNameKeyFor('name_bay', 'North Bay'),
            createdAt: NOW - 100_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          out.push(id);
        }
        return out;
      });
      const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as PlaceView;
      expect(item.asks).toHaveLength(Math.min(n, VIEW_MEMBERS));
      expect(item.asks.every((a) => a.asker !== null)).toBe(true);
      expect(item.memberCount).toBe(n);
      expect(item.asksCut).toBe(false);
    },
  );

  test('heavy asks: the list ends where the budget does, says so, and no ask is half-read', async () => {
    const w = await world();
    // Six rings of 8,000 points (a deployment caps an array at 8,192): ~860 KiB.
    const ring = Array.from({ length: 8_001 }, (_, i) => {
      const a = (2 * Math.PI * (i % 8_000)) / 8_000;
      return [30.5 + 0.4 * Math.cos(a), 0.4 * Math.sin(a)];
    });
    const outline = {
      type: 'Polygon' as const,
      coordinates: Array.from({ length: 6 }, () => ring),
    };
    const n = 16;
    const ids: Id<'waterBodyRequests'>[] = [];
    for (let i = 0; i < n; i++) {
      const who = (await person(w.t, `heavy${i}`)).id;
      ids.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'admit',
            status: 'open',
            requesterId: who,
            coord: { lat: 0, lng: 30.5 },
            candidate: {
              source: '3dhp',
              externalId: 'catalog/heavy',
              name: 'Big Pond',
              featureType: 390,
              cls: 'lakePond',
              polygon: outline as never,
              bbox: { minLat: -0.5, minLng: 30, maxLat: 0.5, maxLng: 31 },
              centroid: { lat: 0, lng: 30.5 },
              surfaceAreaSqM: 5_000_000,
              serviceUrl: 'https://example.invalid/3dhp',
              fetchedAt: NOW,
            },
            candidateExternalId: 'catalog/heavy',
            resolvedAt: NOW,
            createdAt: NOW - 100_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as RequestView;
    expect(item.asksCut).toBe(true);
    expect(item.memberCount).toBe(n);
    expect(item.asks.length).toBeGreaterThan(0);
    expect(item.asks.length).toBeLessThan(n);
    // A prefix by recency, each whole: its asker read with it.
    expect(item.asks.map((a) => a.requestId)).toEqual(
      [...ids].reverse().slice(0, item.asks.length),
    );
    expect(item.asks.every((a) => a.asker !== null)).toBe(true);
  }, 120_000);

  test('a flag item and an Access item past a dozen: every flag and report keeps its filer', async () => {
    const w = await world();
    const target = await person(w.t, 'flagged');
    const filers: As[] = [];
    for (let i = 0; i < 30; i++) filers.push((await person(w.t, `f${i}`)).as);
    for (const f of filers) {
      await f.mutation(api.contentFlags.flag, {
        targetType: 'user',
        targetId: target.id,
        reason: 'harassment',
      });
      await f.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: w.lake,
        reason: 'no_public_access',
      });
    }
    const items = await w.t.run((ctx) => ctx.db.query('inboxItems').collect());
    const flagItem = items.find((i) => i.kind === 'flag');
    const accessItem = items.find((i) => i.kind === 'access');
    const flags = (await w.mod.as.query(api.inbox.item, { ref: flagItem?._id as string }))
      .item as Extract<InboxItemView, { kind: 'flag' }>;
    const access = (await w.mod.as.query(api.inbox.item, { ref: accessItem?._id as string }))
      .item as Extract<InboxItemView, { kind: 'access' }>;
    expect(flags.flags).toHaveLength(30);
    expect(flags.flags.every((f) => f.filer !== null)).toBe(true);
    expect(access.reports).toHaveLength(30);
    expect(access.reports.every((f) => f.filer !== null)).toBe(true);
  }, 120_000);
});

describe('every member list says when it is cut, beside its total', () => {
  /** A person whose profile weighs ~900 KiB (a display name at that length) — a filer at its worst. */
  const heavyPerson = (w: W, subject: string) =>
    w.t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: `${'W'.repeat(900 * 1024)} Test-Person`,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: NOW,
      }),
    );
  /** `n` flags on one target, each by its own filer, filed raw (as the flag write files them). */
  const flagsOn = async (
    w: W,
    n: number,
    target: { targetType: 'user' | 'waterbody'; targetId: string },
    reason: 'harassment' | 'no_public_access',
    heavy = false,
  ) => {
    const filers: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      filers.push(heavy ? await heavyPerson(w, `hf${i}`) : (await person(w.t, `lf${i}`)).id);
    }
    for (let start = 0; start < n; start += 25) {
      await w.t.run(async (ctx) => {
        for (const [i, flaggerId] of filers.slice(start, start + 25).entries()) {
          const id = await ctx.db.insert('contentFlags', {
            flaggerId,
            ...target,
            reason,
            status: 'open',
            origin: 'user',
            createdAt: NOW - 100_000 + start + i,
          });
          await fileMember(ctx, flagSource(id));
        }
      });
    }
  };
  const itemOfKind = async (w: W, kind: 'flag' | 'access') => {
    const item = (await w.t.run((ctx) => ctx.db.query('inboxItems').collect())).find(
      (i) => i.kind === kind,
    );
    return (await w.mod.as.query(api.inbox.item, { ref: item?._id as string })).item;
  };

  test.each([1, VIEW_MEMBERS, VIEW_MEMBERS + 10])(
    'a flag item and an Access item of %i: served to the cap, the total beside it, not cut',
    async (n) => {
      const w = await world();
      const target = await person(w.t, 'flagged');
      await flagsOn(w, n, { targetType: 'user', targetId: target.id }, 'harassment');
      await flagsOn(w, n, { targetType: 'waterbody', targetId: w.lake }, 'no_public_access');
      const flag = (await itemOfKind(w, 'flag')) as Extract<InboxItemView, { kind: 'flag' }>;
      const access = (await itemOfKind(w, 'access')) as Extract<InboxItemView, { kind: 'access' }>;
      expect([flag.flags.length, flag.memberCount, flag.flagsCut]).toEqual([
        Math.min(n, VIEW_MEMBERS),
        n,
        false,
      ]);
      expect([access.reports.length, access.memberCount, access.reportsCut]).toEqual([
        Math.min(n, VIEW_MEMBERS),
        n,
        false,
      ]);
    },
    120_000,
  );

  test('heavy filers: each list ends where the budget does, says so, and keeps every filer it shows', async () => {
    const w = await world();
    const target = await person(w.t, 'flagged');
    await flagsOn(w, 16, { targetType: 'user', targetId: target.id }, 'harassment', true);
    await flagsOn(w, 16, { targetType: 'waterbody', targetId: w.lake }, 'no_public_access', true);
    const flag = (await itemOfKind(w, 'flag')) as Extract<InboxItemView, { kind: 'flag' }>;
    const access = (await itemOfKind(w, 'access')) as Extract<InboxItemView, { kind: 'access' }>;
    for (const [list, cut] of [
      [flag.flags, flag.flagsCut],
      [access.reports, access.reportsCut],
    ] as const) {
      expect(cut).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThan(16);
      expect(list.every((f) => f.filer !== null)).toBe(true);
    }
  }, 180_000);

  test.each([1, DISMISSED_BY_RULING_READ, DISMISSED_BY_RULING_READ + 1])(
    'the reports a ruling dismissed, %i of them: to the read’s cap, and cut past it',
    async (n) => {
      const w = await world();
      await flagsOn(w, n, { targetType: 'waterbody', targetId: w.lake }, 'no_public_access');
      await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
        waterBodyId: w.lake,
        verdict: 'open',
        reason: 'Town lot is public',
      });
      const access = (await itemOfKind(w, 'access')) as Extract<InboxItemView, { kind: 'access' }>;
      expect(access.dismissedByRuling).toHaveLength(Math.min(n, DISMISSED_BY_RULING_READ));
      expect(access.dismissedByRulingCut).toBe(n > DISMISSED_BY_RULING_READ);
      expect(access.dismissedByRuling.every((f) => f.filer !== null)).toBe(true);
    },
    120_000,
  );

  test('a ruling’s dismissed reports by heavy filers: the list ends where the budget does, each filer whole', async () => {
    const w = await world();
    await flagsOn(w, 14, { targetType: 'waterbody', targetId: w.lake }, 'no_public_access', true);
    await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: w.lake,
      verdict: 'open',
      reason: 'Town lot is public',
    });
    const access = (await itemOfKind(w, 'access')) as Extract<InboxItemView, { kind: 'access' }>;
    expect(access.dismissedByRulingCut).toBe(true);
    expect(access.dismissedByRuling.length).toBeLessThan(14);
    expect(access.dismissedByRuling.every((f) => f.filer !== null)).toBe(true);
  }, 180_000);

  test('a flag row: its flags’ reasons read whole on a tight page budget, never dropped', async () => {
    const w = await world();
    const target = await person(w.t, 'flagged');
    // One lane's reasons, so one item.
    const reasons = ['harassment', 'spam', 'inappropriate', 'other'] as const;
    await w.t.run(async (ctx) => {
      for (const [i, reason] of reasons.entries()) {
        const flaggerId = await ctx.db.insert('profiles', {
          clerkUserId: `rf${i}`,
          displayName: `rf${i} Test-Person`,
          username: `rf${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: NOW,
        });
        const id = await ctx.db.insert('contentFlags', {
          flaggerId,
          targetType: 'user',
          targetId: target.id,
          reason,
          status: 'open',
          origin: 'user',
          createdAt: NOW - 1000 + i,
        });
        await fileMember(ctx, flagSource(id));
      }
    });
    // Room for the page and two and a half flags at their bound: four flag reads started together
    // held two; one at a time, each hands back what it didn't use.
    const spy = vi
      .spyOn(readBudget, 'requestBudget')
      .mockImplementation(
        () => new readBudget.ReadBudget(2.5 * readBudget.ROW_MAX.contentFlag + 2048),
      );
    const page = await w.mod.as.query(api.inbox.listPage, { lane: 'contentFlags', pageSize: 1 });
    spy.mockRestore();
    const row = page.rows.find((r) => r.kind === 'flag') as Extract<
      (typeof page.rows)[number],
      { kind: 'flag' }
    >;
    expect([...row.reasons].sort()).toEqual([...reasons].sort());
  });

  test('a place row: its other askers read whole on a tight page budget, never dropped', async () => {
    const w = await world();
    const ids: Id<'waterBodyRequests'>[] = [];
    for (let i = 0; i < 3; i++) {
      const who = (await person(w.t, `row${i}`)).id;
      ids.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: who,
            coord: { lat: 0.2, lng: 0.2 },
            waterBodyId: w.lake,
            name: 'North Bay',
            nameKey: requestNameKeyFor('name_bay', 'North Bay'),
            createdAt: NOW - 10_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    // A page budget of two and a half documents: three ask reads started together held three.
    const spy = vi
      .spyOn(readBudget, 'requestBudget')
      .mockImplementation(() => new readBudget.ReadBudget(2.5 * readBudget.DOC_MAX));
    const page = await w.mod.as.query(api.inbox.listPage, { lane: 'placesAsked', pageSize: 10 });
    spy.mockRestore();
    const row = page.rows.find((r) => r.kind === 'place') as Extract<
      (typeof page.rows)[number],
      { kind: 'place' }
    >;
    expect(row.askers).toBe(3);
    expect(row.others).toHaveLength(2);
  });
});

describe('the item’s map draws the skate behind it (boards 2.3, 2.5)', () => {
  let n = 0;
  /** A skate of `by`'s with a `points`-long track, drawn into a new body. */
  const drawFrom = async (_w: W, by: { as: As }, points = 20) => {
    const i = n++;
    const T0 = NOW - (6 + i) * 3_600_000;
    const activityId = await by.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: `map-${i}`,
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: points }, (_, k) => [50 + i + k * 1e-4, 40.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    const waterBodyId = await by.as.mutation(api.waterBodies.create, {
      name: 'Hidden Pond',
      type: 'lakePond',
      activityId,
      confirmedNew: true,
    });
    return { activityId, waterBodyId };
  };
  const mapOf = async (as: As, ref: string) => (await as.query(api.inbox.itemMap, { ref })).map;

  test('the map’s bounds are whole whichever module loads first (this file loads inbox.ts first)', async () => {
    const { MAP_BOUNDS } = await import('./lib/inboxViews');
    expect(MAP_BOUNDS).toMatchObject({
      outlineBytes: MAP_OUTLINE_BYTES,
      ringPoints: MAP_RING_POINTS,
    });
    expect(MAP_RING_POINTS).toBe(512);
  });

  test('a drawing’s own skate: its track, whole', async () => {
    const w = await world();
    const { activityId, waterBodyId } = await drawFrom(w, w.asker);
    const map = await mapOf(w.mod.as, `body:${waterBodyId}`);
    expect(map?.tracks).toHaveLength(1);
    expect(map?.tracks[0]).toMatchObject({ id: activityId, simplified: false });
    expect(map?.tracks[0]?.path).toHaveLength(20);
    expect(map?.tracks[0]?.path[0]).toEqual([expect.any(Number), 40.5]);
    expect(map?.capped).toBe(false);
    // A small drawing's outline is sent whole, not thinned (the bounds read as numbers).
    expect(map?.body?.simplified).toBe(false);
  });

  test('a drawing whose skate has no track: none; an interloper’s later skate: only the drawer’s track', async () => {
    const w = await world();
    const { activityId, waterBodyId } = await drawFrom(w, w.asker);
    await w.t.run((ctx) => ctx.db.patch(activityId, { path: undefined }));
    expect((await mapOf(w.mod.as, `body:${waterBodyId}`))?.tracks).toEqual([]);

    const second = await drawFrom(w, w.asker);
    const body = await w.t.run((ctx) => ctx.db.get(second.waterBodyId));
    const other = await person(w.t, 'other');
    await w.t.run((ctx) =>
      ctx.db.insert('gpsActivities', {
        userId: other.id,
        provider: 'native',
        providerActivityId: 'theirs',
        sportType: 'IceSkate',
        startTime: (body?.createdAt ?? NOW) - 1,
        waterBodyId: second.waterBodyId,
        path: {
          type: 'LineString',
          coordinates: [
            [1, 1],
            [2, 2],
          ],
        },
        promptState: 'pending',
        detectedAt: NOW,
      } as never),
    );
    expect((await mapOf(w.mod.as, `body:${second.waterBodyId}`))?.tracks.map((t) => t.id)).toEqual([
      second.activityId,
    ]);
  });

  test('an oversized track: thinned to the embed’s points, first and last kept, said', async () => {
    const w = await world();
    const { activityId, waterBodyId } = await drawFrom(w, w.asker);
    const coordinates = Array.from({ length: 30_000 }, (_, k) => [50 + k * 1e-6, 40 + k * 1e-6]);
    await w.t.run((ctx) => ctx.db.patch(activityId, { path: { type: 'LineString', coordinates } }));
    const track = (await mapOf(w.mod.as, `body:${waterBodyId}`))?.tracks[0];
    expect(track?.simplified).toBe(true);
    expect(track?.path).toHaveLength(MAP_RING_POINTS);
    expect(track?.path[0]).toEqual(coordinates[0]);
    expect(track?.path.at(-1)).toEqual(coordinates.at(-1));
  });

  test('an admit ask from a recorded skate: its track beside the asked point', async () => {
    const w = await world();
    const activityId = await skate(w, w.asker.id, 0);
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 30, lng: 30 },
      activityId,
    });
    const map = await mapOf(w.mod.as, `request:${requestId}`);
    expect(map?.points.map((p) => p.id)).toEqual([requestId]);
    expect(map?.tracks.map((t) => [t.id, t.path.length, t.simplified])).toEqual([
      [activityId, 20, false],
    ]);
    // An ask with no skate draws none.
    const plain = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 35, lng: 35 },
    });
    expect((await mapOf(w.mod.as, `request:${plain}`))?.tracks).toEqual([]);
  });

  test('tracks share the answer’s bound with the outlines: past it, one is left out and the map says capped', async () => {
    const w = await world();
    const ids: Id<'waterBodyRequests'>[] = [];
    // Five askers, each from a skate whose track is just under what an embed sends whole (~230 KiB):
    // more than the answer's 1 MiB together.
    for (let i = 0; i < 5; i++) {
      const who = (await person(w.t, `trk${i}`)).id;
      const activityId = await skate(w, who, 100 + i, 12_000);
      ids.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: who,
            coord: { lat: 0.2, lng: 0.2 },
            waterBodyId: w.lake,
            name: 'North Bay',
            nameKey: requestNameKeyFor('name_bay', 'North Bay'),
            activityId,
            createdAt: NOW - 10_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as PlaceView;
    expect(item.asks.filter((a) => a.skate !== null)).toHaveLength(5);
    // A place's map draws its asks' points, not their skates: the bound is held on a request's.
    const request = await w.t.run(async (ctx) => {
      const admits: Id<'waterBodyRequests'>[] = [];
      for (const [i, ask] of ids.entries()) {
        const row = await ctx.db.get(ask);
        const id = await ctx.db.insert('waterBodyRequests', {
          kind: 'admit',
          status: 'open',
          requesterId: row?.requesterId as Id<'profiles'>,
          coord: { lat: 30, lng: 30 },
          candidate: {
            source: '3dhp',
            externalId: 'catalog/tracks',
            name: 'Track Pond',
            featureType: 390,
            cls: 'lakePond',
            polygon: SQUARE as never,
            bbox: { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 },
            centroid: { lat: 0, lng: 0 },
            surfaceAreaSqM: 1_000_000,
            serviceUrl: 'https://example.invalid/3dhp',
            fetchedAt: NOW,
          },
          candidateExternalId: 'catalog/tracks',
          resolvedAt: NOW,
          activityId: row?.activityId,
          createdAt: NOW - 5_000 + i,
        });
        await fileMember(ctx, requestSource(id));
        admits.push(id);
      }
      return admits;
    });
    const map = await mapOf(w.mod.as, `request:${request[0]}`);
    expect(map?.tracks.length).toBeGreaterThan(0);
    expect(map?.tracks.length).toBeLessThan(5);
    expect(map?.tracks.every((t) => !t.simplified)).toBe(true);
    expect(map?.capped).toBe(true);
  }, 60_000); // 7.7 s under the contended run: 5x headroom with CI's slower runners.

  test('the drawer and any skater are refused the map, track and all', async () => {
    const w = await world();
    const { waterBodyId } = await drawFrom(w, w.asker);
    await expect(mapOf(w.asker.as, `body:${waterBodyId}`)).rejects.toThrow();
    expect((await mapOf(w.mod.as, `body:${waterBodyId}`))?.tracks).toHaveLength(1);
  });
});

describe('what an item rests on is read before what fills its budget (B01-5c review)', () => {
  /** Twelve asks of `kind` on the lake, each from its own ~900 KiB skate — more than the item holds. */
  const heavyAsks = async (w: W, kind: 'contest_access' | 'activate') => {
    const ids: Id<'waterBodyRequests'>[] = [];
    for (let i = 0; i < 12; i++) {
      const who = (await person(w.t, `${kind}${i}`)).id;
      const activityId = await skate(w, who, 200 + i, 50_000);
      ids.push(
        await w.t.run(async (ctx) => {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind,
            status: 'open',
            requesterId: who,
            coord: { lat: 0.1, lng: 0.1 },
            waterBodyId: w.lake,
            activityId,
            createdAt: NOW - 100_000 + i,
          });
          await fileMember(ctx, requestSource(id));
          return id;
        }),
      );
    }
    return ids;
  };

  test('a contest-access item full of heavy skates: the ruling keeps its ruler and what they cited', async () => {
    const w = await world();
    await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: w.lake,
      verdict: 'none',
      reason: 'Owner called',
    });
    const ids = await heavyAsks(w, 'contest_access');
    const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as RequestView;
    // The skates did fill the budget: some asks carry none.
    expect(item.asks.some((a) => a.activityId !== null && a.skate === null)).toBe(true);
    expect(item.ruling?.by).toEqual(expect.objectContaining({ userId: w.mod.id }));
    expect(item.ruling?.reason).toBe('Owner called');
  }, 180_000);

  test('an activate item full of heavy skates: a moderator’s shelving still names the moderator', async () => {
    const w = await world();
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, {
        dormant: { since: NOW, reason: 'moderator', byUserId: w.admin.id, note: 'Drained' },
      }),
    );
    const ids = await heavyAsks(w, 'activate');
    const item = (await itemOf(w, ids[0] as Id<'waterBodyRequests'>)) as RequestView;
    expect(item.dormancy?.by).toEqual(expect.objectContaining({ userId: w.admin.id }));
  }, 180_000);

  test('a flag and an Access item of heavy filers: the target, its author and the ruler are whole', async () => {
    const w = await world();
    const target = await person(w.t, 'flagged');
    const heavy: Id<'profiles'>[] = [];
    for (let i = 0; i < 14; i++) {
      heavy.push(
        await w.t.run((ctx) =>
          ctx.db.insert('profiles', {
            clerkUserId: `hv${i}`,
            displayName: `${'W'.repeat(900 * 1024)} Test-Person`,
            username: `hv${i}`,
            driveTimePrefMinutes: 60,
            profileVisibility: 'public',
            notificationPrefs: PREFS,
            dateOfBirth: Date.UTC(1990, 0, 1),
            reputationPoints: 0,
            role: 'member',
            status: 'active',
            createdAt: NOW,
          }),
        ),
      );
    }
    const reportId = await w.t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: target.id,
        waterBodyId: w.lake,
        point: { lat: 0.1, lng: 0.1 },
        skateEndTime: NOW - 3_600_000,
        reportTime: NOW,
        source: 'native',
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        notes: 'Held fine',
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await w.mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: w.lake,
      verdict: 'open',
      reason: 'Town lot',
    });
    await w.t.run(async (ctx) => {
      for (const [i, flaggerId] of heavy.entries()) {
        for (const [targetType, targetId, reason] of [
          ['report', reportId, 'spam'],
          ['waterbody', w.lake, 'no_public_access'],
        ] as const) {
          const id = await ctx.db.insert('contentFlags', {
            flaggerId,
            targetType,
            targetId,
            reason,
            status: 'open',
            origin: 'user',
            ...(targetType === 'report' ? { subjectUserId: target.id } : {}),
            createdAt: NOW - 1000 + i,
          });
          await fileMember(ctx, flagSource(id));
        }
      }
    });
    const items = await w.t.run((ctx) => ctx.db.query('inboxItems').collect());
    const flag = (
      await w.mod.as.query(api.inbox.item, {
        ref: items.find((i) => i.kind === 'flag')?._id as string,
      })
    ).item as Extract<InboxItemView, { kind: 'flag' }>;
    const access = (
      await w.mod.as.query(api.inbox.item, {
        ref: items.find((i) => i.kind === 'access')?._id as string,
      })
    ).item as Extract<InboxItemView, { kind: 'access' }>;
    expect(flag.flagsCut).toBe(true);
    expect(flag.target).toMatchObject({ targetType: 'report' });
    expect((flag.target as { report?: { reportId: string } }).report?.reportId).toBe(reportId);
    expect(flag.author?.person.userId).toBe(target.id);
    expect(access.reportsCut).toBe(true);
    expect(access.ruling?.by).toEqual(expect.objectContaining({ userId: w.mod.id }));
    expect(access.ruling?.reason).toBe('Town lot');
  }, 240_000);

  test('a required row past the budget throws, never reading as a row that is gone', async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const tight = () =>
        new InboxReader(ctx, new readBudget.ReadBudget(1024), NOW, w.mod.id, true);
      // A list's read answers null past the budget — the same null as a row that's gone…
      await expect(tight().get<'profiles'>('profile', w.admin.id)).resolves.toBeNull();
      // …a required row's says so.
      await expect(tight().must<'profiles'>('profile', w.admin.id)).rejects.toBeInstanceOf(
        readBudget.OverBudget,
      );
    });
  });
});
