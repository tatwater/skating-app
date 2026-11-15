/**
 * The reads the Bodies pages asked for (B01-3c): a search's matches in the other standings, rows by
 * id, a removed body's facts, the preview's askers and intake reasons, and the frame's completeness.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { ASKERS_CAP, OTHER_STANDING_ROWS, ROWS_BY_IDS_MAX } from './bodies';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();
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

let seq = 0;
async function person(t: T, role: 'member' | 'moderator' = 'member') {
  const n = seq++;
  const subject = `reads-${n}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `Pat ${n}`,
      username: `pat-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function body(
  t: T,
  name: string,
  over: Partial<Doc<'waterBodies'>> = {},
): Promise<Id<'waterBodies'>> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond',
      source: 'osm',
      polygon: {
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
      },
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44, lng: -72 },
      states: ['VT'],
      surfaceAreaSqM: 40_000,
      dedupStatus: 'clean',
      createdAt: NOW,
      ...over,
    });
    await rebuildBodyLibrary(ctx, id);
    return id;
  });
}

const dormant = { dormant: { since: NOW, reason: 'inactive' as const } };

describe('searchOtherStandings', () => {
  test('a lane’s search counts and shows the matches in every other standing, the best first', async () => {
    const t = harness();
    const { as } = await person(t, 'moderator');
    await body(t, 'Mirror Pond');
    await body(t, 'Mirror Lake');
    for (let i = 0; i < OTHER_STANDING_ROWS + 2; i++) await body(t, `Mirror Basin ${i}`, dormant);
    await body(t, 'Elsewhere Pond', dormant);
    const r = await as.query(api.bodies.searchOtherStandings, { lane: 'active', q: ' mirror ' });
    // Normalized at the edge as the list's search is.
    expect(r.q).toBe('mirror');
    const byLane = Object.fromEntries(r.groups.map((g) => [g.lane, g]));
    expect(byLane.active).toBeUndefined();
    expect(byLane.inactive).toMatchObject({ count: OTHER_STANDING_ROWS + 2, capped: false });
    expect(byLane.inactive?.rows).toHaveLength(OTHER_STANDING_ROWS);
    expect(byLane.removed).toMatchObject({ count: 0, capped: false, rows: [] });
    // From the dormant lane, the active ones are the other standing.
    const back = await as.query(api.bodies.searchOtherStandings, { lane: 'inactive', q: 'mirror' });
    expect(back.groups.find((g) => g.lane === 'active')).toMatchObject({ count: 2 });
    // No search, *All* and *Changed*: nothing beside the lane.
    for (const args of [
      { lane: 'active' as const, q: 'm' },
      { lane: 'all' as const, q: 'mirror' },
      { lane: 'changed' as const, q: 'mirror' },
    ]) {
      expect((await as.query(api.bodies.searchOtherStandings, args)).groups).toEqual([]);
    }
    const member = await person(t);
    await expect(
      member.as.query(api.bodies.searchOtherStandings, { lane: 'active', q: 'mirror' }),
    ).rejects.toThrow();
  });
});

describe('rowsByIds', () => {
  test('in order, de-duplicated and bounded; a merge followed; unknown and unlisted said so', async () => {
    const t = harness();
    const { as } = await person(t, 'moderator');
    const a = await body(t, 'Alpha');
    const survivor = await body(t, 'Survivor');
    const merged = await body(t, 'Merged', { dedupStatus: 'merged', mergedIntoId: survivor });
    const gone = await body(t, 'Gone');
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', gone).eq('scope', '*'))
        .first();
      if (row) await ctx.db.delete(row._id);
      await ctx.db.delete(gone);
    });
    const unlisted = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'No Row',
        searchText: 'no row',
        type: 'lakePond',
        source: 'osm',
        polygon: { type: 'Polygon', coordinates: [] },
        bbox: { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 },
        centroid: { lat: 0, lng: 0 },
        dedupStatus: 'clean',
        createdAt: NOW,
      }),
    );
    const r = await as.query(api.bodies.rowsByIds, {
      ids: [a, ` ${a}`, merged, 'not an id', gone, unlisted],
    });
    expect(r.entries.map((e) => [e.status, e.row?.name ?? null])).toEqual([
      ['ok', 'Alpha'],
      ['merged', 'Survivor'],
      ['unknown', null],
      ['unknown', null],
      ['unlisted', null],
    ]);
    expect(r.entries[1]?.survivorId).toBe(survivor);
    expect(r.dropped).toBe(1);
    const many = Array.from({ length: ROWS_BY_IDS_MAX + 3 }, (_, i) => `id-${i}`);
    const bounded = await as.query(api.bodies.rowsByIds, { ids: many });
    expect(bounded.entries).toHaveLength(ROWS_BY_IDS_MAX);
    expect(bounded.dropped).toBe(3);
  });
});

describe('removedFacts', () => {
  test('a removed body’s facts, when and why it left and who decided; a rejected one; a served one', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const removed = await body(t, 'Taken Down', {
      removedAt: NOW - 1000,
      removedByUserId: mod.id,
      removalReason: 'landowner_request',
    });
    const rejected = await body(t, 'Not Water', { source: 'user', reviewStatus: 'rejected' });
    const served = await body(t, 'Still Here');
    await t.run(async (ctx) => {
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'remove',
        targetType: 'waterbody',
        targetId: removed,
        reason: 'Removed from map (landowner_request)',
        metadata: { removalReason: 'landowner_request' },
        createdAt: NOW - 1000,
      });
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'reject_waterbody',
        targetType: 'waterbody',
        targetId: rejected,
        reason: 'A field, not a pond',
        createdAt: NOW - 500,
      });
    });
    const r = await mod.as.query(api.bodyConsole.removedFacts, { waterBodyId: removed });
    expect(r).toMatchObject({
      name: 'Taken Down',
      bodyClass: 'lakePond',
      states: ['VT'],
      areaSqM: 40_000,
      standing: 'removed',
      left: {
        action: 'remove',
        at: NOW - 1000,
        removalReason: 'landowner_request',
        by: { userId: mod.id },
      },
      towns: null,
      reports: { count: 0, capped: false },
    });
    expect(
      await mod.as.query(api.bodyConsole.removedFacts, { waterBodyId: rejected }),
    ).toMatchObject({
      standing: 'rejected',
      left: { action: 'reject_waterbody', reason: 'A field, not a pond', removalReason: null },
    });
    expect(
      (await mod.as.query(api.bodyConsole.removedFacts, { waterBodyId: served }))?.left,
    ).toBeNull();
  });
});

describe('the preview and the frame', () => {
  test('each request’s distinct askers, the intake reasons worst first, and the frame’s completeness', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const id = await body(t, 'Asked Of', {
      reviewReasons: ['name-conflict', 'duplicate-candidate'],
      reviewReason: 'duplicate-candidate',
      duplicateCandidateIds: [],
      confidence: { name: 'low', polygon: 'high', cls: 'medium' },
    });
    const askers = [await person(t), await person(t), await person(t)];
    await t.run(async (ctx) => {
      const ask = (requesterId: Id<'profiles'>, name: string, at: number) =>
        ctx.db.insert('waterBodyRequests', {
          kind: 'name_bay',
          status: 'open',
          requesterId,
          coord: { lat: 44, lng: -72 },
          waterBodyId: id,
          name,
          nameKey: name.toLowerCase(),
          createdAt: at,
        });
      // Three people ask for one bay (one of them twice over), one for another.
      for (const [i, p] of askers.entries()) await ask(p.id, 'North Cove', NOW - 10 * i);
      await ask(askers[0]?.id as Id<'profiles'>, 'South Cove', NOW - 100);
    });
    const p = await mod.as.query(api.bodies.preview, { waterBodyId: id });
    const north = p?.asks.find((a) => a.kind === 'request' && a.name === 'North Cove');
    const south = p?.asks.find((a) => a.kind === 'request' && a.name === 'South Cove');
    expect(north).toMatchObject({ askers: { count: 3, capped: false } });
    expect(south).toMatchObject({ askers: { count: 1, capped: false } });
    expect(p?.intake).toEqual([
      { reason: 'duplicate-candidate', advisory: false, detail: { candidates: 0 } },
      { reason: 'name-conflict', advisory: true, detail: { confidence: 'low' } },
    ]);
    expect(ASKERS_CAP).toBeGreaterThan(3);
    const extras = await mod.as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    expect(extras.complete).toEqual(p?.complete);
    expect(extras.complete).not.toBeNull();
  });
});

describe('the bathymetry search record', () => {
  test('a coverage run records what it searched; a body reads its states’ newest search, else none', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const vt = await body(t, 'Vermont Pond');
    const me = await body(t, 'Maine Pond', { states: ['ME'] });
    const extras = (id: Id<'waterBodies'>) =>
      mod.as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    expect((await extras(vt)).bathymetrySearched).toBeNull();
    await t.mutation(internal.waterBodies.importContourCoverage, {
      source: 'osm',
      externalIds: [],
      clearFirst: true,
      searched: [{ label: ' VT ANR lake contours ', states: ['vt', 'NH', 'nope'] }],
    });
    expect((await extras(vt)).bathymetrySearched).toEqual({
      label: 'VT ANR lake contours',
      at: expect.any(Number),
    });
    expect((await extras(me)).bathymetrySearched).toBeNull();
    // A later batch (no clear) records nothing; a dataset with no state is refused.
    await t.mutation(internal.waterBodies.importContourCoverage, {
      source: 'osm',
      externalIds: [],
      searched: [{ label: 'Ignored', states: ['ME'] }],
    });
    expect((await extras(me)).bathymetrySearched).toBeNull();
    await expect(
      t.mutation(internal.waterBodies.importContourCoverage, {
        source: 'osm',
        externalIds: [],
        clearFirst: true,
        searched: [{ label: 'No states', states: ['x'] }],
      }),
    ).rejects.toThrow(/at least one state/);
  });
});
