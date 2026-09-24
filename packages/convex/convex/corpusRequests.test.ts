/**
 * Corpus requests (A07b PR 2): the five kinds, the guards, the resolver's record, the decisions and
 * what they perform, and the create-over-a-takedown refusal.
 */

import { describeRequestOutcome, standingOf } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { QUEUE_CAP } from './corpusRequests';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);

const POLYGON: Polygon = {
  type: 'Polygon',
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
const INSIDE = { lat: 0.5, lng: 0.5 };
const FAR = { lat: 20, lng: 20 };

const BASE_PREFS = {
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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: BASE_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    } as Doc<'profiles'>),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  externalId = 'osm/1',
  patch: Partial<Doc<'waterBodies'>> = {},
): Promise<Id<'waterBodies'>> {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: 'Quiet Pond',
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: INSIDE,
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  if (Object.keys(patch).length > 0) {
    await t.run((ctx) => ctx.db.patch(body._id, patch));
    await t.mutation(internal.waterBodies.backfillCells, {});
  }
  return body._id;
}

const get = (t: ReturnType<typeof convexTest>, id: Id<'waterBodies'>) =>
  t.run((ctx) => ctx.db.get(id));

const dormant = { dormant: { since: Date.now(), reason: 'inactive' as const } };

/** A candidate as the resolver would record it — a 3DHP square around FAR. */
const CANDIDATE = {
  source: '3dhp' as const,
  externalId: 'I6PYK',
  name: 'Unseen Pond',
  cls: 'lakePond',
  featureType: 3,
  polygon: {
    type: 'Polygon',
    coordinates: [
      [
        [19.99, 19.99],
        [20.01, 19.99],
        [20.01, 20.01],
        [19.99, 20.01],
        [19.99, 19.99],
      ],
    ],
  },
  bbox: { minLat: 19.99, minLng: 19.99, maxLat: 20.01, maxLng: 20.01 },
  centroid: FAR,
  surfaceAreaSqM: 4_900_000,
  serviceUrl: 'https://hydro.nationalmap.gov/…',
  fetchedAt: Date.now(),
};

