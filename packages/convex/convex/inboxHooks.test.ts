/**
 * Each writer hook in the inventory (B01-5, `inboxWriters.test.ts`): the source event moves the item,
 * its members and its counts.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { fileOrBumpAutoFlag } from './lib/autoFlag';
import { fileLandmarkProposals } from './lib/landmarkProposals';
import { closeRow } from './lib/requestDecisions';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

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
const square = (x: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, 0],
      [x, 1],
      [x + 1, 1],
      [x + 1, 0],
      [x, 0],
    ],
  ],
});

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

async function body(t: T, externalId: string, x: number) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond',
        polygon: square(x),
        bbox: { minLat: 0, minLng: x, maxLat: 1, maxLng: x + 1 },
        centroid: { lat: 0.5, lng: x + 0.5 },
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

/** The Inbox as the hooks left it: open items by key with their open members, and the counts. */
async function inbox(t: T) {
  return t.run(async (ctx) => {
    const items = await ctx.db.query('inboxItems').collect();
    const members = await ctx.db.query('inboxItemMembers').collect();
    const counts = Object.fromEntries(
      (await ctx.db.query('inboxCounts').collect())
        .filter((c) => c.count !== 0)
        .map((c) => [c.key, c.count]),
    );
    return {
      items,
      members,
      counts,
      open: items
        .filter((i) => i.status === 'open')
        .map((i) => `${i.key.split(':')[0]}:${i.memberCount}`),
      decided: items.filter((i) => i.status === 'decided').map((i) => i.decision),
    };
  });
}

describe('flags', () => {
  test('filed, a second filer joins, retracted, resolved: the item and its counts follow', async () => {
    const t = harness();
    const [a, b, c] = [await person(t, 'a'), await person(t, 'b'), await person(t, 'c')];
    const mod = await person(t, 'mod', 'moderator');
    const flag = (who: typeof a) =>
      who.as.mutation(api.contentFlags.flag, {
        targetType: 'user',
        targetId: c.id,
        reason: 'spam',
      });
    const f1 = await flag(a);
    expect((await inbox(t)).counts).toEqual({
      'open:contentFlags': 1,
      'open:contentFlags:people': 1,
    });
    const f2 = await flag(b);
    expect((await inbox(t)).open).toEqual(['flag:2']);
    await b.as.mutation(api.contentFlags.retract, { flagId: f2 });
    expect((await inbox(t)).open).toEqual(['flag:1']);
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: f1,
      resolution: 'dismissed',
      reason: 'fine',
    });
    const after = await inbox(t);
    expect(after.open).toEqual([]);
    expect(after.decided).toEqual(['dismissed']);
    expect(after.counts).toEqual({ decided: 1 });
    expect(after.items[0]?.decidedByUserId).toBe(mod.id);
  });

  test('the last filer withdrawing deletes the item — never decided', async () => {
    const t = harness();
    const [a, c] = [await person(t, 'a'), await person(t, 'c')];
    const f = await a.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: c.id,
      reason: 'unsafe_false_report',
    });
    expect((await inbox(t)).counts).toEqual({ 'open:safety': 1, 'open:safety:people': 1 });
    await a.as.mutation(api.contentFlags.retract, { flagId: f });
    expect(await inbox(t)).toMatchObject({ items: [], members: [], counts: {} });
  });

  test('the app’s flag files, its occurrence bump keeps the one item', async () => {
    const t = harness();
    const [system, c] = [await person(t, 'system'), await person(t, 'c')];
    await t.run(async (ctx) => {
      await fileOrBumpAutoFlag(ctx, {
        targetType: 'user',
        targetId: c.id,
        reason: 'other',
        flaggerId: system.id,
      });
      await fileOrBumpAutoFlag(ctx, {
        targetType: 'user',
        targetId: c.id,
        reason: 'other',
        flaggerId: system.id,
      });
    });
    const s = await inbox(t);
    expect(s.open).toEqual(['flag:1']);
    // No person filed it: no filer to refuse (D289).
    expect(s.members[0]?.filedByUserId).toBeUndefined();
  });

  test('a ruling closes the body’s access reports, its item decided as the ruling says', async () => {
    const t = harness();
    const [a, b] = [await person(t, 'a'), await person(t, 'b')];
    const mod = await person(t, 'mod', 'moderator');
    const lake = await body(t, 'osm/A', 0);
    for (const who of [a, b]) {
      await who.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: lake,
        reason: 'no_public_access',
      });
    }
    const before = await inbox(t);
    expect(before.open).toEqual(['access:2']);
    expect(before.counts).toEqual({ 'open:accessReports': 1, 'open:accessReports:new': 1 });
    // Most-corroborated first: two reporters rank ahead of any one.
    expect(before.items[0]?.rankKey).toBeLessThan(499 * 1e13);
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: lake, verdict: 'none' });
    const after = await inbox(t);
    expect(after.decided).toEqual(['ruled_closed']);
    expect(after.counts).toEqual({ decided: 1 });
  });
});

