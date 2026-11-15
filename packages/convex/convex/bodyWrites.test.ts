/**
 * The Bodies writes (B01-3d): a moderator's aliases and class — normalized and refused at the edge,
 * audited, undone through the same write (and the undo undone), the library row refreshed, a merged
 * body refused and a removed one editable; and the import's class claims.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { MAX_FEATURE_POSITIONS } from './bodyFeatures';
import { OVERRIDES_READ } from './imageryOverrides';
import { DOC_MAX, REQUEST_PROFILE_BUDGET, requestBudget } from './lib/readBudget';
import { savedPutInsOf } from './lib/standing';
import { undoState } from './lib/undo';
import { UNDO_CHECKED_ELSEWHERE, undoRead } from './lib/undoReads';
import schema from './schema';
import { MAX_MODERATOR_ALIAS_CHARS, MAX_MODERATOR_ALIASES } from './waterBodies';

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
const POLYGON = {
  type: 'Polygon' as const,
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

let seq = 0;
async function person(t: T, role: 'member' | 'moderator' = 'moderator') {
  const n = seq++;
  const subject = `writes-${n}`;
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

/** A body through the import, with each catalog's class claim. */
async function imported(
  t: T,
  externalId: string,
  over: { type?: Doc<'waterBodies'>['type']; classClaims?: unknown } = {},
): Promise<Id<'waterBodies'>> {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: 'Mirror Lake',
        type: over.type ?? 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: 40_000,
        ...(over.classClaims !== undefined ? { classClaims: over.classClaims as never } : {}),
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('not imported');
  return body._id;
}

const get = (t: T, id: Id<'waterBodies'>) => t.run((ctx) => ctx.db.get(id));
const libraryRow = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id).eq('scope', '*'))
      .first(),
  );
const lastAction = (t: T, action: Doc<'moderationActions'>['action']) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('moderationActions').order('desc').collect();
    return rows.find((r) => r.action === action) as Doc<'moderationActions'>;
  });

describe('setAliases', () => {
  test('normalized once — trimmed, de-duplicated against the name and each other — and folded into the library row', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    await mod.as.mutation(api.waterBodies.setAliases, {
      waterBodyId: id,
      aliases: ['  The   Mirror ', 'mirror lake', 'the mirror', '', 'Glass Pond'],
    });
    expect((await get(t, id))?.moderatorAliases).toEqual(['The Mirror', 'Glass Pond']);
    const row = await libraryRow(t, id);
    expect(row?.aliases).toEqual(expect.arrayContaining(['The Mirror', 'Glass Pond']));
    expect(row?.searchText.toLowerCase()).toContain('glass pond');
    // Found by the alias in the list's search.
    const found = await mod.as.query(api.bodies.listPage, {
      lane: 'all',
      q: 'glass',
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(found.page.map((r) => r.id)).toEqual([id]);
  });

  test('refused past the bounds, on a merged-away body, and to a member; a removed body is editable', async () => {
    const t = harness();
    const mod = await person(t);
    const member = await person(t, 'member');
    const id = await imported(t, 'way/1');
    const set = (aliases: string[], waterBodyId = id) =>
      mod.as.mutation(api.waterBodies.setAliases, { waterBodyId, aliases });
    await expect(
      set(Array.from({ length: MAX_MODERATOR_ALIASES + 1 }, (_, i) => `Alias ${i}`)),
    ).rejects.toThrow(/at most 20/);
    await expect(set(['x'.repeat(MAX_MODERATOR_ALIAS_CHARS + 1)])).rejects.toThrow(/at most 120/);
    await expect(
      member.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases: ['A'] }),
    ).rejects.toThrow();
    const survivor = await imported(t, 'way/2');
    await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'merged', mergedIntoId: survivor }));
    await expect(set(['A'])).rejects.toThrow(/merged into another/);
    await t.run((ctx) => ctx.db.patch(survivor, { removedAt: NOW, removalReason: 'other' }));
    await set(['Still Named'], survivor);
    expect((await get(t, survivor))?.moderatorAliases).toEqual(['Still Named']);
  });

  test('undone through the same write, and the undo undone', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    await mod.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases: ['First'] });
    await mod.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases: ['Second'] });
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_aliases'))._id });
    expect((await get(t, id))?.moderatorAliases).toEqual(['First']);
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_aliases'))._id });
    expect((await get(t, id))?.moderatorAliases).toEqual(['Second']);
  });
});

describe('setClass and the class claims', () => {
  test('the import stores each catalog’s claim; a moderator’s class outranks it and survives a re-import', async () => {
    const t = harness();
    const mod = await person(t);
    const claims = [
      { source: 'nhd', value: 'reservoir' },
      { source: 'osm', value: 'lakePond' },
      { source: 'nhd', value: 'lakePond' },
    ];
    const id = await imported(t, 'way/1', { type: 'reservoir', classClaims: claims });
    expect((await get(t, id))?.classClaims).toEqual([
      { source: 'nhd', value: 'reservoir' },
      { source: 'osm', value: 'lakePond' },
    ]);
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: 'lakePond' });
    expect(await get(t, id)).toMatchObject({ type: 'lakePond', moderatorClass: 'lakePond' });
    expect((await libraryRow(t, id))?.bodyClass).toBe('lakePond');
    // A re-import keeps the moderator's class, and leaves the claims when the record carries none.
    await imported(t, 'way/1', { type: 'reservoir' });
    expect(await get(t, id)).toMatchObject({
      type: 'lakePond',
      classClaims: [
        { source: 'nhd', value: 'reservoir' },
        { source: 'osm', value: 'lakePond' },
      ],
    });
    expect(await mod.as.query(api.bodyConsole.identity, { waterBodyId: id })).toEqual({
      bodyClass: 'lakePond',
      classClaims: [
        { source: 'nhd', value: 'reservoir' },
        { source: 'osm', value: 'lakePond' },
      ],
      moderatorClass: 'lakePond',
      moderatorAliases: [],
    });
    // Clearing puts the import's class back.
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: null });
    const cleared = await get(t, id);
    expect(cleared?.type).toBe('reservoir');
    expect(cleared?.moderatorClass).toBeUndefined();
  });

  test('clearing puts back the import’s ranked class, not the first claim — as the latest import ranked it', async () => {
    const t = harness();
    const mod = await person(t);
    // The merge ranks a reservoir over a lake, whichever catalog the members listed first.
    const claims = [
      { source: 'osm', value: 'lakePond' },
      { source: 'nhd', value: 'reservoir' },
    ];
    const id = await imported(t, 'way/1', { type: 'reservoir', classClaims: claims });
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: 'wetland' });
    // Re-ranked by a campaign while the moderator's class holds `type`.
    await imported(t, 'way/1', { type: 'river', classClaims: claims });
    expect((await get(t, id))?.type).toBe('wetland');
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: null });
    expect((await get(t, id))?.type).toBe('river');
    // The undo of the clear is the moderator's class again; its undo, the import's.
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_class'))._id });
    expect((await get(t, id))?.type).toBe('wetland');
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_class'))._id });
    expect((await get(t, id))?.type).toBe('river');
  });

  test('a body with no claims recorded: clearing puts back the class the override displaced; undo and its undo', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1', { type: 'reservoir' });
    // Imported before claims were stored: the tab reads *not recorded*.
    expect(
      (await mod.as.query(api.bodyConsole.identity, { waterBodyId: id })).classClaims,
    ).toBeNull();
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: 'lakePond' });
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_class'))._id });
    const undone = await get(t, id);
    expect(undone?.type).toBe('reservoir');
    expect(undone?.moderatorClass).toBeUndefined();
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_class'))._id });
    expect(await get(t, id)).toMatchObject({ type: 'lakePond', moderatorClass: 'lakePond' });
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: null });
    expect((await get(t, id))?.type).toBe('reservoir');
  });

  test('refused on a merged-away body', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const survivor = await imported(t, 'way/2');
    await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'merged', mergedIntoId: survivor }));
    await expect(
      mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: 'reservoir' }),
    ).rejects.toThrow(/merged into another/);
  });
});

