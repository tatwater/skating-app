/**
 * The text caps at their writers (B01-3h): a moderator's name or URL past its cap is refused with a
 * plain message; an import skips the row and counts it, never the campaign; a stored value past a cap
 * keeps working. A property over the writers whose free text lands in audit metadata: no write
 * produces metadata past its stated bound. And the landmark undo's full rule where one landmark is in
 * view, honest where a list can't check it.
 */

import {
  MAX_APPROACH_PATH_POINTS,
  MAX_EXTERNAL_ID_CHARS,
  MAX_PLACE_NAME_CHARS,
  MAX_REFERENCE_LINK_LABEL,
  MAX_REFERENCE_LINKS,
  MAX_URL_CHARS,
} from '@skating/core';
import { getDocumentSize } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { undoClashRefusal } from './lib/undoHandlersBody';
import schema from './schema';
import { MAX_MODERATOR_ALIAS_CHARS, MAX_MODERATOR_ALIASES } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();
const long = (n: number) => 'x'.repeat(n);

let seq = 0;
async function admin(t: T) {
  const n = seq++;
  const subject = `caps-${n}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `Lee ${n}`,
      username: `lee-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      reputationPoints: 0,
      role: 'admin',
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const SQUARE = {
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
const item = (externalId: string, name = 'Mirror Lake') => ({
  source: 'osm',
  externalId,
  osmId: externalId,
  name,
  type: 'lakePond',
  polygon: SQUARE,
  bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
  centroid: { lat: 44, lng: -72 },
  surfaceAreaSqM: 40_000,
  states: ['VT'],
});
async function body(t: T, externalId = 'way/1', name = 'Mirror Lake') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [item(externalId, name)],
  } as never);
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!row) throw new Error('not imported');
  return row._id;
}
const lastAction = (t: T, action: Doc<'moderationActions'>['action']) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('moderationActions').order('desc').collect();
    return rows.find((r) => r.action === action) as Doc<'moderationActions'>;
  });