describe('create — the five kinds and their guards', () => {
  test('activate on a dormant body; refused on an active one, and on a second ask', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant);
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
      note: 'We skate it every January.',
    });
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).toMatchObject({
      kind: 'activate',
      status: 'open',
      note: 'We skate it every January.',
    });
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'activate',
        coord: INSIDE,
        waterBodyId: id,
      }),
    ).rejects.toThrow(/already asked/i);

    const active = await seedBody(t, 'osm/2');
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'activate',
        coord: INSIDE,
        waterBodyId: active,
      }),
    ).rejects.toThrow(/already on the active map/i);
  });

  test('the kinds follow the standing: restore for removed, contest for none, takedown for active', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const removed = await seedBody(t, 'osm/r', { removedAt: Date.now(), removalReason: 'junk' });
    const none = await seedBody(t, 'osm/n', {
      publicAccess: { verdict: 'none', decidedAt: Date.now(), decidedByUserId: mod.id },
    });
    const active = await seedBody(t, 'osm/a');
    await skater.as.mutation(api.corpusRequests.create, {
      kind: 'restore',
      coord: INSIDE,
      waterBodyId: removed,
    });
    await skater.as.mutation(api.corpusRequests.create, {
      kind: 'contest_access',
      coord: INSIDE,
      waterBodyId: none,
    });
    await skater.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: INSIDE,
      waterBodyId: active,
    });
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'activate',
        coord: INSIDE,
        waterBodyId: removed,
      }),
    ).rejects.toThrow(/not something that can be asked/i);
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'takedown',
        coord: INSIDE,
        waterBodyId: removed,
      }),
    ).rejects.toThrow(/not something/i);
  });

  test('admit at a point we already hold is refused with the body and its standing', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant);
    await expect(
      skater.as.mutation(api.corpusRequests.create, { kind: 'admit', coord: INSIDE }),
    ).rejects.toMatchObject({
      data: { code: 'known_water', waterBodyId: id, standing: { standing: 'dormant' } },
    });
  });

  test('admit on open water schedules the resolver', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: FAR,
    });
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).toMatchObject({ kind: 'admit', status: 'open', coord: FAR });
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.map((s) => s.name)).toContain('corpusRequests:resolveAdmit');
  });

  test('a cap on open asks per person', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    for (let i = 0; i < 10; i++) {
      await skater.as.mutation(api.corpusRequests.create, {
        kind: 'admit',
        coord: { lat: 30 + i, lng: 30 },
      });
    }
    await expect(
      skater.as.mutation(api.corpusRequests.create, { kind: 'admit', coord: { lat: 45, lng: 30 } }),
    ).rejects.toThrow(/catch up/i);
  });

  test('the cap counts open asks only — a history of decided ones does not hide them', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    // Ten open, then forty decided — the newest rows are all decided, the open ten are older.
    const openIds = [];
    for (let i = 0; i < 10; i++) {
      openIds.push(
        await skater.as.mutation(api.corpusRequests.create, {
          kind: 'admit',
          coord: { lat: 30 + i, lng: 30 },
        }),
      );
    }
    await expect(
      skater.as.mutation(api.corpusRequests.create, { kind: 'admit', coord: { lat: 45, lng: 30 } }),
    ).rejects.toThrow(/catch up/i);
    // Decide one; the cap frees one slot, and only one.
    await mod.as.mutation(api.corpusRequests.decline, {
      requestId: openIds[0] as Id<'waterBodyRequests'>,
      note: 'Not water.',
    });
    await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 46, lng: 30 },
    });
    await expect(
      skater.as.mutation(api.corpusRequests.create, { kind: 'admit', coord: { lat: 47, lng: 30 } }),
    ).rejects.toThrow(/catch up/i);
  });

  test('signed out cannot ask; a note over the cap is refused', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    await expect(
      t.mutation(api.corpusRequests.create, { kind: 'admit', coord: FAR }),
    ).rejects.toThrow(/authenticated/i);
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'admit',
        coord: FAR,
        note: 'x'.repeat(300),
      }),
    ).rejects.toThrow(/280/);
  });
});

describe('the resolver record', () => {
  test('recordResolution attaches a candidate, or the reason there is none', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: FAR,
    });
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: Date.now(),
      resolveError: 'No catalog water at this point',
    });
    let row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row?.resolveError).toMatch(/No catalog water/);
    expect(row?.candidate).toBeUndefined();

    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: Date.now(),
      candidate: CANDIDATE,
    });
    row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row?.candidate?.name).toBe('Unseen Pond');
    expect(row?.resolveError).toBeUndefined();
  });
});