describe('chooseDepthSource and the depth candidates', () => {
  const offer = (
    max: [string, number][],
    mean: [string, number][] = [],
  ): { depths: Record<string, unknown>[] } => ({
    depths: [
      ...max.map(([source, m]) => ({
        source: 'osm',
        externalId: 'way/1',
        maxDepthM: m,
        maxDepthSource: source,
      })),
      ...mean.map(([source, m]) => ({
        source: 'osm',
        externalId: 'way/1',
        meanDepthM: m,
        meanDepthSource: source,
      })),
    ],
  });
  const load = (t: T, o: ReturnType<typeof offer>) =>
    t.mutation(internal.waterBodies.importDepths, o as never);

  test('the ladder keeps every source’s offer and still picks the best — the default path unchanged', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const first = await load(
      t,
      offer(
        [
          ['osm_tag', 22],
          ['state_agency', 24],
          ['lagos_us', 23],
        ],
        [['hydrolakes_modeled', 8.1]],
      ),
    );
    // lagos_us arrives below state_agency: kept as a candidate, not a changed depth — as before.
    expect(first).toMatchObject({ updated: 3, skipped: 1 });
    expect(await get(t, id)).toMatchObject({ maxDepthM: 24, maxDepthSource: 'state_agency' });
    const choices = await mod.as.query(api.bodyConsole.depthChoices, { waterBodyId: id });
    expect(choices.max.choices.map((c) => [c.source, c.valueM, c.inUse])).toEqual([
      ['state_agency', 24, true],
      ['lagos_us', 23, false],
      ['osm_tag', 22, false],
    ]);
    expect(choices).toMatchObject({ recorded: true, max: { chosen: null, operatorValueM: null } });
    // A lower rung re-offered only refreshes its candidate: no depth changes, none counted.
    const again = await load(t, offer([['lagos_us', 23.4]]));
    expect(again).toMatchObject({ updated: 0, skipped: 1 });
    expect((await get(t, id))?.maxDepthM).toBe(24);
  });

  test('a choice holds against better rungs, follows its source’s fresh value, hands back, and undoes', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    await load(
      t,
      offer([
        ['state_agency', 24],
        ['lagos_us', 23],
      ]),
    );
    const choose = (source: string | null) =>
      mod.as.mutation(api.waterBodies.chooseDepthSource, {
        waterBodyId: id,
        measure: 'max',
        source: source as never,
      });
    await choose('lagos_us');
    expect(await get(t, id)).toMatchObject({ maxDepthM: 23, maxDepthSource: 'lagos_us' });
    expect((await libraryRow(t, id)) !== null).toBe(true);
    await load(
      t,
      offer([
        ['state_agency', 25],
        ['lagos_us', 23.5],
      ]),
    );
    expect(await get(t, id)).toMatchObject({ maxDepthM: 23.5, maxDepthSource: 'lagos_us' });
    await choose(null);
    expect(await get(t, id)).toMatchObject({ maxDepthM: 25, maxDepthSource: 'state_agency' });
    expect((await get(t, id))?.depthChoice).toBeUndefined();
    // Undo the hand-back: the choice again; undo that undo: the ladder again.
    await mod.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'choose_depth_source'))._id,
    });
    expect(await get(t, id)).toMatchObject({
      maxDepthSource: 'lagos_us',
      depthChoice: { max: 'lagos_us' },
    });
    await mod.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'choose_depth_source'))._id,
    });
    expect(await get(t, id)).toMatchObject({ maxDepthSource: 'state_agency' });
  });

  test('handed back, the measure takes the best-ranked candidate the pair allows, as the ladder settled it', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    // lagos_us's mean inverts the state survey's max, so the ladder dropped it for globathy's.
    await load(
      t,
      offer(
        [['state_agency', 10]],
        [
          ['lagos_us', 12],
          ['globathy', 6],
        ],
      ),
    );
    expect(await get(t, id)).toMatchObject({ meanDepthM: 6, meanDepthSource: 'globathy' });
    const choose = (source: string | null) =>
      mod.as.mutation(api.waterBodies.chooseDepthSource, {
        waterBodyId: id,
        measure: 'mean',
        source: source as never,
      });
    await expect(choose('lagos_us')).rejects.toThrow(/deeper than the max/);
    await choose('globathy');
    await choose(null);
    expect(await get(t, id)).toMatchObject({ meanDepthM: 6, meanDepthSource: 'globathy' });
    // The undo of the first choice is a hand-back too, and lands the same way.
    await choose('globathy');
    await mod.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'choose_depth_source'))._id,
    });
    expect(await get(t, id)).toMatchObject({ meanDepthM: 6, meanDepthSource: 'globathy' });
  });

  test('refused: a source with no value, an inverted pair, a typed depth, a merged-away body, a member', async () => {
    const t = harness();
    const mod = await person(t);
    const member = await person(t, 'member');
    const id = await imported(t, 'way/1');
    await load(
      t,
      offer(
        [
          ['state_agency', 24],
          ['osm_tag', 5],
        ],
        [['hydrolakes_modeled', 8]],
      ),
    );
    const choose = (measure: 'mean' | 'max', source: string, as = mod.as, waterBodyId = id) =>
      as.mutation(api.waterBodies.chooseDepthSource, {
        waterBodyId,
        measure,
        source: source as never,
      });
    await expect(choose('max', 'cslap')).rejects.toThrow(/no depth/);
    await expect(choose('max', 'osm_tag')).rejects.toThrow(/deeper than the max/);
    await expect(choose('max', 'state_agency', member.as)).rejects.toThrow();
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: id, maxDepthM: 30 });
    await expect(choose('max', 'state_agency')).rejects.toThrow(/typed this depth/);
    const survivor = await imported(t, 'way/2');
    await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'merged', mergedIntoId: survivor }));
    await expect(choose('mean', 'hydrolakes_modeled')).rejects.toThrow(/merged into another/);
  });
});

