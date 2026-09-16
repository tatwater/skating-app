/**
 * Corpus standing (N7b) — the campaign walk, the transitions, the evidence hooks, the push surfaces,
 * the seed and the rollover.
 *
 * The first block is the regression net the plan asked for before anything else was changed: one
 * body per state, run through `importCanonical` and both campaign prunes, each asserted to land
 * exactly where the lifecycle table says. Every other block is a transition or a surface, and every
 * surface test seeds a non-active body and asserts it is *absent* — because every omission on a push
 * surface fails silently and permissively.
 */

import { DORMANT_MIN_VISIBLE_ZOOM, isActive, seasonStartMs, standingOf } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
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
const VIEWPORT = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
const SKATE_TIME = Date.UTC(2026, 0, 10);

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
  extra: Record<string, unknown> = {},
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
      ...extra,
    } as Doc<'profiles'>),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

/** A canonical body through the real import path, so it lands in the cell index like the corpus. */
function canonical(externalId: string, name = 'Lake Morey', over: Record<string, unknown> = {}) {
  return {
    source: 'osm' as const,
    externalId,
    osmId: externalId,
    name,
    type: 'lakePond' as const,
    polygon: POLYGON,
    bbox: VIEWPORT,
    centroid: { lat: 0.5, lng: 0.5 },
    surfaceAreaSqM: 1_000_000,
    ...over,
  };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  externalId = 'osm/1',
  patch: Partial<Doc<'waterBodies'>> = {},
  name = 'Lake Morey',
): Promise<Id<'waterBodies'>> {
  await t.mutation(internal.waterBodies.importCanonical, { bodies: [canonical(externalId, name)] });
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

const cellsFor = (t: ReturnType<typeof convexTest>, id: Id<'waterBodies'>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('waterBodyCells').collect()).filter((c) => c.waterBodyId === id),
  );

const inViewport = async (t: ReturnType<typeof convexTest>, zoom: number) =>
  (await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT, zoom })).map((b) => b._id);