describe('decide — what approving performs', () => {
  test('approving an activate brings the body back, closes every sibling ask, and audits both', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant);
    const first = await a.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    await b.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    expect(await t.query(api.corpusRequests.openCountsForBody, { waterBodyId: id })).toEqual({
      activate: 2,
    });

    // convex-test can stamp a same-millisecond insert a hair past the clock; the decision closes
    // what existed when it was made, so let the clock pass the second ask (a rare flake otherwise).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mod.as.mutation(api.corpusRequests.approve, { requestId: first, note: 'Welcome back.' });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');
    const rows = await t.run((ctx) => ctx.db.query('waterBodyRequests').collect());
    expect(rows.every((r) => r.status === 'approved' && r.decisionNote === 'Welcome back.')).toBe(
      true,
    );
    const actions = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).map(
      (x) => x.action,
    );
    expect(actions.filter((x) => x === 'approve_request')).toHaveLength(2);
    expect(actions).toContain('activate_body');
    // The requester reads the outcome on the lake.
    const mine = await a.as.query(api.corpusRequests.listMineForBody, { waterBodyId: id });
    expect(mine[0]).toMatchObject({ status: 'approved', decisionNote: 'Welcome back.' });
  });

  test('a decline needs a note the skater can read', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant);
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    await expect(
      mod.as.mutation(api.corpusRequests.decline, { requestId, note: '   ' }),
    ).rejects.toThrow(/say why/i);
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('open');
  });

  test('two admits that resolved to the same feature are one decision, counted as two askers', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const mod = await seedUser(t, 'mod', 'moderator');
    const first = await a.as.mutation(api.corpusRequests.create, { kind: 'admit', coord: FAR });
    const second = await b.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 20.001, lng: 20.001 },
    });
    for (const requestId of [first, second]) {
      await t.mutation(internal.corpusRequests.recordResolution, {
        requestId,
        resolvedAt: Date.now(),
        candidate: CANDIDATE,
      });
    }
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue.map((r) => r.askers)).toEqual([2, 2]);
    await mod.as.mutation(api.corpusRequests.approve, { requestId: first });
    const rows = await t.run((ctx) => ctx.db.query('waterBodyRequests').collect());
    expect(rows.map((r) => r.status)).toEqual(['approved', 'approved']);
    expect(new Set(rows.map((r) => r.admittedWaterBodyId)).size).toBe(1);
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(1);
  });

  test('a decision closes every sibling past the page cap, of its own kind, as the group stood when it was made', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant);
    const first = await a.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    // More siblings than one page holds, plus open asks of another kind on the same lake, written
    // straight to the table — `create` would refuse the second ask from one person. Explicit
    // `createdAt`s keep the queue's order deterministic: activates first, contests after.
    const base = Date.now();
    const seedOpen = (kind: 'activate' | 'contest_access', n: number, from: number) =>
      t.run(async (ctx) => {
        for (let i = 0; i < n; i++) {
          await ctx.db.insert('waterBodyRequests', {
            kind,
            status: 'open',
            requesterId: a.id,
            coord: INSIDE,
            waterBodyId: id,
            createdAt: from + i,
          });
        }
      });
    await seedOpen('activate', QUEUE_CAP + 30, base + 1);
    await seedOpen('contest_access', 5, base + 1_000);

    // People, not rows (the fixture wrote every row under one requester): the public count says
    // how many skaters are asking, which one person filing many rows must not inflate.
    const counts = await t.query(api.corpusRequests.openCountsForBody, { waterBodyId: id });
    expect(counts).toEqual({ activate: 1, contest_access: 1 });
    // The queue is a backlog: the rank counts the page it holds and says so.
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue).toHaveLength(QUEUE_CAP);
    expect(queue[0]).toMatchObject({ _id: first, askers: QUEUE_CAP, askersCapped: true });

    // The approve closes the request and one page in its own transaction; the rest is a scheduled
    // continuation, so the mutation's write count is bounded whatever the group's size.
    vi.useFakeTimers();
    try {
      await mod.as.mutation(api.corpusRequests.approve, { requestId: first });
      const statuses = async (kind: string) =>
        (await t.run((ctx) => ctx.db.query('waterBodyRequests').collect()))
          .filter((r) => r.kind === kind)
          .map((r) => r.status);
      expect((await statuses('activate')).filter((s) => s === 'approved')).toHaveLength(
        QUEUE_CAP + 1,
      );
      expect((await statuses('activate')).filter((s) => s === 'open')).toHaveLength(30);
      const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
      expect(scheduled.map((s) => s.name)).toContain('corpusRequests:closeSiblings');

      // An ask filed while the pages drain is a new question: it inherits nothing.
      vi.advanceTimersByTime(1);
      const late = await t.run((ctx) =>
        ctx.db.insert('waterBodyRequests', {
          kind: 'activate',
          status: 'open',
          requesterId: a.id,
          coord: INSIDE,
          waterBodyId: id,
          createdAt: Date.now(),
        }),
      );

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await statuses('activate')).filter((s) => s === 'approved')).toHaveLength(
        QUEUE_CAP + 31,
      );
      expect((await t.run((ctx) => ctx.db.get(late)))?.status).toBe('open');
      expect(new Set(await statuses('contest_access'))).toEqual(new Set(['open']));
      const audits = await t.run((ctx) => ctx.db.query('moderationActions').collect());
      expect(audits.filter((x) => x.action === 'approve_request')).toHaveLength(QUEUE_CAP + 31);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  test('approving an admit re-checks the point: a body admitted under it since, without a 3DHP id, is used', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: FAR,
    });
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: Date.now(),
      candidate: CANDIDATE,
    });
    // An OSM import lands the same pond after the ask was filed — no 3DHP id on it.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/way/9',
          osmId: 'osm/way/9',
          name: 'Unseen Pond',
          type: 'lakePond',
          polygon: CANDIDATE.polygon as Polygon,
          bbox: CANDIDATE.bbox,
          centroid: FAR,
          surfaceAreaSqM: 4_900_000,
        },
      ],
    });
    const res = await mod.as.mutation(api.corpusRequests.approve, { requestId });
    const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(bodies).toHaveLength(1);
    expect(res.admittedWaterBodyId).toEqual(bodies[0]?._id);
    expect(bodies[0]?.includedByRequest).toBe(true);
  });

  test('declining leaves the body alone and keeps the record', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant);
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    await mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'Drained since 2024.' });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('dormant');
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).toMatchObject({ status: 'declined', decisionNote: 'Drained since 2024.' });
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      /been decided/i,
    );
  });

  test('restore and takedown need an admin, and perform D48’s verbs', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'admin', 'admin');
    const removed = await seedBody(t, 'osm/r', { removedAt: Date.now(), removalReason: 'junk' });
    const active = await seedBody(t, 'osm/a');
    const restoreReq = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'restore',
      coord: INSIDE,
      waterBodyId: removed,
    });
    const takedownReq = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: INSIDE,
      waterBodyId: active,
    });
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: restoreReq }),
    ).rejects.toThrow(/admin/i);
    await admin.as.mutation(api.corpusRequests.approve, { requestId: restoreReq });
    expect(standingOf((await get(t, removed)) as Doc<'waterBodies'>).standing).toBe('active');
    await admin.as.mutation(api.corpusRequests.approve, { requestId: takedownReq });
    expect(standingOf((await get(t, active)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'removed',
      reason: 'landowner_request',
    });
  });

  test('approving a contest sets the ruling to open, which activates the body', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/n', {
      publicAccess: { verdict: 'none', decidedAt: Date.now(), decidedByUserId: mod.id },
    });
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'contest_access',
      coord: INSIDE,
      waterBodyId: id,
      note: 'Town launch on the east shore.',
    });
    await mod.as.mutation(api.corpusRequests.approve, { requestId, note: 'Confirmed the launch.' });
    const body = (await get(t, id)) as Doc<'waterBodies'>;
    expect(body.publicAccess?.verdict).toBe('open');
    expect(standingOf(body).standing).toBe('active');
  });

  test('approving an admit inserts the catalog polygon as a body kept by request', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: FAR,
    });
    // Unresolved: refused, plainly.
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      /not answered yet/i,
    );
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: Date.now(),
      candidate: CANDIDATE,
    });
    const res = await mod.as.mutation(api.corpusRequests.approve, { requestId });
    const body = (await get(t, res.admittedWaterBodyId as Id<'waterBodies'>)) as Doc<'waterBodies'>;
    expect(body).toMatchObject({
      name: 'Unseen Pond',
      source: '3dhp',
      externalId: 'I6PYK',
      threeDhpId: 'I6PYK',
      includedByRequest: true,
      type: 'lakePond',
    });
    expect(standingOf(body).standing).toBe('active');
    expect(body.activatedAt).toBeDefined();
    // Reachable on the map at once.
    const res2 = await t.query(api.waterBodies.resolveBodyForCoord, { coord: FAR });
    expect(res2?.waterBodyId).toEqual(body._id);
    // A second approval of the same feature activates the same row, never a twin.
    const again = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 40, lng: 40 },
    });
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId: again,
      resolvedAt: Date.now(),
      candidate: CANDIDATE,
    });
    const second = await mod.as.mutation(api.corpusRequests.approve, { requestId: again });
    expect(second.admittedWaterBodyId).toEqual(body._id);
  });

  test('approving an activate refuses when the lake acquired a ruling since the ask', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant);
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      /no-public-access ruling/i,
    );
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('open');
  });

  test('an admit whose catalog feature is a removed body is refused, never re-activated', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: '3dhp',
          externalId: 'I6PYK',
          threeDhpId: 'I6PYK',
          name: 'Taken Down Pond',
          type: 'lakePond',
          polygon: CANDIDATE.polygon as Polygon,
          bbox: CANDIDATE.bbox,
          centroid: FAR,
          surfaceAreaSqM: 4_900_000,
        },
      ],
    });
    const twin = (await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0];
    if (!twin) throw new Error('seed failed');
    await t.run((ctx) =>
      ctx.db.patch(twin._id, { removedAt: Date.now(), removalReason: 'landowner_request' }),
    );
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 40, lng: 40 },
    });
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: Date.now(),
      candidate: CANDIDATE,
    });
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      /taken off the map/i,
    );
    expect(standingOf((await get(t, twin._id)) as Doc<'waterBodies'>).standing).toBe('removed');
  });

  test('an admit whose candidate is flowing water is refused rather than guessed', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: FAR,
    });
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: Date.now(),
      candidate: { ...CANDIDATE, cls: undefined, featureType: 1 },
    });
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId })).rejects.toThrow(
      /flowing water/i,
    );
  });

  test('the queue: oldest first, with the asker count and the body’s standing; members cannot read it', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant);
    await a.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    await b.as.mutation(api.corpusRequests.create, {
      kind: 'activate',
      coord: INSIDE,
      waterBodyId: id,
    });
    await a.as.mutation(api.corpusRequests.create, { kind: 'admit', coord: FAR });
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue).toHaveLength(3);
    expect(queue[0]).toMatchObject({ kind: 'activate', askers: 2, body: { _id: id } });
    expect(queue[0]?.body?.standing).toMatchObject({ standing: 'dormant' });
    expect(queue[2]).toMatchObject({ kind: 'admit', askers: 1 });
    expect(await mod.as.query(api.corpusRequests.queueCount, {})).toEqual({
      count: 3,
      capped: false,
    });
    await expect(a.as.query(api.corpusRequests.listQueue, {})).rejects.toThrow(/moderator/i);
  });
});