describe('bodyFeatures.updateShape', () => {
  const ridge = {
    type: 'LineString' as const,
    coordinates: [
      [-72.005, 44],
      [-71.995, 44],
    ],
  };
  async function seedFeature(t: T) {
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    const featureId = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId: id,
      type: 'recurring_pressure_ridge',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [-72, 44] },
      radiusMeters: 30,
      reason: 'seed',
    });
    return { admin, id, featureId };
  }

  test('redrawn: geometry, box and bay move; the body’s geometry facts are untouched; undo and its undo', async () => {
    const t = harness();
    const { admin, id, featureId } = await seedFeature(t);
    const facts = () =>
      t.run((ctx) =>
        ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', id))
          .first(),
      );
    const before = await facts();
    await admin.as.mutation(api.bodyFeatures.updateShape, {
      bodyFeatureId: featureId,
      geometryKind: 'line',
      geometry: ridge,
      bufferMeters: 15,
      reason: 'the ridge runs east–west',
    });
    const redrawn = await t.run((ctx) => ctx.db.get(featureId));
    expect(redrawn).toMatchObject({ geometryKind: 'line', bufferMeters: 15, geometry: ridge });
    expect(redrawn?.radiusMeters).toBeUndefined();
    expect(redrawn?.bbox.minLng).toBeLessThan(-72.004);
    expect(await facts()).toEqual(before);
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'update_body_feature_shape'))._id,
    });
    expect(await t.run((ctx) => ctx.db.get(featureId))).toMatchObject({
      geometryKind: 'point_radius',
      radiusMeters: 30,
    });
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'update_body_feature_shape'))._id,
    });
    expect(await t.run((ctx) => ctx.db.get(featureId))).toMatchObject({ geometryKind: 'line' });
  });

  test('refused: too many points, off its lake, no reason, a member, a demoted feature, a merged-away lake', async () => {
    const t = harness();
    const { admin, id, featureId } = await seedFeature(t);
    const member = await person(t, 'member');
    const redraw = (geometry: unknown, as = admin.as, reason = 'r') =>
      as.mutation(api.bodyFeatures.updateShape, {
        bodyFeatureId: featureId,
        geometryKind: 'line',
        geometry: geometry as never,
        bufferMeters: 10,
        reason,
      });
    const long = {
      type: 'LineString',
      coordinates: Array.from({ length: MAX_FEATURE_POSITIONS + 1 }, (_, i) => [
        -72 + i * 1e-6,
        44,
      ]),
    };
    await expect(redraw(long)).rejects.toThrow(`at most ${MAX_FEATURE_POSITIONS} points`);
    // The cap is the hazards' gate's own: a shape at it is accepted, never refused as invalid.
    await redraw({ ...long, coordinates: long.coordinates.slice(0, MAX_FEATURE_POSITIONS) });
    await expect(
      redraw({
        type: 'LineString',
        coordinates: [
          [-60, 40],
          [-60.01, 40],
        ],
      }),
    ).rejects.toThrow(/on its lake/);
    await expect(redraw(ridge, admin.as, '  ')).rejects.toThrow(/reason/);
    await expect(redraw(ridge, member.as)).rejects.toThrow();
    const survivor = await imported(t, 'way/2');
    await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'merged', mergedIntoId: survivor }));
    await expect(redraw(ridge)).rejects.toThrow(/merged into another/);
    await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'clean', mergedIntoId: undefined }));
    await admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: featureId, reason: 'gone' });
    await expect(redraw(ridge)).rejects.toThrow(/demoted/);
  });
});