describe('a moderator’s name or URL past its cap is refused, plainly', () => {
  test('a lake’s community name, a bay’s name and alias, a lot’s name and lakes, a link’s URL', async () => {
    const t = harness();
    const mod = await admin(t);
    const id = await body(t, 'way/1', '');
    const over = long(MAX_PLACE_NAME_CHARS + 1);
    await expect(
      mod.as.mutation(api.waterBodies.setWaterBodyName, { waterBodyId: id, name: over }),
    ).rejects.toThrow(`A lake’s name is ${MAX_PLACE_NAME_CHARS + 1} characters`);
    await mod.as.mutation(api.waterBodies.setWaterBodyName, {
      waterBodyId: id,
      name: long(MAX_PLACE_NAME_CHARS),
    });
    const bay = {
      waterBodyId: id,
      polygon: SQUARE,
    };
    await expect(mod.as.mutation(api.subAreas.create, { ...bay, name: over })).rejects.toThrow(
      /A bay’s name is/,
    );
    await expect(
      mod.as.mutation(api.subAreas.create, { ...bay, name: 'North Arm', aliases: [over] }),
    ).rejects.toThrow(/A bay’s alias is/);
    await expect(
      mod.as.mutation(api.accessPoints.setOfficialParking, {
        coord: { lat: 44, lng: -72 },
        name: over,
        amenities: [],
        waterBodyIds: [id],
      }),
    ).rejects.toThrow(/A lot’s name is/);
    await expect(
      mod.as.mutation(api.accessPoints.setOfficialParking, {
        coord: { lat: 44, lng: -72 },
        amenities: [],
        waterBodyIds: Array.from({ length: 51 }, () => id),
      }),
    ).rejects.toThrow(/at most 50 lakes/);
    await expect(
      mod.as.mutation(api.waterBodies.setReferenceLinks, {
        waterBodyId: id,
        links: [{ label: 'Association', url: `https://example.org/${long(MAX_URL_CHARS)}` }],
      }),
    ).rejects.toThrow(`A link is at most ${MAX_URL_CHARS} characters`);
  });

  test('a value stored past its cap keeps working: read, edited around, and undone', async () => {
    const t = harness();
    const mod = await admin(t);
    const id = await body(t);
    const bayId = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: id,
      name: 'North Arm',
      polygon: SQUARE,
    });
    // Written before the caps.
    const stored = long(MAX_PLACE_NAME_CHARS + 50);
    await t.run((ctx) => ctx.db.patch(bayId, { name: stored }));
    // An alias-only edit leaves the stored name alone and is accepted; its undo puts the old back.
    await mod.as.mutation(api.subAreas.rename, { subAreaId: bayId, aliases: ['The Arm'] });
    expect((await t.run((ctx) => ctx.db.get(bayId)))?.name).toBe(stored);
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'rename_sub_area'))._id });
    expect(await t.run((ctx) => ctx.db.get(bayId))).toMatchObject({ name: stored });
  });

  test('an edit around a link’s URL or a lot’s name stored past its cap keeps it; a new one is held', async () => {
    const t = harness();
    const mod = await admin(t);
    const id = await body(t);
    const storedUrl = `https://example.org/${long(MAX_URL_CHARS)}`;
    await t.run((ctx) => ctx.db.patch(id, { referenceLinks: [{ label: 'Old', url: storedUrl }] }));
    await mod.as.mutation(api.waterBodies.setReferenceLinks, {
      waterBodyId: id,
      links: [
        { label: 'Old', url: storedUrl },
        { label: 'New', url: 'https://example.org/new' },
      ],
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.referenceLinks).toHaveLength(2);
    await expect(
      mod.as.mutation(api.waterBodies.setReferenceLinks, {
        waterBodyId: id,
        links: [{ label: 'Another', url: `${storedUrl}/more` }],
      }),
    ).rejects.toThrow(`A link is at most ${MAX_URL_CHARS} characters`);

    const lot = { coord: { lat: 44, lng: -72 }, amenities: [], waterBodyIds: [id] };
    const parkingAreaId = await mod.as.mutation(api.accessPoints.setOfficialParking, {
      ...lot,
      name: 'Town Lot',
    });
    const storedName = long(MAX_PLACE_NAME_CHARS + 20);
    await t.run((ctx) => ctx.db.patch(parkingAreaId, { name: storedName }));
    await mod.as.mutation(api.accessPoints.setOfficialParking, {
      ...lot,
      parkingAreaId,
      name: storedName,
      fee: true,
    });
    expect(await t.run((ctx) => ctx.db.get(parkingAreaId))).toMatchObject({
      name: storedName,
      fee: true,
    });
    await expect(
      mod.as.mutation(api.accessPoints.setOfficialParking, {
        ...lot,
        parkingAreaId,
        name: `${storedName}y`,
      }),
    ).rejects.toThrow(/A lot’s name is/);
  });
});