describe('a track over a removed body (D48 edge (a), closed)', () => {
  test('findMatchCandidates offers the removed body with its standing, and create refuses to mint over it', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', {
      removedAt: Date.now(),
      removalReason: 'landowner_request',
    });
    const T0 = Date.UTC(2026, 0, 15, 14);
    const activityId = await skater.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'session-1',
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, i) => [0.2 + i * 0.03, 0.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    // The track resolved to the removed body (it is reachable), so the prompt would not open — but
    // if it did, the match names the removed body, and a "none of these" cannot mint over it.
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.waterBodyId).toEqual(id);
    const candidates = await skater.as.query(api.waterBodies.findMatchCandidates, { activityId });
    expect(candidates.matches[0]).toMatchObject({
      waterBodyId: id,
      standing: { standing: 'removed', reason: 'landowner_request' },
    });
    // Because the track resolved, `create` refuses at the door — the skate already has its lake.
    // (The `removed_water` guard inside `create` is the second line, for a track that resolved to
    // nothing but dedups against a removed body.)
    await expect(
      skater.as.mutation(api.waterBodies.create, {
        name: 'My Pond',
        type: 'lakePond',
        activityId,
        confirmedNew: true,
      }),
    ).rejects.toThrow(/already resolved to a known lake/i);
  });
});