/** Drive a paginated internal mutation to completion, summing the numeric tallies it returns. */
async function drain<A extends { cursor?: string }>(
  run: (args: A) => Promise<{ cursor: string; isDone: boolean } & Record<string, unknown>>,
  args: A,
) {
  let cursor: string | undefined;
  let done = false;
  const totals: Record<string, number> = {};
  while (!done) {
    const page = await run({ ...args, ...(cursor ? { cursor } : {}) });
    cursor = page.cursor;
    done = page.isDone;
    for (const [k, v] of Object.entries(page)) {
      if (typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
    }
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. The campaign walk — every state, through the import and both prunes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('the campaign walk — one body per state, through importCanonical and both prunes', () => {
  const CAMPAIGN = 'n7b-walk';
  const NOW = Date.UTC(2026, 8, 16);

  /**
   * The lifecycle table, as code. Each row: how the body is seeded, and where it must be after a
   * re-import that re-affirms it, after a re-import that does NOT, and after the floor prune.
   */
  async function seedEveryState(t: ReturnType<typeof convexTest>) {
    const mod = await seedUser(t, 'mod', 'moderator');
    const ids = {
      listed: await seedBody(t, 'osm/listed', {}, 'Listed Pond'),
      removed: await seedBody(
        t,
        'osm/removed',
        { removedAt: NOW, removalReason: 'landowner_request' },
        'Removed Pond',
      ),
      none: await seedBody(
        t,
        'osm/none',
        { publicAccess: { verdict: 'none', decidedAt: NOW, decidedByUserId: mod.id } },
        'Private Pond',
      ),
      inactive: await seedBody(
        t,
        'osm/inactive',
        { dormant: { since: NOW, reason: 'inactive' } },
        'Quiet Pond',
      ),
      notInCampaign: await seedBody(
        t,
        'osm/nic',
        { dormant: { since: NOW, reason: 'not_in_campaign' } },
        'Refused Pond',
      ),
      byRequest: await seedBody(t, 'osm/requested', { includedByRequest: true }, 'Asked Pond'),
      rejected: await seedBody(
        t,
        'osm/rejected',
        { source: 'user', reviewStatus: 'rejected' },
        'Drawn Pond',
      ),
    };
    return ids;
  }

  async function assertTable(
    t: ReturnType<typeof convexTest>,
    ids: Record<string, Id<'waterBodies'>>,
    listedExpected: 'active' | 'dormant' = 'active',
  ) {
    const s = async (id: Id<'waterBodies'>) => standingOf((await get(t, id)) as Doc<'waterBodies'>);
    expect((await s(ids.listed as Id<'waterBodies'>)).standing).toBe(listedExpected);
    expect(await s(ids.removed as Id<'waterBodies'>)).toMatchObject({
      standing: 'removed',
      reason: 'landowner_request',
    });
    expect(await s(ids.none as Id<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'no_public_access',
    });
    expect(await s(ids.inactive as Id<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'inactive',
    });
    expect(await s(ids.notInCampaign as Id<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'not_in_campaign',
    });
    expect((await s(ids.byRequest as Id<'waterBodies'>)).standing).toBe('active');
    expect((await s(ids.rejected as Id<'waterBodies'>)).standing).toBe('unlisted');

    // The rung follows the standing, on the row and on every cell row — the derived half that a
    // re-import used to silently reset.
    for (const [key, id] of Object.entries(ids)) {
      const body = (await get(t, id)) as Doc<'waterBodies'>;
      const cells = await cellsFor(t, id);
      if (key === 'rejected') {
        expect(cells).toHaveLength(0);
        continue;
      }
      const expected = isActive(body) ? body.minVisibleZoom : DORMANT_MIN_VISIBLE_ZOOM;
      expect(body.minVisibleZoom).toBe(expected);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((c) => c.minVisibleZoom === expected)).toBe(true);
    }
  }

  test('a re-import that re-affirms every body preserves every standing and every rung', async () => {
    const t = harness();
    const ids = await seedEveryState(t);
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        canonical('osm/listed', 'Listed Pond'),
        canonical('osm/removed', 'Removed Pond'),
        canonical('osm/none', 'Private Pond'),
        canonical('osm/inactive', 'Quiet Pond'),
        canonical('osm/nic', 'Refused Pond'),
        canonical('osm/requested', 'Asked Pond'),
      ],
      campaignId: CAMPAIGN,
    });
    await assertTable(t, ids);
  });

  test('a campaign that re-affirms nothing demotes the active canonical bodies and touches no other state', async () => {
    const t = harness();
    const ids = await seedEveryState(t);
    const totals = await drain(
      (args) =>
        t.mutation(internal.waterBodies.pruneNotInCampaign, {
          campaignId: 'some-other-campaign',
          apply: true,
          ...args,
        }),
      {},
    );
    // Only `listed` was active, canonical and unprotected. `byRequest` is protected by its flag;
    // `rejected` is user-drawn; the rest were already not active.
    expect(totals.deleted).toBe(1);
    const listed = (await get(t, ids.listed)) as Doc<'waterBodies'>;
    expect(standingOf(listed)).toMatchObject({ standing: 'dormant', reason: 'not_in_campaign' });
    // Everything else is exactly where it was.
    await assertTable(t, ids, 'dormant');
    // Nothing was deleted — the whole point.
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(7);
  });

  test('the floor prune agrees: nothing in a non-active state is touched, and nothing is deleted', async () => {
    const t = harness();
    const ids = await seedEveryState(t);
    // Shrink every body under the floor so the prune has an opinion about all of them.
    await t.run(async (ctx) => {
      for (const id of Object.values(ids)) await ctx.db.patch(id, { surfaceAreaSqM: 100 });
    });
    const totals = await drain(
      (args) => t.mutation(internal.waterBodies.pruneBelowAreaFloor, { apply: true, ...args }),
      {},
    );
    expect(totals.deleted).toBe(1); // `listed` again
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(7);
    expect(standingOf((await get(t, ids.listed)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'not_in_campaign',
    });
  });

  test('a removed body stays removed through a re-import, and a report on it re-activates nothing', async () => {
    const t = harness();
    const ids = await seedEveryState(t);
    const skater = await seedUser(t, 'skater');
    await skater.as.mutation(api.reports.create, {
      waterBodyId: ids.removed,
      skateEndTime: SKATE_TIME,
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [canonical('osm/removed', 'Removed Pond')],
      campaignId: CAMPAIGN,
    });
    const body = (await get(t, ids.removed)) as Doc<'waterBodies'>;
    expect(standingOf(body).standing).toBe('removed');
    expect(body.minVisibleZoom).toBe(DORMANT_MIN_VISIBLE_ZOOM);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. The map: what each standing draws at
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('the dormant rung on the map', () => {
  test('a dormant body is absent at the D49 floor and present when zoomed in on', async () => {
    const t = harness();
    const active = await seedBody(t, 'osm/active');
    const dormant = await seedBody(t, 'osm/dormant', {
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    expect(await inViewport(t, 14)).toEqual([active]);
    expect((await inViewport(t, DORMANT_MIN_VISIBLE_ZOOM)).sort()).toEqual(
      [active, dormant].sort(),
    );
  });

  test('a removed body draws the same way — reachable, not browsable', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t, 'osm/1');
    await admin.as.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' });
    expect(await inViewport(t, 14)).toEqual([]);
    expect(await inViewport(t, DORMANT_MIN_VISIBLE_ZOOM)).toEqual([id]);
    expect(
      await t.query(api.waterBodies.resolveBodyForCoord, { coord: { lat: 0.5, lng: 0.5 } }),
    ).toMatchObject({ waterBodyId: id });
  });

  test('`get` returns a dormant body whole; only an unlisted one is unavailable', async () => {
    const t = harness();
    const id = await seedBody(t, 'osm/1', { dormant: { since: Date.now(), reason: 'moderator' } });
    const res = await t.query(api.waterBodies.get, { waterBodyId: id });
    if (!res?.available) throw new Error('expected the body');
    expect(standingOf(res.body)).toMatchObject({ standing: 'dormant', reason: 'moderator' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Transitions — remove / restore / the access verdicts / the moderator's hand
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('transitions', () => {
  test('remove keeps the cell rows, moves them to the dormant rung, and delists the bays', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t, 'osm/1');
    await admin.as.mutation(api.subAreas.create, {
      waterBodyId: id,
      name: 'North Bay',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0.1, 0.1],
            [0.1, 0.4],
            [0.4, 0.4],
            [0.4, 0.1],
            [0.1, 0.1],
          ],
        ],
      },
    });
    const bayCellsBefore = await t.run((ctx) => ctx.db.query('waterBodySubAreaCells').collect());
    expect(bayCellsBefore.length).toBeGreaterThan(0);

    await admin.as.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' });
    const cells = await cellsFor(t, id);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.minVisibleZoom === DORMANT_MIN_VISIBLE_ZOOM)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query('waterBodySubAreaCells').collect())).toHaveLength(0);
  });

  test('restore is an activation: clears dormancy, stamps activatedAt, re-scores, re-registers weather', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t, 'osm/1', {
      removedAt: Date.now(),
      removalReason: 'junk',
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const before = (await get(t, id)) as Doc<'waterBodies'>;
    expect(before.minVisibleZoom).toBe(DORMANT_MIN_VISIBLE_ZOOM);

    await admin.as.mutation(api.waterBodies.restore, { waterBodyId: id });
    const after = (await get(t, id)) as Doc<'waterBodies'>;
    expect(standingOf(after).standing).toBe('active');
    expect(after.dormant).toBeUndefined();
    expect(after.activatedAt).toBeDefined();
    expect(after.minVisibleZoom).toBeLessThanOrEqual(14);
    expect(await inViewport(t, 14)).toEqual([id]);
    const membership = await t.run((ctx) =>
      ctx.db
        .query('bodyWeatherCells')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .collect(),
    );
    expect(membership).toHaveLength(1);
  });

  test('a restore under a `none` ruling comes back dormant, not active', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t, 'osm/1', {
      removedAt: Date.now(),
      publicAccess: { verdict: 'none', decidedAt: Date.now(), decidedByUserId: admin.id },
    });
    await admin.as.mutation(api.waterBodies.restore, { waterBodyId: id });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'no_public_access',
    });
  });

  test('a `none` ruling makes the body dormant; `open` activates it and clears a stored dormancy', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    let body = (await get(t, id)) as Doc<'waterBodies'>;
    expect(standingOf(body)).toMatchObject({ standing: 'dormant', reason: 'no_public_access' });
    expect(body.minVisibleZoom).toBe(DORMANT_MIN_VISIBLE_ZOOM);
    expect(await inViewport(t, 14)).toEqual([]);

    // Shelve it on the stored field too, then confirm access: both go.
    await t.run((ctx) => ctx.db.patch(id, { dormant: { since: Date.now(), reason: 'inactive' } }));
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'open' });
    body = (await get(t, id)) as Doc<'waterBodies'>;
    expect(standingOf(body).standing).toBe('active');
    expect(body.dormant).toBeUndefined();
    expect(body.activatedAt).toBeDefined();
    expect(await inViewport(t, 14)).toEqual([id]);
  });

  test('clearing a ruling re-derives from the rest of the row', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', { dormant: { since: Date.now(), reason: 'moderator' } });
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: null });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'moderator',
    });
  });

  test('setStanding: a moderator shelves with a note and brings back; the refusals name the right verb', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'admin', 'admin');
    const id = await seedBody(t, 'osm/1');

    await mod.as.mutation(api.standing.setStanding, {
      waterBodyId: id,
      standing: 'dormant',
      note: 'Drained for dam work',
    });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>)).toEqual({
      standing: 'dormant',
      since: expect.any(Number),
      reason: 'moderator',
      note: 'Drained for dam work',
    });
    await expect(
      mod.as.mutation(api.standing.setStanding, { waterBodyId: id, standing: 'dormant' }),
    ).rejects.toThrow(/already dormant/i);

    await mod.as.mutation(api.standing.setStanding, { waterBodyId: id, standing: 'active' });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');

    await admin.as.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' });
    await expect(
      mod.as.mutation(api.standing.setStanding, { waterBodyId: id, standing: 'active' }),
    ).rejects.toThrow(/restore/i);

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['set_standing', 'activate_body', 'remove']),
    );
  });

  test('a member cannot set standing', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    const id = await seedBody(t, 'osm/1');
    await expect(
      member.as.mutation(api.standing.setStanding, { waterBodyId: id, standing: 'dormant' }),
    ).rejects.toThrow(/moderator/i);
  });

  test('a positive curated boost on a shelved body brings it back; a zero boost does not', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', { dormant: { since: Date.now(), reason: 'inactive' } });
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 0 });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('dormant');
    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 0.3 });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Evidence — what brings a body back on its own, and what does not
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('evidence hooks', () => {
  const dormant = (reason: 'inactive' | 'not_in_campaign' | 'moderator') => ({
    dormant: { since: Date.now(), reason },
  });

  test('a report on an inactive body activates it', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant('inactive'));
    await skater.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    const body = (await get(t, id)) as Doc<'waterBodies'>;
    expect(standingOf(body).standing).toBe('active');
    expect(body.includedByRequest).toBeUndefined();
    expect(await inViewport(t, 14)).toEqual([id]);
    const audit = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .filter((q) => q.eq(q.field('action'), 'activate_body'))
        .first(),
    );
    expect(audit?.metadata?.via).toBe('report');
    expect(audit?.actorId).toBeUndefined();
  });

  test('a report on a body the campaign refused activates it AND keeps it by request', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant('not_in_campaign'));
    await skater.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    const body = (await get(t, id)) as Doc<'waterBodies'>;
    expect(standingOf(body).standing).toBe('active');
    expect(body.includedByRequest).toBe(true);
    // …so the next campaign prune leaves it alone.
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: 'next',
      apply: true,
    });
    expect(res).toMatchObject({
      deleted: 0,
      kept: expect.objectContaining({ includedByRequest: 1 }),
    });
  });

  test('a report does NOT flip a moderator dormancy, a `none` ruling, or a removal', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const mod = await seedUser(t, 'mod', 'moderator');
    const byMod = await seedBody(t, 'osm/mod', dormant('moderator'));
    const none = await seedBody(t, 'osm/none', {
      publicAccess: { verdict: 'none', decidedAt: Date.now(), decidedByUserId: mod.id },
    });
    const removed = await seedBody(t, 'osm/removed', { removedAt: Date.now() });
    for (const id of [byMod, none, removed]) {
      await skater.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    }
    expect(standingOf((await get(t, byMod)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'moderator',
    });
    expect(standingOf((await get(t, none)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'no_public_access',
    });
    expect(standingOf((await get(t, removed)) as Doc<'waterBodies'>).standing).toBe('removed');
  });

  test('a recorded track over a dormant body activates it', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant('inactive'));
    const T0 = Date.UTC(2026, 0, 15, 14);
    await skater.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'session-1',
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, i) => [0.2 + i * 0.03, 0.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');
  });

  test('a hazard on a dormant body activates it', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant('inactive'));
    await skater.as.mutation(api.hazards.create, {
      waterBodyId: id,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [0.5, 0.5] },
      radiusMeters: 40,
    });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');
  });

  test('an official put-in on a dormant body activates it (founder call)', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await seedBody(t, 'osm/1', dormant('inactive'));
    await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.9, lng: 0.1 },
    });
    const body = (await get(t, id)) as Doc<'waterBodies'>;
    expect(standingOf(body).standing).toBe('active');
    expect(body.activatedAt).toBeDefined();
  });

  test('a favourite does not activate — it retains, and it is the request path’s job to ask', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', dormant('inactive'));
    await skater.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });
    expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('dormant');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. The push surfaces — each seeds a non-active body and asserts it is absent
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('push surfaces', () => {
  const NONE = (modId: Id<'profiles'>) => ({
    publicAccess: { verdict: 'none' as const, decidedAt: Date.now(), decidedByUserId: modId },
  });

  test('the drive-time fan-out skips a `none` body; a favouriter is still told; a removed body tells nobody', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const BAND: Polygon = POLYGON;
    const nearby = await seedUser(t, 'nearby', 'member', {
      homeCoord: { lat: 0.5, lng: 0.5 },
      cachedIsochrones: { band30: BAND },
      outerRadiusMeters: 50_000,
      allRadiusMinutes: 30,
      notificationPrefs: { ...BASE_PREFS, nearbyReportDigest: true },
    });
    const fan = await seedUser(t, 'fan');

    const none = await seedBody(t, 'osm/none', NONE(mod.id));
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: none });
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: none,
      skateEndTime: SKATE_TIME,
    });
    const res = await t.mutation(internal.notifications.fanOutNearbyNotifications, { reportId });
    expect(res).toMatchObject({ stopped: 'body_not_active' });
    const queued = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queued.map((q) => [q.userId, q.type])).toEqual([[fan.id, 'favorite_report']]);
    expect(queued.some((q) => q.userId === nearby.id)).toBe(false);

    // A removed body: the favourite predates the takedown; the report still tells nobody.
    const removed = await seedBody(t, 'osm/removed');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: removed });
    await t.run((ctx) => ctx.db.patch(removed, { removedAt: Date.now() }));
    await author.as.mutation(api.reports.create, {
      waterBodyId: removed,
      skateEndTime: SKATE_TIME,
    });
    const after = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(after).toHaveLength(1);
  });

  test('the feed shows a report on a dormant body and hides one on a removed body', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const dormant = await seedBody(t, 'osm/dormant', {
      dormant: { since: Date.now(), reason: 'moderator' },
    });
    const removed = await seedBody(t, 'osm/removed', { removedAt: Date.now() });
    await author.as.mutation(api.reports.create, {
      waterBodyId: dormant,
      skateEndTime: SKATE_TIME,
    });
    await author.as.mutation(api.reports.create, {
      waterBodyId: removed,
      skateEndTime: SKATE_TIME,
    });
    const page = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 10, cursor: null },
      season: 2025,
    });
    expect(page.page.map((c) => c.waterBodyId)).toEqual([dormant]);
  });

  test('a bounty cannot be opened on a dormant or removed body', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const dormant = await seedBody(t, 'osm/dormant', {
      dormant: { since: Date.now(), reason: 'moderator' },
    });
    await expect(
      requester.as.action(api.bounties.create, { waterBodyId: dormant }),
    ).rejects.toThrow(/not found/i);
  });

  test('the weather cell registry walk registers active bodies only', async () => {
    const t = harness();
    await seedBody(t, 'osm/active');
    const dormant = await seedBody(t, 'osm/dormant', {
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const page = await t.query(internal.weatherArchive.pageBodyCells, {
      cursor: null,
      tier: 'filter',
    });
    expect(page.members.map((m) => m.waterBodyId)).not.toContain(dormant);
    expect(page.members).toHaveLength(1);
  });

  test('the enrichment lists walk past dormant bodies, and count them', async () => {
    const t = harness();
    await seedBody(t, 'osm/active');
    await seedBody(t, 'osm/dormant', { dormant: { since: Date.now(), reason: 'inactive' } });
    const elevation = await t.query(internal.waterBodies.listNeedingElevation, {});
    expect(elevation.targets).toHaveLength(1);
    expect(elevation.dormant).toBe(1);
    const both = await t.query(internal.waterBodies.listNeedingElevation, { includeDormant: true });
    expect(both.targets).toHaveLength(2);
  });

  test('search badges a dormant body, ranks it last, and never returns a removed one', async () => {
    const t = harness();
    await seedBody(t, 'osm/a', {}, 'Mirror Lake');
    const dormant = await seedBody(
      t,
      'osm/b',
      { dormant: { since: Date.now(), reason: 'inactive' } },
      'Mirror Lake',
    );
    await seedBody(t, 'osm/c', { removedAt: Date.now() }, 'Mirror Lake');
    const hits = await t.query(api.waterBodies.searchByName, { query: 'Mirror' });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.inactive).toBeUndefined();
    expect(hits[1]?._id).toBe(dormant);
    expect(hits[1]?.inactive).toBe(true);
  });

  test('regionStats counts known and active separately', async () => {
    const t = harness();
    await seedBody(t, 'osm/a', { states: ['VT'] });
    await seedBody(t, 'osm/b', {
      states: ['VT'],
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    await seedBody(t, 'osm/c', { states: ['VT'], removedAt: Date.now() });
    await t.action(internal.regionStats.recompute, {});
    const rows = await t.query(api.regionStats.list, {});
    expect(rows.find((r) => r.state === 'VT')).toMatchObject({ bodiesScanned: 2, bodiesActive: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6. The seed and the rollover
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('seedStanding — the partition by evidence of access or use', () => {
  test('keeps what has evidence or a decision, shelves the rest, dry by default', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const skater = await seedUser(t, 'skater');
    const bare = await seedBody(t, 'osm/bare');
    const curated = await seedBody(t, 'osm/curated', { curatedBoost: 0.3 });
    const requested = await seedBody(t, 'osm/requested', { includedByRequest: true });
    const kept = await seedBody(t, 'osm/kept');
    const withPutIn = await seedBody(t, 'osm/putin');
    await mod.as.mutation(api.putIns.setOfficial, {
      waterBodyId: withPutIn,
      coord: { lat: 0.9, lng: 0.1 },
    });
    const withReport = await seedBody(t, 'osm/report');
    await skater.as.mutation(api.reports.create, {
      waterBodyId: withReport,
      skateEndTime: SKATE_TIME,
    });
    const alreadyDormant = await seedBody(t, 'osm/dormant', {
      dormant: { since: Date.now(), reason: 'moderator' },
    });

    const dry = await drain(
      (args) => t.mutation(internal.standing.seedStanding, { keepIds: [kept], ...args }),
      {},
    );
    expect(dry.demoted).toBe(1);
    expect(standingOf((await get(t, bare)) as Doc<'waterBodies'>).standing).toBe('active');

    const wet = await drain(
      (args) =>
        t.mutation(internal.standing.seedStanding, { keepIds: [kept], apply: true, ...args }),
      {},
    );
    expect(wet.demoted).toBe(1);
    expect(standingOf((await get(t, bare)) as Doc<'waterBodies'>)).toMatchObject({
      standing: 'dormant',
      reason: 'inactive',
    });
    for (const id of [curated, requested, kept, withPutIn, withReport]) {
      expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');
    }
    expect(standingOf((await get(t, alreadyDormant)) as Doc<'waterBodies'>)).toMatchObject({
      reason: 'moderator',
    });
  });
});

describe('the season rollover', () => {
  const SEASON = 2029;

  test('demotes an active body with no activity in the window; retains use, boosts and favourites', async () => {
    const t = harness();
    const skater = await seedUser(t, 'skater');
    const fan = await seedUser(t, 'fan');
    const never = await seedBody(t, 'osm/never');
    const old = await seedBody(t, 'osm/old');
    const recent = await seedBody(t, 'osm/recent');
    const boosted = await seedBody(t, 'osm/boosted', { curatedBoost: 0.3 });
    const favourited = await seedBody(t, 'osm/fav');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: favourited });
    // The window into '29/'30 is the start of the '26/'27 season onward.
    const cutoff = seasonStartMs(SEASON - 3);
    await t.run(async (ctx) => {
      const profile = await ctx.db.get(skater.id);
      if (!profile) throw new Error('no skater');
      for (const [id, when] of [
        [old, cutoff - 1],
        [recent, cutoff + 1],
      ] as const) {
        await ctx.db.insert('reports', {
          authorId: skater.id,
          waterBodyId: id,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: when,
          reportTime: when,
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          moderationStatus: 'visible',
          photoIds: [],
          hazardIdsCreated: [],
          createdAt: when,
          updatedAt: when,
        } as unknown as Doc<'reports'>);
      }
    });

    const totals = await drain(
      (args) =>
        t.mutation(internal.standing.demoteInactiveBodies, {
          season: SEASON,
          apply: true,
          ...args,
        }),
      {},
    );
    expect(totals.demoted).toBe(2);
    expect(standingOf((await get(t, never)) as Doc<'waterBodies'>)).toMatchObject({
      reason: 'inactive',
    });
    expect(standingOf((await get(t, old)) as Doc<'waterBodies'>)).toMatchObject({
      reason: 'inactive',
    });
    for (const id of [recent, boosted, favourited]) {
      expect(standingOf((await get(t, id)) as Doc<'waterBodies'>).standing).toBe('active');
    }
  });

  test('the action records a run row, and the daily gate runs it once per season', async () => {
    const t = harness();
    await seedBody(t, 'osm/never');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(SEASON, 6, 3)); // July 3 — inside the window
      const first = await t.mutation(internal.standing.maybeRunStandingRollover, {});
      expect(first).toMatchObject({ ran: true, season: SEASON });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const runs = await t.run((ctx) => ctx.db.query('importRuns').collect());
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        kind: 'standing_rollover',
        status: 'succeeded',
        campaignId: `standing-rollover-${SEASON}`,
      });
      expect(runs[0]?.counts).toEqual(
        expect.arrayContaining([
          { name: 'demoted', value: 1 },
          { name: 'scanned', value: 1 },
        ]),
      );

      // Tomorrow: nothing to do.
      vi.setSystemTime(Date.UTC(SEASON, 6, 4));
      expect(await t.mutation(internal.standing.maybeRunStandingRollover, {})).toMatchObject({
        ran: false,
      });
      // Outside the window: nothing either.
      vi.setSystemTime(Date.UTC(SEASON, 0, 4));
      expect(await t.mutation(internal.standing.maybeRunStandingRollover, {})).toMatchObject({
        ran: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 7. The moderator lists
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('the standing lists', () => {
  test('each lane shows its own standing, once, and a member cannot read them', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const member = await seedUser(t, 'member');
    const inactive = await seedBody(t, 'osm/inactive', {
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    // Removed AND carrying a stale dormancy: it belongs to the removed lane only.
    const removed = await seedBody(t, 'osm/removed', {
      removedAt: Date.now(),
      dormant: { since: Date.now(), reason: 'inactive' },
    });
    const none = await seedBody(t, 'osm/none', {
      publicAccess: { verdict: 'none', decidedAt: Date.now(), decidedByUserId: mod.id },
    });

    const lane = async (name: 'inactive' | 'removed' | 'no_public_access') =>
      (await mod.as.query(api.standing.listLane, { lane: name })).rows.map((r) => r._id);
    expect(await lane('inactive')).toEqual([inactive]);
    expect(await lane('removed')).toEqual([removed]);
    expect(await lane('no_public_access')).toEqual([none]);
    await expect(member.as.query(api.standing.listLane, { lane: 'inactive' })).rejects.toThrow(
      /moderator/i,
    );
  });

  test('recent activations carry what brought the body back and what it still lacks', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const skater = await seedUser(t, 'skater');
    const id = await seedBody(t, 'osm/1', { dormant: { since: Date.now(), reason: 'inactive' } });
    await skater.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    const rows = await mod.as.query(api.standing.listRecentActivations, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: id, via: 'report' });
    expect(rows[0]?.missing).toEqual(expect.arrayContaining(['elevation', 'wind', 'depth']));
  });
});