describe('an import skips a row past a cap and counts it — never the campaign', () => {
  test('bodies: a name or catalog id past its cap', async () => {
    const t = harness();
    const out = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        item('way/1'),
        item('way/2', long(MAX_PLACE_NAME_CHARS + 1)),
        item(`way/${long(MAX_EXTERNAL_ID_CHARS)}`),
      ],
    } as never);
    expect(out).toMatchObject({ inserted: 1, tooLong: 2 });
  });

  test('bodies: a skipped re-import still re-affirms the row it names, taking nothing else from it', async () => {
    const t = harness();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [item('way/1')],
      campaignId: 'c1',
    } as never);
    const out = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [item('way/1', long(MAX_PLACE_NAME_CHARS + 1))],
      campaignId: 'c2',
    } as never);
    expect(out).toMatchObject({ updated: 0, tooLong: 1 });
    const [row] = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    // Step 6's prune reads the stamp: the catalogs still list this body.
    expect(row).toMatchObject({ name: 'Mirror Lake', lastCampaignId: 'c2' });
    const pruned = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: 'c2',
    } as never);
    expect(pruned).toMatchObject({ deleted: 0 });
  });

  test('bays from the catalogs: a name past its cap', async () => {
    const t = harness();
    const mod = await admin(t);
    await body(t);
    const out = await t.mutation(internal.subAreas.importBaySubAreas, {
      actorUserId: mod.id,
      bays: [
        { name: long(MAX_PLACE_NAME_CHARS + 1), polygon: SQUARE, parentIds: { osmId: 'way/1' } },
      ],
      dryRun: false,
    });
    expect(out).toMatchObject({ results: [{ ok: false, reason: 'name_too_long' }] });
  });

  test('a record past a cap whose ids reach several bodies still flags them, as any merge verdict does', async () => {
    const t = harness();
    const a = await body(t, 'way/1');
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...item('nhd/9'), source: 'nhd', osmId: undefined, nhdId: 'nhd/9' }],
    } as never);
    const out = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...item('way/1', long(MAX_PLACE_NAME_CHARS + 1)), nhdId: 'nhd/9' }],
    } as never);
    expect(out).toMatchObject({ inserted: 0, updated: 0 });
    const rows = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(rows).toHaveLength(2);
    // Both are in the dedup queue, so the prune's protection list keeps them.
    expect(rows.every((r) => r.dedupStatus !== 'clean')).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(a)))?.name).toBe('Mirror Lake');
  });

  test('launches: a name or id past its cap is skipped; a walk past its cap is thinned, its ends kept', async () => {
    const t = harness();
    await body(t);
    const walk = Array.from({ length: MAX_APPROACH_PATH_POINTS * 3 }, (_, i) => ({
      lat: 44.01 + i / 1e6,
      lng: -72,
    }));
    const out = await t.mutation(internal.accessPoints.matchAndImportPutIns, {
      putIns: [
        { externalId: 'node/1', point: { lat: 44.01, lng: -72 }, approachPath: walk },
        {
          externalId: 'node/2',
          point: { lat: 44.01, lng: -72.005 },
          name: long(MAX_PLACE_NAME_CHARS + 1),
        },
        { externalId: `node/${long(MAX_EXTERNAL_ID_CHARS)}`, point: { lat: 44.01, lng: -71.995 } },
      ],
    });
    expect(out).toMatchObject({ created: 1, tooLong: 2 });
    const launch = await t.run((ctx) => ctx.db.query('putIns').first());
    expect(launch?.approachPath).toHaveLength(MAX_APPROACH_PATH_POINTS);
    expect(launch?.approachPath?.[0]).toEqual(walk[0]);
    expect(launch?.approachPath?.at(-1)).toEqual(walk.at(-1));
  });

  test('lots: a name or id past its cap', async () => {
    const t = harness();
    await body(t);
    const lot = (externalId: string, name?: string) => ({
      externalId,
      point: { lat: 44.0, lng: -72.0 },
      amenities: [],
      paired: true,
      ...(name !== undefined ? { name } : {}),
    });
    const out = await t.mutation(internal.accessPoints.matchAndImportParking, {
      lots: [
        lot('way/1'),
        lot('way/2', long(MAX_PLACE_NAME_CHARS + 1)),
        lot(`way/${long(MAX_EXTERNAL_ID_CHARS)}`),
      ],
    });
    expect(out).toMatchObject({ created: 1, tooLong: 2 });
  });
});

/** The most metadata any of these writers puts on its audit row (stated, B01-3h). */
const AUDIT_METADATA_MAX = 160 * 1024;