/**
 * `name_bay` (D201): the sub-area queue as a request kind. The name is the question, the body page
 * lists a lake's open asks by bay, approval needs the bay drawn, and the corpus seed files its rows
 * through the same table.
 */
describe('name_bay — the sub-area queue', () => {
  const NOTCH = { lat: 0.9, lng: 0.9 };

  async function seedBay(
    t: ReturnType<typeof convexTest>,
    waterBodyId: Id<'waterBodies'>,
    name: string,
    aliases: string[] = [],
  ) {
    const actor = await seedUser(t, `drawer-${name}`, 'moderator');
    return t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId,
        name,
        ...(aliases.length > 0 ? { aliases } : {}),
        searchText: [name, ...aliases].join(' '),
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0.8, 0.8],
              [1, 0.8],
              [1, 1],
              [0.8, 1],
              [0.8, 0.8],
            ],
          ],
        },
        bbox: { minLat: 0.8, minLng: 0.8, maxLat: 1, maxLng: 1 },
        centroid: NOTCH,
        surfaceAreaSqM: 40_000,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: actor.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test('an active lake admits it; the name is required, and only on this kind', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t);

    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
      }),
    ).rejects.toThrow(/Which bay/);
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'takedown',
        coord: NOTCH,
        waterBodyId: id,
        name: 'Corner Bay',
      }),
    ).rejects.toThrow(/Only a bay request/);
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name: 'x'.repeat(81),
      }),
    ).rejects.toThrow(/under 80/);

    const requestId = await skater.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: '  Corner Bay ',
      note: 'We skate it as its own trip.',
    });
    expect(await t.run((ctx) => ctx.db.get(requestId))).toMatchObject({
      kind: 'name_bay',
      status: 'open',
      name: 'Corner Bay',
      waterBodyId: id,
    });
  });

  test('one open ask per person per bay — a second bay on the same lake is a second ask', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t);
    await skater.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'St. Albans Bay',
    });
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name: 'Saint Albans bay',
      }),
    ).rejects.toThrow(/already asked/);
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name: 'Maquam Bay',
      }),
    ).resolves.toBeTruthy();
    expect(await t.run((ctx) => ctx.db.query('waterBodyRequests').collect())).toHaveLength(2);
  });

  test('the queue ranks by bay, not by lake: two people asking for one bay are one question', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const two = await seedUser(t, 'two');
    const id = await seedBody(t);
    const ask = (who: typeof one, name: string) =>
      who.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name,
      });
    await ask(one, 'St. Albans Bay');
    await ask(two, 'Saint Albans Bay');
    await ask(two, 'Maquam Bay');

    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    const byName = Object.fromEntries(queue.map((r) => [r.name, r.askers]));
    expect(byName).toEqual({ 'St. Albans Bay': 2, 'Saint Albans Bay': 2, 'Maquam Bay': 1 });
    expect(queue.every((r) => r.drawnSubAreaId === undefined)).toBe(true);
  });

  test('the lake editor’s queue groups a lake’s asks by bay, pools the aliases and notes, and names a drawn bay', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const two = await seedUser(t, 'two');
    const id = await seedBody(t);
    const other = await seedBody(t, 'osm/2');
    const first = await one.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'St. Albans Bay',
      note: 'North of the point.',
    });
    await two.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: { lat: 0.85, lng: 0.85 },
      waterBodyId: id,
      name: 'Saint Albans Bay',
      note: 'We skate it as its own trip.',
    });
    await two.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'Maquam Bay',
    });
    await two.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: other,
      name: 'Elsewhere Bay',
    });
    // Seed rows carry aliases; a skater's do not. The group pools whatever it has.
    await t.run((ctx) => ctx.db.patch(first, { aliases: ['Saint Albans Bay', 'St Albans'] }));
    await seedBay(t, id, 'Maquam Bay', ['Maquam']);

    await expect(
      one.as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: id }),
    ).rejects.toThrow();
    const rows = await mod.as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: id });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      requestId: first,
      name: 'St. Albans Bay',
      aliases: ['Saint Albans Bay', 'St Albans'],
      coord: NOTCH,
      notes: ['North of the point.', 'We skate it as its own trip.'],
      askers: 2,
    });
    expect(rows[0]?.drawnSubAreaId).toBeUndefined();
    expect(rows[1]).toMatchObject({ name: 'Maquam Bay', askers: 1 });
    expect(rows[1]?.drawnSubAreaId).toBeDefined();
  });

  test('approving from the queue needs the bay drawn by that name (or an alias), then closes the siblings', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const two = await seedUser(t, 'two');
    const id = await seedBody(t);
    const first = await one.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'Corner Bay',
    });
    const second = await two.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'corner bay',
    });

    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId: first })).rejects.toThrow(
      /draw it in the lake editor first/,
    );

    await seedBay(t, id, 'The Corner', ['Corner Bay']);
    const listed = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(listed.find((r) => r._id === first)?.drawnSubAreaId).toBeDefined();
    await mod.as.mutation(api.corpusRequests.approve, { requestId: first });
    const rows = await t.run((ctx) => Promise.all([first, second].map((r) => ctx.db.get(r))));
    expect(rows.map((r) => r?.status)).toEqual(['approved', 'approved']);
    expect(describeRequestOutcome(rows[0] as Doc<'waterBodyRequests'>)).toMatch(/drew this bay/);
  });

  test('bay asks have a budget of their own: capped at ten, and never spending the lake-ask budget', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t);
    for (let i = 0; i < 10; i++) {
      await skater.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name: `Bay ${i}`,
      });
    }
    // The eleventh distinct name is refused — a name loop cannot fill the queue (Greptile, #76).
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name: 'Bay 10',
      }),
    ).rejects.toThrow(/waiting on a moderator/);
    // …and a lake ask still goes through: ten open bay asks spend nothing of that budget.
    const other = await seedBody(t, 'osm/2', dormant);
    await expect(
      skater.as.mutation(api.corpusRequests.create, {
        kind: 'activate',
        coord: INSIDE,
        waterBodyId: other,
      }),
    ).resolves.toBeTruthy();
  });

  test('approving closes the asks for every name the answering bay carries, not just the one asked', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const two = await seedUser(t, 'two');
    const id = await seedBody(t);
    const ask = (who: typeof one, name: string) =>
      who.as.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: NOTCH,
        waterBodyId: id,
        name,
      });
    const first = await ask(one, 'Northwest Bay');
    const variant = await ask(two, 'NW Bay'); // no fold joins these; the bay's alias does
    const other = await ask(two, 'Button Bay');
    await seedBay(t, id, 'Northwest Bay', ['NW Bay']);
    // A decision closes the asks that existed when it was made; convex-test stamps inserts in one
    // millisecond a hair past the clock, so let the clock pass them (the subAreas suite's reason).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mod.as.mutation(api.corpusRequests.approve, { requestId: first });
    const rows = await t.run((ctx) =>
      Promise.all([first, variant, other].map((r) => ctx.db.get(r))),
    );
    expect(rows.map((r) => r?.status)).toEqual(['approved', 'approved', 'open']);
  });

  test('a bay drawn under one of the ask’s other spellings still answers it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const founder = await seedUser(t, 'founder', 'admin');
    const id = await seedBody(t, 'osm/1', { states: ['VT'] });
    await seedBay(t, id, 'NW Bay');
    // The seed's row goes by "Northwest Bay" with "NW Bay" as an alias.
    const report = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: founder.id,
      rows: [
        {
          name: 'Northwest Bay',
          aliases: ['NW Bay'],
          state: 'VT',
          parentName: 'Quiet Pond',
          coord: NOTCH,
          note: '',
        },
      ],
    });
    expect(report[0]?.status).toBe('already_drawn');
    // A skater's ask by the full name, with the seed's spelling on an earlier row, still matches.
    const requestId = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        requesterId: founder.id,
        coord: NOTCH,
        waterBodyId: id,
        name: 'Northwest Bay',
        nameKey: 'northwest bay',
        aliases: ['NW Bay'],
        createdAt: Date.now(),
      }),
    );
    const rows = await mod.as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: id });
    expect(rows[0]?.drawnSubAreaId).toBeDefined();
    await mod.as.mutation(api.corpusRequests.approve, { requestId });
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('approved');
  });

  test('the editor’s queue flies only to a real point — a drawer ask carries the lake’s own', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const id = await seedBody(t);
    // The drawer sends the lake's centroid — INSIDE, for this fixture.
    await one.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: INSIDE,
      waterBodyId: id,
      name: 'Corner Bay',
    });
    let rows = await mod.as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: id });
    expect(rows[0]?.coord).toBeUndefined();
    // A later ask for the same bay with a real point supplies one.
    const two = await seedUser(t, 'two');
    await two.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'corner bay',
    });
    rows = await mod.as.query(api.corpusRequests.openBayRequestsForBody, { waterBodyId: id });
    expect(rows[0]?.coord).toEqual(NOTCH);
    expect(rows[0]?.askers).toBe(2);
  });

  test('approving from the queue records which sub-area answered the ask', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const one = await seedUser(t, 'one');
    const id = await seedBody(t);
    const requestId = await one.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: NOTCH,
      waterBodyId: id,
      name: 'Corner Bay',
    });
    const bay = await seedBay(t, id, 'Corner Bay');
    await mod.as.mutation(api.corpusRequests.approve, { requestId });
    const audit = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterBodyRequest').eq('targetId', requestId as string),
        )
        .first(),
    );
    expect(audit?.metadata).toMatchObject({ kind: 'name_bay', subAreaId: bay });
  });

  test('the corpus seed files bays as asks — dry by default, idempotent, and it names every skip', async () => {
    const t = harness();
    const founder = await seedUser(t, 'founder', 'admin');
    const id = await seedBody(t, 'osm/1', { states: ['VT'] });
    await seedBody(t, 'osm/2', { states: ['NH'] }); // a same-named lake in another state
    await seedBay(t, id, 'Maquam Bay');
    const rows = [
      {
        name: 'Corner Bay',
        aliases: ['SW Corner'],
        state: 'VT',
        // Word order aside: the corpus says "Pond Quiet" where the catalog says "Quiet Pond".
        parentName: 'Pond Quiet',
        coord: NOTCH,
        note: 'Corpus: 26 messages, 12 skated.',
      },
      {
        name: 'Maquam Bay',
        state: 'VT',
        parentName: 'Quiet Pond',
        coord: NOTCH,
        note: 'Corpus: 11 messages, 5 skated.',
      },
      { name: 'Lost Bay', state: 'VT', parentName: 'No Such Lake', coord: NOTCH, note: '' },
      { name: 'Nowhere Bay', state: 'ME', parentName: 'Quiet Pond', coord: NOTCH, note: '' },
    ];

    const dry = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: founder.id,
      rows,
    });
    expect(dry.map((r) => r.status)).toEqual([
      'would_file',
      'already_drawn',
      'no_parent',
      'no_parent',
    ]);
    // A parent the corpus holds but has shelved is its own status: activate it, not rename it.
    const shelved = await seedBody(t, 'osm/3', { ...dormant, states: ['ME'] });
    expect(shelved).toBeTruthy();
    const dormantParent = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: founder.id,
      rows: [
        { name: 'Shelved Bay', state: 'ME', parentName: 'Quiet Pond', coord: NOTCH, note: '' },
      ],
    });
    expect(dormantParent[0]).toMatchObject({ parent: 'Quiet Pond', status: 'parent_not_active' });
    expect(await t.run((ctx) => ctx.db.query('waterBodyRequests').collect())).toHaveLength(0);

    const applied = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: founder.id,
      rows,
      apply: true,
    });
    expect(applied[0]).toEqual({ name: 'Corner Bay', parent: 'Quiet Pond', status: 'filed' });
    const filed = await t.run((ctx) => ctx.db.query('waterBodyRequests').collect());
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      kind: 'name_bay',
      status: 'open',
      name: 'Corner Bay',
      aliases: ['SW Corner'],
      waterBodyId: id,
      requesterId: founder.id,
      note: 'Corpus: 26 messages, 12 skated.',
    });

    const again = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: founder.id,
      rows,
      apply: true,
    });
    expect(again[0]?.status).toBe('already_asked');
    expect(await t.run((ctx) => ctx.db.query('waterBodyRequests').collect())).toHaveLength(1);

    // Two active lakes by one name in one state: refuse to guess.
    await t.run(async (ctx) => {
      const twin = (await ctx.db.query('waterBodies').collect()).find(
        (b) => b.externalId === 'osm/2',
      );
      if (twin) await ctx.db.patch(twin._id, { states: ['VT'] });
    });
    const ambiguous = await t.mutation(internal.corpusRequests.seedBayRequests, {
      requesterId: founder.id,
      rows: [{ name: 'Twin Bay', state: 'VT', parentName: 'Quiet Pond', coord: NOTCH, note: '' }],
    });
    expect(ambiguous[0]?.status).toBe('ambiguous_parent');
  });
});
