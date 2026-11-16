/**
 * The reads the Bodies pages asked for (B01-3c): a search's matches in the other standings, rows by
 * id, a removed body's facts, the preview's askers and intake reasons, and the frame's completeness.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { ASKERS_CAP, OTHER_STANDING_ROWS, ROWS_BY_IDS_MAX } from './bodies';
import { REMOVED_REPORT_CAP } from './bodyConsole';
import { PLACES_RULE } from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import schema from './schema';
import { removeBodyImpl } from './waterBodies';

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
    expect(r.facetsIgnored).toBe(false);
    // The lane's facets don't narrow the other standings' counts, and the read says so.
    const faceted = await as.query(api.bodies.searchOtherStandings, {
      lane: 'active',
      q: 'mirror',
      facets: { size: ['1000-up'] },
    });
    expect(faceted.facetsIgnored).toBe(true);
    expect(faceted.groups.find((g) => g.lane === 'inactive')?.count).toBe(OTHER_STANDING_ROWS + 2);
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

  test('says when a removal’s reason is a person’s own words (a restore’s undo), never the composed sentence', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const id = await body(t, 'Taken Down');
    const removeOf = (auditReason?: string) =>
      t.run(async (ctx) => {
        const actor = (await ctx.db.get(mod.id)) as Doc<'profiles'>;
        await removeBodyImpl(ctx, actor, {
          waterBodyId: id,
          reason: 'landowner_request',
          ...(auditReason !== undefined ? { auditReason } : {}),
        });
      });
    const left = async () =>
      (await mod.as.query(api.bodyConsole.removedFacts, { waterBodyId: id }))?.left;
    await removeOf();
    expect(await left()).toMatchObject({ reasonIsOwn: false, note: null });
    // Restored (as its row would be), then removed again by the restore's undo, with its reason.
    await t.run((ctx) =>
      ctx.db.patch(id, {
        removedAt: undefined,
        removedByUserId: undefined,
        removalReason: undefined,
      }),
    );
    await removeOf('The owner asked again');
    expect(await left()).toMatchObject({
      reason: 'The owner asked again',
      reasonIsOwn: true,
      note: null,
    });
  });

  test('a rejected body removed later reads as rejected, with its rejection’s row', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const id = await body(t, 'Both', {
      source: 'user',
      reviewStatus: 'rejected',
      removedAt: NOW - 100,
      removedByUserId: mod.id,
      removalReason: 'other',
    });
    await t.run(async (ctx) => {
      for (const [action, at] of [
        ['reject_waterbody', NOW - 1000],
        ['remove', NOW - 100],
      ] as const) {
        await ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action,
          targetType: 'waterbody',
          targetId: id,
          reason: action,
          createdAt: at,
        });
      }
    });
    expect(await mod.as.query(api.bodyConsole.removedFacts, { waterBodyId: id })).toMatchObject({
      standing: 'rejected',
      left: { action: 'reject_waterbody', at: NOW - 1000, removalReason: null },
    });
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

  test('a lead town whose name two states share is named once, its state beside it', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const id = await body(t, 'Border Pond', { states: ['NH', 'VT'] });
    await t.run(async (ctx) => {
      const town = (state: string, geoid: string) =>
        ctx.db.insert('adminAreas', {
          name: 'Franklin',
          level: 'town',
          state,
          externalId: `tiger/${geoid}`,
          polygon: {
            type: 'Polygon',
            coordinates: [
              [
                [-72.1, 43.9],
                [-71.9, 43.9],
                [-71.9, 44.1],
                [-72.1, 43.9],
              ],
            ],
          },
          bbox: { minLat: 43.9, minLng: -72.1, maxLat: 44.1, maxLng: -71.9 },
          centroid: { lat: 44, lng: -72 },
          createdAt: NOW,
        });
      const vt = await town('VT', '5001126800');
      const nh = await town('NH', '3301327380');
      for (const r of await ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .collect()) {
        await ctx.db.delete(r._id);
      }
      await ctx.db.insert('bodyGeoFacts', {
        waterBodyId: id,
        computedAt: NOW,
        checkedAt: NOW,
        placesRule: PLACES_RULE,
        towns: ['Franklin'],
        townStates: ['VT'],
        townIds: [vt],
        townEntries: [
          { name: 'Franklin', state: 'VT', id: vt },
          { name: 'Franklin', state: 'NH', id: nh },
        ],
        counties: [],
        states: ['NH', 'VT'],
      });
    });
    // The page joins `town` and `townState`: "Franklin, VT", never "Franklin, VT, VT".
    expect(await mod.as.query(api.bodies.preview, { waterBodyId: id })).toMatchObject({
      town: 'Franklin',
      townState: 'VT',
      moreTownsWithState: [{ name: 'Franklin', state: 'NH' }],
    });
  });

  test('a landmark ask’s askers are the asks for the same place, as the inbox counts them', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const id = await body(t, 'Long Lake');
    const [a, b, c] = [await person(t), await person(t), await person(t)];
    await t.run(async (ctx) => {
      const ask = (requesterId: Id<'profiles'>, lat: number, at: number) =>
        ctx.db.insert('waterBodyRequests', {
          kind: 'name_landmark',
          status: 'open',
          requesterId,
          coord: { lat, lng: -72 },
          waterBodyId: id,
          name: 'Long Point',
          nameKey: 'long point',
          createdAt: at,
        });
      // Two people name one spot; a third names another spot by the same name, 20 km off.
      await ask(a?.id as Id<'profiles'>, 44, NOW - 30);
      await ask(b?.id as Id<'profiles'>, 44, NOW - 20);
      await ask(c?.id as Id<'profiles'>, 44.18, NOW - 10);
    });
    const p = await mod.as.query(api.bodies.preview, { waterBodyId: id });
    const counts = (p?.asks ?? [])
      .filter((x) => x.kind === 'request')
      .map((x) => (x.kind === 'request' ? x.askers?.count : null));
    // Newest first: the far spot's one asker, then the near spot's two, twice.
    expect(counts).toEqual([1, 2, 2]);
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
    // The loader sends it with its last batch, which need not clear; a dataset with no state is
    // refused.
    await t.mutation(internal.waterBodies.importContourCoverage, {
      source: 'osm',
      externalIds: [],
      searched: [{ label: 'ME lake contours', states: ['ME'] }],
    });
    expect((await extras(me)).bathymetrySearched).toMatchObject({ label: 'ME lake contours' });
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

describe('Greptile on #122', () => {
  test('a removed body’s hidden reports never use up its visible count', async () => {
    const t = harness();
    const mod = await person(t, 'moderator');
    const author = await person(t);
    const id = await body(t, 'Hidden Reports', { removedAt: NOW, removalReason: 'other' });
    await t.run(async (ctx) => {
      const report = (at: number, moderationStatus: 'visible' | 'hidden') =>
        ctx.db.insert('reports', {
          authorId: author.id,
          waterBodyId: id,
          point: { lat: 44, lng: -72 },
          skateEndTime: at,
          reportTime: at,
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          hazardIdsCreated: [],
          moderationStatus,
          createdAt: at,
          updatedAt: at,
        });
      for (let i = 0; i < REMOVED_REPORT_CAP + 1; i++) await report(NOW - i, 'hidden');
      await report(NOW - 10_000, 'visible');
      await report(NOW - 20_000, 'visible');
    });
    expect(
      (await mod.as.query(api.bodyConsole.removedFacts, { waterBodyId: id }))?.reports,
    ).toEqual({ count: 2, capped: false });
  });

  test('a run past the searched bounds is refused, never cut', async () => {
    const t = harness();
    await expect(
      t.mutation(internal.waterBodies.importContourCoverage, {
        source: 'osm',
        externalIds: [],
        searched: Array.from({ length: 21 }, (_, i) => ({ label: `D${i}`, states: ['VT'] })),
      }),
    ).rejects.toThrow(/at most 20/);
    await expect(
      t.mutation(internal.waterBodies.importContourCoverage, {
        source: 'osm',
        externalIds: [],
        searched: [
          {
            label: 'Wide',
            states: ['VT', 'NH', 'ME', 'MA', 'NY', 'CT', 'RI', 'NJ', 'PA', 'OH', 'MI'],
          },
        ],
      }),
    ).rejects.toThrow(/at most 10 states/);
  });
});