describe('no writer of free text produces audit metadata past its bound', () => {
  // Strings of any length up to twice the cap, in characters of one to four UTF-8 bytes.
  const text = (cap: number) =>
    fc
      .tuple(fc.integer({ min: 0, max: 2 * cap }), fc.constantFrom('a', 'é', '€', '𝄞'))
      .map(([n, ch]) => ch.repeat(n));
  const metadataOf = async (t: T, action: Doc<'moderationActions'>['action']) =>
    getDocumentSize(((await lastAction(t, action))?.metadata ?? {}) as never);

  test('aliases, links, a community name, a bay’s names', async () => {
    const t = harness();
    const mod = await admin(t);
    const id = await body(t, 'way/1', '');
    const bayId = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: id,
      name: 'North Arm',
      polygon: SQUARE,
    });
    const writes = fc.oneof(
      fc
        .array(text(MAX_MODERATOR_ALIAS_CHARS), { maxLength: MAX_MODERATOR_ALIASES + 2 })
        .map(
          (aliases) =>
            [
              'set_aliases',
              () => mod.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases }),
            ] as const,
        ),
      fc
        .array(
          fc.record({
            label: text(MAX_REFERENCE_LINK_LABEL),
            url: text(MAX_URL_CHARS).map((s) => `https://example.org/${s}`),
          }),
          { maxLength: MAX_REFERENCE_LINKS + 1 },
        )
        .map(
          (links) =>
            [
              'set_reference_links',
              () => mod.as.mutation(api.waterBodies.setReferenceLinks, { waterBodyId: id, links }),
            ] as const,
        ),
      text(MAX_PLACE_NAME_CHARS)
        .filter((name) => name.trim() !== '')
        .map(
          (name) =>
            [
              'set_water_body_name',
              () => mod.as.mutation(api.waterBodies.setWaterBodyName, { waterBodyId: id, name }),
            ] as const,
        ),
      fc
        .tuple(text(MAX_PLACE_NAME_CHARS), fc.array(text(MAX_PLACE_NAME_CHARS), { maxLength: 4 }))
        .filter(([name]) => name.trim() !== '')
        .map(
          ([name, aliases]) =>
            [
              'rename_sub_area',
              () => mod.as.mutation(api.subAreas.rename, { subAreaId: bayId, name, aliases }),
            ] as const,
        ),
    );
    await fc.assert(
      fc.asyncProperty(writes, async ([action, write]) => {
        try {
          await write();
        } catch {
          return; // refused: nothing written
        }
        expect(await metadataOf(t, action)).toBeLessThanOrEqual(AUDIT_METADATA_MAX);
      }),
      { numRuns: 24 },
    );
  });
});

describe('the landmark undo: the edit’s own rule where one landmark is in view', () => {
  async function seed(t: T) {
    const mod = await admin(t);
    const id = await body(t);
    const landmark = (name: string, lng: number) =>
      t.run((ctx) =>
        ctx.db.insert('bodyLandmarks', {
          waterBodyId: id,
          name,
          kind: 'point',
          point: { lat: 44, lng },
          aliases: [],
          source: 'gnis',
          externalIds: [`gnis:${name}`],
          createdAt: NOW,
          updatedAt: NOW,
        } as never),
      );
    return { mod, id, landmark };
  }

  test('a clash since: the single view and runUndo refuse plainly, nothing half-applied; a list still answers every row', async () => {
    const t = harness();
    const { mod, landmark } = await seed(t);
    const a = await landmark('Long Point', -72);
    const b = await landmark('Birch Point', -71.995);
    const c = await landmark('Cedar Point', -71.991);
    for (const [landmarkId, name] of [
      [a, 'Long Pt'],
      [b, 'Birch Pt'],
      [c, 'Cedar Pt'],
    ] as const) {
      await mod.as.mutation(api.landmarks.update, { landmarkId, name });
    }
    // A catalog run places a landmark at Long Point's spot under its old name (no row on `a`).
    await landmark('Long Point', -72);
    const editOfA = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).find(
      (r) => r.action === 'edit_landmark' && r.targetId === a,
    ) as Doc<'moderationActions'>;
    const clash = '"Long Point" is already a landmark here';
    const why = undoClashRefusal(clash, false);
    // One landmark's own history: the full rule.
    const own = await mod.as.query(api.moderation.listActions, {
      targetType: 'bodyLandmark',
      targetId: a,
    });
    expect(own.find((r) => r.id === editOfA._id)?.undo).toEqual({ state: 'unavailable', why });
    // The feed (a list): spellings only, every row answered, none sent elsewhere by a neighbor.
    const feed = await mod.as.query(api.moderation.listActions, {});
    const edits = feed.filter((r) => r.action === 'edit_landmark');
    expect(edits.map((r) => r.undo.state)).toEqual(['available', 'available', 'available']);
    // runUndo (which the feed offered) refuses plainly, saying a list couldn't check it, and writes
    // nothing.
    const before = await t.run((ctx) => ctx.db.get(a));
    await expect(mod.as.mutation(api.undo.run, { actionId: editOfA._id })).rejects.toThrow(
      undoClashRefusal(clash, true),
    );
    expect(await t.run((ctx) => ctx.db.get(a))).toEqual(before);
    // The others undo.
    const editOfB = edits.find((r) => r.targetId === b);
    await mod.as.mutation(api.undo.run, { actionId: editOfB?.id as Id<'moderationActions'> });
    expect((await t.run((ctx) => ctx.db.get(b)))?.name).toBe('Birch Point');
  });
});