describe('asks', () => {
  test('filed by two people is one item; one withdraws; an admit resolved joins its feature’s item', async () => {
    const t = harness();
    const [a, b] = [await person(t, 'a'), await person(t, 'b')];
    const lake = await body(t, 'osm/A', 0);
    for (const who of [a, b]) {
      await who.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: lake,
        name: 'Cove',
      });
    }
    expect((await inbox(t)).open).toEqual(['bay:2']);
    const admits: Id<'waterBodyRequests'>[] = [];
    for (const [i, who] of [a, b].entries()) {
      admits.push(
        await who.as.mutation(api.corpusRequests.create, {
          kind: 'admit',
          coord: { lat: 30 + i, lng: 30 },
        }),
      );
    }
    expect((await inbox(t)).open.filter((k) => k.startsWith('admit'))).toEqual([
      'admit:1',
      'admit:1',
    ]);
    const candidate = {
      source: '3dhp' as const,
      externalId: 'EXT',
      name: 'Unseen',
      featureType: 1,
      polygon: square(30),
      bbox: { minLat: 0, minLng: 30, maxLat: 1, maxLng: 31 },
      centroid: { lat: 0.5, lng: 30.5 },
      surfaceAreaSqM: 10,
      serviceUrl: 'https://example.invalid',
      fetchedAt: 1,
    };
    for (const requestId of admits) {
      await t.mutation(internal.corpusRequests.recordResolution, {
        requestId,
        resolvedAt: Date.now(),
        candidate,
      });
    }
    const resolved = await inbox(t);
    expect(resolved.open.filter((k) => k.startsWith('admit'))).toEqual(['admit:2']);
    expect(resolved.items.find((i) => i.key === 'admit:EXT')).toBeTruthy();
    await a.as.mutation(api.corpusRequests.retract, {
      requestId: admits[0] as Id<'waterBodyRequests'>,
    });
    expect((await inbox(t)).open.filter((k) => k.startsWith('admit'))).toEqual(['admit:1']);
  });

  test('declined with siblings across a drain page: the item decides with its last sibling', async () => {
    const t = harness();
    const people = [await person(t, 'a'), await person(t, 'b'), await person(t, 'c')];
    const mod = await person(t, 'mod', 'moderator');
    const lake = await body(t, 'osm/A', 0);
    const asks: Id<'waterBodyRequests'>[] = [];
    for (const who of people) {
      asks.push(
        await who.as.mutation(api.corpusRequests.create, {
          kind: 'takedown',
          coord: { lat: 0.5, lng: 0.5 },
          waterBodyId: lake,
        }),
      );
    }
    const primary = (await t.run((ctx) =>
      ctx.db.get(asks[0] as Id<'waterBodyRequests'>),
    )) as Doc<'waterBodyRequests'>;
    // A moment for the wall clock to pass the asks: convex-test hands out `_creationTime` ahead of it
    // under a burst of inserts, and a decision drains only the asks that existed by its `now`.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const now = Date.now();
    const decision = {
      requestId: primary._id,
      status: 'declined' as const,
      actorId: mod.id,
      now,
      note: 'no',
    };
    // The first page closes only the primary (the page boundary); `closeRow` decides its member.
    await t.run(async (ctx) => {
      await closeRow(ctx, primary, decision);
    });
    const mid = await inbox(t);
    expect(mid.open).toEqual(['takedown:2']);
    expect(mid.members.filter((m) => m.status === 'closed')).toHaveLength(1);
    // The drain's next page closes the siblings; the item decides with its last open member.
    await t.mutation(internal.corpusRequests.closeSiblings, decision);
    const after = await inbox(t);
    expect(after.open).toEqual([]);
    expect(after.decided).toEqual(['declined']);
    expect(after.items[0]?.memberCount).toBe(3);
  });

  test('a seed-origin ask files no item and moves no count (D289, amended)', async () => {
    const t = harness();
    const staff = await person(t, 'staff', 'admin');
    const lake = await body(t, 'osm/A', 0);
    const report = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: staff.id,
      apply: true,
      rows: [
        {
          name: 'Seed Bay',
          parentName: 'Pond osm/A',
          state: 'VT',
          coord: { lat: 0.5, lng: 0.5 },
          note: 'seeded',
        },
      ],
    });
    expect(report[0]?.status).toBe('filed');
    const rows = await t.run((ctx) => ctx.db.query('waterBodyRequests').collect());
    expect(rows.map((r) => r.origin)).toEqual(['seed']);
    expect(await inbox(t)).toMatchObject({ items: [], members: [], counts: {} });
    void lake;
  });

  test('landmark asks join the open item of the same place; another place is its own', async () => {
    const t = harness();
    const [a, b] = [await person(t, 'a'), await person(t, 'b')];
    const lake = await body(t, 'osm/A', 0);
    await t.run(async (ctx) => {
      const water = (await ctx.db.get(lake)) as Doc<'waterBodies'>;
      const report = await ctx.db.insert('reports', {
        authorId: a.id,
        waterBodyId: lake,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: 1,
        reportTime: 1,
        source: 'native',
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: 1,
        updatedAt: 1,
      });
      await fileLandmarkProposals(
        ctx,
        a.id,
        water,
        report,
        [{ name: 'the Narrows', coord: { lat: 0.5, lng: 0.5 } }],
        [],
      );
      await fileLandmarkProposals(
        ctx,
        b.id,
        water,
        report,
        [{ name: 'the Narrows', coord: { lat: 0.5001, lng: 0.5 } }],
        [],
      );
      await fileLandmarkProposals(
        ctx,
        b.id,
        water,
        report,
        [{ name: 'Long Point', coord: { lat: 0.1, lng: 0.1 } }],
        [],
      );
    });
    expect((await inbox(t)).open.sort()).toEqual(['landmark:1', 'landmark:2']);
  });
});