describe('the imagery pass overrides', () => {
  const S = 'winter-2026-27';
  const G = 'S2C_18TXP_20261215_0_L2A';

  test('show anyway, hide with a reason, clear; the skater read carries no person; undo and its undo', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.imageryOverrides.set, {
      waterBodyId: id,
      season: S,
      granuleId: G,
      action: 'show',
    });
    expect(
      await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }),
    ).toEqual([{ granuleId: G, action: 'show' }]);
    await admin.as.mutation(api.imageryOverrides.set, {
      waterBodyId: id,
      season: S,
      granuleId: G,
      action: 'hide',
      reason: '  a  smoke plume over the north basin ',
    });
    const admin1 = await admin.as.query(api.imageryOverrides.forBody, {
      waterBodyId: id,
      season: S,
    });
    expect(admin1).toMatchObject({
      capped: false,
      overrides: [
        {
          granuleId: G,
          action: 'hide',
          reason: 'a smoke plume over the north basin',
          by: { userId: admin.id },
        },
      ],
    });
    // Undo the hide: shown again; undo that undo: hidden again.
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'set_imagery_override'))._id,
      reason: 'the plume was a cloud',
    });
    expect(
      (await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }))[0]
        ?.action,
    ).toBe('show');
    // Hiding again takes a pass from skaters, so that undo asks a reason, as a hide does.
    await expect(
      admin.as.mutation(api.undo.run, {
        actionId: (await lastAction(t, 'set_imagery_override'))._id,
      }),
    ).rejects.toThrow(/needs a reason/);
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'set_imagery_override'))._id,
      reason: 'it was smoke after all',
    });
    expect(
      (await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }))[0]
        ?.action,
    ).toBe('hide');
    await admin.as.mutation(api.imageryOverrides.clear, {
      waterBodyId: id,
      season: S,
      granuleId: G,
    });
    expect(
      await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }),
    ).toEqual([]);
    // Undoing a show over no call lets the gate hide the pass again — a pass taken from skaters.
    await admin.as.mutation(api.imageryOverrides.set, {
      waterBodyId: id,
      season: S,
      granuleId: G,
      action: 'show',
    });
    const showRow = await lastAction(t, 'set_imagery_override');
    await expect(admin.as.mutation(api.undo.run, { actionId: showRow._id })).rejects.toThrow(
      /needs a reason/,
    );
    await admin.as.mutation(api.undo.run, { actionId: showRow._id, reason: 'the gate was right' });
    expect(
      await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }),
    ).toEqual([]);
  });

  test('a season holds a bounded number of calls, so the skater read is whole; the tab reads newest first', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    await t.run(async (ctx) => {
      for (let i = 0; i < OVERRIDES_READ; i++) {
        await ctx.db.insert('imageryPassOverrides', {
          waterBodyId: id,
          season: S,
          granuleId: `g${i}`,
          action: 'show',
          byUserId: admin.id,
          // g0 the newest of these, every one older than a call made now.
          at: i === 0 ? NOW - 1_000 : NOW - 100_000 + i,
        });
      }
    });
    const set = (granuleId: string, action: 'show' | 'hide') =>
      admin.as.mutation(api.imageryOverrides.set, {
        waterBodyId: id,
        season: S,
        granuleId,
        action,
        ...(action === 'hide' ? { reason: 'smoke' } : {}),
      });
    await expect(set('one-more', 'show')).rejects.toThrow(`at most ${OVERRIDES_READ} calls`);
    // A call already held is changed in place.
    await set('g5', 'hide');
    const tab = await admin.as.query(api.imageryOverrides.forBody, { waterBodyId: id, season: S });
    expect(tab.capped).toBe(false);
    expect(tab.overrides).toHaveLength(OVERRIDES_READ);
    expect(tab.overrides[0]?.granuleId).toBe('g5');
    expect(tab.overrides[1]?.granuleId).toBe('g0');
    expect(
      await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }),
    ).toHaveLength(OVERRIDES_READ);
  });

  test('refused: a hide without a reason, a long reason, a malformed pass, a moderator, a merged-away body', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const set = (over: Record<string, unknown>, as = admin.as) =>
      as.mutation(api.imageryOverrides.set, {
        waterBodyId: id,
        season: S,
        granuleId: G,
        action: 'hide',
        reason: 'r',
        ...over,
      } as never);
    await expect(set({ reason: '   ' })).rejects.toThrow(/takes a reason/);
    await expect(set({ reason: 'x'.repeat(501) })).rejects.toThrow(/at most 500/);
    await expect(set({ granuleId: 'two words' })).rejects.toThrow(/not a satellite pass/);
    await expect(set({}, mod.as)).rejects.toThrow();
    const survivor = await imported(t, 'way/2');
    await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'merged', mergedIntoId: survivor }));
    await expect(set({})).rejects.toThrow(/merged into another/);
  });
});

describe('recurrence.waitingCountForBody (BS19)', () => {
  test('counts the waiting patterns by the tab’s rule; exactly the bound is whole, one more is capped', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const hazardId = await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: id,
        type: 'pressure_ridge',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [-72, 44] },
        radiusMeters: 20,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        createdByUserId: mod.id,
        photoIds: [],
        moderationStatus: 'visible',
        confirmCount: 0,
        goneCount: 0,
        createdAt: NOW,
        firstReportedAt: NOW,
        lastConfirmedAt: NOW,
        status: 'active',
      }),
    );
    const insert = (n: number, over: Record<string, unknown> = {}) =>
      t.run(async (ctx) => {
        for (let i = 0; i < n; i++) {
          await ctx.db.insert('hazardRecurrence', {
            waterBodyId: id,
            family: 'ridge',
            geometryKind: 'point_radius',
            geometry: { type: 'Point', coordinates: [-72, 44] },
            radiusMeters: 30,
            bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
            memberHazardIds: [hazardId],
            representativeHazardId: hazardId,
            seasonsObserved: [2024, 2025],
            windowSeasons: 5,
            firstReportedDayOfSeasonP25: 180,
            firstReportedDayOfSeasonP75: 200,
            distinctAuthorCount: 1,
            priority: i,
            publiclyVisible: true,
            computedAt: NOW,
            computedForSeason: 2026,
            ...over,
          } as never);
        }
      });
    await insert(998);
    await insert(2, { suppressedAt: NOW });
    const count = () => mod.as.query(api.recurrence.waitingCountForBody, { waterBodyId: id });
    expect(await count()).toEqual({ count: 998, capped: false });
    await insert(1);
    expect(await count()).toMatchObject({ capped: true });
  });

  test('the admin and public lists read highest priority first: past the bound, the newest top pattern is kept', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const hazardId = await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: id,
        type: 'pressure_ridge',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [-72, 44] },
        radiusMeters: 20,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        createdByUserId: mod.id,
        photoIds: [],
        moderationStatus: 'visible',
        confirmCount: 0,
        goneCount: 0,
        createdAt: NOW,
        firstReportedAt: NOW - 400 * 86_400_000,
        lastConfirmedAt: NOW,
        status: 'archived',
      }),
    );
    await t.run(async (ctx) => {
      // 1,000 ordinary patterns first, then the most important one, stored last.
      for (let i = 0; i <= 1_000; i++) {
        await ctx.db.insert('hazardRecurrence', {
          waterBodyId: id,
          family: 'ridge',
          geometryKind: 'point_radius',
          geometry: { type: 'Point', coordinates: [-72, 44] },
          radiusMeters: 30,
          bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
          memberHazardIds: [hazardId],
          representativeHazardId: hazardId,
          seasonsObserved: [2024, 2025],
          windowSeasons: 5,
          firstReportedDayOfSeasonP25: 180,
          firstReportedDayOfSeasonP75: 200,
          distinctAuthorCount: 1,
          priority: i === 1_000 ? 1_000_000 : i,
          publiclyVisible: true,
          computedAt: NOW,
          computedForSeason: 2026,
        } as never);
      }
    });
    const admin = await mod.as.query(api.recurrence.listForBodyAdmin, { waterBodyId: id });
    expect(admin).toHaveLength(1_000);
    expect(admin[0]?.priority).toBe(1_000_000);
    expect(admin.at(-1)?.priority).toBe(1);
    const shown = await t.query(api.recurrence.listForBody, { waterBodyId: id });
    expect(shown[0]?.priority).toBe(1_000_000);
  });
});

