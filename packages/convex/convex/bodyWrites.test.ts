/**
 * The Bodies writes (B01-3d): a moderator's aliases and class — normalized and refused at the edge,
 * audited, undone through the same write (and the undo undone), the library row refreshed, a merged
 * body refused and a removed one editable; and the import's class claims.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
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
    // Clearing puts the catalogs' first claim back.
    await mod.as.mutation(api.waterBodies.setClass, { waterBodyId: id, bodyClass: null });
    const cleared = await get(t, id);
    expect(cleared?.type).toBe('reservoir');
    expect(cleared?.moderatorClass).toBeUndefined();
  });

  test('a body with no claims recorded: clearing puts back the class the override displaced; undo and its undo', async () => {
    const t = harness();
    const mod = await person(t);
    const id = await imported(t, 'way/1', { type: 'reservoir' });
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