describe('drawn bodies, merges and tickets', () => {
  async function drawn(who: { as: ReturnType<T['withIdentity']> }, i: number) {
    const T0 = Date.UTC(2026, 0, 15, 14 + i);
    const activityId = await who.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: `track-${i}`,
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, k) => [40 + i * 3 + k * 0.01, 40.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    return who.as.mutation(api.waterBodies.create, {
      name: `Drawn ${i}`,
      type: 'lakePond',
      activityId,
      confirmedNew: true,
    });
  }

  test('drawn, approved, rejected, merged: each decides its item', async () => {
    const t = harness();
    const a = await person(t, 'a');
    const mod = await person(t, 'mod', 'moderator');
    const lake = await body(t, 'osm/A', 0);
    const [d0, d1, d2] = [await drawn(a, 0), await drawn(a, 1), await drawn(a, 2)];
    expect((await inbox(t)).counts).toEqual({
      'open:drawnBodies': 3,
      'open:drawnBodies:newWater': 3,
    });
    await mod.as.mutation(api.waterBodies.approve, { waterBodyId: d0 });
    await mod.as.mutation(api.waterBodies.reject, { waterBodyId: d1 });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: lake, loserId: d2 });
    const after = await inbox(t);
    expect(after.decided.sort()).toEqual(['approved', 'merged', 'rejected']);
    expect(after.counts).toEqual({ decided: 3 });
  });

  test('a merge moves the loser’s asks and access reports to the survivor’s items', async () => {
    const t = harness();
    const [a, b] = [await person(t, 'a'), await person(t, 'b')];
    const mod = await person(t, 'mod', 'moderator');
    const survivor = await body(t, 'osm/S', 0);
    const loser = await body(t, 'osm/L', 3);
    await a.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: survivor,
      reason: 'no_public_access',
    });
    await b.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: loser,
      reason: 'no_public_access',
    });
    await b.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0.5, lng: 3.5 },
      waterBodyId: loser,
    });
    await a.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0.5, lng: 0.5 },
      waterBodyId: survivor,
    });
    expect((await inbox(t)).open.sort()).toEqual([
      'access:1',
      'access:1',
      'takedown:1',
      'takedown:1',
    ]);
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const after = await inbox(t);
    expect(after.open.sort()).toEqual(['access:2', 'takedown:2']);
    expect(after.items.every((i) => i.key.includes(survivor))).toBe(true);
  });

  test('a ticket filed and resolved', async () => {
    const t = harness();
    const a = await person(t, 'a');
    const admin = await person(t, 'admin', 'admin');
    const ticketId = await a.as.mutation(api.support.create, { category: 'account', body: 'help' });
    expect((await inbox(t)).counts).toEqual({ 'open:support': 1, 'open:support:account': 1 });
    await admin.as.mutation(api.support.resolve, { ticketId });
    const after = await inbox(t);
    expect(after.decided).toEqual(['resolved']);
    expect(after.counts).toEqual({ decided: 1, 'decided:support': 1 });
    expect(after.items[0]).toMatchObject({ decidedByUserId: admin.id, subjectUserId: a.id });
  });
});