describe('whole-list writes refuse a list that moved under them (BS17)', () => {
  test('two interleaved writers: with the list they built on the second is refused with the current list; without it, the later wins', async () => {
    const t = harness();
    const a = await person(t);
    const b = await person(t);
    const id = await imported(t, 'way/1');
    const link = (label: string) => ({ label, url: `https://example.org/${label}` });
    await a.as.mutation(api.waterBodies.setReferenceLinks, {
      waterBodyId: id,
      links: [link('one')],
    });
    // Both open the body on [one]; A saves first.
    const opened = [link('one')];
    await a.as.mutation(api.waterBodies.setReferenceLinks, {
      waterBodyId: id,
      links: [...opened, link('a')],
      expected: opened,
    });
    const refused = await b.as
      .mutation(api.waterBodies.setReferenceLinks, {
        waterBodyId: id,
        links: [...opened, link('b')],
        expected: opened,
      })
      .then(
        () => null,
        (err: { data?: { code: string; current: unknown } }) => err.data,
      );
    expect(refused).toMatchObject({ code: 'list_changed', current: [link('one'), link('a')] });
    // B re-applies on top of the current list.
    await b.as.mutation(api.waterBodies.setReferenceLinks, {
      waterBodyId: id,
      links: [link('one'), link('a'), link('b')],
      expected: [link('one'), link('a')],
    });
    // Without `expected`, as the open pages save today, the later write wins.
    await a.as.mutation(api.waterBodies.setReferenceLinks, { waterBodyId: id, links: [link('z')] });
    expect((await get(t, id))?.referenceLinks).toEqual([link('z')]);
  });

  test('the same check on aliases and a landmark’s spellings; an undo is refused once the list moved', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    await mod.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases: ['First'] });
    await expect(
      mod.as.mutation(api.waterBodies.setAliases, {
        waterBodyId: id,
        aliases: ['Second'],
        expected: [],
      }),
    ).rejects.toThrow(/Someone else changed this body’s aliases/);
    // An undo of a list write that has since been overwritten is refused, not applied over it.
    const first = await lastAction(t, 'set_aliases');
    await mod.as.mutation(api.waterBodies.setAliases, {
      waterBodyId: id,
      aliases: ['Third'],
      expected: ['First'],
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: first._id })).rejects.toThrow();
    expect((await get(t, id))?.moderatorAliases).toEqual(['Third']);
    // The newest one undoes, through the same check.
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_aliases'))._id });
    expect((await get(t, id))?.moderatorAliases).toEqual(['First']);

    const landmarkId = await t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId: id,
        name: 'Long Point',
        kind: 'point',
        point: { lat: 44, lng: -72 },
        aliases: ['The Point'],
        source: 'gnis',
        externalIds: ['gnis:lp'],
        createdAt: NOW,
        updatedAt: NOW,
      } as never),
    );
    await expect(
      mod.as.mutation(api.landmarks.update, {
        landmarkId,
        aliases: ['Longpoint'],
        expectedAliases: [],
      }),
    ).rejects.toThrow(/other spellings/);
    await mod.as.mutation(api.landmarks.update, {
      landmarkId,
      aliases: ['The Point', 'Longpoint'],
      expectedAliases: ['The Point'],
    });
    expect((await t.run((ctx) => ctx.db.get(landmarkId)))?.aliases).toEqual([
      'The Point',
      'Longpoint',
    ]);
  });
});

describe('putIns.promote', () => {
  async function seedLaunch(t: T, over: Record<string, unknown> = {}) {
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const { lot, putInId } = await t.run(async (ctx) => {
      const lot = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44.012, lng: -72 },
        source: 'osm',
        status: 'visible',
        amenities: [],
        createdAt: NOW,
      });
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44.01, lng: -72 },
        source: 'osm',
        status: 'visible',
        externalId: 'node/9',
        name: 'Town Ramp',
        parkingAreaId: lot,
        approachMeters: 240,
        approachRouted: true,
        approachAscentM: 6,
        approachPath: [
          { lat: 44.012, lng: -72 },
          { lat: 44.01, lng: -72 },
        ],
        approachKindOverride: 'short_walk',
        createdAt: NOW,
        ...over,
      } as never);
      return { lot, putInId };
    });
    return { mod, id, lot, putInId };
  }
  const putIn = (t: T, id: Id<'putIns'>) => t.run((ctx) => ctx.db.get(id));

  test('in place: the same row, point, lot, walk and override; the name only when given; undo and its undo', async () => {
    const t = harness();
    const { mod, lot, putInId } = await seedLaunch(t);
    const before = await putIn(t, putInId);
    const r = await mod.as.mutation(api.putIns.promote, { putInId, name: '  North   Ramp ' });
    expect(r).toEqual({ putInId, actionId: expect.any(String), undoNeedsReason: true });
    const after = await putIn(t, putInId);
    expect(after).toMatchObject({
      source: 'official',
      name: 'North Ramp',
      coord: before?.coord,
      parkingAreaId: lot,
      approachMeters: 240,
      approachRouted: true,
      approachAscentM: 6,
      approachPath: before?.approachPath,
      approachKindOverride: 'short_walk',
      externalId: 'node/9',
    });
    expect((await t.run((ctx) => ctx.db.query('putIns').collect())).length).toBe(1);
    await expect(mod.as.mutation(api.putIns.promote, { putInId })).rejects.toThrow(
      /already official/,
    );
    // The undo takes official status away, so it asks a reason.
    await expect(mod.as.mutation(api.undo.run, { actionId: r.actionId })).rejects.toThrow(/reason/);
    await mod.as.mutation(api.undo.run, { actionId: r.actionId, reason: 'not the town’s ramp' });
    expect(await putIn(t, putInId)).toMatchObject({
      source: 'osm',
      name: 'Town Ramp',
      parkingAreaId: lot,
      approachMeters: 240,
    });
    // Undoing the undo gives it back, and asks none.
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_put_in'))._id });
    expect(await putIn(t, putInId)).toMatchObject({ source: 'official', name: 'North Ramp' });
  });

  test('a dormant body comes back; the rollover’s put-in rule sees the launch the same before and after', async () => {
    const t = harness();
    const { mod, id, putInId } = await seedLaunch(t);
    await t.run((ctx) => ctx.db.patch(id, { dormant: { since: NOW, reason: 'inactive' } }));
    const keeps = () => t.run((ctx) => savedPutInsOf(ctx, id));
    const before = await keeps();
    await mod.as.mutation(api.putIns.promote, { putInId });
    expect(await keeps()).toEqual(before);
    expect(before.keeps).toBe(true);
    expect((await get(t, id))?.dormant).toBeUndefined();
  });

  test('refused: hidden, suppressed, on a merged-away body, missing; an undo once the launch was renamed', async () => {
    const t = harness();
    const { mod, id, putInId } = await seedLaunch(t);
    await t.run((ctx) => ctx.db.patch(putInId, { status: 'hidden' }));
    await expect(mod.as.mutation(api.putIns.promote, { putInId })).rejects.toThrow(/hidden/);
    await t.run(async (ctx) => {
      await ctx.db.patch(putInId, { status: 'visible' });
      await ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44.01, lng: -72 },
        source: 'derived',
        status: 'hidden',
        createdAt: NOW,
      });
    });
    await expect(mod.as.mutation(api.putIns.promote, { putInId })).rejects.toThrow(/hid a put-in/);
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query('putIns').collect()) {
        if (r.status === 'hidden') await ctx.db.delete(r._id);
      }
    });
    const r = await mod.as.mutation(api.putIns.promote, { putInId });
    await t.run((ctx) => ctx.db.patch(putInId, { name: 'Renamed Since' }));
    await expect(
      mod.as.mutation(api.undo.run, { actionId: r.actionId, reason: 'r' }),
    ).rejects.toThrow(/changed since/);
    const survivor = await imported(t, 'way/2');
    await t.run(async (ctx) => {
      await ctx.db.patch(putInId, { source: 'osm' });
      await ctx.db.patch(id, { dedupStatus: 'merged', mergedIntoId: survivor });
    });
    await expect(mod.as.mutation(api.putIns.promote, { putInId })).rejects.toThrow(
      /merged into another/,
    );
    await t.run((ctx) => ctx.db.delete(putInId));
    await expect(mod.as.mutation(api.putIns.promote, { putInId })).rejects.toThrow(
      /no longer exists/,
    );
  });
});

