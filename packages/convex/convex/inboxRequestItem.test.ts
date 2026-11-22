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
import type { Id } from './_generated/dataModel';
import type { InboxItemView } from './inbox';
import { fileMember, requestSource } from './lib/inboxItems';
import { VIEW_MEMBERS, VIEW_SKATES } from './lib/inboxViews';
import * as readBudget from './lib/readBudget';
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