describe('Greptile on #126', () => {
  test('a body loaded before candidates keeps its stored depth when a choice replaces it', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    // The winner as a load before this PR left it: on the depth fields, no candidates.
    await t.run((ctx) => ctx.db.patch(id, { maxDepthM: 24, maxDepthSource: 'state_agency' }));
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [{ source: 'osm', externalId: 'way/1', maxDepthM: 23, maxDepthSource: 'lagos_us' }],
    } as never);
    const choose = (source: string | null) =>
      mod.as.mutation(api.waterBodies.chooseDepthSource, {
        waterBodyId: id,
        measure: 'max',
        source: source as never,
      });
    await choose('lagos_us');
    expect(await get(t, id)).toMatchObject({ maxDepthM: 23 });
    await choose(null);
    expect(await get(t, id)).toMatchObject({ maxDepthM: 24, maxDepthSource: 'state_agency' });
  });

  test('re-promoting through an undo refuses a launch an import moved or renamed since', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1');
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44.01, lng: -72 },
        source: 'osm',
        status: 'visible',
        name: 'Town Ramp',
        createdAt: NOW,
      }),
    );
    const r = await mod.as.mutation(api.putIns.promote, { putInId });
    await mod.as.mutation(api.undo.run, { actionId: r.actionId, reason: 'r' });
    // An import moves and renames the launch, writing no audit row.
    await t.run((ctx) =>
      ctx.db.patch(putInId, { coord: { lat: 44.0101, lng: -72 }, name: 'Ramp Road' }),
    );
    await expect(
      mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_put_in'))._id }),
    ).rejects.toThrow(/changed since/);
    expect((await t.run((ctx) => ctx.db.get(putInId)))?.source).toBe('osm');
  });
});

/**
 * The sweep before re-review: every undo in this PR, after a change no audit row records (an import, a
 * loader run, a merge's moves, an outline recomputed, a hide on another target). Each case runs twice:
 * without the change the undo is offered and runs; with it, History never offers it (the query's own
 * undo state, as History reads it) and running it is refused with the same plain message, leaving the
 * row as it was. "Holds" cases follow: the undo is offered and puts back the newer value, never the
 * stale one.
 */
describe('undo after an un-audited change: write → change → undo → redo', () => {
  type Who = Awaited<ReturnType<typeof person>>;
  interface Setup {
    admin: Who;
    /** The row whose undo is tested (an undo's own row, for a redo). */
    subject: Id<'moderationActions'>;
    reason?: string;
    /** The change no audit row records (or, for a merge, records on another target). */
    drift: () => Promise<unknown>;
    /** What a refused undo must leave exactly as it is. */
    state: () => Promise<unknown>;
  }
  const offered = async (t: T, admin: Who, id: Id<'moderationActions'>) => {
    const row = await t.run((ctx) => ctx.db.get(id));
    if (!row) throw new Error('no row');
    const rows = await admin.as.query(api.moderation.listActions, {
      targetType: row.targetType,
      targetId: row.targetId,
    });
    const line = rows.find((r) => r.id === id);
    if (!line) throw new Error('not in History');
    return line.undo;
  };
  const S = 'winter-2026-27';
  const G = 'S2C_18TXP_20261215_0_L2A';
  const depthLoad = (t: T, max: [string, number][]) =>
    t.mutation(internal.waterBodies.importDepths, {
      depths: max.map(([source, m]) => ({
        source: 'osm',
        externalId: 'way/1',
        maxDepthM: m,
        maxDepthSource: source,
      })),
    } as never);
  const undo = (who: Who, actionId: Id<'moderationActions'>, reason?: string) =>
    who.as.mutation(api.undo.run, { actionId, ...(reason !== undefined ? { reason } : {}) });
  async function feature(t: T) {
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    const featureId = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId: id,
      type: 'recurring_pressure_ridge',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [-72, 44] },
      radiusMeters: 30,
      reason: 'seed',
    });
    await admin.as.mutation(api.bodyFeatures.updateShape, {
      bodyFeatureId: featureId,
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [-72.005, 44.005] },
      radiusMeters: 20,
      reason: 'moved to the ridge',
    });
    const subject = (await lastAction(t, 'update_body_feature_shape'))._id;
    return { admin, id, featureId, subject };
  }
  async function launch(t: T) {
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44.01, lng: -72 },
        source: 'osm',
        status: 'visible',
        name: 'Town Ramp',
        createdAt: NOW,
      }),
    );
    const r = await admin.as.mutation(api.putIns.promote, { putInId });
    return { admin, id, putInId, actionId: r.actionId };
  }

  const CASES: { name: string; refused: RegExp | 'overtaken'; setup: (t: T) => Promise<Setup> }[] =
    [
      {
        name: 'choose_depth_source, redone after a loader run took its source away',
        refused: /no depth for this body/,
        setup: async (t) => {
          const admin = await person(t, 'admin' as never);
          const id = await imported(t, 'way/1');
          await depthLoad(t, [
            ['state_agency', 24],
            ['lagos_us', 23],
          ]);
          await admin.as.mutation(api.waterBodies.chooseDepthSource, {
            waterBodyId: id,
            measure: 'max',
            source: 'lagos_us',
          });
          await undo(admin, (await lastAction(t, 'choose_depth_source'))._id);
          return {
            admin,
            subject: (await lastAction(t, 'choose_depth_source'))._id,
            drift: () =>
              t.run(async (ctx) => {
                const body = await ctx.db.get(id);
                await ctx.db.patch(id, {
                  depthCandidates: body?.depthCandidates?.filter((c) => c.source !== 'lagos_us'),
                });
              }),
            state: async () => {
              const b = await get(t, id);
              return [b?.maxDepthM, b?.maxDepthSource, b?.depthChoice, b?.depthCandidates];
            },
          };
        },
      },
      {
        name: 'update_body_feature_shape, after the outline was re-imported away from the shape it puts back',
        refused: /has to be on its lake/,
        setup: async (t) => {
          const { admin, id, featureId, subject } = await feature(t);
          return {
            admin,
            subject,
            drift: () =>
              t.run((ctx) =>
                ctx.db.patch(id, {
                  bbox: { minLat: 44.004, minLng: -72.006, maxLat: 44.006, maxLng: -72.004 },
                }),
              ),
            state: () => t.run((ctx) => ctx.db.get(featureId)),
          };
        },
      },
      {
        name: 'set_put_in, after the launch was hidden (audited on the put-in, not the body)',
        refused: /hidden/,
        setup: async (t) => {
          const { admin, putInId, actionId } = await launch(t);
          return {
            admin,
            subject: actionId,
            reason: 'not the town’s ramp',
            drift: () => t.run((ctx) => ctx.db.patch(putInId, { status: 'hidden' })),
            state: () => t.run((ctx) => ctx.db.get(putInId)),
          };
        },
      },
      {
        name: 'set_put_in, redone after an import moved the launch',
        refused: /changed since/,
        setup: async (t) => {
          const { admin, putInId, actionId } = await launch(t);
          await undo(admin, actionId, 'not the town’s ramp');
          return {
            admin,
            subject: (await lastAction(t, 'set_put_in'))._id,
            drift: () =>
              t.run((ctx) => ctx.db.patch(putInId, { coord: { lat: 44.0101, lng: -72 } })),
            state: () => t.run((ctx) => ctx.db.get(putInId)),
          };
        },
      },
      {
        name: 'edit_landmark, after a merge’s fold or a catalog run moved its spellings',
        refused: /other spellings/,
        setup: async (t) => {
          const admin = await person(t, 'admin' as never);
          const id = await imported(t, 'way/1');
          const landmarkId = await t.run((ctx) =>
            ctx.db.insert('bodyLandmarks', {
              waterBodyId: id,
              name: 'Long Point',
              kind: 'point',
              point: { lat: 44, lng: -72 },
              aliases: ['The Point'],
              source: 'gnis',
              externalIds: ['gnis:lp'],
              createdAt: NOW,
              updatedAt: NOW,
            } as never),
          );
          await admin.as.mutation(api.landmarks.update, {
            landmarkId,
            aliases: ['The Point', 'Longpoint'],
          });
          return {
            admin,
            subject: (await lastAction(t, 'edit_landmark'))._id,
            drift: () =>
              t.run((ctx) =>
                ctx.db.patch(landmarkId, { aliases: ['The Point', 'Longpoint', 'Lone Point'] }),
              ),
            state: () => t.run((ctx) => ctx.db.get(landmarkId)),
          };
        },
      },
      {
        name: 'set_weather_sample_points, after the outline moved off the grid it puts back',
        refused: /isn't on/,
        setup: async (t) => {
          const admin = await person(t, 'admin' as never);
          const id = await imported(t, 'way/1');
          const set = (points: { lat: number; lng: number }[]) =>
            admin.as.mutation(api.waterBodies.setWeatherSamplePoints, { waterBodyId: id, points });
          await set([{ lat: 43.995, lng: -72 }]);
          await set([{ lat: 44.005, lng: -72 }]);
          return {
            admin,
            subject: (await lastAction(t, 'set_weather_sample_points'))._id,
            drift: () =>
              t.run((ctx) =>
                ctx.db.patch(id, {
                  polygon: {
                    type: 'Polygon',
                    coordinates: [
                      [
                        [-72.01, 44],
                        [-71.99, 44],
                        [-71.99, 44.01],
                        [-72.01, 44.01],
                        [-72.01, 44],
                      ],
                    ],
                  } as never,
                }),
              ),
            state: async () => (await get(t, id))?.weatherSamplePoints,
          };
        },
      },
      {
        name: 'set_aliases, after a merge moved the body (the merge’s row overtakes it)',
        refused: 'overtaken',
        setup: async (t) => {
          const admin = await person(t, 'admin' as never);
          const id = await imported(t, 'way/1');
          const survivor = await imported(t, 'way/2');
          await admin.as.mutation(api.waterBodies.setAliases, {
            waterBodyId: id,
            aliases: ['The Mirror'],
          });
          return {
            admin,
            subject: (await lastAction(t, 'set_aliases'))._id,
            drift: () =>
              admin.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: id }),
            state: async () => (await get(t, id))?.moderatorAliases,
          };
        },
      },
    ];

  for (const c of CASES) {
    test(`${c.name}: offered and run without the change; with it, never offered and refused`, async () => {
      const t = harness();
      const control = await c.setup(t);
      const before = await control.state();
      expect(await offered(t, control.admin, control.subject)).toMatchObject({
        state: 'available',
      });
      await undo(control.admin, control.subject, control.reason);
      expect(await control.state()).not.toEqual(before);

      const t2 = harness();
      const s = await c.setup(t2);
      await s.drift();
      const state = await s.state();
      const undoState = await offered(t2, s.admin, s.subject);
      if (c.refused === 'overtaken') {
        expect(undoState.state).toBe('overtaken');
        await expect(undo(s.admin, s.subject, s.reason)).rejects.toThrow(/changed this since/);
      } else {
        expect(undoState).toMatchObject({
          state: 'unavailable',
          why: expect.stringMatching(c.refused),
        });
        await expect(undo(s.admin, s.subject, s.reason)).rejects.toThrow(c.refused);
      }
      expect(await s.state()).toEqual(state);
    });
  }

  test('set_class, after a re-import changed the catalog class: the undo puts back the newer class, and its undo the moderator’s', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1', { type: 'reservoir' });
    await admin.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: 'wetland' });
    const set = (await lastAction(t, 'set_class'))._id;
    await imported(t, 'way/1', { type: 'river' });
    expect(await offered(t, admin, set)).toMatchObject({ state: 'available' });
    await undo(admin, set);
    const undone = await get(t, id);
    expect(undone?.type).toBe('river');
    expect(undone?.moderatorClass).toBeUndefined();
    await undo(admin, (await lastAction(t, 'set_class'))._id);
    expect(await get(t, id)).toMatchObject({ type: 'wetland', moderatorClass: 'wetland' });
  });

  test('choose_depth_source, after a loader run refreshed the ladder: the undo hands back to the fresh value, not the recorded one', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    await depthLoad(t, [
      ['state_agency', 24],
      ['lagos_us', 23],
    ]);
    await admin.as.mutation(api.waterBodies.chooseDepthSource, {
      waterBodyId: id,
      measure: 'max',
      source: 'lagos_us',
    });
    await depthLoad(t, [['state_agency', 25]]);
    expect((await get(t, id))?.maxDepthM).toBe(23);
    await undo(admin, (await lastAction(t, 'choose_depth_source'))._id);
    expect(await get(t, id)).toMatchObject({ maxDepthM: 25, maxDepthSource: 'state_agency' });
  });

  test('set_imagery_override, after its pass was recut or pruned: the call is keyed by the pass, so its undo still clears it', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.imageryOverrides.set, {
      waterBodyId: id,
      season: S,
      granuleId: G,
      action: 'hide',
      reason: 'smoke',
    });
    // The pass is gone from the pipeline's tables; nothing of it was ever read by the override.
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query('imageryGranules').collect()) await ctx.db.delete(g._id);
    });
    const row = (await lastAction(t, 'set_imagery_override'))._id;
    expect(await offered(t, admin, row)).toMatchObject({ state: 'available' });
    await undo(admin, row);
    expect(
      await t.query(api.imageryOverrides.passOverrides, { waterBodyId: id, season: S }),
    ).toEqual([]);
  });

  test('update_body_feature_shape, after a merge moved the feature to the survivor: offered, and the shape goes back on the survivor', async () => {
    const t = harness();
    const { admin, id, featureId, subject } = await feature(t);
    const survivor = await imported(t, 'way/2');
    await admin.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: id });
    // The merge's row is on the body, not the feature; the geometry it moved is the moderator's own.
    expect((await t.run((ctx) => ctx.db.get(featureId)))?.waterBodyId).toBe(survivor);
    expect(await offered(t, admin, subject)).toMatchObject({ state: 'available' });
    await undo(admin, subject);
    expect(await t.run((ctx) => ctx.db.get(featureId))).toMatchObject({
      waterBodyId: survivor,
      geometry: { type: 'Point', coordinates: [-72, 44] },
      radiusMeters: 30,
    });
  });

  test('a landmark edit recorded before its spellings were: undone as before, with no compare', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    const landmarkId = await t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId: id,
        name: 'Long Point',
        kind: 'point',
        point: { lat: 44, lng: -72 },
        aliases: ['The Point'],
        source: 'gnis',
        externalIds: ['gnis:lp'],
        createdAt: NOW,
        updatedAt: NOW,
      } as never),
    );
    await admin.as.mutation(api.landmarks.update, { landmarkId, aliases: ['Longpoint'] });
    const row = await lastAction(t, 'edit_landmark');
    const { aliases: _aliases, ...older } = row.metadata as Record<string, unknown>;
    await t.run(async (ctx) => {
      await ctx.db.patch(row._id, { metadata: older });
      await ctx.db.patch(landmarkId, { aliases: ['Longpoint', 'Lone Point'] });
    });
    expect(await offered(t, admin, row._id)).toMatchObject({ state: 'available' });
    await undo(admin, row._id);
    expect((await t.run((ctx) => ctx.db.get(landmarkId)))?.aliases).toEqual(['The Point']);
  });

  test('past the page’s read budget the check is not guessed: the undo says to open what it changed', async () => {
    const t = harness();
    const admin = await person(t, 'admin' as never);
    const id = await imported(t, 'way/1');
    await depthLoad(t, [
      ['state_agency', 24],
      ['lagos_us', 23],
    ]);
    await admin.as.mutation(api.waterBodies.chooseDepthSource, {
      waterBodyId: id,
      measure: 'max',
      source: 'lagos_us',
    });
    const rowId = (await lastAction(t, 'choose_depth_source'))._id;
    const state = await t.run(async (ctx) => {
      // Everything but less than one body's worst case already spent by the page.
      requestBudget(ctx).spend(REQUEST_PROFILE_BUDGET - DOC_MAX + 1);
      const viewer = await ctx.db.get(admin.id);
      const row = await ctx.db.get(rowId);
      if (!viewer || !row) throw new Error('missing');
      return undoState(ctx, viewer, row);
    });
    expect(state).toEqual({ state: 'unavailable', why: UNDO_CHECKED_ELSEWHERE });
  });

  test('reads in flight together are charged one after another: the second waits for the first’s weight', async () => {
    const t = harness();
    const a = await imported(t, 'way/1');
    const b = await imported(t, 'way/2');
    const got = await t.run(async (ctx) => {
      // Room for one body's worst case and a byte: the first read leaves less than that for the second.
      requestBudget(ctx).spend(REQUEST_PROFILE_BUDGET - DOC_MAX - 1);
      const [first, second] = await Promise.all([
        undoRead(ctx, 'waterBody', a),
        undoRead(ctx, 'waterBody', b),
      ]);
      return { first: first?._id ?? null, secondRead: second !== undefined };
    });
    expect(got).toEqual({ first: a, secondRead: false });
  });

  test('a staffer’s Decisions (People) asks the same refusal: each axis’s worst verb answers, never throws', async () => {
    // The redraw is the hook's most calls (feature, body, snapshot); the launch its most documents
    // (the launch and its body's hidden ones) — the two peaks People's per-row plan counts.
    const decisionsLine = async (who: Who, id: Id<'moderationActions'>) => {
      const page = await who.as.query(api.people.decisions, { userId: who.id });
      return page?.rows.find((r) => r.id === id)?.undo;
    };
    const t1 = harness();
    const shaped = await feature(t1);
    expect(await decisionsLine(shaped.admin, shaped.subject)).toMatchObject({ state: 'available' });
    await t1.run((ctx) =>
      ctx.db.patch(shaped.id, {
        bbox: { minLat: 44.004, minLng: -72.006, maxLat: 44.006, maxLng: -72.004 },
      }),
    );
    expect(await decisionsLine(shaped.admin, shaped.subject)).toEqual({
      state: 'unavailable',
      why: expect.stringMatching(/has to be on its lake/),
    });

    const t2 = harness();
    const promoted = await launch(t2);
    expect(await decisionsLine(promoted.admin, promoted.actionId)).toMatchObject({
      state: 'available',
    });
    await t2.run((ctx) => ctx.db.patch(promoted.putInId, { status: 'hidden' }));
    expect(await decisionsLine(promoted.admin, promoted.actionId)).toEqual({
      state: 'unavailable',
      why: expect.stringMatching(/hidden/),
    });
  });
});
